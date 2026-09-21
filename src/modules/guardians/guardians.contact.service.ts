import { prisma } from '../../lib/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { notify } from '../notifications/notifications.service.js';

/**
 * Contact-based Guardian service.
 *
 * Design notes:
 *   - A Guardian row links an owner to one of their VERIFIED contacts.
 *     Duplicates are prevented by the composite unique index
 *     (ownerId, contactId).
 *   - Deletion is BLOCKED while the guardian is still linked to any resource.
 *     Today that means TimeCapsule.guardianId; when new resource types grow
 *     guardian support (vaults, groups, ...), extend the check inside
 *     `deleteGuardian`.
 *   - No email/invitation flow — the contact is already VERIFIED, so we
 *     immediately fire a GUARDIAN_ASSIGNED in-app + push notification and
 *     the guardian sees the assignment on next open.
 */

// ── Public API ──────────────────────────────────────────────────────────────

/** POST /guardians */
export async function createGuardian(ownerId: string, contactId: string) {
  const contact = await assertVerifiedOwnContact(ownerId, contactId);

  if (contact.contactUserId === ownerId) {
    throw Errors.badRequest('You cannot make yourself a guardian');
  }

  // Idempotency: return the existing row if this contact is already a guardian.
  const existing = await prisma.guardian.findUnique({
    where: { ownerId_contactId: { ownerId, contactId } },
    include: guardianInclude,
  });
  if (existing) {
    throw Errors.conflict('This contact is already a guardian');
  }

  const guardian = await prisma.guardian.create({
    data: { ownerId, contactId },
    include: guardianInclude,
  });

  // Best-effort notification to the guardian's account. The `if` guard is a
  // belt-and-braces safety net — assertVerifiedOwnContact already required
  // status=VERIFIED, so contactUserId is non-null in normal operation.
  if (contact.contactUserId) {
    notify(
      contact.contactUserId,
      'GUARDIAN_ASSIGNED',
      'You have been assigned as a Guardian',
      'You have been assigned as a guardian for a time capsule.',
      {
        guardianId: guardian.id,
        ownerId,
        referenceId: guardian.id,
        referenceType: 'Guardian',
      },
    ).catch((err) =>
      logger.warn({ err }, 'GUARDIAN_ASSIGNED notify failed'),
    );
  }

  return projectGuardian(guardian);
}

/** GET /guardians — the caller's own guardians (owner view). */
export async function listGuardians(ownerId: string) {
  const rows = await prisma.guardian.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
    include: guardianInclude,
  });
  return rows.map(projectGuardian);
}

/** GET /guardians/:guardianId */
export async function getGuardian(ownerId: string, guardianId: string) {
  const row = await prisma.guardian.findFirst({
    where: { id: guardianId, ownerId },
    include: guardianInclude,
  });
  if (!row) throw Errors.notFound('Guardian not found');
  return projectGuardian(row);
}

/**
 * DELETE /guardians/:guardianId
 *
 * Blocks the delete if the guardian is still linked to any protected
 * resource. Today the only linkage is TimeCapsule.guardianId. The check
 * happens at the DB level (COUNT query), not just the frontend, so a direct
 * API call from a mobile client or an internal tool can't bypass it.
 */
export async function deleteGuardian(ownerId: string, guardianId: string) {
  const guardian = await prisma.guardian.findFirst({
    where: { id: guardianId, ownerId },
    include: {
      contact: {
        select: { name: true, contactUserId: true },
      },
    },
  });
  if (!guardian) throw Errors.notFound('Guardian not found');

  // Aggregate every "guardian-of" relation here so future guardian-linked
  // resources are one line to add. Today: TimeCapsule.guardianId only.
  const linkedCapsules = await prisma.timeCapsule.count({
    where: { guardianId, status: { notIn: ['RELEASED', 'CANCELLED'] } },
  });

  if (linkedCapsules > 0) {
    throw Errors.conflict(
      'This guardian is currently linked to one or more resources. Please remove the guardian from those resources before deleting.',
    );
  }

  await prisma.guardian.delete({ where: { id: guardianId } });

  // Roll-up notification to the (formerly assigned) guardian.
  if (guardian.contact.contactUserId) {
    notify(
      guardian.contact.contactUserId,
      'GUARDIAN_REMOVED',
      'Guardian assignment removed',
      'A guardian assignment referencing you has been removed.',
      {
        guardianId,
        ownerId,
        referenceId: guardianId,
        referenceType: 'Guardian',
      },
    ).catch((err) =>
      logger.warn({ err }, 'GUARDIAN_REMOVED notify failed'),
    );
  }
}

// ── Guardian Dashboard (spec §13) ───────────────────────────────────────────

/**
 * GET /guardians/dashboard
 *
 * Everything the calling user "guards": right now that's the union of every
 * TimeCapsule whose guardian.contact.contactUserId matches. Returns per-item
 * owner, release-date, status, and schedule metadata so the frontend can
 * render a My Guardianships pane without a second round-trip.
 */
export async function listGuardianDashboard(guardianUserId: string) {
  // Which Guardian rows point at ME (as the underlying contact.contactUserId)?
  const myGuardianRows = await prisma.guardian.findMany({
    where: { contact: { contactUserId: guardianUserId } },
    select: { id: true, ownerId: true },
  });
  if (myGuardianRows.length === 0) {
    return { items: [], counts: { capsules: 0 } };
  }
  const myGuardianIds = myGuardianRows.map((r) => r.id);

  const capsules = await prisma.timeCapsule.findMany({
    where: { guardianId: { in: myGuardianIds } },
    orderBy: [{ releaseAt: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      title: true,
      status: true,
      releaseType: true,
      releaseAt: true,
      recurMonth: true,
      recurDay: true,
      scheduleTimezone: true,
      releasedAt: true,
      createdAt: true,
      owner: {
        select: { id: true, fullName: true, avatarKey: true, isDeceased: true },
      },
    },
  });

  return {
    items: capsules.map((c) => ({
      resourceType: 'TimeCapsule' as const,
      id: c.id,
      title: c.title,
      status: c.status,
      releaseType: c.releaseType,
      releaseAt: c.releaseAt,
      recurMonth: c.recurMonth,
      recurDay: c.recurDay,
      scheduleTimezone: c.scheduleTimezone,
      releasedAt: c.releasedAt,
      createdAt: c.createdAt,
      owner: c.owner,
    })),
    counts: { capsules: capsules.length },
  };
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function assertVerifiedOwnContact(ownerId: string, contactId: string) {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, ownerId },
    select: {
      id: true,
      name: true,
      email: true,
      status: true,
      contactUserId: true,
    },
  });
  if (!contact) throw Errors.notFound('Contact not found in your address book');
  if (contact.status !== 'VERIFIED') {
    throw Errors.badRequest(
      'Only VERIFIED contacts can be assigned as guardians — invite them to Echoes first',
    );
  }
  if (!contact.contactUserId) {
    // Shouldn't happen for VERIFIED, but the type-narrowing keeps downstream
    // callers honest.
    throw Errors.badRequest(
      'This contact is not linked to an Echoes account yet',
    );
  }
  return contact;
}

const guardianInclude = {
  contact: {
    select: {
      id: true,
      name: true,
      email: true,
      status: true,
      contactUserId: true,
      contactUser: {
        select: { id: true, fullName: true, avatarKey: true },
      },
    },
  },
} as const;

type RawGuardian = Prisma.GuardianGetPayload<{ include: typeof guardianInclude }>;

function projectGuardian(row: RawGuardian) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    contactId: row.contactId,
    name: row.contact.name,
    email: row.contact.email,
    contactUser: row.contact.contactUser,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
