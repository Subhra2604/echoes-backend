import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { Errors } from '../../lib/errors.js';
import { generateToken, hashToken } from '../../lib/crypto.js';
import { sendGuardianInvitationEmail } from '../notifications/notifications.service.js';
import { notify } from '../notifications/notifications.service.js';

const ACTIVE_STATUSES = ['PENDING', 'ACCEPTED'] as const;

/**
 * Owner invites a guardian. [GAP §2]
 *  - more than one guardian allowed (backups)
 *  - invitation expires after GUARDIAN_INVITE_EXPIRY_DAYS (30)
 *  - re-inviting the same email refreshes an expired/declined/revoked invite
 */
export async function inviteGuardian(ownerId: string, guardianEmail: string, isPrimary?: boolean) {
  if (guardianEmail.toLowerCase() === (await ownerEmail(ownerId)).toLowerCase()) {
    throw Errors.badRequest('You cannot be your own guardian');
  }

  // Promote the owner to Legacy Owner on first guardian assignment. [Role_Docs]
  await prisma.user.update({ where: { id: ownerId }, data: { isLegacyOwner: true } });

  const raw = generateToken();
  const expiresAt = new Date(Date.now() + env.GUARDIAN_INVITE_EXPIRY_DAYS * 86_400_000);

  // Is this the owner's first guardian? Then it's primary by default.
  const existingActive = await prisma.guardianInvitation.count({
    where: { ownerId, status: { in: [...ACTIVE_STATUSES] } },
  });
  const primary = isPrimary ?? existingActive === 0;

  // If a guardian record already exists by upsert, refresh it (re-invite).
  const existing = await prisma.guardianInvitation.findUnique({
    where: { ownerId_guardianEmail: { ownerId, guardianEmail } },
  });
  if (existing && existing.status === 'ACCEPTED') {
    throw Errors.conflict('That guardian has already accepted');
  }
  if (existing && existing.status === 'PENDING' && existing.expiresAt > new Date()) {
    throw Errors.conflict('An active invitation for that email already exists');
  }

  const invitedUser = await prisma.user.findFirst({ where: { email: guardianEmail, deletedAt: null } });

  const invitation = await prisma.guardianInvitation.upsert({
    where: { ownerId_guardianEmail: { ownerId, guardianEmail } },
    create: {
      ownerId,
      guardianEmail,
      guardianId: invitedUser?.id,
      tokenHash: hashToken(raw),
      expiresAt,
      isPrimary: primary,
      priority: existingActive,
      status: 'PENDING',
    },
    update: {
      tokenHash: hashToken(raw),
      expiresAt,
      status: 'PENDING',
      declinedAt: null,
      revokedAt: null,
      guardianId: invitedUser?.id,
    },
  });

  const link = `${env.PUBLIC_APP_URL}/guardian/invitation?token=${raw}`;
  await sendGuardianInvitationEmail(guardianEmail, link);
  return { invitationId: invitation.id, expiresAt };
}

/** Guardian accepts or declines, via the tokenised link. [GAP §2] */
export async function respondToInvitation(actingUserId: string, token: string, accept: boolean) {
  const invitation = await prisma.guardianInvitation.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!invitation) throw Errors.notFound('Invitation not found');
  if (invitation.status !== 'PENDING') throw Errors.gone('This invitation is no longer pending');
  if (invitation.expiresAt < new Date()) {
    await prisma.guardianInvitation.update({ where: { id: invitation.id }, data: { status: 'EXPIRED' } });
    throw Errors.gone('This invitation has expired');
  }

  // The signed-in user's email must match the invited email.
  const actingUser = await prisma.user.findUniqueOrThrow({ where: { id: actingUserId } });
  if (actingUser.email.toLowerCase() !== invitation.guardianEmail.toLowerCase()) {
    throw Errors.forbidden('This invitation was sent to a different email address');
  }

  if (!accept) {
    await prisma.guardianInvitation.update({
      where: { id: invitation.id },
      data: { status: 'DECLINED', declinedAt: new Date() },
    });
    await notify(invitation.ownerId, 'GUARDIAN_DECLINED', 'Guardian declined', `${actingUser.fullName} declined to be your Legacy Guardian.`);
    return { status: 'DECLINED' as const };
  }

  await prisma.$transaction([
    prisma.guardianInvitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date(), guardianId: actingUser.id },
    }),
    prisma.user.update({ where: { id: actingUser.id }, data: { isGuardian: true } }),
  ]);
  await notify(invitation.ownerId, 'GUARDIAN_ACCEPTED', 'Guardian accepted', `${actingUser.fullName} is now your Legacy Guardian.`);
  return { status: 'ACCEPTED' as const };
}

/**
 * Owner revokes a guardian while alive. [GAP §2]
 * Guards the "must assign at least 1" rule: cannot revoke the last guardian.
 */
export async function revokeGuardian(ownerId: string, invitationId: string) {
  const invitation = await prisma.guardianInvitation.findFirst({ where: { id: invitationId, ownerId } });
  if (!invitation) throw Errors.notFound('Invitation not found');

  const activeCount = await prisma.guardianInvitation.count({
    where: { ownerId, status: { in: [...ACTIVE_STATUSES] } },
  });
  const isActive = (ACTIVE_STATUSES as readonly string[]).includes(invitation.status);
  if (isActive && activeCount <= 1) {
    throw Errors.conflict('You must keep at least one Legacy Guardian — assign a replacement before revoking this one');
  }

  await prisma.guardianInvitation.update({
    where: { id: invitation.id },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });
  return { status: 'REVOKED' as const };
}

export async function listMyGuardians(ownerId: string) {
  return prisma.guardianInvitation.findMany({
    where: { ownerId, status: { notIn: ['REVOKED', 'DECLINED'] } },
    orderBy: [{ isPrimary: 'desc' }, { priority: 'asc' }],
    select: { id: true, guardianEmail: true, status: true, isPrimary: true, expiresAt: true, acceptedAt: true },
  });
}

export async function listOwnersIGuard(guardianId: string) {
  const rows = await prisma.guardianInvitation.findMany({
    where: { guardianId, status: 'ACCEPTED' },
    include: { owner: { select: { id: true, fullName: true, isDeceased: true } } },
  });
  return rows.map((r: { owner: { id: string; fullName: string; isDeceased: boolean } }) => ({
    ownerId: r.owner.id,
    ownerName: r.owner.fullName,
    memorialActive: r.owner.isDeceased,
  }));
}

/**
 * Guardian activates memorial mode after the owner has passed. [GAP §2]
 *  - requires a death certificate (already uploaded to S3)
 *  - sets owner.isDeceased = true
 *  - transfers memorial page management to this guardian [GAP §6 policy]
 *  - reversible via cancelMemorial
 */
export async function activateMemorial(ownerId: string, guardianUserId: string, deathCertificateKey: string) {
  const accepted = await prisma.guardianInvitation.findFirst({
    where: { ownerId, guardianId: guardianUserId, status: 'ACCEPTED' },
  });
  if (!accepted) throw Errors.forbidden('You are not an accepted guardian for this account');

  const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
  if (owner.isDeceased) throw Errors.conflict('Memorial mode is already active for this account');

  await prisma.$transaction(async (tx) => {
    await tx.memorialActivation.upsert({
      where: { ownerId },
      create: { ownerId, activatedById: guardianUserId, deathCertificateKey, status: 'ACTIVE', activatedAt: new Date() },
      update: { activatedById: guardianUserId, deathCertificateKey, status: 'ACTIVE', activatedAt: new Date(), cancelledAt: null, cancelledReason: null },
    });
    await tx.user.update({ where: { id: ownerId }, data: { isDeceased: true } });
    // Transfer page management to the activating guardian.
    await tx.memorialPage.updateMany({ where: { deceasedUserId: ownerId }, data: { managerUserId: guardianUserId } });
  });

  await notify(guardianUserId, 'MEMORIAL_ACTIVATED', 'Memorial mode activated', `You now manage ${owner.fullName}'s legacy.`);
  return { status: 'ACTIVE' as const };
}

/** Reverse an activation done by mistake. [GAP §2] guardian or admin. */
export async function cancelMemorial(ownerId: string, byUserId: string, reason?: string, isAdmin = false) {
  const activation = await prisma.memorialActivation.findUnique({ where: { ownerId } });
  if (!activation || activation.status !== 'ACTIVE') throw Errors.conflict('Memorial mode is not active');
  if (!isAdmin && activation.activatedById !== byUserId) {
    throw Errors.forbidden('Only the guardian who activated memorial mode (or an admin) can cancel it');
  }

  await prisma.$transaction(async (tx) => {
    await tx.memorialActivation.update({
      where: { ownerId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: reason, reviewedByAdminId: isAdmin ? byUserId : null },
    });
    await tx.user.update({ where: { id: ownerId }, data: { isDeceased: false } });
    // Hand page management back to the creator.
    await tx.memorialPage.updateMany({ where: { deceasedUserId: ownerId }, data: { managerUserId: null } });
  });
  return { status: 'CANCELLED' as const };
}

async function ownerEmail(ownerId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: ownerId }, select: { email: true } });
  return u.email;
}
