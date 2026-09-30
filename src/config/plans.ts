import { env } from './env.js';
import type { SubscriptionPlan, CapsuleReleaseType } from '../generated/prisma/enums.js';

/**
 * Subscription-plan configuration (Free / Basic / Family / Legacy Premium).
 *
 * One place defines what each plan grants so quota checks, billing, and the
 * `/users/me` payload all agree.
 *
 * A future AI query/chat feature will reuse this same pattern — see
 * `PLAN_AI_PROMPT_LIMIT` at the bottom, not enforced anywhere yet.
 */

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** Base storage allocation per plan, in bytes. */
export const PLAN_STORAGE_BYTES: Record<SubscriptionPlan, number> = {
  FREE: 500 * MB,
  BASIC: 5 * GB,
  FAMILY: 20 * GB,
  LEGACY_PREMIUM: 200 * GB,
};

/** Max number of memorial pages a user may create; null = unlimited. */
export const PLAN_MEMORIAL_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 1,
  BASIC: 3,
  FAMILY: null,
  LEGACY_PREMIUM: null,
};

/** Max number of photo items; null = unlimited. (Free is capped at 20.) */
export const PLAN_PHOTO_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 20,
  BASIC: null,
  FAMILY: null,
  LEGACY_PREMIUM: null,
};

/** Whether ads are shown. Ads on the free tier only. */
export const PLAN_ADS_ENABLED: Record<SubscriptionPlan, boolean> = {
  FREE: true,
  BASIC: false,
  FAMILY: false,
  LEGACY_PREMIUM: false,
};

/** Display price in USD/month (for reference / the /plans endpoint). */
export const PLAN_PRICE_USD: Record<SubscriptionPlan, number> = {
  FREE: 0,
  BASIC: 9.99,
  FAMILY: 19.99,
  LEGACY_PREMIUM: 39.99,
};

/**
 * Max number of non-cancelled, non-released Time Capsules a user may own;
 * null = unlimited. RELEASED/CANCELLED capsules don't count — a fulfilled
 * capsule shouldn't permanently occupy a slot.
 */
export const PLAN_CAPSULE_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 1,
  BASIC: 10,
  FAMILY: null,
  LEGACY_PREMIUM: null,
};

/**
 * Which capsule release types a plan may create. RECURRING_ANNUAL is a
 * perpetual scheduling commitment; GUARDIAN_CONTROLLED depends on having a
 * Guardian, which Free has none of (see PLAN_GUARDIAN_LIMIT) — restricting
 * Free to the simplest one-shot type is a natural, internally-consistent
 * upsell rather than an arbitrary cut.
 */
export const PLAN_CAPSULE_RELEASE_TYPES: Record<SubscriptionPlan, CapsuleReleaseType[]> = {
  FREE: ['SCHEDULED_DATE'],
  BASIC: ['SCHEDULED_DATE', 'RECURRING_ANNUAL', 'GUARDIAN_CONTROLLED'],
  FAMILY: ['SCHEDULED_DATE', 'RECURRING_ANNUAL', 'GUARDIAN_CONTROLLED'],
  LEGACY_PREMIUM: ['SCHEDULED_DATE', 'RECURRING_ANNUAL', 'GUARDIAN_CONTROLLED'],
};

/**
 * Max number of contact-based Guardians a user may assign; null = unlimited.
 * Applies only to the newer contact-based `Guardian` model — NOT the
 * separate legacy email-invitation `GuardianInvitation` system, which keeps
 * its own unrelated "must keep at least one" floor rule untouched.
 */
export const PLAN_GUARDIAN_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 0,
  BASIC: 3,
  FAMILY: null,
  LEGACY_PREMIUM: null,
};

/** Max number of Scheduled Messages a user may own; null = unlimited. */
export const PLAN_SCHEDULED_MESSAGE_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 2,
  BASIC: 25,
  FAMILY: null,
  LEGACY_PREMIUM: null,
};

/** Max number of Groups a user may own (create); null = unlimited. */
export const PLAN_GROUP_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 1,
  BASIC: 5,
  FAMILY: null,
  LEGACY_PREMIUM: null,
};

/**
 * Max participants per group, gated by the GROUP OWNER's plan (not the
 * calling admin's) — a group's capacity is a property of whoever owns it.
 * null = unlimited.
 */
export const PLAN_GROUP_PARTICIPANT_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 5,
  BASIC: 20,
  FAMILY: null,
  LEGACY_PREMIUM: null,
};

/**
 * Max AI eulogy generations per calendar month (UTC); null = unlimited. This
 * is the one dimension mapping to real metered third-party spend (a live
 * Anthropic API call per generation), so even the top tier keeps a generous
 * bound rather than going unlimited outright — LEGACY_PREMIUM is 2.5x
 * FAMILY's allowance, a real perk for the price without open-ended cost
 * exposure on a single account. Counted via the EulogyGeneration log table,
 * not Eulogy rows — see eulogy.service.ts for why (regenerations update
 * Eulogy in place).
 */
export const PLAN_EULOGY_GENERATION_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 1,
  BASIC: 5,
  FAMILY: 20,
  LEGACY_PREMIUM: 50,
};

/**
 * Max AI age-progression image jobs per calendar month (UTC); null =
 * unlimited. Counted directly off ImageAgingJob.createdAt — unlike eulogies,
 * every real generation attempt creates a fresh row here, so there's no
 * separate log table needed (no in-place "regenerate" that would hide a
 * repeat call behind an update).
 *
 * Gemini image cost (~$0.04/image) is roughly 4-8x a Haiku eulogy
 * generation's cost, so limits sit proportionally lower than
 * PLAN_EULOGY_GENERATION_LIMIT rather than mirroring its numbers. Free gets
 * none — too costly to give away. Deliberately conservative pending real
 * usage data; easy to raise later, hard to walk back after users expect a
 * number.
 */
export const PLAN_IMAGE_AGING_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 0,
  BASIC: 3,
  FAMILY: 10,
  LEGACY_PREMIUM: 25,
};

/**
 * NOT ENFORCED ANYWHERE YET. Reserved for the future AI query/chat feature
 * (ChatGPT + Claude, per product direction). Per calendar month, same
 * convention as PLAN_EULOGY_GENERATION_LIMIT above.
 */
export const PLAN_AI_PROMPT_LIMIT: Record<SubscriptionPlan, number> = {
  FREE: 0,
  BASIC: 20,
  FAMILY: 100,
  LEGACY_PREMIUM: 200,
};

/** Stripe Price IDs per paid plan (from the dashboard, via env). */
export function planPriceId(plan: SubscriptionPlan): string | undefined {
  switch (plan) {
    case 'BASIC':
      return env.STRIPE_PRICE_BASIC;
    case 'FAMILY':
      return env.STRIPE_PRICE_FAMILY;
    case 'LEGACY_PREMIUM':
      return env.STRIPE_PRICE_LEGACY_PREMIUM;
    default:
      return undefined;
  }
}

export const PAID_PLANS: SubscriptionPlan[] = ['BASIC', 'FAMILY', 'LEGACY_PREMIUM'];

/** Storage-warning thresholds (fraction of quota used) surfaced to the client. */
export const STORAGE_WARNING_THRESHOLDS = [0.8, 0.9, 1.0] as const;

/** Returns the highest crossed threshold for a usage fraction, or null. */
export function storageWarningLevel(usedBytes: number, limitBytes: number): 80 | 90 | 100 | null {
  if (limitBytes <= 0) return null;
  const frac = usedBytes / limitBytes;
  if (frac >= 1.0) return 100;
  if (frac >= 0.9) return 90;
  if (frac >= 0.8) return 80;
  return null;
}
