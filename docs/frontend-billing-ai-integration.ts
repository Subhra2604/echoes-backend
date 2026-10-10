/**
 * Echoes Backend — Billing/Plans (Stripe) + AI Features: single handover file.
 *
 * Covers everything added recently:
 *   - Billing/Plans: Memory/Family/Legacy, monthly+yearly pricing, 7-day
 *     trial, Stripe Checkout (first subscription) + Billing Portal (manage
 *     an existing one) — LIVE, proven end-to-end on real Stripe test-mode
 *     traffic as of 2026-10-06
 *   - GET /api/billing/entitlements — one call that says what the user's plan
 *     includes and how much is left of each limit (drive locks/counters from it)
 *   - Eulogy AI (guided prompts, Haiku model, PDF export)
 *   - Image Aging AI (async job flow, Gemini)
 *   - AI Prompts (one-shot Q&A, Claude only — shipped 2026-10-06)
 *   - The QUOTA_EXCEEDED pattern — applies across EVERY plan-gated feature,
 *     including the ones you've already integrated (Capsules, Guardians,
 *     Scheduled Messages, Groups), not just the ones defined in this file
 *
 * Does NOT re-cover Guardians / Time Capsules / Scheduled Messages /
 * Contacts+Groups / Notifications CRUD — already integrated, unchanged.
 * Eulogy has NO share/export path beyond PDF — no group-sharing, no public
 * link — don't build UI assuming either exists.
 *
 * All shapes verified against https://backend.echoesremembered.com as of
 * 2026-10-06 — real Stripe subscriptions (checkout through cancellation),
 * real Anthropic calls (Eulogy + AI Prompts), real Gemini image generations
 * (including a real failure path). Full interactive docs:
 * https://backend.echoesremembered.com/docs/
 */

const BASE_URL = 'https://backend.echoesremembered.com';
let accessToken = '';

async function apiFetch<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const refreshed = res.headers.get('x-refresh-token');
  if (refreshed) accessToken = refreshed;
  if (res.status === 204) return undefined as T;
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data.error?.code, data.error?.message ?? `Request failed (${res.status})`, data.error?.details);
  return data as T;
}

/**
 * Every error response is `{ error: { code, message, details? } }`. See
 * section 9 for the full code -> UI-treatment table. The one you'll hit most
 * often here is QUOTA_EXCEEDED (402) — never show it as a generic error.
 */
class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

// ============================================================================
// 1. App bootstrap — one call drives plan state + trial/payment banners
// ============================================================================

interface Me {
  id: string;
  email: string;
  fullName: string;
  plan: 'FREE' | 'MEMORY' | 'FAMILY' | 'LEGACY';
  storageUsedBytes: number;
  storageLimitBytes: number;
  memorialLimit: number | null;
  adsEnabled: boolean;
  subscription: {
    status: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELLED' | 'INCOMPLETE';
    billingInterval: 'MONTH' | 'YEAR' | null;
    trialEndsAt: string | null;      // ISO; show "trial ends in N days"
    currentPeriodEnd: string | null; // ISO; next renewal date
    /**
     * true = the customer pressed "Cancel plan" in Stripe, but the plan is NOT
     * over yet: Stripe keeps it ACTIVE (full access) until the paid period runs
     * out, then it drops to FREE by itself. Status stays 'ACTIVE' / 'TRIALING'
     * the whole time — this flag is the only signal.
     */
    cancelAtPeriodEnd: boolean;
    /** ISO date full access ends when cancelAtPeriodEnd is true, otherwise null. */
    accessEndsAt: string | null;
  } | null; // null = no REAL Stripe subscription (never subscribed, OR started checkout but never finished)
}

/** Call once after login, cache in your global/session store. */
function getMe() {
  return apiFetch<Me>('/api/users/me');
}
// Real example response, mid-trial on Family (verified 2026-10-06 against a
// real Stripe test subscription, not a mock):
//   { id: "9510cfb6-...", email: "user@example.com", plan: "FAMILY",
//     storageLimitBytes: 107374182400, memorialLimit: null, adsEnabled: false,
//     subscription: {
//       status: "TRIALING", billingInterval: "MONTH",
//       trialEndsAt: "2026-10-13T14:42:57.000Z",
//       currentPeriodEnd: "2026-10-13T14:42:57.000Z", // next renewal date; during a
//                                                    // trial it equals trialEndsAt
//       cancelAtPeriodEnd: false, accessEndsAt: null,
//     } }
//
// NOTE: until 2026-10-10 this field was wrongly always null (the backend read it
// from where Stripe no longer puts it). Fixed — show it as "Renews on <date>"
// (ACTIVE) or "First charge on <date>" (TRIALING). Subscriptions that were
// last synced before the fix get their date on the next Stripe update; treat
// null as "date not available yet", not as an error.
//
// Real example response, a subscription that was cancelled (NOT the same as
// never-subscribed — subscription is a real object here, just cleared out.
// Check subscription === null vs status === 'CANCELLED' for different UI:
// the latter might want a "come back" message instead of a plain pricing page):
//   { ..., plan: "FREE", subscription: { status: "CANCELLED",
//     billingInterval: null, trialEndsAt: null, currentPeriodEnd: null,
//     cancelAtPeriodEnd: false, accessEndsAt: null } }
//
// Real example, user cancelled in the portal but the paid period isn't over
// (plan still LEGACY, full access):
//   { ..., plan: "LEGACY", subscription: { status: "ACTIVE", billingInterval: "MONTH",
//     trialEndsAt: "2026-10-10T06:58:57.000Z", currentPeriodEnd: "2026-11-10T06:58:58.000Z",
//     cancelAtPeriodEnd: true, accessEndsAt: "2026-11-10T06:58:58.000Z" } }
//
// Real example response, never subscribed (also what you get if checkout was
// started but abandoned — no card entered, nothing subscribed):
//   { ..., plan: "FREE", storageLimitBytes: 524288000, subscription: null }

/**
 * Recommended app-shell logic:
 *
 *   const me = await getMe();
 *
 *   // Storage bar
 *   const usedFraction = me.storageUsedBytes / me.storageLimitBytes;
 *
 *   // Trial banner — only while TRIALING.
 *   if (me.subscription?.status === 'TRIALING' && me.subscription.trialEndsAt) {
 *     const daysLeft = Math.ceil((new Date(me.subscription.trialEndsAt).getTime() - Date.now()) / 86_400_000);
 *     showBanner(`Your free trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`);
 *   }
 *
 *   // Payment-failed banner — status flips to PAST_DUE while Stripe retries
 *   // the card. You'll also get a PAYMENT_FAILED notification (section 10)
 *   // the moment it happens; this check covers someone who dismissed that.
 *   if (me.subscription?.status === 'PAST_DUE') {
 *     showBanner('Your last payment failed. Update your card to keep your plan.', {
 *       action: 'Manage billing', onClick: openBillingPortal,
 *     });
 *   }
 *
 *   // Cancelled but still running. When the user taps "Cancel plan" in Stripe's
 *   // portal NOTHING changes immediately: they paid for this period, so they
 *   // keep the plan (status stays ACTIVE) until the period ends, and Stripe then
 *   // ends it and the plan becomes FREE automatically. Without this banner the
 *   // user sees no sign that their cancel worked.
 *   if (me.subscription?.cancelAtPeriodEnd && me.subscription.accessEndsAt) {
 *     showBanner(`Your plan ends on ${formatDate(me.subscription.accessEndsAt)}. You keep full access until then.`, {
 *       action: 'Resume plan', onClick: openBillingPortal, // the portal has the resume / renew button
 *     });
 *   }
 *
 * IMPORTANT: gate every feature on `me.plan`, never on `subscription.status` or
 * `cancelAtPeriodEnd`. TRIALING grants FULL access to the plan — that's the point
 * of a trial — and so does a plan that is cancelled-but-not-yet-ended.
 *
 * What the user's cancel looks like, step by step:
 *   1. User opens the portal (POST /api/billing/portal) and taps Cancel plan.
 *   2. Back in the app (echoes://billing/return?status=portal) -> call getMe().
 *      plan is unchanged, status 'ACTIVE', cancelAtPeriodEnd: true,
 *      accessEndsAt: "2026-11-10T06:58:58.000Z"  -> show the banner above.
 *   3. If they change their mind: portal -> Resume/Renew. getMe() then shows
 *      cancelAtPeriodEnd: false, accessEndsAt: null.
 *   4. On accessEndsAt Stripe ends the subscription: plan becomes FREE,
 *      status 'CANCELLED', cancelAtPeriodEnd false (they also lose paid
 *      features; existing data is kept). Re-fetch on app open to pick it up.
 * To end a plan immediately instead (support / testing), cancel it in the Stripe
 * dashboard with "Cancel immediately" — it goes to FREE within a second.
 */

// ============================================================================
// 2. Plan catalog — prices, storage, every feature limit, for your pricing page
// ============================================================================

type PlanId = 'FREE' | 'MEMORY' | 'FAMILY' | 'LEGACY';
type PaidPlanId = 'MEMORY' | 'FAMILY' | 'LEGACY';
type BillingInterval = 'MONTH' | 'YEAR';

interface PlanInfo {
  plan: PlanId;
  name: string;    // "Memory" / "Family" / "Legacy"
  tagline: string; // e.g. "Your story. Preserved."
  purchasable: boolean; // false for FREE — filter on this for the pricing page
  priceUsd: { monthly: number; yearly: number };
  storageBytes: number;
  ads: boolean;
  /** null = unlimited, 0 = feature NOT included on this plan. */
  limits: {
    memorials: number | null;
    photos: number | null;
    capsules: number | null;
    capsuleReleaseTypes: Array<'SCHEDULED_DATE' | 'RECURRING_ANNUAL' | 'GUARDIAN_CONTROLLED'>;
    guardians: number | null;
    scheduledMessages: number | null;
    groups: number | null;
    groupParticipants: number | null;
    eulogyGenerationsPerMonth: number | null;
    imageAgingPerMonth: number | null;
    aiPromptsPerMonth: number; // 0 = not on this plan; no plan is unlimited
  };
}

/** GET /api/billing/plans — public, no auth. Render your pricing page from this. */
function getPlanCatalog() {
  return apiFetch<{ trialDays: number; plans: PlanInfo[] }>('/api/billing/plans');
}
// Response shape (abridged — FREE is included but has purchasable: false):
//   { trialDays: 7, plans: [
//     { plan: "MEMORY", name: "Memory", tagline: "Your story. Preserved.",
//       purchasable: true, priceUsd: { monthly: 7.99, yearly: 79.99 },
//       storageBytes: 26843545600, ads: false,
//       limits: { memorials: 3, photos: null, capsules: 0, capsuleReleaseTypes: [],
//                 guardians: 0, scheduledMessages: 0, groups: 0, groupParticipants: 5,
//                 eulogyGenerationsPerMonth: 2, imageAgingPerMonth: 0, aiPromptsPerMonth: 0 } },
//     { plan: "FAMILY", ..., priceUsd: { monthly: 14.99, yearly: 149.99 }, storageBytes: 107374182400,
//       limits: { capsules: 15, capsuleReleaseTypes: ["SCHEDULED_DATE"], guardians: 5,
//                 scheduledMessages: 50, groups: 10, eulogyGenerationsPerMonth: 15, imageAgingPerMonth: 5,
//                 aiPromptsPerMonth: 50, ... } },
//     { plan: "LEGACY", ..., priceUsd: { monthly: 29.99, yearly: 299.99 }, storageBytes: 322122547200,
//       limits: { capsules: null, capsuleReleaseTypes: ["SCHEDULED_DATE","RECURRING_ANNUAL","GUARDIAN_CONTROLLED"],
//                 guardians: null, scheduledMessages: null, groups: null,
//                 eulogyGenerationsPerMonth: 50, imageAgingPerMonth: 20, aiPromptsPerMonth: 200, ... } }
//   ] }
//
// A limit of 0 means "not on this plan" (show a lock/upsell); null means
// unlimited. Don't render "0" as a quantity. Time Capsules, scheduled
// messages, guardians and sharing groups all start at FAMILY — MEMORY is
// vault-only.

// ============================================================================
// 3. Feature gating — ONE call: GET /api/billing/entitlements
// ============================================================================

/**
 * "What does MY plan include, and how much do I have left?" — one authenticated
 * call that returns the user's plan plus, for every plan-gated feature, whether
 * it's included, whether they can still use it right now, and the numbers to
 * show ("3 of 15 used", "resets Nov 1"). Drive every lock / unlock / counter in
 * the app from this instead of hard-coding plan names.
 *
 * Verified on production 2026-10-09 against real FREE/MEMORY/FAMILY/LEGACY
 * accounts, including that `canUse` agrees with what the real create endpoints
 * then do (402 when canUse is false).
 */
interface FeatureEntitlement {
  /** The plan has this feature at all (limit is not 0). false -> show a LOCK + upgrade. */
  included: boolean;
  /** included AND not used up -> the create call will not be refused for quota. */
  canUse: boolean;
  /** Max allowed. null = unlimited (hide any counter), 0 = not on this plan. */
  limit: number | null;
  /** How many the user has now ('lifetime') or has used this month ('month'). */
  used: number;
  /** limit - used (never below 0). null when unlimited. */
  remaining: number | null;
  /** 'lifetime' = total currently owned. 'month' = counter resets on the 1st (UTC). */
  period: 'lifetime' | 'month';
  /** ISO time the monthly counter resets (first of next month, UTC). null for lifetime. */
  resetsAt: string | null;
}

interface Entitlements {
  plan: PlanId;
  planName: string; // "Family"
  ads: boolean;     // show ads? (only FREE does)
  /** Same object as /users/me.subscription (null = no real Stripe subscription). */
  subscription: Me['subscription'];
  storage: {
    usedBytes: number;
    limitBytes: number;
    remainingBytes: number;
    warningLevel: 80 | 90 | 100 | null; // null until 80% full; drive the storage banner from this
  };
  features: {
    memorials: FeatureEntitlement;
    photos: FeatureEntitlement;
    timeCapsules: FeatureEntitlement & {
      /** Which release types this plan may create. Only offer these in the picker. */
      releaseTypes: Array<'SCHEDULED_DATE' | 'RECURRING_ANNUAL' | 'GUARDIAN_CONTROLLED'>;
    };
    guardians: FeatureEntitlement;
    scheduledMessages: FeatureEntitlement;
    groups: FeatureEntitlement & {
      /** Per group, set by the group OWNER's plan. null = unlimited. */
      maxParticipantsPerGroup: number | null;
    };
    eulogyGenerations: FeatureEntitlement; // monthly
    imageAging: FeatureEntitlement;        // monthly
    aiPrompts: FeatureEntitlement;         // monthly
  };
}

/** GET /api/billing/entitlements — auth required, never cached. */
function getEntitlements() {
  return apiFetch<Entitlements>('/api/billing/entitlements');
}
// Example (the shape is exactly what the API returns; the numbers are illustrative —
// a FAMILY user mid-trial with 3 capsules and 2 AI questions used this month):
//   { plan: "FAMILY", planName: "Family", ads: false,
//     subscription: { status: "TRIALING", billingInterval: "MONTH",
//                     trialEndsAt: "2026-10-16T03:20:36.000Z", currentPeriodEnd: "2026-10-16T03:20:36.000Z",
//                     cancelAtPeriodEnd: false, accessEndsAt: null },
//     storage: { usedBytes: 1048576, limitBytes: 107374182400, remainingBytes: 107373134848, warningLevel: null },
//     features: {
//       memorials:  { included: true, canUse: true, limit: null, used: 0, remaining: null, period: "lifetime", resetsAt: null },
//       photos:     { included: true, canUse: true, limit: null, used: 12, remaining: null, period: "lifetime", resetsAt: null },
//       timeCapsules: { included: true, canUse: true, limit: 15, used: 3, remaining: 12, period: "lifetime", resetsAt: null,
//                       releaseTypes: ["SCHEDULED_DATE"] },
//       guardians:  { included: true, canUse: true, limit: 5, used: 1, remaining: 4, period: "lifetime", resetsAt: null },
//       scheduledMessages: { included: true, canUse: true, limit: 50, used: 0, remaining: 50, period: "lifetime", resetsAt: null },
//       groups:     { included: true, canUse: true, limit: 10, used: 0, remaining: 10, period: "lifetime", resetsAt: null,
//                     maxParticipantsPerGroup: 20 },
//       eulogyGenerations: { included: true, canUse: true, limit: 15, used: 0, remaining: 15, period: "month", resetsAt: "2026-11-01T00:00:00.000Z" },
//       imageAging: { included: true, canUse: true, limit: 5, used: 0, remaining: 5, period: "month", resetsAt: "2026-11-01T00:00:00.000Z" },
//       aiPrompts:  { included: true, canUse: true, limit: 50, used: 2, remaining: 48, period: "month", resetsAt: "2026-11-01T00:00:00.000Z" }
//     } }
//
// A FREE user gets the same shape with `included: false, canUse: false, limit: 0`
// on everything the plan lacks (capsules, guardians, scheduled messages, groups,
// eulogies, image aging, AI prompts), and memorials limit 1 / photos limit 20.

/**
 * The three states every feature button / screen can be in:
 *
 *   !included           -> LOCKED. Show a lock icon; tapping opens the upgrade
 *                          prompt. ("Your plan doesn't include Time Capsules.")
 *   included && !canUse -> LIMIT REACHED. Plan has it but it's used up. Monthly
 *                          features: "You've used all 5 this month — resets Nov 1"
 *                          (from resetsAt). Lifetime features: "Delete one or
 *                          upgrade for more." Don't offer the create action.
 *   included && canUse  -> ENABLED. If `remaining` is not null you can show
 *                          "12 left"; if it's null it's unlimited — show no counter.
 */
type FeatureState = 'locked' | 'limit_reached' | 'enabled';
function featureState(f: FeatureEntitlement): FeatureState {
  if (!f.included) return 'locked';
  return f.canUse ? 'enabled' : 'limit_reached';
}
// Usage:
//   const ent = await getEntitlements();
//   featureState(ent.features.aiPrompts)    // 'locked' on FREE/MEMORY, 'enabled' on FAMILY
//   ent.features.timeCapsules.releaseTypes  // which options to show in the release-type picker
//   ent.features.groups.maxParticipantsPerGroup // cap the "add people" screen
//   ent.storage.warningLevel                // 80/90/100 -> storage banner

/**
 * WHEN TO CALL IT (it is cheap, but it is per-user and changes constantly, so
 * keep it in memory only — never persist it between app launches):
 *
 *   - after login and on every app launch / return to foreground
 *   - after coming back from Stripe (handleBillingReturn, section 4) — the plan
 *     just changed, so every lock may have flipped
 *   - after a successful create of anything plan-gated, so the "N left" counters
 *     and the limit-reached state update (or decrement locally and refetch later)
 *   - when a create call returns 402 QUOTA_EXCEEDED (section 5) — your copy was stale
 *
 * RULES:
 *   1. Gate on this response, NOT on plan names. Never write `if (plan === 'FAMILY')`
 *      — limits change on the server and the app then updates with no release.
 *   2. This only drives the UI. The server still enforces every limit when the
 *      create call is made (402 QUOTA_EXCEEDED), so keep the withQuotaHandling
 *      wrapper from section 5 on every create call — two devices, or a stale
 *      screen, can still race past what you showed.
 *   3. A TRIALING user has FULL access to the plan they picked; this endpoint
 *      already reflects that (plan = FAMILY while subscription.status = TRIALING).
 *   4. After a downgrade or cancel, `used` can be larger than `limit` (existing
 *      items are never deleted). `remaining` is then 0 and canUse false: they can
 *      still view / edit what they have, they just can't create more.
 *   5. `subscription` here is identical to /users/me — you don't need both for
 *      billing banners (trial ending, payment failed), but /users/me is still
 *      the call for profile info.
 */

// ============================================================================
// 4. Subscribing & managing a plan — Checkout (first time) vs. Portal (after)
// ============================================================================

/**
 * POST /api/billing/checkout — starts a Stripe Checkout session for a user's
 * FIRST subscription only. Redirect the browser to the returned `checkoutUrl`.
 * Stripe collects the card, starts the 7-day free trial, and the webhook
 * activates the plan server-side — no further client action needed.
 *
 * Returns 400 "You already have an active subscription. Use the billing
 * portal to change your plan." if already ACTIVE/TRIALING — Checkout always
 * starts a brand NEW Stripe subscription, it has no concept of "replace my
 * existing one", so a second call here would double-bill, not switch plans.
 *
 * LIVE as of 2026-10-06 — verified end to end with a real Stripe test-mode
 * subscription (real checkout session, real 7-day trial, real webhook
 * activating the plan). Currently running on Stripe TEST keys, so no real
 * card is charged; the request/response contract is identical once the
 * account switches to live keys.
 */
function startCheckout(plan: PaidPlanId, interval: BillingInterval = 'MONTH') {
  return apiFetch<{ checkoutUrl: string; trialDays: number }>('/api/billing/checkout', {
    method: 'POST',
    body: { plan, interval },
  });
}
// Request body sent:  { "plan": "FAMILY", "interval": "YEAR" }
// Real example response (verified 2026-10-06):
//   { checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_a10rJhx5...",
//     trialDays: 7 }
// Usage:
//   const { checkoutUrl } = await startCheckout('FAMILY', 'YEAR');
//   window.location.href = checkoutUrl;

/**
 * POST /api/billing/portal — for an EXISTING subscriber. Opens Stripe's
 * hosted billing portal: upgrade/downgrade, switch monthly<->yearly, update
 * card, or cancel — no custom UI needed for any of that. Redirect the
 * browser to the returned `portalUrl`.
 *
 * Returns 400 "No billing account found — subscribe to a plan first" if the
 * user has never been through checkout.
 *
 * Plan-switching specifically (upgrade/downgrade/interval change) was NOT
 * actually live when this was first written on 2026-10-06 — the portal
 * loaded fine, but the "Update subscription" button simply didn't appear,
 * because of a Stripe-side configuration gap (not a bug in this endpoint).
 * Fixed and CONFIRMED WORKING 2026-10-08 — verified by opening a real
 * portal session for a real trialing subscriber and seeing the "Update
 * subscription" button actually render. Switching is prorated: the user is
 * charged/credited the difference immediately, not at next renewal.
 */
function openBillingPortal() {
  return apiFetch<{ portalUrl: string }>('/api/billing/portal', { method: 'POST' });
}
// Request body: none.
// Real example response (verified 2026-10-06):
//   { portalUrl: "https://billing.stripe.com/p/session?secret=test_YWNj..." }
// Usage:
//   const { portalUrl } = await openBillingPortal();
//   window.location.href = portalUrl;

/**
 * THE ROUTING RULE — get this wrong and users get stuck on FREE:
 *
 *   me.subscription is null, CANCELLED, or anything else  -> startCheckout()
 *   me.subscription.status is ACTIVE, TRIALING or PAST_DUE -> openBillingPortal()
 *
 * Why it matters: ONLY Checkout (/api/billing/checkout) creates a
 * subscription and starts the 7-day trial. The portal can save a card and
 * show invoices, but it can NEVER start a trial or subscribe anyone. A user
 * who taps "Start free trial", lands on a Stripe page showing "Payment
 * method" and "Invoice history" (billing.stripe.com), and "adds a card"
 * there has NOT subscribed — they stay on FREE. If that's what they see, the
 * app called the portal when it should have called checkout. The real
 * subscribe page is checkout.stripe.com and ends in a "Start trial" button.
 *
 * `subscription` is null whenever there is no REAL Stripe subscription —
 * including someone who opened checkout but never finished it. The backend
 * guarantees this, so `!me.subscription` is a safe "never subscribed" test.
 *
 * Testing the subscribe flow: use a FRESH FREE account. The shared
 * frontend-memory/family/legacy test accounts have their plan pre-set by
 * hand (for checking plan limits), so they don't behave like a real signup.
 */
const PORTAL_STATUSES = ['ACTIVE', 'TRIALING', 'PAST_DUE'];

async function handleManagePlanClick(me: Me, choice?: { plan: PaidPlanId; interval: BillingInterval }) {
  if (me.subscription && PORTAL_STATUSES.includes(me.subscription.status)) {
    // Already subscribed -> upgrade/downgrade/card/cancel all happen in Stripe's portal.
    const { portalUrl } = await openBillingPortal();
    window.location.href = portalUrl;
  } else {
    // Never subscribed, abandoned checkout, or cancelled -> subscribe via Checkout.
    if (!choice) throw new Error('Pass the plan/interval the user picked on the pricing page');
    const { checkoutUrl } = await startCheckout(choice.plan, choice.interval);
    window.location.href = checkoutUrl;
  }
}

/**
 * COMING BACK FROM STRIPE — how the user gets from Stripe back into the app.
 *
 * Stripe redirects the browser to a normal web URL, so it sends the user to
 * our own page, GET https://backend.echoesremembered.com/api/billing/return
 * (public, no auth). That page then opens the app with a FIXED deep link. The
 * backend sets these URLs on every Checkout/Portal session itself — nothing to
 * configure on your side except handling the links in the app:
 *
 *   Stripe screen finished      Stripe sends the browser to              status
 *   Checkout, card entered      .../api/billing/return?status=success    success
 *   Checkout, user tapped back  .../api/billing/return?status=cancelled  cancelled
 *   Billing portal, "Return"    .../api/billing/return?status=portal     portal
 *
 * The page picks the link from the device's User-Agent (iPhone/iPad -> iOS
 * link, Android -> Android link). The six links are hard-coded on the server:
 *
 *   iOS      echoes://billing/return?status=success      (or cancelled / portal)
 *   Android  intent://billing/return?status=success#Intent;scheme=echoes;package=com.echoes;end
 *            (or cancelled / portal — same string, only status changes)
 *
 * Same for debug and release builds. Security: the link carries ONLY `status`,
 * and only one of those three exact words. Nothing else from the Stripe URL
 * (session id, user id, token, ...) is ever copied into it, and the links are
 * not built from request values — an unknown or missing status is shown as
 * `portal`. So the link tells you "the user came back", NOT "the payment worked".
 *
 * On a desktop browser (no iPhone/Android User-Agent) the page shows "switch
 * back to the app" and opens nothing.
 *
 * Android caveat: Chrome may refuse to follow an intent:// link that a page
 * opens on its own (without a tap), in which case the automatic redirect does
 * nothing. The page therefore always shows a visible "Open the Echoes app"
 * button — a tap on it is a user gesture. iOS gets the same button as a fallback.
 * Please confirm on a real Android device that both paths open the app.
 *
 * WHAT THE APP MUST DO when it receives echoes://billing/return?status=...:
 * always re-fetch /api/users/me — for ALL three statuses. The plan is changed
 * by Stripe's webhook, not by the redirect, and the user can be back in the
 * app a second or two BEFORE the webhook has landed. So on `success` the first
 * getMe() may still show FREE / subscription null; retry briefly instead of
 * concluding that the payment failed.
 */
type BillingReturnStatus = 'success' | 'cancelled' | 'portal';

async function handleBillingReturn(status: BillingReturnStatus): Promise<Me> {
  if (status === 'cancelled') {
    // User backed out of Checkout — nothing changed. Back to the pricing page.
    return getMe();
  }
  if (status === 'portal') {
    // Card/plan/cancel may have changed in the portal; one refresh is enough.
    return getMe();
  }
  // status === 'success': poll until the webhook has activated the plan
  // (about every 1.5s for up to ~15s; usually 1-3 attempts).
  let me = await getMe();
  for (let attempt = 0; attempt < 10 && me.plan === 'FREE'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    me = await getMe();
  }
  // Still FREE after ~15s: show "We're confirming your payment — this can take
  // a minute" and re-check on the next app open. Do NOT tell the user it failed.
  // Success looks like: me.plan === 'FAMILY' (etc.) and
  // me.subscription?.status === 'TRIALING'.
  return me;
}

// ============================================================================
// 5. One quota handler for every plan-gated create call in the app
// ============================================================================

/**
 * Every quota-gated create endpoint — Capsules, Guardians, Scheduled
 * Messages, Groups (already integrated), plus Eulogy, Image Aging, and AI
 * Prompts (sections 6-8 below) — fails the exact same way: HTTP 402, code
 * QUOTA_EXCEEDED, with a ready-to-display message. Wrap ALL of them with
 * this one function instead of a separate try/catch per feature — including
 * your existing Capsule/Guardian/Scheduled-Message/Group create calls, not
 * just the new ones in this file.
 */
async function withQuotaHandling<T>(action: () => Promise<T>): Promise<T | null> {
  try {
    return await action();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'QUOTA_EXCEEDED') {
      // err.message is already the full user-facing sentence, e.g.:
      //   "Your plan does not include Time Capsules. Upgrade to create one."
      //   "Your plan allows up to 15 time capsules. Upgrade to create more."
      //   "Your plan allows up to 5 AI age-progression images per month.
      //    Upgrade for more, or try again next month."
      //   "Your plan does not include AI Q&A. Upgrade to use it."
      // Show it directly, paired with a button into section 4's flow.
      showUpgradePrompt(err.message);
      return null;
    }
    throw err; // anything else is a real error — see the table in section 9
  }
}
declare function showUpgradePrompt(message: string): void; // your UI hook

// Usage — identical regardless of which feature:
//   await withQuotaHandling(() => createEulogy({ ... }));
//   await withQuotaHandling(() => createAgingJob(fileKey, 20));
//   await withQuotaHandling(() => yourExistingCreateCapsuleCall({ ... }));

// ============================================================================
// 6. Eulogy AI — guided categories, Haiku model, PDF export
// ============================================================================

interface Eulogy {
  id: string;
  ownerId: string;
  deceasedName: string | null;
  promptAnswers: Record<string, unknown>;
  draftText: string;
  provider: 'ANTHROPIC' | 'OPENAI' | 'GOOGLE';
  model: string; // "claude-haiku-4-5-20251001" by default
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * POST /api/eulogies — the 3 guided category keys below are RECOGNIZED and
 * prioritized in the generated draft, but not required — any other keys in
 * promptAnswers still work (free-form input).
 */
function createEulogy(input: {
  deceasedName: string;
  relationship?: string;
  tone?: 'warm' | 'formal' | 'celebratory' | 'reflective';
  promptAnswers: {
    coreMemory?: string;          // a specific memory that captures who they were
    characterOrFeeling?: string;  // a defining trait / how they made people feel
    legacyOrLesson?: string;      // a lesson or legacy they leave behind
    [key: string]: unknown;
  };
  pageId?: string;
}) {
  return apiFetch<Eulogy>('/api/eulogies', { method: 'POST', body: input });
}
// Real example verified in testing:
//   createEulogy({
//     deceasedName: "Margaret Chen",
//     relationship: "grandmother",
//     tone: "warm",
//     promptAnswers: {
//       coreMemory: "Sunday mornings making dumplings together in her tiny kitchen.",
//       characterOrFeeling: "She made everyone feel like the most important person in the room.",
//       legacyOrLesson: "Show up for people, even in small ways, especially in small ways.",
//     },
//   })
// Real example response (same call, abridged draftText):
//   { id: "6f810fe2-ad41-4d27-a09e-b41ceac7a275", ownerId: "9510cfb6-...",
//     deceasedName: "Margaret Chen",
//     promptAnswers: { coreMemory: "...", characterOrFeeling: "...", legacyOrLesson: "..." },
//     draftText: "Good morning. I'm Margaret's granddaughter, and I want to share...",
//     provider: "ANTHROPIC", model: "claude-haiku-4-5-20251001", version: 1,
//     createdAt: "2026-10-01T07:50:00.777Z", updatedAt: "2026-10-01T07:50:00.777Z" }
// listEulogies/getEulogy/reviseEulogy/regenerateEulogy/deleteEulogy all
// return or operate on this exact same Eulogy shape — reviseEulogy and
// regenerateEulogy just come back with version incremented.
// NOTE on `relationship`: interpreted as "written from the perspective of the
// deceased's {relationship}" — relationship: "grandmother" means the SPEAKER
// is the deceased's grandmother (the deceased is the speaker's grandchild),
// not that the deceased was a grandmother. Word your UI copy accordingly, or
// omit the field.

function listEulogies() {
  return apiFetch<Eulogy[]>('/api/eulogies');
}
function getEulogy(eulogyId: string) {
  return apiFetch<Eulogy>(`/api/eulogies/${eulogyId}`);
}
/** Manual text edit — no AI call, no quota consumed, bumps `version`. */
function reviseEulogy(eulogyId: string, draftText: string) {
  return apiFetch<Eulogy>(`/api/eulogies/${eulogyId}`, { method: 'PATCH', body: { draftText } });
}
/** Re-runs AI generation from the ORIGINAL promptAnswers — consumes one
 * monthly quota slot, same limit as creating a new eulogy. */
function regenerateEulogy(eulogyId: string) {
  return apiFetch<Eulogy>(`/api/eulogies/${eulogyId}/regenerate`, { method: 'POST' });
}
function deleteEulogy(eulogyId: string) {
  return apiFetch<void>(`/api/eulogies/${eulogyId}`, { method: 'DELETE' });
}

/**
 * GET /:eulogyId/pdf — returns a raw PDF stream, NOT json. Use a plain fetch
 * + blob, not apiFetch. Filename comes from Content-Disposition.
 */
async function downloadEulogyPdf(eulogyId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/eulogies/${eulogyId}/pdf`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`PDF download failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? 'eulogy.pdf';
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================================
// 7. Image Aging AI — async job flow
// ============================================================================

interface ImageAgingJob {
  id: string;
  ownerId: string;
  sourceFileKey: string;
  ageOffset: number; // whole years, 1-80
  status: 'QUEUED' | 'PROCESSING' | 'READY' | 'FAILED';
  resultFileKey: string | null;
  errorMessage: string | null;
  downloadUrl?: string; // only present once status is READY
  createdAt: string;
  completedAt: string | null;
}

/**
 * Full flow, 3 steps. ASYNC — job creation returns immediately with status
 * QUEUED; the Gemini call happens in the background. Poll, or react to the
 * push/in-app notification (section 10) instead. Typical real completion
 * time observed in testing: ~7-15 seconds.
 */

// Step 1: upload the source photo — the SAME generic upload flow used
// elsewhere (category: 'memory'), nothing image-aging-specific here.
async function uploadAgingSourcePhoto(file: File): Promise<string> {
  const { uploads } = await apiFetch<{ uploads: Array<{ key: string; upload: { url: string; fields: Record<string, string> } }> }>(
    '/api/uploads/presign',
    { method: 'POST', body: { category: 'memory', files: [{ filename: file.name, contentType: file.type, sizeBytes: file.size }] } },
  );
  const { key, upload } = uploads[0];

  const form = new FormData();
  Object.entries(upload.fields).forEach(([k, v]) => form.append(k, v));
  form.append('file', file);
  const uploadRes = await fetch(upload.url, { method: 'POST', body: form });
  if (!uploadRes.ok) throw new Error('Photo upload to storage failed');

  return key; // this is the fileKey for step 2
}

// Step 2: create the job. Dedup is automatic — calling this again with the
// SAME photo + same ageOffset returns the existing job instantly instead of
// generating (and charging) again, so it's safe to call defensively.
//
// ageOffset is ANY whole number of years from 1 to 80 — not a fixed set.
// Offer quick-pick chips (10/20/30/50), a free-entry field, or both; the
// backend can't tell the difference. Anything outside 1-80, or a decimal,
// gets a 400. Note for the free-entry case: dedup is per EXACT number, so
// 25 and 26 are two separate paid generations, not a dedup hit.
function createAgingJob(fileKey: string, ageOffset: number) {
  return apiFetch<ImageAgingJob>('/api/image-aging/jobs', { method: 'POST', body: { fileKey, ageOffset } });
}
// Request body: { "fileKey": "memories/<userId>/<uuid>/photo.jpg", "ageOffset": 20 }
// Real example response, right after creation (status always starts QUEUED):
//   { id: "60f386fc-49fd-40a4-9d56-13edf9106335", ownerId: "9510cfb6-...",
//     sourceFileKey: "memories/9510cfb6-.../photo.jpg", ageOffset: 20,
//     status: "QUEUED", resultFileKey: null, errorMessage: null,
//     createdAt: "2026-10-01T07:18:02.000Z", completedAt: null }
// Real example response, polled ~7s later once the worker finishes:
//   { ...same id..., status: "READY",
//     resultFileKey: "image-aging/9510cfb6-.../aged-20y.png",
//     downloadUrl: "https://echoes-vault-....s3.eu-north-1.amazonaws.com/...",
//     completedAt: "2026-10-01T07:18:09.000Z" }
// If generation fails on the final retry instead: status: "FAILED",
// errorMessage holds a real reason string, no downloadUrl.

// Step 3: poll until READY or FAILED (or skip polling and just react to the
// push notification instead — both work, polling is the fallback/manual-refresh path).
async function pollAgingJob(jobId: string, { intervalMs = 2000, timeoutMs = 60_000 } = {}): Promise<ImageAgingJob> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await apiFetch<ImageAgingJob>(`/api/image-aging/jobs/${jobId}`);
    if (job.status === 'READY' || job.status === 'FAILED') return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Image-aging job timed out waiting for a result');
}

function listAgingJobs() {
  return apiFetch<ImageAgingJob[]>('/api/image-aging/jobs');
}

// Full usage example:
//   const fileKey = await uploadAgingSourcePhoto(file);
//   const job = await withQuotaHandling(() => createAgingJob(fileKey, 20));
//   if (!job) return; // quota hit, prompt already shown
//   const finished = await pollAgingJob(job.id);
//   if (finished.status === 'READY') showImage(finished.downloadUrl!);
//   else showError(finished.errorMessage ?? 'Generation failed');
declare function showImage(url: string): void; // your UI hook
declare function showError(message: string): void; // your UI hook

// ============================================================================
// 8. AI Prompts — one-shot Q&A, Claude only (shipped 2026-10-06)
// ============================================================================

interface AiPrompt {
  id: string;
  ownerId: string;
  question: string;
  answer: string;
  model: string; // "claude-haiku-4-5-20251001"
  createdAt: string;
}

/**
 * POST /api/ai-prompts — ask a question, get an answer in the same response.
 * Fully synchronous, no polling. Every question is independent: the AI has
 * NO memory of earlier questions (not a threaded chat) and NO awareness of
 * the user's own vault/memories/eulogies — it's a generic assistant, not
 * grounded in their data. Rate-limited to 20/min (burst protection only —
 * the real control is the monthly quota, same as every other AI feature).
 */
function askAiPrompt(question: string) {
  return apiFetch<AiPrompt>('/api/ai-prompts', { method: 'POST', body: { question } });
}
// Request body: { "question": "Give me 3 short questions I could ask my
//   family to learn more about my late grandmother's life, in a numbered list." }
// Real example response (verified against production 2026-10-06):
//   { id: "b0794ca9-...", ownerId: "29e523e1-...",
//     question: "Give me 3 short questions I could ask my family...",
//     answer: "# Questions About Your Grandmother\n\n1. What was one of her
//       favorite hobbies...", model: "claude-haiku-4-5-20251001",
//     createdAt: "2026-10-06T15:51:20.267Z" }
// Usage:
//   const result = await withQuotaHandling(() => askAiPrompt(question));
//   if (!result) return; // quota hit, prompt already shown
//   showAnswer(result.answer);
declare function showAnswer(answer: string): void; // your UI hook

/** GET /api/ai-prompts — full history, not quota-gated (reading is free). */
function listAiPrompts() {
  return apiFetch<AiPrompt[]>('/api/ai-prompts');
}

// ============================================================================
// 9. Error code -> UI treatment (every code the API returns, anywhere)
// ============================================================================

/**
 * code              status  typical cause                         UI treatment
 * ----------------- ------- ------------------------------------- --------------------------------------------
 * BAD_REQUEST        400    validation failed, or a business-rule  Show err.message near the offending field.
 *                            precondition (e.g. "File key does      err.details has per-field Zod errors when
 *                            not belong to you")                   it's a validation failure.
 * UNAUTHORIZED       401    missing/expired access token           Redirect to login. If you're not already
 *                                                                   handling x-refresh-token (see apiFetch
 *                                                                   above), check that first.
 * FORBIDDEN          403    authenticated, but not allowed to       Generic "you don't have access" — this
 *                            touch this specific resource            shouldn't be reachable through normal UI.
 * NOT_FOUND          404    id doesn't exist / isn't yours          Treat identically to a 403 in the UI —
 *                                                                   don't reveal whether the id exists for
 *                                                                   someone else.
 * CONFLICT           409    e.g. duplicate contact invite           Show err.message; usually means "this
 *                                                                   already exists", not a bug.
 * QUOTA_EXCEEDED     402    plan limit reached                      withQuotaHandling() in section 5 — never
 *                                                                   a generic error toast.
 * PAYLOAD_TOO_LARGE  413    file exceeds the category's size cap    Show the limit; don't retry.
 * TOO_MANY_REQUESTS  429    rate limiter tripped                    Brief "slow down" message; safe to retry
 *                                                                   after a few seconds.
 * INTERNAL           500    unexpected server error                 Generic "something went wrong, try again"
 *                                                                   — err.message is deliberately vague here
 *                                                                   by design, don't try to parse it.
 */

// ============================================================================
// 10. Two new notification types to add to your existing feed/toast logic
// ============================================================================

/**
 * No new endpoints — these flow through the notification system you already
 * integrated (GET /api/notifications, device-token registration, etc.).
 * Just two new `type` values to handle if your feed renders by a switch/
 * lookup on `type`. Both carry `data.referenceId` + `data.referenceType` for
 * deep-linking, same convention as every type you already handle.
 *
 * type                 referenceType    body                                                          suggested icon
 * -------------------- ---------------- ------------------------------------------------------------- ---------------
 * IMAGE_AGING_READY     ImageAgingJob    "Your {N}-year age-progression image is ready to view."       ai / photo
 * IMAGE_AGING_FAILED    ImageAgingJob    "Your {N}-year age-progression request failed. Please try     ai / photo /
 *                                         again."                                                      warning
 * PAYMENT_FAILED         (none)          "We couldn't process your subscription payment. Please        billing /
 *                                         update your payment method to keep your plan active."        warning — tap
 *                                                                                                       should call
 *                                                                                                       openBillingPortal()
 */

export {
  getMe,
  getPlanCatalog,
  startCheckout,
  openBillingPortal,
  handleManagePlanClick,
  withQuotaHandling,
  createEulogy,
  listEulogies,
  getEulogy,
  reviseEulogy,
  regenerateEulogy,
  deleteEulogy,
  downloadEulogyPdf,
  uploadAgingSourcePhoto,
  createAgingJob,
  pollAgingJob,
  listAgingJobs,
  askAiPrompt,
  listAiPrompts,
  ApiError,
};
