import { prisma } from '../../lib/prisma.js';
import type { CapsuleReleaseType, SubscriptionPlan } from '../../generated/prisma/enums.js';
import {
  PLAN_DISPLAY,
  PLAN_STORAGE_BYTES,
  PLAN_MEMORIAL_LIMIT,
  PLAN_PHOTO_LIMIT,
  PLAN_CAPSULE_LIMIT,
  PLAN_CAPSULE_RELEASE_TYPES,
  PLAN_GUARDIAN_LIMIT,
  PLAN_SCHEDULED_MESSAGE_LIMIT,
  PLAN_GROUP_LIMIT,
  PLAN_GROUP_PARTICIPANT_LIMIT,
  PLAN_EULOGY_GENERATION_LIMIT,
  PLAN_IMAGE_AGING_LIMIT,
  PLAN_AI_PROMPT_LIMIT,
  PLAN_ADS_ENABLED,
  storageWarningLevel,
} from '../../config/plans.js';

/**
 * "What can the current user do on their plan, and how much is left?" — one
 * read-only answer for the client to enable/disable features from.
 *
 * Purely informational. The server still enforces every limit at the moment of
 * creation (402 QUOTA_EXCEEDED); nothing here is trusted for security. The
 * counts below deliberately mirror what each feature's own quota check counts
 * (same table, same filters, same UTC calendar month) so that
 * `canUse: true` here means the create call will not be refused for quota.
 * If a feature's quota rule changes, change it here too.
 */

/** A Subscription row as stored, narrowed to what clients are allowed to see. */
interface SubscriptionRow {
  status: string;
  billingInterval: string | null;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  stripeSubscriptionId: string | null;
}

/**
 * The subscription as exposed to clients, shared by /users/me and
 * /billing/entitlements so the two can never disagree.
 *
 * A row with no stripeSubscriptionId is only a stub created when checkout
 * STARTED (to hold the Stripe customer id) — no payment method, no trial,
 * nothing subscribed. Its `status` is meaningless, so report it as "no
 * subscription" instead of letting a stale ACTIVE/INCOMPLETE mislead the
 * client into routing to the portal, which can never create a subscription.
 * The Stripe id itself is internal and never exposed.
 */
export function toPublicSubscription(row: SubscriptionRow | null | undefined) {
  if (!row?.stripeSubscriptionId) return null;
  return {
    status: row.status,
    billingInterval: row.billingInterval,
    trialEndsAt: row.trialEndsAt,
    currentPeriodEnd: row.currentPeriodEnd,
  };
}

function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfNextMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export interface FeatureEntitlement {
  /** The plan includes this feature at all (limit is not 0). */
  included: boolean;
  /** included AND there is still room — i.e. a create call would not hit the quota. */
  canUse: boolean;
  /** Max allowed; null = unlimited, 0 = not on this plan. */
  limit: number | null;
  /** How many the user has right now (lifetime features) or this month (monthly ones). */
  used: number;
  /** limit - used, floored at 0; null when unlimited. */
  remaining: number | null;
  /** 'lifetime' = total currently owned; 'month' = resets on the 1st (UTC). */
  period: 'lifetime' | 'month';
  /** ISO time the monthly counter resets; null for lifetime features. */
  resetsAt: string | null;
}

function feature(
  limit: number | null,
  used: number,
  period: 'lifetime' | 'month',
  resetsAt: Date | null,
  extraRequirement = true,
): FeatureEntitlement {
  const included = (limit === null || limit > 0) && extraRequirement;
  const remaining = limit === null ? null : Math.max(0, limit - used);
  return {
    included,
    canUse: included && (remaining === null || remaining > 0),
    limit,
    used,
    remaining,
    period,
    resetsAt: resetsAt ? resetsAt.toISOString() : null,
  };
}

export async function getEntitlements(userId: string) {
  const now = new Date();
  const monthStart = startOfMonthUtc(now);
  const nextMonth = startOfNextMonthUtc(now);

  const [
    user,
    memorials,
    photos,
    capsules,
    guardians,
    scheduledMessages,
    groups,
    eulogyGenerations,
    imageAging,
    aiPrompts,
  ] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        plan: true,
        storageUsedBytes: true,
        subscription: {
          select: {
            status: true, billingInterval: true, trialEndsAt: true, currentPeriodEnd: true,
            stripeSubscriptionId: true,
          },
        },
      },
    }),
    prisma.memorialPage.count({ where: { creatorUserId: userId } }),
    // Matched via the vault's owner rather than getVault(), which would create
    // an empty vault as a side effect of a read.
    prisma.vaultItem.count({ where: { type: 'PHOTO', vault: { userId } } }),
    prisma.timeCapsule.count({ where: { ownerId: userId, status: { notIn: ['CANCELLED', 'RELEASED'] } } }),
    prisma.guardian.count({ where: { ownerId: userId } }),
    prisma.scheduledMessage.count({ where: { ownerId: userId } }),
    prisma.group.count({ where: { createdById: userId, deletedAt: null } }),
    prisma.eulogyGeneration.count({ where: { ownerId: userId, createdAt: { gte: monthStart } } }),
    prisma.imageAgingJob.count({ where: { ownerId: userId, createdAt: { gte: monthStart } } }),
    prisma.aiPrompt.count({ where: { ownerId: userId, createdAt: { gte: monthStart } } }),
  ]);

  const plan = user.plan as SubscriptionPlan;
  const releaseTypes: CapsuleReleaseType[] = PLAN_CAPSULE_RELEASE_TYPES[plan];

  const storageLimit = PLAN_STORAGE_BYTES[plan];
  const storageUsed = Number(user.storageUsedBytes);

  return {
    plan,
    planName: PLAN_DISPLAY[plan].name,
    ads: PLAN_ADS_ENABLED[plan],
    subscription: toPublicSubscription(user.subscription),
    storage: {
      usedBytes: storageUsed,
      limitBytes: storageLimit,
      remainingBytes: Math.max(0, storageLimit - storageUsed),
      // null until 80% is crossed, then 80 | 90 | 100.
      warningLevel: storageWarningLevel(storageUsed, storageLimit),
    },
    features: {
      memorials: feature(PLAN_MEMORIAL_LIMIT[plan], memorials, 'lifetime', null),
      photos: feature(PLAN_PHOTO_LIMIT[plan], photos, 'lifetime', null),
      timeCapsules: {
        ...feature(PLAN_CAPSULE_LIMIT[plan], capsules, 'lifetime', null, releaseTypes.length > 0),
        /** Which release types the plan may create; empty = none. */
        releaseTypes,
      },
      guardians: feature(PLAN_GUARDIAN_LIMIT[plan], guardians, 'lifetime', null),
      scheduledMessages: feature(PLAN_SCHEDULED_MESSAGE_LIMIT[plan], scheduledMessages, 'lifetime', null),
      groups: {
        ...feature(PLAN_GROUP_LIMIT[plan], groups, 'lifetime', null),
        /** Per group, set by the group OWNER's plan; null = unlimited. */
        maxParticipantsPerGroup: PLAN_GROUP_PARTICIPANT_LIMIT[plan],
      },
      eulogyGenerations: feature(PLAN_EULOGY_GENERATION_LIMIT[plan], eulogyGenerations, 'month', nextMonth),
      imageAging: feature(PLAN_IMAGE_AGING_LIMIT[plan], imageAging, 'month', nextMonth),
      aiPrompts: feature(PLAN_AI_PROMPT_LIMIT[plan], aiPrompts, 'month', nextMonth),
    },
  };
}
