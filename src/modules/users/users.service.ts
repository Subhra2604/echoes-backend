import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import { PLAN_STORAGE_BYTES, PLAN_ADS_ENABLED, PLAN_MEMORIAL_LIMIT } from '../../config/plans.js';
import { deleteObject } from '../../lib/s3.js';
import type { UpdateProfileInput } from './users.dto.js';
import type { SubscriptionPlan } from '../../generated/prisma/enums.js';

export async function getMe(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true, email: true, fullName: true, timezone: true, avatarKey: true,
      emailVerifiedAt: true, totpEnabled: true,
      isFamilyUser: true, isLegacyOwner: true, isGuardian: true, platformRole: true,
      plan: true, storageUsedBytes: true, isDeceased: true, createdAt: true,
    },
  });
  const plan = user.plan as SubscriptionPlan;
  return {
    ...user,
    storageUsedBytes: Number(user.storageUsedBytes),
    storageLimitBytes: PLAN_STORAGE_BYTES[plan],
    memorialLimit: PLAN_MEMORIAL_LIMIT[plan], // null = unlimited
    adsEnabled: PLAN_ADS_ENABLED[plan],
  };
}

export async function updateProfile(userId: string, input: UpdateProfileInput) {
  return prisma.user.update({
    where: { id: userId },
    data: { fullName: input.fullName, timezone: input.timezone },
    select: { id: true, fullName: true, timezone: true },
  });
}

/**
 * [Role_Docs] Self-upgrade to Legacy Owner. A Family User becomes a Legacy Owner
 * with no extra verification at MVP. This unlocks recording capsules and
 * assigning guardians. The user keeps isFamilyUser = true (roles stack).
 */
export async function upgradeToLegacyOwner(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.isLegacyOwner) return { isLegacyOwner: true };
  await prisma.user.update({ where: { id: userId }, data: { isLegacyOwner: true } });
  return { isLegacyOwner: true };
}

/**
 * [GAP §1] PERMANENT account deletion. Cascades via Prisma relations (onDelete:
 * Cascade across vault, sessions, capsules owned, pages created, etc.). We first
 * remove the user's S3 objects (DB cascade cannot reach into the bucket), then
 * hard-delete the row inside a transaction.
 *
 * Caller must pass the double-confirmation (enforced at the DTO layer).
 */
export async function deleteAccount(userId: string): Promise<void> {
  // Collect S3 keys to purge: vault items + any uploaded death certificates the
  // user owns are tied to other users' activations, so we only purge this user's
  // vault objects and avatar here.
  const vault = await prisma.vault.findUnique({
    where: { userId },
    include: { items: { select: { s3Key: true } } },
  });
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { avatarKey: true } });

  const keys = [
    ...(vault?.items
      .map((i: { s3Key: string | null }) => i.s3Key)
      .filter((k: string | null): k is string => Boolean(k)) ?? []),
    ...(user?.avatarKey ? [user.avatarKey] : []),
  ];

  // Best-effort object cleanup before the DB row disappears.
  await Promise.all(keys.map((k) => deleteObject(k).catch(() => undefined)));

  // Hard delete — relations cascade.
  await prisma.user.delete({ where: { id: userId } });
}
