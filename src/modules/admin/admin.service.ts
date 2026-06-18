import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import { writeAudit } from './audit.service.js';
import { executeRelease } from '../capsules/capsules.service.js';
import { cancelMemorial } from '../guardians/guardians.service.js';

/**
 * Admin/Support moderation actions. [GAP §9] the client listed: delete page,
 * suspend user, manual release, override activation — all audit-logged with a
 * mandatory reason. This module is the service layer for the (Phase 2) admin
 * web app; endpoints are gated by platform role in admin.routes.ts.
 */

interface ActorCtx {
  adminId: string;
  ip?: string;
}

export async function deleteMemorialPage(ctx: ActorCtx, pageId: string, reason: string) {
  const page = await prisma.memorialPage.findUnique({ where: { id: pageId } });
  if (!page) throw Errors.notFound('Memorial page not found');
  await prisma.memorialPage.delete({ where: { id: pageId } });
  await writeAudit({
    actorId: ctx.adminId, action: 'MEMORIAL_PAGE_DELETED', targetType: 'MemorialPage',
    targetId: pageId, reason, ip: ctx.ip, metadata: { deceasedName: page.deceasedName },
  });
  return { deleted: true };
}

export async function setUserSuspension(ctx: ActorCtx, userId: string, suspend: boolean, reason: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound('User not found');

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { suspendedAt: suspend ? new Date() : null } });
    if (suspend) {
      // Force logout everywhere on suspension.
      await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
  });

  await writeAudit({
    actorId: ctx.adminId, action: suspend ? 'USER_SUSPENDED' : 'USER_REINSTATED',
    targetType: 'User', targetId: userId, reason, ip: ctx.ip,
  });
  return { suspended: suspend };
}

/** [GAP §9] manual capsule release by an admin (e.g. support escalation). */
export async function manualReleaseCapsule(ctx: ActorCtx, capsuleId: string, reason: string) {
  const capsule = await prisma.timeCapsule.findUnique({ where: { id: capsuleId } });
  if (!capsule) throw Errors.notFound('Capsule not found');
  await executeRelease(capsuleId);
  await writeAudit({
    actorId: ctx.adminId, action: 'CAPSULE_MANUALLY_RELEASED', targetType: 'TimeCapsule',
    targetId: capsuleId, reason, ip: ctx.ip,
  });
  return { released: true };
}

/**
 * [GAP §2] admin override of a memorial activation. CANCEL reverses an
 * erroneous activation (reuses the guardian service's admin path); ACTIVATE
 * force-activates without a guardian (recorded as admin-reviewed).
 */
export async function overrideActivation(ctx: ActorCtx, ownerId: string, action: 'CANCEL' | 'ACTIVATE', reason: string) {
  if (action === 'CANCEL') {
    await cancelMemorial(ownerId, ctx.adminId, reason, true);
    await writeAudit({
      actorId: ctx.adminId, action: 'ACTIVATION_OVERRIDDEN_CANCEL', targetType: 'User',
      targetId: ownerId, reason, ip: ctx.ip,
    });
    return { status: 'CANCELLED' as const };
  }

  // Force-activate.
  const owner = await prisma.user.findUnique({ where: { id: ownerId } });
  if (!owner) throw Errors.notFound('User not found');
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: ownerId }, data: { isDeceased: true } });
    await tx.memorialActivation.upsert({
      where: { ownerId },
      create: {
        ownerId, activatedById: ctx.adminId, deathCertificateKey: 'ADMIN_OVERRIDE',
        status: 'ACTIVE', activatedAt: new Date(), reviewedByAdminId: ctx.adminId,
      },
      update: { status: 'ACTIVE', activatedAt: new Date(), reviewedByAdminId: ctx.adminId },
    });
  });
  await writeAudit({
    actorId: ctx.adminId, action: 'ACTIVATION_OVERRIDDEN_ACTIVATE', targetType: 'User',
    targetId: ownerId, reason, ip: ctx.ip,
  });
  return { status: 'ACTIVE' as const };
}
