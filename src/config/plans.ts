import { env } from './env.js';
import type { SubscriptionPlan, CapsuleReleaseType } from '../generated/prisma/enums.js';

/**
 * Subscription-plan configuration (Free / Starter / Pro).
 *
 * One place defines what each plan grants so quota checks, billing, and the
 * `/users/me` payload all agree. `LEGACY_PREMIUM` is a dormant enum value
 * (see schema.prisma) — every map below still needs a key for it to satisfy
 * TypeScript, set to PRO's values as the most-generous fallback in the
 * vanishingly unlikely case any row is still on it.
 *
 * A future AI query/chat feature will reuse this same pattern — see
 * `PLAN_AI_PROMPT_LIMIT` at the bottom, not enforced anywhere yet.
 */

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** Base storage allocation per plan, in bytes. */
export const PLAN_STORAGE_BYTES: Record<SubscriptionPlan, number> = {
  FREE: 500 * MB,
  STARTER: 5 * GB,
  PRO: 20 * GB,
  LEGACY_PREMIUM: 20 * GB,
};

/** Max number of memorial pages a user may create; null = unlimited. */
export const PLAN_MEMORIAL_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 1,
  STARTER: 3,
  PRO: null,
  LEGACY_PREMIUM: null,
};

/** Max number of photo items; null = unlimited. (Free is capped at 20.) */
export const PLAN_PHOTO_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 20,
  STARTER: null,
  PRO: null,
  LEGACY_PREMIUM: null,
};

/** Whether ads are shown. Ads on the free tier only. */
export const PLAN_ADS_ENABLED: Record<SubscriptionPlan, boolean> = {
  FREE: true,
  STARTER: false,
  PRO: false,
  LEGACY_PREMIUM: false,
};

/** Display price in USD/month (for reference / the /plans endpoint). */
export const PLAN_PRICE_USD: Record<SubscriptionPlan, number> = {
  FREE: 0,
  STARTER: 10,
  PRO: 20,
  LEGACY_PREMIUM: 20,
};

/**
 * Max number of non-cancelled Time Capsules a user may own; null = unlimited.
 * Currently ungated for everyone — this is a real monetization gap on the
 * platform's headline feature.
 */
export const PLAN_CAPSULE_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 1,
  STARTER: 10,
  PRO: null,
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
  STARTER: ['SCHEDULED_DATE', 'RECURRING_ANNUAL', 'GUARDIAN_CONTROLLED'],
  PRO: ['SCHEDULED_DATE', 'RECURRING_ANNUAL', 'GUARDIAN_CONTROLLED'],
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
  STARTER: 3,
  PRO: null,
  LEGACY_PREMIUM: null,
};

/** Max number of Scheduled Messages a user may own; null = unlimited. */
export const PLAN_SCHEDULED_MESSAGE_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 2,
  STARTER: 25,
  PRO: null,
  LEGACY_PREMIUM: null,
};

/** Max number of Groups a user may own (create); null = unlimited. */
export const PLAN_GROUP_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 1,
  STARTER: 5,
  PRO: null,
  LEGACY_PREMIUM: null,
};

/**
 * Max participants per group, gated by the GROUP OWNER's plan (not the
 * calling admin's) — a group's capacity is a property of whoever owns it.
 * null = unlimited.
 */
export const PLAN_GROUP_PARTICIPANT_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 5,
  STARTER: 20,
  PRO: null,
  LEGACY_PREMIUM: null,
};

/**
 * Max AI eulogy generations per calendar month (UTC); null = unlimited. This
 * is the one dimension mapping to real metered third-party spend (a live
 * Anthropic API call per generation, with zero abuse control before this).
 * Counted via the EulogyGeneration log table, not Eulogy rows — see
 * eulogy.service.ts for why (regenerations update Eulogy in place).
 */
export const PLAN_EULOGY_GENERATION_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 1,
  STARTER: 5,
  PRO: 20,
  LEGACY_PREMIUM: 20,
};

/**
 * NOT ENFORCED ANYWHERE YET. Reserved for the future AI query/chat feature
 * (ChatGPT + Claude, per product direction). Per calendar month, same
 * convention as PLAN_EULOGY_GENERATION_LIMIT above.
 */
export const PLAN_AI_PROMPT_LIMIT: Record<SubscriptionPlan, number> = {
  FREE: 0,
  STARTER: 20,
  PRO: 100,
  LEGACY_PREMIUM: 100,
};

/** Stripe Price IDs per paid plan (from the dashboard, via env). */
export function planPriceId(plan: SubscriptionPlan): string | undefined {
  switch (plan) {
    case 'STARTER':
      return env.STRIPE_PRICE_STARTER;
    case 'PRO':
      return env.STRIPE_PRICE_PRO;
    default:
      return undefined;
  }
}

export const PAID_PLANS: SubscriptionPlan[] = ['STARTER', 'PRO'];

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
