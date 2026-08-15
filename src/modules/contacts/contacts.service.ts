import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import {
  sendContactInvitationEmail,
  notify,
} from '../notifications/notifications.service.js';
import type {
  CheckEmailInput,
  CreateContactInput,
  ListContactsQuery,
} from './contacts.dto.js';
import { deriveUserStatus } from '../users/users.service.js';

/**
 * Contacts service.
 *
 * Mental model:
 *  - Contact rows are OWNER-scoped: the row lives on the address book of the
 *    user who created it. Two users adding the same email get two independent
 *    rows.
 *  - Every row has a mandatory `email`. `contactUserId` is null while the
 *    invitee hasn't joined Echoes yet, and gets filled in either at create
 *    time (invitee already on the platform) or later by
 *    `reconcilePendingContactsOnVerify` when the invitee finishes OTP.
 *  - The only status transitions the service performs are
 *      PENDING_INVITATION -> VERIFIED   (reconcile)
 *      VERIFIED           -> BLOCKED    (future work; enum already present)
 *    Blocking is not implemented yet — the enum is reserved.
 */

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * POST /contacts/check-email — does this email correspond to an Echoes account?
 * Gated behind auth so it isn't a public email-enumeration endpoint.
 */
export async function checkEmailExists(input: CheckEmailInput): Promise<{ exists: boolean }> {
  // Only count ACTIVE users. A soft-deleted row with this email still exists
  // in the DB but should look "available" to the caller — the frontend uses
  // this endpoint to decide whether to send an invitation or link directly.
  const user = await prisma.user.findFirst({
    where: { email: input.email, deletedAt: null },
    select: { id: true },
  });
  return { exists: user !== null };
}

/**
 * POST /contacts — add an email to the caller's address book.
 *
 * Two paths depending on whether the email already belongs to an Echoes user:
 *   - Yes -> create a VERIFIED contact linked to their userId.
 *   - No  -> create a PENDING_INVITATION contact and email an invite.
 *
 * Re-adding the same email upserts on (ownerId, email) — a stale
 * PENDING_INVITATION gets a fresh invite email so the user can prompt a
 * hesitant contact again without accumulating duplicate rows.
 */
export async function createContact(ownerId: string, input: CreateContactInput) {
  const owner = await prisma.user.findUniqueOrThrow({
    where: { id: ownerId },
    select: { email: true, fullName: true },
  });

  if (input.email === owner.email.toLowerCase()) {
    throw Errors.badRequest('You cannot add yourself as a contact');
  }

  // Is the target already an Echoes user?
 const invitee = await prisma.user.findFirst({
  where: { email: input.email, deletedAt: null },
  select: { id: true, fullName: true },
});
const isVerified = invitee !== null;

  // Reject an existing ACTIVE contact for the same email (409). An idle
  // PENDING invite is not "active" — we let the caller trigger a fresh
  // invitation email by re-adding.
  const existing = await prisma.contact.findUnique({
    where: { ownerId_email: { ownerId, email: input.email } },
  });
  if (existing && existing.status === 'VERIFIED') {
    throw Errors.conflict('That email is already in your contact list');
  }

  const displayName =
    input.name?.trim() ||
    invitee?.fullName ||
    input.email.split('@')[0]!;

  const now = new Date();

  const contact = await prisma.contact.upsert({
    where: { ownerId_email: { ownerId, email: input.email } },
    create: {
      ownerId,
      email: input.email,
      contactUserId: isVerified ? invitee!.id : null,
      name: displayName,
      status: isVerified ? 'VERIFIED' : 'PENDING_INVITATION',
      invitationSentAt: isVerified ? null : now,
      joinedAt: isVerified ? now : null,
    },
    update: {
      // Preserve status if the row is already VERIFIED (guarded above); the
      // only reach-here update is PENDING -> PENDING (re-invite refresh).
      name: displayName,
      contactUserId: isVerified ? invitee!.id : null,
      status: isVerified ? 'VERIFIED' : 'PENDING_INVITATION',
      invitationSentAt: isVerified ? null : now,
      joinedAt: isVerified ? now : null,
    },
    select: contactPublicSelect,
  });

  // Fire-and-forget invitation email for pending contacts. We swallow send
  // failures so a transient SendGrid outage doesn't break contact creation —
  // the row still exists; the client can re-add to trigger another send.
  if (!isVerified) {
    const signupUrl = `${env.PUBLIC_APP_URL}/signup?invite_email=${encodeURIComponent(input.email)}`;
    sendContactInvitationEmail(input.email, owner.fullName, signupUrl).catch((err) => {
      logger.warn({ err, email: input.email }, 'contact invitation email failed to send');
    });
  }

  return projectContactRow(contact);
}

/**
 * GET /contacts — the caller's address book.
 *
 * Optional filters:
 *   - `search`   : substring match on name OR email (case-insensitive)
 *   - `status`   : narrow by ContactStatus
 *   - `limit` + `cursor` : keyset pagination on createdAt (desc)
 */
export async function listContacts(ownerId: string, q: ListContactsQuery) {
  const rows = await prisma.contact.findMany({
    where: {
      ownerId,
      // Exclude contacts whose linked user has been soft-deleted. The contact
      // row itself stays in the DB (so history is preserved) but we filter it
      // from the list. Contacts with no linked user (PENDING_INVITATION) are
      // always shown — they haven't registered yet, not deleted.
      OR: [
        { contactUserId: null },                          // PENDING_INVITATION
        { contactUser: { deletedAt: null } },             // ACTIVE linked user
      ],
      ...(q.status ? { status: q.status } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { email: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(q.cursor ? { createdAt: { lt: new Date(q.cursor) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: q.limit,
    select: contactPublicSelect,
  });

  const nextCursor =
    rows.length === q.limit ? rows[rows.length - 1]!.createdAt.toISOString() : null;

  return { items: rows.map(projectContactRow), nextCursor };
}

/**
 * DELETE /contacts/:contactId — remove a contact from the caller's book.
 *
 * A contact removal is address-book-local: it does NOT affect the other user's
 * account, and it does NOT remove them from any groups they've been added to.
 * Group participants keep their own row; groups can remove them separately.
 */
export async function deleteContact(ownerId: string, contactId: string): Promise<void> {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, ownerId },
    select: { id: true },
  });
  if (!contact) throw Errors.notFound('Contact not found');
  await prisma.contact.delete({ where: { id: contact.id } });
}

// ── Reconciliation hook (called from auth.service.verifyCode) ────────────────

/**
 * Called immediately after a user's `emailVerifiedAt` is set. Finds every
 * PENDING_INVITATION contact row addressed to their email, flips it to
 * VERIFIED, and fires an in-app notification to each inviter so they know the
 * invitee is now on the platform.
 *
 * Safe to call multiple times — the WHERE narrows to `status: PENDING_INVITATION`
 * so subsequent invocations are no-ops.
 *
 * Errors are logged and swallowed: reconciliation must never break the
 * verify-email flow that succeeded a moment earlier.
 */
export async function reconcilePendingContactsOnVerify(
  newlyVerifiedUserId: string,
  email: string,
): Promise<void> {
  try {
    const normalized = email.trim().toLowerCase();
    const now = new Date();

    // 1. Collect pending rows before we mutate, so we can notify each inviter.
    const pending = await prisma.contact.findMany({
      where: { email: normalized, status: 'PENDING_INVITATION' },
      select: { id: true, ownerId: true },
    });
    if (pending.length === 0) return;

    // 2. Flip them all to VERIFIED in one shot.
    await prisma.contact.updateMany({
      where: { id: { in: pending.map((c) => c.id) } },
      data: {
        contactUserId: newlyVerifiedUserId,
        status: 'VERIFIED',
        joinedAt: now,
      },
    });

    // 3. Best-effort notification fan-out. Push + in-app; email is deliberately
    // omitted to avoid spamming the inviter after they already got an
    // acknowledgement when the invite went out.
    const invitee = await prisma.user.findUnique({
      where: { id: newlyVerifiedUserId },
      select: { fullName: true },
    });
    const inviteeName = invitee?.fullName ?? normalized;

    await Promise.all(
      pending.map((p) =>
        notify(
          p.ownerId,
          'CONTACT_JOINED',
          `${inviteeName} joined Echoes`,
          `${inviteeName} is now on Echoes — they've been added to your verified contacts.`,
          { contactId: p.id, joinedUserId: newlyVerifiedUserId },
        ).catch((err) => logger.warn({ err }, 'contact-joined notify failed')),
      ),
    );

    logger.info(
      { newlyVerifiedUserId, reconciled: pending.length },
      'reconciled pending contact invitations',
    );
  } catch (err) {
    logger.error({ err }, 'reconcilePendingContactsOnVerify failed (swallowed)');
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Prisma select clause used by every endpoint that returns a contact. Kept in
 * one place so the shape stays consistent across create / list / reconcile.
 */
const contactPublicSelect = {
  id: true,
  email: true,
  name: true,
  status: true,
  contactUserId: true,
  invitationSentAt: true,
  joinedAt: true,
  createdAt: true,
  updatedAt: true,
  // A minimal projection of the linked user (only when VERIFIED). Lifecycle
  // fields are pulled so we can derive `contactUser.status` in the mapper.
  // Frontend never sees the raw dates as status flags — it consumes only
  // the derived `status` enum below.
  contactUser: {
    select: {
      id: true,
      fullName: true,
      avatarKey: true,
      deletedAt: true,
      suspendedAt: true,
      emailVerifiedAt: true,
    },
  },
} as const;

/**
 * Attach the derived `status` field to a contactUser projection (if present)
 * and drop the raw lifecycle dates from the wire response. The frontend gets
 * one clean enum instead of three nullable timestamps to interpret.
 */
function projectContactUser(
  u: {
    id: string;
    fullName: string;
    avatarKey: string | null;
    deletedAt: Date | null;
    suspendedAt: Date | null;
    emailVerifiedAt: Date | null;
  } | null,
): {
  id: string;
  fullName: string;
  avatarKey: string | null;
  status: 'ACTIVE' | 'DELETED' | 'SUSPENDED' | 'UNVERIFIED';
} | null {
  if (!u) return null;
  return {
    id: u.id,
    fullName: u.fullName,
    avatarKey: u.avatarKey,
    status: deriveUserStatus(u),
  };
}

/**
 * Apply `projectContactUser` to every row returned by a contactPublicSelect
 * query. Kept as a thin helper so every list/detail endpoint reshapes the
 * response consistently.
 */
type ContactRow = Awaited<
  ReturnType<typeof prisma.contact.findFirst<{ select: typeof contactPublicSelect }>>
>;
function projectContactRow<T extends NonNullable<ContactRow>>(row: T) {
  return { ...row, contactUser: projectContactUser(row.contactUser) };
}
