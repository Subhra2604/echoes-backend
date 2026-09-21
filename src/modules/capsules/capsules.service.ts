import { prisma } from '../../lib/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import {
  notify,
  sendCapsuleEmail,
  sendCapsuleReturnedToGuardian,
} from '../notifications/notifications.service.js';
import {
  scheduleOneOff,
  scheduleRecurringAnnual,
  cancelSchedule,
} from './capsules.scheduler.js';
import type {
  CreateCapsuleInput,
  UpdateCapsuleInput,
  UpdateCapsuleScheduleInput,
  AddCapsuleContactsInput,
  SetCapsuleGuardianInput,
} from './capsules.dto.js';

/**
 * Time Capsule service.
 *
 * Recipient model — a capsule now supports TWO paths at once, so existing
 * clients keep working while newer clients use the contact-based flow:
 *
 *   1. Contact-based multi-recipient (preferred, spec §15)
 *        CapsuleRecipient rows link the capsule to one-or-more VERIFIED
 *        Contacts of the owner. Delivery creates one CapsuleDelivery row per
 *        (capsule, recipient, occurrenceYear) with a DB-level unique index so
 *        the release is idempotent even if the BullMQ worker fires twice.
 *
 *   2. Legacy single-recipient (kept)
 *        `recipientEmail` (+ optional `recipientUserId`) on the TimeCapsule
 *        row itself. Delivery still writes a CapsuleDelivery whose
 *        `capsuleRecipientId` is null; the historical service-layer
 *        idempotency guard (`already && already.status !== 'BOUNCED'`)
 *        is preserved for that path.
 *
 * Permissions:
 *   - Owner (while alive): full edit + delete
 *   - Guardian (contact-based, spec §14): can PATCH the schedule ONLY
 *     (scheduleDate / releaseAt / timezone / recurMonth / recurDay). Any
 *     other field on that endpoint is rejected at the DTO layer.
 *   - Guardian (legacy invitation-based, memorial-mode active, spec §3):
 *     can trigger a GUARDIAN_CONTROLLED release. Unchanged.
 */

// ── Create ──────────────────────────────────────────────────────────────────

export async function createCapsule(ownerId: string, input: CreateCapsuleInput) {
  const owner = await prisma.user.findUniqueOrThrow({
    where: { id: ownerId },
    select: { id: true, fullName: true, timezone: true },
  });

  // Validate the attached media (belongs to the owner + within 60s cap).
  if (input.mediaItemId) {
    await assertOwnedMedia(ownerId, input.mediaItemId);
  }

  // Resolve recipients — both paths supported.
  const contactRecipients =
    input.contactIds && input.contactIds.length > 0
      ? await resolveContactRecipients(ownerId, input.contactIds)
      : [];

  // Optional guardian must belong to the caller.
  if (input.guardianId) {
    await assertOwnedGuardian(ownerId, input.guardianId);
  }

  const guardianControlled = input.releaseType === 'GUARDIAN_CONTROLLED';
  const status = guardianControlled ? 'PENDING_GUARDIAN_RELEASE' : 'SCHEDULED';

  const scheduleTimezone = (input.timezone ?? owner.timezone).trim();
  assertValidTimezone(scheduleTimezone);

  const fireAt = input.releaseAt ?? input.scheduleDate ?? null;
  const body = input.message ?? input.note ?? null;

  const capsule = await prisma.$transaction(async (tx) => {
    const c = await tx.timeCapsule.create({
      data: {
        ownerId,
        title: input.title,
        message: body,
        mediaItemId: input.mediaItemId ?? null,
        // Legacy fields — populated only if the caller supplied them.
        recipientEmail: input.recipientEmail ?? null,
        recipientUserId: input.recipientUserId ?? null,
        // New contact-based guardian
        guardianId: input.guardianId ?? null,

        releaseType: input.releaseType,
        scheduleTimezone,
        releaseAt: fireAt,
        recurMonth: input.recurMonth ?? null,
        recurDay: input.recurDay ?? null,
        recurring: input.releaseType === 'RECURRING_ANNUAL',
        guardianControlled,
        status,
      },
    });

    if (contactRecipients.length > 0) {
      await tx.capsuleRecipient.createMany({
        data: contactRecipients.map((r) => ({
          capsuleId: c.id,
          contactId: r.contactId,
          email: r.email,
        })),
        skipDuplicates: true,
      });
    }

    return c;
  });

  // BullMQ scheduling outside the DB transaction — a Redis blip must not
  // leave a persisted row silently un-scheduled.
  if (input.releaseType === 'SCHEDULED_DATE' && fireAt) {
    await scheduleOneOff(capsule.id, fireAt);
  } else if (input.releaseType === 'RECURRING_ANNUAL') {
    await scheduleRecurringAnnual(
      capsule.id,
      input.recurMonth!,
      input.recurDay!,
      scheduleTimezone,
    );
  }
  // GUARDIAN_CONTROLLED capsules are triggered by the guardian directly.

  // GUARDIAN_ASSIGNED notification — the guardian should learn about a new
  // capsule they're now responsible for. Best-effort.
  if (input.guardianId) {
    fireGuardianAssignedNotification(capsule.id, input.guardianId, input.title)
      .catch((err) =>
        logger.warn({ err }, 'GUARDIAN_ASSIGNED (capsule) notify failed'),
      );
  }

  return getCapsule(ownerId, capsule.id);
}

// ── List ────────────────────────────────────────────────────────────────────

export async function listCapsules(ownerId: string) {
  const rows = await prisma.timeCapsule.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
    include: capsuleInclude,
  });
  return rows.map(projectCapsule);
}

export async function getCapsule(ownerId: string, capsuleId: string) {
  const c = await prisma.timeCapsule.findFirst({
    where: { id: capsuleId, ownerId },
    include: capsuleInclude,
  });
  if (!c) throw Errors.notFound('Capsule not found');
  return projectCapsule(c);
}

// ── Update (owner) ──────────────────────────────────────────────────────────

/**
 * Owner update — anything metadata-shaped, while the owner is still alive
 * and the capsule is not yet RELEASED. Guardian updates go through
 * `updateCapsuleSchedule` (schedule-only, spec §14).
 */
export async function updateCapsule(
  ownerId: string,
  capsuleId: string,
  patch: UpdateCapsuleInput,
) {
  const capsule = await assertOwnerCanModify(ownerId, capsuleId);

  // Validate any referenced media / guardian / contacts before touching DB.
  if (patch.mediaItemId) await assertOwnedMedia(ownerId, patch.mediaItemId);
  if (patch.guardianId) await assertOwnedGuardian(ownerId, patch.guardianId);
  const nextContactRecipients =
    patch.contactIds !== undefined
      ? await resolveContactRecipients(ownerId, patch.contactIds)
      : null;

  const scheduleChanged =
    patch.releaseAt !== undefined ||
    patch.scheduleDate !== undefined ||
    patch.timezone !== undefined ||
    patch.recurMonth !== undefined ||
    patch.recurDay !== undefined;

  if (patch.timezone) assertValidTimezone(patch.timezone);

  const body = patch.message ?? patch.note;
  const guardianPatchIsClear = patch.guardianId === null;

  await prisma.$transaction(async (tx) => {
    await tx.timeCapsule.update({
      where: { id: capsuleId },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(body !== undefined ? { message: body } : {}),
        ...(patch.mediaItemId !== undefined
          ? { mediaItemId: patch.mediaItemId }
          : {}),
        ...(patch.recipientEmail !== undefined
          ? { recipientEmail: patch.recipientEmail }
          : {}),
        ...(patch.guardianId !== undefined
          ? { guardianId: guardianPatchIsClear ? null : patch.guardianId }
          : {}),
        ...(patch.timezone ? { scheduleTimezone: patch.timezone } : {}),
        ...(patch.releaseAt !== undefined ? { releaseAt: patch.releaseAt } : {}),
        ...(patch.scheduleDate !== undefined
          ? { releaseAt: patch.scheduleDate }
          : {}),
        ...(patch.recurMonth !== undefined
          ? { recurMonth: patch.recurMonth }
          : {}),
        ...(patch.recurDay !== undefined ? { recurDay: patch.recurDay } : {}),
      },
    });

    if (nextContactRecipients !== null) {
      await replaceCapsuleRecipients(tx, capsuleId, nextContactRecipients);
    }
  });

  // Reschedule if timing changed.
  if (scheduleChanged) {
    await cancelSchedule(capsuleId);
    const c = await prisma.timeCapsule.findUniqueOrThrow({
      where: { id: capsuleId },
    });
    if (c.releaseType === 'SCHEDULED_DATE' && c.releaseAt) {
      await scheduleOneOff(capsuleId, c.releaseAt);
    } else if (c.releaseType === 'RECURRING_ANNUAL' && c.recurMonth && c.recurDay) {
      await scheduleRecurringAnnual(
        capsuleId,
        c.recurMonth,
        c.recurDay,
        c.scheduleTimezone,
      );
    }
  }

  // If the schedule moved AND a guardian is attached, tell them.
  if (scheduleChanged && capsule.guardianId) {
    fireGuardianScheduleChangedNotification(capsuleId, capsule.guardianId, capsule.title)
      .catch((err) =>
        logger.warn({ err }, 'CAPSULE_SCHEDULE_CHANGED (owner) notify failed'),
      );
  }

  // If the guardian actually changed, ping the new guardian.
  if (patch.guardianId && patch.guardianId !== capsule.guardianId) {
    fireGuardianAssignedNotification(capsuleId, patch.guardianId, capsule.title)
      .catch((err) =>
        logger.warn({ err }, 'GUARDIAN_ASSIGNED (capsule update) notify failed'),
      );
  }

  return getCapsule(ownerId, capsuleId);
}

// ── Update (guardian) — spec §14 schedule-only ──────────────────────────────

/**
 * Guardian schedule-only PATCH.
 *
 * Enforces spec §14: the guardian can move the schedule (or update the
 * recurrence), and nothing else. Any other field arrives through
 * `updateCapsuleSchedule` at the DTO layer, which does not accept them.
 *
 * Requires: the caller's user account matches the underlying
 * Contact.contactUserId of the capsule's assigned Guardian.
 */
export async function updateCapsuleScheduleByGuardian(
  guardianUserId: string,
  capsuleId: string,
  patch: UpdateCapsuleScheduleInput,
) {
  const capsule = await prisma.timeCapsule.findUnique({
    where: { id: capsuleId },
    include: {
      guardian: {
        include: {
          contact: { select: { contactUserId: true } },
        },
      },
    },
  });
  if (!capsule) throw Errors.notFound('Capsule not found');

  const contactUserId = capsule.guardian?.contact?.contactUserId;
  if (!contactUserId || contactUserId !== guardianUserId) {
    throw Errors.forbidden(
      'Only the assigned guardian of this capsule may edit its schedule',
    );
  }
  if (capsule.status === 'RELEASED') {
    throw Errors.conflict('A released capsule cannot be rescheduled');
  }

  if (patch.timezone) assertValidTimezone(patch.timezone);
  const nextTimezone = patch.timezone ?? capsule.scheduleTimezone;
  const nextFireAt = patch.releaseAt ?? patch.scheduleDate ?? capsule.releaseAt;

  await prisma.timeCapsule.update({
    where: { id: capsuleId },
    data: {
      scheduleTimezone: nextTimezone,
      releaseAt: nextFireAt,
      recurMonth: patch.recurMonth ?? capsule.recurMonth,
      recurDay: patch.recurDay ?? capsule.recurDay,
    },
  });

  // Reschedule the BullMQ job on the new instant / recurrence.
  await cancelSchedule(capsuleId);
  const refreshed = await prisma.timeCapsule.findUniqueOrThrow({
    where: { id: capsuleId },
  });
  if (refreshed.releaseType === 'SCHEDULED_DATE' && refreshed.releaseAt) {
    await scheduleOneOff(capsuleId, refreshed.releaseAt);
  } else if (
    refreshed.releaseType === 'RECURRING_ANNUAL' &&
    refreshed.recurMonth &&
    refreshed.recurDay
  ) {
    await scheduleRecurringAnnual(
      capsuleId,
      refreshed.recurMonth,
      refreshed.recurDay,
      refreshed.scheduleTimezone,
    );
  }

  // Notify the owner so they know their guardian moved the schedule.
  notify(
    capsule.ownerId,
    'CAPSULE_SCHEDULE_CHANGED',
    'Capsule schedule updated by guardian',
    `The guardian of "${capsule.title}" has updated its release schedule.`,
    {
      capsuleId,
      referenceId: capsuleId,
      referenceType: 'TimeCapsule',
    },
  ).catch((err) =>
    logger.warn({ err }, 'CAPSULE_SCHEDULE_CHANGED (owner) notify failed'),
  );

  return getCapsuleForGuardian(guardianUserId, capsuleId);
}

/**
 * Small read-model helper used by the guardian PATCH — restricts the
 * projected fields to what a guardian is allowed to see (schedule + status),
 * NOT the message body or the attached media (spec §14).
 */
async function getCapsuleForGuardian(
  guardianUserId: string,
  capsuleId: string,
) {
  const c = await prisma.timeCapsule.findFirst({
    where: {
      id: capsuleId,
      guardian: { contact: { contactUserId: guardianUserId } },
    },
    select: {
      id: true,
      title: true,
      status: true,
      releaseType: true,
      releaseAt: true,
      recurMonth: true,
      recurDay: true,
      scheduleTimezone: true,
      owner: {
        select: { id: true, fullName: true, avatarKey: true, isDeceased: true },
      },
    },
  });
  if (!c) throw Errors.notFound('Capsule not found');
  return c;
}

// ── Add / remove recipients + change guardian ───────────────────────────────

export async function listCapsuleContacts(
  ownerId: string,
  capsuleId: string,
) {
  await assertOwnerCanRead(ownerId, capsuleId);
  const rows = await prisma.capsuleRecipient.findMany({
    where: { capsuleId },
    include: {
      contact: {
        select: { id: true, name: true, email: true, status: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    email: r.email,
    contact: r.contact,
    createdAt: r.createdAt,
  }));
}

export async function addCapsuleContacts(
  ownerId: string,
  capsuleId: string,
  input: AddCapsuleContactsInput,
) {
  await assertOwnerCanModify(ownerId, capsuleId);
  const resolved = await resolveContactRecipients(ownerId, input.contactIds);
  await prisma.capsuleRecipient.createMany({
    data: resolved.map((r) => ({
      capsuleId,
      contactId: r.contactId,
      email: r.email,
    })),
    skipDuplicates: true,
  });
  return listCapsuleContacts(ownerId, capsuleId);
}

export async function removeCapsuleContact(
  ownerId: string,
  capsuleId: string,
  contactId: string,
) {
  await assertOwnerCanModify(ownerId, capsuleId);
  await prisma.capsuleRecipient.deleteMany({
    where: { capsuleId, contactId },
  });
}

export async function setCapsuleGuardian(
  ownerId: string,
  capsuleId: string,
  input: SetCapsuleGuardianInput,
) {
  const capsule = await assertOwnerCanModify(ownerId, capsuleId);
  if (input.guardianId) await assertOwnedGuardian(ownerId, input.guardianId);

  await prisma.timeCapsule.update({
    where: { id: capsuleId },
    data: { guardianId: input.guardianId },
  });

  if (input.guardianId && input.guardianId !== capsule.guardianId) {
    fireGuardianAssignedNotification(capsuleId, input.guardianId, capsule.title)
      .catch((err) =>
        logger.warn({ err }, 'GUARDIAN_ASSIGNED (setCapsuleGuardian) failed'),
      );
  }

  return getCapsule(ownerId, capsuleId);
}

// ── Delete (owner) ──────────────────────────────────────────────────────────

export async function deleteCapsule(ownerId: string, capsuleId: string) {
  await assertOwnerCanModify(ownerId, capsuleId);
  await cancelSchedule(capsuleId);
  await prisma.timeCapsule.delete({ where: { id: capsuleId } });
}

// ── Guardian-controlled manual release (legacy path, unchanged behavior) ────

export async function guardianRelease(
  ownerId: string,
  guardianUserId: string,
  capsuleId: string,
) {
  const isActive = await prisma.guardianInvitation.findFirst({
    where: {
      ownerId,
      guardianId: guardianUserId,
      status: 'ACCEPTED',
      owner: { isDeceased: true },
    },
  });
  if (!isActive) {
    throw Errors.forbidden('You are not an active guardian for this account');
  }

  const capsule = await prisma.timeCapsule.findFirst({
    where: { id: capsuleId, ownerId, guardianControlled: true },
  });
  if (!capsule) throw Errors.notFound('Guardian-controlled capsule not found');
  if (capsule.status === 'RELEASED') throw Errors.conflict('Already released');

  await executeRelease(capsuleId);
  return { status: 'RELEASED' as const };
}

// ── Core release routine (worker + guardianRelease) ────────────────────────

/**
 * Deliver a capsule. Prefers the multi-recipient (CapsuleRecipient) path
 * when at least one CapsuleRecipient exists; falls back to the legacy
 * single-recipient shape otherwise.
 *
 * Idempotent per (capsule, recipient, occurrenceYear) via the DB unique
 * index on CapsuleDelivery (created by the accompanying migration).
 */
export async function executeRelease(capsuleId: string): Promise<void> {
  const capsule = await prisma.timeCapsule.findUnique({
    where: { id: capsuleId },
    include: {
      recipients: { include: { contact: true } },
    },
  });
  if (!capsule) return;

  const occurrenceYear = new Date().getUTCFullYear();

  if (capsule.recipients.length > 0) {
    await releaseMultiRecipient(capsule, occurrenceYear);
  } else {
    await releaseLegacySingleRecipient(capsule, occurrenceYear);
  }
}

async function releaseMultiRecipient(
  capsule: Prisma.TimeCapsuleGetPayload<{
    include: { recipients: { include: { contact: true } } };
  }>,
  occurrenceYear: number,
) {
  const hasAccount = new Map<string, string | null>(); // contactId → userId
  for (const r of capsule.recipients) {
    hasAccount.set(r.contactId, r.contact.contactUserId);
  }

  // De-dup notification targets — a user could be represented by two
  // separate Contact rows for the same email (unlikely but possible after
  // account merges). We keep one notify per userId.
  const notifiedUserIds = new Set<string>();

  for (const r of capsule.recipients) {
    // Idempotency: the DB unique index (capsuleId, capsuleRecipientId,
    // occurrenceYear) will reject a duplicate insert. We race the insert and
    // treat a P2002 as "already delivered — nothing to do".
    try {
      const delivery = await prisma.capsuleDelivery.create({
        data: {
          capsuleId: capsule.id,
          capsuleRecipientId: r.id,
          channel: 'EMAIL',
          toEmail: r.email,
          occurrenceYear,
          status: 'QUEUED',
        },
      });

      try {
        await sendCapsuleEmail(r.email, {
          title: capsule.title,
          message: capsule.message,
          hasAccount: Boolean(r.contact.contactUserId),
        });
        await prisma.capsuleDelivery.update({
          where: { id: delivery.id },
          data: { status: 'SENT', sentAt: new Date() },
        });

        // In-app + push if the recipient has an Echoes account.
        const userId = r.contact.contactUserId;
        if (userId && !notifiedUserIds.has(userId)) {
          notifiedUserIds.add(userId);
          notify(
            userId,
            'CAPSULE_RELEASED',
            'Your Time Capsule Is Ready',
            `A time capsule "${capsule.title}" has been released and is now available to you.`,
            {
              capsuleId: capsule.id,
              referenceId: capsule.id,
              referenceType: 'TimeCapsule',
            },
          ).catch((err) =>
            logger.warn({ err }, 'CAPSULE_RELEASED notify failed'),
          );
        }
      } catch {
        await markBouncedAndReturn(capsule.id, delivery.id);
      }
    } catch (err: unknown) {
      // Prisma unique-constraint (P2002) = already delivered — skip.
      const code = (err as { code?: string })?.code;
      if (code !== 'P2002') throw err;
    }
  }

  // Flip capsule status to RELEASED for non-recurring capsules.
  if (!capsule.recurring) {
    await prisma.timeCapsule.updateMany({
      where: { id: capsule.id, status: { not: 'RELEASED' } },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
  }
}

async function releaseLegacySingleRecipient(
  capsule: Prisma.TimeCapsuleGetPayload<{
    include: { recipients: { include: { contact: true } } };
  }>,
  occurrenceYear: number,
) {
  if (!capsule.recipientEmail) {
    logger.warn(
      { capsuleId: capsule.id },
      'legacy capsule has no recipient email — cannot deliver',
    );
    return;
  }
  const already = await prisma.capsuleDelivery.findFirst({
    where: {
      capsuleId: capsule.id,
      capsuleRecipientId: null,
      occurrenceYear,
    },
  });
  if (already && already.status !== 'BOUNCED') return;

  const delivery = await prisma.capsuleDelivery.create({
    data: {
      capsuleId: capsule.id,
      channel: 'EMAIL',
      toEmail: capsule.recipientEmail,
      occurrenceYear,
      status: 'QUEUED',
    },
  });

  try {
    await sendCapsuleEmail(capsule.recipientEmail, {
      title: capsule.title,
      message: capsule.message,
      hasAccount: Boolean(capsule.recipientUserId),
    });
    await prisma.capsuleDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SENT', sentAt: new Date() },
    });

    if (!capsule.recurring) {
      await prisma.timeCapsule.update({
        where: { id: capsule.id },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
    }
    if (capsule.recipientUserId) {
      notify(
        capsule.recipientUserId,
        'CAPSULE_RELEASED',
        'Your Time Capsule Is Ready',
        `A time capsule "${capsule.title}" has been released and is now available to you.`,
        {
          capsuleId: capsule.id,
          referenceId: capsule.id,
          referenceType: 'TimeCapsule',
        },
      ).catch((err) =>
        logger.warn({ err }, 'CAPSULE_RELEASED notify failed'),
      );
    }
  } catch {
    await markBouncedAndReturn(capsule.id, delivery.id);
  }
}

/** Bounce handling for the legacy invitation-guardian fallback path. */
export async function markBouncedAndReturn(
  capsuleId: string,
  deliveryId: string,
): Promise<void> {
  const capsule = await prisma.timeCapsule.findUniqueOrThrow({
    where: { id: capsuleId },
  });
  const primaryGuardian = await prisma.guardianInvitation.findFirst({
    where: { ownerId: capsule.ownerId, status: 'ACCEPTED' },
    orderBy: [{ isPrimary: 'desc' }, { priority: 'asc' }],
  });
  const delivery = await prisma.capsuleDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
  });
  await prisma.capsuleDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'RETURNED_TO_GUARDIAN',
      bouncedAt: new Date(),
      returnedToGuardianId: primaryGuardian?.guardianId ?? null,
    },
  });
  if (primaryGuardian?.guardianId) {
    notify(
      primaryGuardian.guardianId,
      'CAPSULE_BOUNCED_RETURNED',
      'A capsule could not be delivered',
      `Delivery of "${capsule.title}" to ${delivery.toEmail} bounced and has been returned to you.`,
    ).catch((err) => logger.warn({ err }, 'bounce notify failed'));
    sendCapsuleReturnedToGuardian(
      primaryGuardian.guardianEmail,
      capsule.title,
      delivery.toEmail,
    ).catch((err) => logger.warn({ err }, 'bounce email failed'));
  }
}

// ── Assertion helpers ──────────────────────────────────────────────────────

async function assertOwnerCanRead(ownerId: string, capsuleId: string) {
  const c = await prisma.timeCapsule.findFirst({
    where: { id: capsuleId, ownerId },
  });
  if (!c) throw Errors.notFound('Capsule not found');
  return c;
}

async function assertOwnerCanModify(ownerId: string, capsuleId: string) {
  const c = await assertOwnerCanRead(ownerId, capsuleId);
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
  if (owner.isDeceased) {
    throw Errors.forbidden('Capsules can no longer be edited or deleted');
  }
  if (c.status === 'RELEASED') {
    throw Errors.conflict('A released capsule cannot be edited');
  }
  return c;
}

async function assertOwnedMedia(ownerId: string, mediaItemId: string) {
  const item = await prisma.vaultItem.findFirst({
    where: { id: mediaItemId, vault: { userId: ownerId } },
  });
  if (!item) throw Errors.badRequest('Media item not found in your vault');
  if (
    (item.type === 'VIDEO' || item.type === 'AUDIO') &&
    (item.durationSec ?? 0) > 60
  ) {
    throw Errors.badRequest(
      'Capsule video/audio messages are limited to 60 seconds',
    );
  }
}

async function assertOwnedGuardian(ownerId: string, guardianId: string) {
  const g = await prisma.guardian.findFirst({
    where: { id: guardianId, ownerId },
    select: { id: true },
  });
  if (!g) throw Errors.badRequest('Guardian not found in your guardians list');
}

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
      'One or more contacts were not found in your address book',
      { missing },
    );
  }
  const unverified = rows.filter((r) => r.status !== 'VERIFIED');
  if (unverified.length > 0) {
    throw Errors.badRequest(
      'One or more contacts have not yet joined Echoes — invite them first',
      { unverified: unverified.map((r) => r.id) },
    );
  }
  return rows.map((r) => ({
    contactId: r.id,
    email: r.email,
    userId: r.contactUserId,
  }));
}

async function replaceCapsuleRecipients(
  tx: Prisma.TransactionClient,
  capsuleId: string,
  next: Array<{ contactId: string; email: string; userId: string | null }>,
) {
  const existing = await tx.capsuleRecipient.findMany({
    where: { capsuleId },
    select: { id: true, contactId: true },
  });
  const nextIds = new Set(next.map((r) => r.contactId));
  const prevIds = new Set(existing.map((r) => r.contactId));

  const toRemove = existing
    .filter((r) => !nextIds.has(r.contactId))
    .map((r) => r.id);
  const toAdd = next.filter((r) => !prevIds.has(r.contactId));

  if (toRemove.length > 0) {
    await tx.capsuleRecipient.deleteMany({ where: { id: { in: toRemove } } });
  }
  if (toAdd.length > 0) {
    await tx.capsuleRecipient.createMany({
      data: toAdd.map((r) => ({
        capsuleId,
        contactId: r.contactId,
        email: r.email,
      })),
      skipDuplicates: true,
    });
  }
}

function assertValidTimezone(tz: string) {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw Errors.badRequest(
      `Unknown timezone "${tz}" — expected an IANA zone like "Asia/Kolkata"`,
    );
  }
}

// ── Notifications ──────────────────────────────────────────────────────────

async function fireGuardianAssignedNotification(
  capsuleId: string,
  guardianId: string,
  capsuleTitle: string,
) {
  const guardian = await prisma.guardian.findUnique({
    where: { id: guardianId },
    include: { contact: { select: { contactUserId: true } } },
  });
  const userId = guardian?.contact?.contactUserId;
  if (!userId) return;
  await notify(
    userId,
    'CAPSULE_ASSIGNED',
    'You have been assigned as the guardian of a time capsule',
    `You are now the guardian of the time capsule "${capsuleTitle}".`,
    {
      capsuleId,
      guardianId,
      referenceId: capsuleId,
      referenceType: 'TimeCapsule',
    },
  );
}

async function fireGuardianScheduleChangedNotification(
  capsuleId: string,
  guardianId: string,
  capsuleTitle: string,
) {
  const guardian = await prisma.guardian.findUnique({
    where: { id: guardianId },
    include: { contact: { select: { contactUserId: true } } },
  });
  const userId = guardian?.contact?.contactUserId;
  if (!userId) return;
  await notify(
    userId,
    'CAPSULE_SCHEDULE_CHANGED',
    'Capsule schedule updated',
    `The schedule of "${capsuleTitle}" has been updated by its owner.`,
    {
      capsuleId,
      guardianId,
      referenceId: capsuleId,
      referenceType: 'TimeCapsule',
    },
  );
}

// ── Read-model helpers ─────────────────────────────────────────────────────

const capsuleInclude = {
  recipients: {
    include: {
      contact: {
        select: { id: true, name: true, email: true, status: true },
      },
    },
  },
  guardian: {
    include: {
      contact: {
        select: {
          id: true,
          name: true,
          email: true,
          contactUserId: true,
        },
      },
    },
  },
  mediaItem: {
    select: {
      id: true,
      type: true,
      title: true,
      s3Key: true,
      mimeType: true,
      durationSec: true,
    },
  },
} as const;

type RawCapsule = Prisma.TimeCapsuleGetPayload<{ include: typeof capsuleInclude }>;

function projectCapsule(c: RawCapsule) {
  return {
    id: c.id,
    ownerId: c.ownerId,
    title: c.title,
    message: c.message,
    note: c.message, // spec §15 alias
    mediaItem: c.mediaItem,
    releaseType: c.releaseType,
    status: c.status,
    scheduleDate: c.releaseAt,
    releaseAt: c.releaseAt,
    scheduleTimezone: c.scheduleTimezone,
    timezone: c.scheduleTimezone,
    recurMonth: c.recurMonth,
    recurDay: c.recurDay,
    recurring: c.recurring,
    guardianControlled: c.guardianControlled,
    releasedAt: c.releasedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    // Legacy fields kept for backwards compatibility.
    recipientEmail: c.recipientEmail,
    recipientUserId: c.recipientUserId,
    // New contact-based recipients + guardian.
    contacts: c.recipients.map((r) => ({
      id: r.id,
      contactId: r.contactId,
      email: r.email,
      name: r.contact.name,
      status: r.contact.status,
    })),
    guardian: c.guardian
      ? {
          id: c.guardian.id,
          contactId: c.guardian.contactId,
          name: c.guardian.contact.name,
          email: c.guardian.contact.email,
          userId: c.guardian.contact.contactUserId,
        }
      : null,
  };
}
