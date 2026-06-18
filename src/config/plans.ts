import { env } from './env.js';
import type { SubscriptionPlan } from '../generated/prisma/enums.js';

/**
 * Subscription-plan configuration (Echoes Remembered framework).
 *
 * One place defines what each plan grants so quota checks, billing, and the
 * `/users/me` payload all agree. Deferred to a later phase: storage add-on
 * packs, and premium feature gating (eulogy video, AI tribute videos, voice
 * playback, private family network). Those will extend this table without
 * changing call sites.
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
