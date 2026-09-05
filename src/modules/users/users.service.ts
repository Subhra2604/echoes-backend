import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import { PLAN_STORAGE_BYTES, PLAN_ADS_ENABLED, PLAN_MEMORIAL_LIMIT } from '../../config/plans.js';
import { deleteObject } from '../../lib/s3.js';
import { decryptSecret } from '../../lib/crypto.js';
import { revokeAppleRefreshToken } from '../auth/apple.client.js';
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
 * Soft-delete the caller's account.
 *
 * Product policy (Patch C):
 *   - No grace period → deletedAt is set immediately and permanently.
 *   - No restore endpoint → if the user changes their mind they must
 *     re-register from scratch (creates a fresh User row with a new UUID).
 *   - Content persists → the user's memories, letters, voice recordings and
 *     shares stay in the DB so recipients keep seeing them. The frontend
 *     renders them with a "deleted account" badge via `contactUser.status`.
 *   - Email freed immediately → the partial unique index on User.email only
 *     constrains active rows, so a new person can register the same email
 *     right away (creates a separate row with a new UUID).
 *
 * Side effects done here:
 *   - Set deletedAt (marks the row as DELETED status).
 *   - Revoke all sessions (existing JWTs stop working on next request).
 *   - Delete all OAuthAccount links (frees the Google/Apple account so it
 *     can be re-linked to a fresh registration by the same person).
 *   - Best-effort delete of the avatar S3 object (content-bearing objects
 *     like vault items are LEFT intact — recipients still need them).
 *
 * Caller must pass the double-confirmation (enforced at the DTO layer).
 */
export async function deleteAccount(userId: string): Promise<void> {
  const now = new Date();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { avatarKey: true, deletedAt: true },
  });
  if (!user) throw Errors.notFound('User not found');
  if (user.deletedAt) return; // idempotent — already deleted

  // Grab any Apple revocation tokens before the transaction below deletes
  // the OAuthAccount rows they live on.
  const appleLinks = await prisma.oAuthAccount.findMany({
    where: { userId, provider: 'APPLE', appleRefreshTokenEnc: { not: null } },
    select: { appleRefreshTokenEnc: true },
  });

  // Atomic DB mutations. Auth middleware also independently checks deletedAt,
  // so any in-flight requests holding a valid JWT will get 401 on next call.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { deletedAt: now },
    }),
    prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    }),
    prisma.oAuthAccount.deleteMany({ where: { userId } }),
  ]);

  // Purge avatar object outside the transaction (best-effort).
  if (user.avatarKey) {
    await deleteObject(user.avatarKey).catch(() => undefined);
  }

  // Best-effort revocation with Apple — never blocks deletion; a user must
  // be able to delete their account even if Apple's revoke endpoint is down.
  await Promise.all(
    appleLinks.map((link: { appleRefreshTokenEnc: string | null }) =>
      link.appleRefreshTokenEnc
        ? revokeAppleRefreshToken(decryptSecret(link.appleRefreshTokenEnc)).catch(() => undefined)
        : Promise.resolve(),
    ),
  );
}

/**
 * Derive a canonical status enum from a User row. Used by any endpoint that
 * projects a foreign user (e.g. contactUser on Contact rows, sharedBy on
 * ContentShare rows, participant.user on GroupParticipant rows).
 *
 * Precedence — most restrictive wins:
 *   DELETED     → deletedAt IS NOT NULL     (soft-deleted account)
 *   SUSPENDED   → suspendedAt IS NOT NULL   (admin action)
 *   UNVERIFIED  → emailVerifiedAt IS NULL   (registered but never confirmed)
 *   ACTIVE      → everything else
 *
 * Frontends should treat DELETED and SUSPENDED as "cannot interact" and
 * UNVERIFIED as "can display but delivery may fail".
 */
export type UserStatus = 'ACTIVE' | 'DELETED' | 'SUSPENDED' | 'UNVERIFIED';

export function deriveUserStatus(u: {
  deletedAt: Date | null;
  suspendedAt: Date | null;
  emailVerifiedAt: Date | null;
}): UserStatus {
  if (u.deletedAt) return 'DELETED';
  if (u.suspendedAt) return 'SUSPENDED';
  if (!u.emailVerifiedAt) return 'UNVERIFIED';
  return 'ACTIVE';
}
