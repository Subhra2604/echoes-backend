import { env } from './env.js';
import type { SubscriptionPlan, CapsuleReleaseType, BillingInterval } from '../generated/prisma/enums.js';

/**
 * Subscription-plan configuration — the client's final pricing:
 *
 *   MEMORY  $7.99/mo  · $79.99/yr   "Your story. Preserved."
 *   FAMILY  $14.99/mo · $149.99/yr  "Your family's story. Together."
 *   LEGACY  $29.99/mo · $299.99/yr  "Your life. Your voice. Your legacy."
 *
 * All three are sold with a 7-day free trial (see TRIAL_PERIOD_DAYS).
 *
 * FREE is NOT a sold tier. It is the floor state for an account with no active
 * paid subscription — signed up but never subscribed, or trial/subscription
 * cancelled — so it is deliberately minimal rather than a usable free product.
 *
 * Feature gating follows the published pricing copy literally: anything the
 * copy lists as something Family *adds* (Time Capsules, scheduled messages,
 * family sharing/collaboration) starts at FAMILY and is absent from MEMORY.
 * Features the copy never enumerates (e.g. AI eulogy drafting) are allocated by
 * cost: cheap ones get a small MEMORY allowance, expensive ones scale upward.
 *
 * Gates are creation-time only — a downgrade never deletes or disables
 * resources a user already created.
 */

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** Length of the free trial granted on every paid plan, in days. */
export const TRIAL_PERIOD_DAYS = 7;

/**
 * Base storage allocation per plan, in bytes.
 *
 * Sized for perceived value, not cost containment: at S3 list price
 * (~$0.023/GB-month) even a completely full LEGACY account costs ~$7/month
 * against a $29.99 price. Storage is the cheapest thing this product sells, so
 * the caps exist to bound outright abuse and to leave room for paid add-on
 * packs later — not to protect margin.
 */
export const PLAN_STORAGE_BYTES: Record<SubscriptionPlan, number> = {
  FREE: 500 * MB,
  MEMORY: 25 * GB,
  FAMILY: 100 * GB,
  LEGACY: 300 * GB,
};

/** Max number of memorial pages a user may create; null = unlimited. */
export const PLAN_MEMORIAL_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 1,
  MEMORY: 3,
  FAMILY: null,
  LEGACY: null,
};

/** Max number of photo items; null = unlimited. */
export const PLAN_PHOTO_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 20,
  MEMORY: null,
  FAMILY: null,
  LEGACY: null,
};

/** Whether ads are shown. No paid tier shows ads. */
export const PLAN_ADS_ENABLED: Record<SubscriptionPlan, boolean> = {
  FREE: true,
  MEMORY: false,
  FAMILY: false,
  LEGACY: false,
};

/**
 * Customer-facing name and tagline per plan, straight from the published
 * pricing page. Served by /api/billing/plans so the pricing UI and the gates
 * enforcing it can't drift apart. FREE is unsold, so it gets a neutral label
 * used only when showing a lapsed account its current state.
 */
export const PLAN_DISPLAY: Record<SubscriptionPlan, { name: string; tagline: string }> = {
  FREE: { name: 'Free', tagline: 'No active subscription.' },
  MEMORY: { name: 'Memory', tagline: 'Your story. Preserved.' },
  FAMILY: { name: 'Family', tagline: "Your family's story. Together." },
  LEGACY: { name: 'Legacy', tagline: 'Your life. Your voice. Your legacy.' },
};

/**
 * Display prices in USD, per billing interval. Reference/display values for the
 * /plans catalog — the amount actually charged comes from the Stripe Price.
 * Keep these in sync with the Stripe dashboard.
 */
export const PLAN_PRICING: Record<SubscriptionPlan, { monthly: number; yearly: number }> = {
  FREE: { monthly: 0, yearly: 0 },
  MEMORY: { monthly: 7.99, yearly: 79.99 },
  FAMILY: { monthly: 14.99, yearly: 149.99 },
  LEGACY: { monthly: 29.99, yearly: 299.99 },
};

/**
 * Max number of non-cancelled, non-released Time Capsules a user may own;
 * null = unlimited. RELEASED/CANCELLED capsules don't count — a fulfilled
 * capsule shouldn't permanently occupy a slot.
 *
 * Time Capsules are a FAMILY feature per the pricing copy; MEMORY gets none.
 */
export const PLAN_CAPSULE_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 0,
  MEMORY: 0,
  FAMILY: 15,
  LEGACY: null,
};

/**
 * Which capsule release types a plan may create. LEGACY's "premium Time
 * Capsules and future messages" is expressed here: FAMILY gets the standard
 * one-shot scheduled release, LEGACY additionally gets the perpetual
 * RECURRING_ANNUAL commitment and GUARDIAN_CONTROLLED release.
 */
export const PLAN_CAPSULE_RELEASE_TYPES: Record<SubscriptionPlan, CapsuleReleaseType[]> = {
  FREE: [],
  MEMORY: [],
  FAMILY: ['SCHEDULED_DATE'],
  LEGACY: ['SCHEDULED_DATE', 'RECURRING_ANNUAL', 'GUARDIAN_CONTROLLED'],
};

/**
 * Max number of contact-based Guardians a user may assign; null = unlimited.
 * Guardians are part of FAMILY's shared-legacy tooling. Applies only to the
 * contact-based `Guardian` model — NOT the separate legacy email-invitation
 * `GuardianInvitation` system, which keeps its own "must keep at least one"
 * floor rule untouched.
 */
export const PLAN_GUARDIAN_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 0,
  MEMORY: 0,
  FAMILY: 5,
  LEGACY: null,
};

/** Max Scheduled Messages a user may own; null = unlimited. FAMILY feature. */
export const PLAN_SCHEDULED_MESSAGE_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 0,
  MEMORY: 0,
  FAMILY: 50,
  LEGACY: null,
};

/**
 * Max number of Groups a user may own (create); null = unlimited. Groups are
 * the "family sharing / expanded collaboration" FAMILY feature.
 */
export const PLAN_GROUP_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 0,
  MEMORY: 0,
  FAMILY: 10,
  LEGACY: null,
};

/**
 * Max participants per group, gated by the GROUP OWNER's plan (not the calling
 * admin's) — a group's capacity is a property of whoever owns it.
 * null = unlimited.
 *
 * FREE/MEMORY can't create groups at all (PLAN_GROUP_LIMIT is 0), but they keep
 * a non-zero participant allowance so a group created under an earlier plan
 * stays usable after a downgrade instead of rejecting every add.
 */
export const PLAN_GROUP_PARTICIPANT_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 5,
  MEMORY: 5,
  FAMILY: 20,
  LEGACY: null,
};

/**
 * Max AI eulogy generations per calendar month (UTC); null = unlimited.
 *
 * The pricing copy doesn't enumerate eulogy drafting under any tier, so it's
 * allocated by cost instead: a Claude Haiku generation runs well under a cent,
 * cheap enough to give MEMORY a real taste of it rather than withholding the
 * feature from a paid tier for no saving. Even LEGACY stays bounded rather than
 * unlimited — this maps to metered third-party spend on every call.
 *
 * Counted via the EulogyGeneration log table, not Eulogy rows — see
 * eulogy.service.ts for why (regenerations update Eulogy in place).
 */
export const PLAN_EULOGY_GENERATION_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 0,
  MEMORY: 2,
  FAMILY: 15,
  LEGACY: 50,
};

/**
 * Max AI age-progression image jobs per calendar month (UTC); null =
 * unlimited. Counted directly off ImageAgingJob.createdAt — unlike eulogies,
 * every real generation attempt creates a fresh row, so no separate log table
 * is needed (there's no in-place "regenerate" hiding a repeat call).
 *
 * This is the most expensive call in the app (~$0.04/image, several times a
 * eulogy generation), and LEGACY's "advanced AI-powered memory experiences" is
 * expressed as a 4x allowance over FAMILY rather than as exclusive access —
 * 5 images/month costs ~$0.20, too little to justify withholding the headline
 * AI feature from a $14.99 tier.
 */
export const PLAN_IMAGE_AGING_LIMIT: Record<SubscriptionPlan, number | null> = {
  FREE: 0,
  MEMORY: 0,
  FAMILY: 5,
  LEGACY: 20,
};

/**
 * Max AI Q&A questions ("AI prompts") per calendar month (UTC). No tier is
 * unlimited (even LEGACY is capped) — every call is a real, metered
 * Anthropic (Claude Haiku) call. Enforced by ai-prompt.service.ts via the
 * AiPrompt table, same per-month-UTC convention as
 * PLAN_EULOGY_GENERATION_LIMIT above.
 */
export const PLAN_AI_PROMPT_LIMIT: Record<SubscriptionPlan, number> = {
  FREE: 0,
  MEMORY: 0,
  FAMILY: 50,
  LEGACY: 200,
};

/**
 * Stripe Price IDs — one per (paid plan x billing interval) pair, from the
 * Stripe dashboard via env.
 */
export function planPriceId(plan: SubscriptionPlan, interval: BillingInterval): string | undefined {
  const yearly = interval === 'YEAR';
  switch (plan) {
    case 'MEMORY':
      return yearly ? env.STRIPE_PRICE_MEMORY_YEARLY : env.STRIPE_PRICE_MEMORY_MONTHLY;
    case 'FAMILY':
      return yearly ? env.STRIPE_PRICE_FAMILY_YEARLY : env.STRIPE_PRICE_FAMILY_MONTHLY;
    case 'LEGACY':
      return yearly ? env.STRIPE_PRICE_LEGACY_YEARLY : env.STRIPE_PRICE_LEGACY_MONTHLY;
    default:
      return undefined;
  }
}

/** The three publicly sold tiers, cheapest first. FREE is excluded by design. */
export const PAID_PLANS: SubscriptionPlan[] = ['MEMORY', 'FAMILY', 'LEGACY'];

export const BILLING_INTERVALS: BillingInterval[] = ['MONTH', 'YEAR'];

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
