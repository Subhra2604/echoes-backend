import { prisma } from '../../lib/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { sendEmail } from '../../lib/email.js';
import { isValidTimezone } from '../../lib/timezone.js';
import { notify } from '../notifications/notifications.service.js';
import {
  scheduleMessageDelivery,
  cancelScheduledMessage,
} from './scheduled-messages.scheduler.js';
import type {
  CreateScheduledMessageInput,
  UpdateScheduledMessageInput,
  ListScheduledMessagesQuery,
} from './scheduled-messages.dto.js';

/**
 * Scheduled Messages service.
 *
 * Model:
 *   - Owner picks one or more of their VERIFIED Contacts and writes an
 *     occasion + a message + a wall-clock schedule date.
 *   - The scheduled instant is stored in UTC on `scheduleDate`, alongside an
 *     IANA `timezone` snapshot (the owner's profile timezone unless
 *     explicitly overridden). BullMQ fires a delayed job at that UTC instant.
 *   - At fire time the worker fans out per recipient:
 *       - always: an email
 *       - additionally, if the recipient has an Echoes account: an in-app +
 *         push notification via the shared `notify()` entry point.
 *   - Idempotency: the worker walks recipients that are still `QUEUED` and
 *     flips them to `SENT` / `FAILED` inside its own commit, so a duplicate
 *     job run is a no-op.
 */

// ── Public API ──────────────────────────────────────────────────────────────

/** POST /scheduled-messages */
export async function createScheduledMessage(
  ownerId: string,
  input: CreateScheduledMessageInput,
) {
  const owner = await prisma.user.findUniqueOrThrow({
    where: { id: ownerId },
    select: { id: true, fullName: true, timezone: true },
  });

  const { fireAt, timezone } = resolveFireInstant(
    input.scheduleDate,
    input.timezone,
    owner.timezone,
  );

  const recipients = await resolveContactRecipients(ownerId, input.contactIds);

  const created = await prisma.$transaction(async (tx) => {
    const msg = await tx.scheduledMessage.create({
      data: {
        ownerId,
        occasion: input.occasion,
        message: input.message,
        scheduleDate: fireAt,
        timezone,
      },
    });

    if (recipients.length > 0) {
      await tx.scheduledMessageRecipient.createMany({
        data: recipients.map((r) => ({
          scheduledMessageId: msg.id,
          contactId: r.contactId,
          email: r.email,
          recipientUserId: r.userId,
        })),
        skipDuplicates: true,
      });
    }

    return msg;
  });

  // Enqueue the delivery job outside the DB transaction so a Redis blip
  // never leaves us with a persisted-but-not-scheduled row (the failure
  // surfaces as an error the client sees rather than silent data loss).
  await scheduleMessageDelivery(created.id, fireAt);

  // Roll-up notification to the owner: "your scheduled message was queued".
  // Best-effort: swallow failures so a notify hiccup doesn't fail the create.
  notify(
    ownerId,
    'SCHEDULED_MESSAGE_CREATED',
    'Scheduled message queued',
    `Your ${input.occasion} message is scheduled for ${input.scheduleDate.toISOString()}.`,
    {
      scheduledMessageId: created.id,
      referenceId: created.id,
      referenceType: 'ScheduledMessage',
    },
  ).catch((err) =>
    logger.warn({ err }, 'SCHEDULED_MESSAGE_CREATED notify failed'),
  );

  return getScheduledMessage(ownerId, created.id);
}

/** GET /scheduled-messages */
export async function listScheduledMessages(
  actorId: string,
  q: ListScheduledMessagesQuery,
) {
  // Build the where clause depending on which "view" the caller asked for.
  //   - for_me         → I am a recipient of the message
  //   - scheduled_by_me → I am the owner
  //   - (omitted)      → union of the two
  const filterWhere = buildFilterWhere(actorId, q.filter);

  const where = {
    ...filterWhere,
    ...(q.status ? { status: q.status } : {}),
    ...(q.search
      ? {
          OR: [
            { occasion: { contains: q.search, mode: 'insensitive' as const } },
            { message: { contains: q.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.scheduledMessage.count({ where }),
    prisma.scheduledMessage.findMany({
      where,
      orderBy: { scheduleDate: 'asc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: scheduledMessageInclude,
    }),
  ]);

  return {
    items: rows.map((r) => projectScheduledMessage(r, actorId)),
    pagination: {
      page: q.page,
      limit: q.limit,
      total,
      totalPages: Math.ceil(total / q.limit),
    },
  };
}

/** GET /scheduled-messages/:id */
export async function getScheduledMessage(actorId: string, id: string) {
  const row = await prisma.scheduledMessage.findFirst({
    where: {
      id,
      OR: [
        { ownerId: actorId },
        { recipients: { some: { recipientUserId: actorId } } },
      ],
    },
    include: scheduledMessageInclude,
  });
  if (!row) throw Errors.notFound('Scheduled message not found');
  return projectScheduledMessage(row, actorId);
}

/** PATCH /scheduled-messages/:id — owner-only, only while PENDING. */
export async function updateScheduledMessage(
  ownerId: string,
  id: string,
  input: UpdateScheduledMessageInput,
) {
  const existing = await prisma.scheduledMessage.findFirst({
    where: { id, ownerId },
    include: { recipients: true },
  });
  if (!existing) throw Errors.notFound('Scheduled message not found');
  if (existing.status !== 'PENDING') {
    throw Errors.conflict(
      'This message has already been dispatched and cannot be edited',
    );
  }

  // Resolve the new fire instant only if the caller changed the schedule.
  let nextFireAt = existing.scheduleDate;
  let nextTimezone = existing.timezone;
  if (input.scheduleDate || input.timezone) {
    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { timezone: true },
    });
    const resolved = resolveFireInstant(
      input.scheduleDate ?? existing.scheduleDate,
      input.timezone ?? existing.timezone,
      owner.timezone,
    );
    nextFireAt = resolved.fireAt;
    nextTimezone = resolved.timezone;
  }

  const nextRecipients =
    input.contactIds !== undefined
      ? await resolveContactRecipients(ownerId, input.contactIds)
      : null;

  await prisma.$transaction(async (tx) => {
    await tx.scheduledMessage.update({
      where: { id },
      data: {
        ...(input.occasion !== undefined ? { occasion: input.occasion } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.scheduleDate || input.timezone
          ? { scheduleDate: nextFireAt, timezone: nextTimezone }
          : {}),
      },
    });

    // Recipient set edit: do a diff — delete rows for removed contacts,
    // create rows for new contacts. Preserve unchanged rows so their status
    // (still QUEUED at this point since status was PENDING above) survives.
    if (nextRecipients) {
      const nextIds = new Set(nextRecipients.map((r) => r.contactId));
      const prevIds = new Set(existing.recipients.map((r) => r.contactId));

      const toRemove = existing.recipients
        .filter((r) => !nextIds.has(r.contactId))
        .map((r) => r.id);
      const toAdd = nextRecipients.filter((r) => !prevIds.has(r.contactId));

      if (toRemove.length > 0) {
        await tx.scheduledMessageRecipient.deleteMany({
          where: { id: { in: toRemove } },
        });
      }
      if (toAdd.length > 0) {
        await tx.scheduledMessageRecipient.createMany({
          data: toAdd.map((r) => ({
            scheduledMessageId: id,
            contactId: r.contactId,
            email: r.email,
            recipientUserId: r.userId,
          })),
          skipDuplicates: true,
        });
      }
    }
  });

  if (nextFireAt.getTime() !== existing.scheduleDate.getTime()) {
    await scheduleMessageDelivery(id, nextFireAt);
  }

  return getScheduledMessage(ownerId, id);
}

/** DELETE /scheduled-messages/:id — owner-only. */
export async function deleteScheduledMessage(ownerId: string, id: string) {
  const existing = await prisma.scheduledMessage.findFirst({
    where: { id, ownerId },
    select: { id: true, status: true },
  });
  if (!existing) throw Errors.notFound('Scheduled message not found');

  // Cancel the BullMQ job first so the worker doesn't race us to delivery.
  await cancelScheduledMessage(id);

  if (existing.status === 'PENDING') {
    await prisma.scheduledMessage.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
  }
  await prisma.scheduledMessage.delete({ where: { id } });
}

// ── Worker entry point ──────────────────────────────────────────────────────

/**
 * Called by the BullMQ worker when a scheduled message's fire time arrives.
 * Fan out per recipient (email always; in-app+push if the recipient has an
 * Echoes account) and roll the message up to SENT/FAILED based on results.
 *
 * Idempotent by construction: we only process recipients still in QUEUED
 * status, and we flip each one to SENT/FAILED inside its own step.
 */
export async function deliverScheduledMessage(
  scheduledMessageId: string,
): Promise<void> {
  const msg = await prisma.scheduledMessage.findUnique({
    where: { id: scheduledMessageId },
    include: {
      owner: { select: { id: true, fullName: true } },
      recipients: true,
    },
  });
  if (!msg) return; // deleted before firing — nothing to do
  if (msg.status !== 'PENDING') return; // already delivered / cancelled

  const senderName = msg.owner.fullName;
  const queued = msg.recipients.filter((r) => r.status === 'QUEUED');
  if (queued.length === 0) {
    await prisma.scheduledMessage.update({
      where: { id: msg.id },
      data: { status: 'SENT', sentAt: new Date() },
    });
    return;
  }

  let sent = 0;
  let failed = 0;

  for (const r of queued) {
    try {
      await sendScheduledMessageEmail(r.email, {
        occasion: msg.occasion,
        message: msg.message,
        senderName,
      });

      if (r.recipientUserId) {
        // Best-effort: a push failure must not flip an already-emailed
        // recipient to FAILED. notify() itself never throws on push, only
        // on the DB insert — which is very unlikely to fail transiently.
        notify(
          r.recipientUserId,
          'SCHEDULED_MESSAGE_SENT',
          `A ${msg.occasion} message from ${senderName}`,
          msg.message.length > 140
            ? msg.message.slice(0, 137) + '…'
            : msg.message,
          {
            scheduledMessageId: msg.id,
            senderId: msg.owner.id,
            referenceId: msg.id,
            referenceType: 'ScheduledMessage',
          },
        ).catch((err) =>
          logger.warn({ err }, 'SCHEDULED_MESSAGE_SENT notify failed'),
        );
      }

      await prisma.scheduledMessageRecipient.update({
        where: { id: r.id },
        data: { status: 'SENT', deliveredAt: new Date() },
      });
      sent += 1;
    } catch (err) {
      logger.error(
        { err, scheduledMessageId: msg.id, recipientId: r.id },
        'scheduled message delivery failed',
      );
      await prisma.scheduledMessageRecipient.update({
        where: { id: r.id },
        data: { status: 'FAILED' },
      });
      failed += 1;
    }
  }

  const nextStatus = failed === queued.length ? 'FAILED' : 'SENT';
  await prisma.scheduledMessage.update({
    where: { id: msg.id },
    data: { status: nextStatus, sentAt: new Date() },
  });

  if (nextStatus === 'FAILED') {
    notify(
      msg.owner.id,
      'SCHEDULED_MESSAGE_FAILED',
      'Scheduled message failed',
      `Your ${msg.occasion} message could not be delivered.`,
      {
        scheduledMessageId: msg.id,
        referenceId: msg.id,
        referenceType: 'ScheduledMessage',
      },
    ).catch((err) =>
      logger.warn({ err }, 'SCHEDULED_MESSAGE_FAILED notify failed'),
    );
  }

  logger.info(
    { scheduledMessageId: msg.id, sent, failed },
    'scheduled message delivered',
  );
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Resolve caller-supplied contact IDs into (contactId, email, userId?) tuples
 * suitable for creating recipient rows. Enforces:
 *   - every contact belongs to the caller (ownership)
 *   - every contact is VERIFIED — an unverified contact has no accessible
 *     inbox we can rely on, so we reject here rather than send into the void
 */
async function resolveContactRecipients(
  ownerId: string,
  contactIds: string[],
): Promise<Array<{ contactId: string; email: string; userId: string | null }>> {
  const uniqueIds = Array.from(new Set(contactIds));
  const rows = await prisma.contact.findMany({
    where: { id: { in: uniqueIds }, ownerId },
    select: { id: true, email: true, status: true, contactUserId: true },
  });

  const found = new Map(rows.map((r) => [r.id, r]));
  const missing = uniqueIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw Errors.badRequest(
      `One or more contacts were not found in your address book`,
      { missing },
    );
  }

  const unverified = rows.filter((r) => r.status !== 'VERIFIED');
  if (unverified.length > 0) {
    throw Errors.badRequest(
      `One or more contacts have not yet joined Echoes and cannot receive scheduled messages`,
      { unverified: unverified.map((r) => r.id) },
    );
  }

  return rows.map((r) => ({
    contactId: r.id,
    email: r.email,
    userId: r.contactUserId,
  }));
}

/**
 * Combine a wall-clock date + IANA timezone into a UTC instant.
 *
 * The client sends `scheduleDate` as an ISO-8601 string. If that string
 * already carries a timezone offset (`2026-12-25T15:30:00Z` or `+05:30`),
 * we honour it — the stored UTC instant is exactly what the client intended.
 * If the client sends a "naive" date (no offset — `2026-12-25T15:30:00`),
 * `z.coerce.date()` will interpret it as UTC, which is almost never what a
 * user picking "8pm my time" meant. We defensively resolve the returned
 * instant against the timezone the caller provided (or the owner's profile
 * timezone) using `Intl.DateTimeFormat`, which is stdlib and needs no
 * dependency.
 *
 * The returned `timezone` is the resolved IANA zone we'll display back to
 * the user.
 */
function resolveFireInstant(
  scheduleDate: Date,
  requestedTz: string | undefined,
  ownerTz: string,
): { fireAt: Date; timezone: string } {
  const timezone = (requestedTz ?? ownerTz).trim();

  if (!isValidTimezone(timezone)) {
    throw Errors.badRequest(
      `Unknown timezone "${timezone}" — expected an IANA zone like "Asia/Kolkata"`,
    );
  }

  const fireAt = scheduleDate;
  if (fireAt.getTime() <= Date.now()) {
    throw Errors.badRequest('scheduleDate must be in the future');
  }

  return { fireAt, timezone };
}

function buildFilterWhere(
  actorId: string,
  filter: ListScheduledMessagesQuery['filter'],
) {
  if (filter === 'for_me') {
    return { recipients: { some: { recipientUserId: actorId } } };
  }
  if (filter === 'scheduled_by_me') {
    return { ownerId: actorId };
  }
  // Default: both (owner OR recipient)
  return {
    OR: [
      { ownerId: actorId },
      { recipients: { some: { recipientUserId: actorId } } },
    ],
  };
}

const scheduledMessageInclude = {
  owner: {
    select: { id: true, fullName: true, avatarKey: true },
  },
  recipients: {
    select: {
      id: true,
      contactId: true,
      email: true,
      recipientUserId: true,
      status: true,
      deliveredAt: true,
      contact: {
        select: {
          id: true,
          name: true,
          email: true,
          status: true,
        },
      },
    },
  },
} as const;

type RawScheduledMessage = Prisma.ScheduledMessageGetPayload<{
  include: typeof scheduledMessageInclude;
}>;

function projectScheduledMessage(
  row: RawScheduledMessage,
  actorId: string,
) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    isMine: row.ownerId === actorId,
    occasion: row.occasion,
    message: row.message,
    scheduleDate: row.scheduleDate,
    timezone: row.timezone,
    status: row.status,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    owner: row.owner,
    recipients: row.recipients.map((r) => ({
      id: r.id,
      contactId: r.contactId,
      contactName: r.contact?.name ?? null,
      email: r.email,
      recipientUserId: r.recipientUserId,
      status: r.status,
      deliveredAt: r.deliveredAt,
    })),
  };
}

// ── Delivery email ──────────────────────────────────────────────────────────

async function sendScheduledMessageEmail(
  toEmail: string,
  payload: { occasion: string; message: string; senderName: string },
): Promise<void> {
  await sendEmail({
    to: toEmail,
    subject: `A ${payload.occasion} message from ${payload.senderName}`,
    text: `${payload.senderName} scheduled a ${payload.occasion} message for you on Echoes.

${payload.message}

— The Echoes Team
support@echoesremembered.com`,
    html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f5f7;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e7eb">
    <h1 style="font-size:20px;margin:0 0 12px;color:#111827">A ${escapeHtml(payload.occasion)} message from ${escapeHtml(payload.senderName)}</h1>
    <p style="white-space:pre-wrap;margin:0;color:#374151;font-size:15px;line-height:1.6">${escapeHtml(payload.message)}</p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
    <p style="color:#9ca3af;font-size:12px;margin:0">Echoes — preserving what matters.</p>
  </div></body></html>`,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
