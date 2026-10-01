/**
 * Echoes Backend — Frontend integration guide.
 *
 * The other two docs files are endpoint-by-endpoint references:
 *   - frontend-api-examples.ts            Guardians, Capsules, Scheduled
 *                                          Messages, Contacts+Groups, Notifications
 *   - frontend-api-examples-billing-ai.ts  Billing/Plans, Eulogy AI, Image Aging
 *
 * This file is different: it's the glue between them — how to wire the
 * endpoints you already have into actual screens (app shell, nav gating,
 * Settings > Plan, a notification feed, error handling). Read this one
 * first; it tells you which function from which other file to call and when.
 *
 * All shapes verified against https://backend.echoesremembered.com as of
 * 2026-10-01. Full interactive docs: https://backend.echoesremembered.com/docs/
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

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

// ============================================================================
// 1. App bootstrap — one call drives the whole shell
// ============================================================================

/**
 * After login, this ONE call gives you everything needed to render the app
 * shell: plan, storage usage, and subscription lifecycle state. Don't call
 * /billing/plans on every page load for this — that endpoint is the static
 * CATALOG (for a pricing page); this is the user's actual current state.
 */
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
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
  } | null;
}

function getMe() {
  return apiFetch<Me>('/api/users/me');
}

/**
 * Recommended app-shell logic, run once after login and cached in your
 * global/session store:
 *
 *   const me = await getMe();
 *
 *   // Storage bar
 *   const usedFraction = me.storageUsedBytes / me.storageLimitBytes;
 *
 *   // Trial banner — only while subscription.status === 'TRIALING'.
 *   if (me.subscription?.status === 'TRIALING' && me.subscription.trialEndsAt) {
 *     const daysLeft = Math.ceil((new Date(me.subscription.trialEndsAt).getTime() - Date.now()) / 86_400_000);
 *     showBanner(`Your free trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`);
 *   }
 *
 *   // Payment-failed banner — status flips to PAST_DUE while Stripe retries
 *   // the card; nothing is lost yet, but the user should fix it. You'll also
 *   // get a PAYMENT_FAILED push/in-app notification the moment it happens —
 *   // this check is for someone who dismissed that and reopens the app later.
 *   if (me.subscription?.status === 'PAST_DUE') {
 *     showBanner('Your last payment failed. Update your card to keep your plan.', {
 *       action: 'Manage billing', onClick: openBillingPortal,
 *     });
 *   }
 *
 *   // IMPORTANT: gate features on `me.plan`, never on `subscription.status`.
 *   // TRIALING grants full access to the plan — that's the point of a trial.
 */

// ============================================================================
// 2. Nav-level feature gating — hide/lock BEFORE the user clicks, not after
// ============================================================================

/**
 * /billing/plans returns every plan's limits (0 = not included on that plan,
 * null = unlimited). Cross-reference the CURRENT plan's row against it once at
 * app-shell load to decide what to show in navigation, instead of only
 * reacting to a 402 after a doomed request. This gives the lock icon / upsell
 * tooltip BEFORE a tap, which is the better UX and costs one extra fetch.
 */
interface PlanLimits {
  capsules: number | null;
  scheduledMessages: number | null;
  groups: number | null;
  guardians: number | null;
  eulogyGenerationsPerMonth: number | null;
  imageAgingPerMonth: number | null;
}

async function getCurrentPlanLimits(plan: Me['plan']): Promise<PlanLimits> {
  const { plans } = await apiFetch<{ plans: Array<{ plan: string; limits: PlanLimits }> }>('/api/billing/plans');
  const row = plans.find((p) => p.plan === plan);
  if (!row) throw new Error(`Plan ${plan} missing from catalog`);
  return row.limits;
}

/**
 * Example: deciding whether to show the "Time Capsules" nav item as active,
 * locked, or hidden.
 *
 *   const limits = await getCurrentPlanLimits(me.plan);
 *   if (limits.capsules === 0) {
 *     renderNavItem('Time Capsules', { locked: true, onClick: () => showUpgradePrompt(
 *       'Your plan does not include Time Capsules. Upgrade to create one.'
 *     )});
 *   } else {
 *     renderNavItem('Time Capsules', { locked: false });
 *   }
 *
 * This is a UX nicety, not a security boundary — the server enforces the real
 * limit on every create call regardless of what the nav shows. Never skip the
 * try/catch in section 3 just because you already gated the nav.
 */

// ============================================================================
// 3. One quota handler for every create call in the app
// ============================================================================

/**
 * Every quota-gated create endpoint — Capsules, Guardians, Scheduled
 * Messages, Groups, Eulogy, Image Aging — fails the exact same way:
 * HTTP 402, code QUOTA_EXCEEDED, with a ready-to-display message. Use ONE
 * wrapper for all of them instead of repeating try/catch per feature.
 *
 * Import the real create functions from the other two docs files:
 *   createCapsule, createScheduledMessage, createGuardian  (frontend-api-examples.ts)
 *   createEulogy, createAgingJob                            (frontend-api-examples-billing-ai.ts)
 */
async function withQuotaHandling<T>(action: () => Promise<T>): Promise<T | null> {
  try {
    return await action();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'QUOTA_EXCEEDED') {
      // err.message is already the full user-facing sentence — display it
      // as-is, paired with a button to Settings > Plan (section 4).
      showUpgradePrompt(err.message);
      return null;
    }
    throw err; // anything else is a real error — see the table in section 5
  }
}
declare function showUpgradePrompt(message: string): void; // your UI hook

// Usage, identical regardless of which feature:
//   await withQuotaHandling(() => createCapsule({ ... }));
//   await withQuotaHandling(() => createGuardian(contactId));
//   await withQuotaHandling(() => createEulogy({ ... }));

// ============================================================================
// 4. Settings > Plan screen — the full subscription lifecycle
// ============================================================================

/**
 * One button, two possible actions depending on whether the user has EVER
 * been through checkout. Never call startCheckout() for someone who already
 * has an active/trialing subscription — the API will reject it (see below),
 * because Checkout always starts a brand NEW Stripe subscription; it has no
 * concept of "replace my existing one". That's what the portal is for.
 */
async function handleManagePlanClick(me: Me, choice?: { plan: 'MEMORY' | 'FAMILY' | 'LEGACY'; interval: 'MONTH' | 'YEAR' }) {
  if (!me.subscription || me.subscription.status === 'CANCELLED') {
    // Never subscribed, or a previous subscription ended -> start fresh.
    if (!choice) throw new Error('Pass the plan/interval the user picked on the pricing page');
    const { checkoutUrl } = await apiFetch<{ checkoutUrl: string; trialDays: number }>(
      '/api/billing/checkout',
      { method: 'POST', body: choice },
    );
    window.location.href = checkoutUrl;
  } else {
    // ACTIVE, TRIALING, or PAST_DUE -> everything (upgrade, downgrade,
    // switch monthly/yearly, update card, cancel) happens in Stripe's portal.
    const { portalUrl } = await apiFetch<{ portalUrl: string }>('/api/billing/portal', { method: 'POST' });
    window.location.href = portalUrl;
  }
}
// If the user tries checkout anyway while already subscribed, the API
// returns 400: "You already have an active subscription. Use the billing
// portal to change your plan." — catch it and redirect to the portal call
// above instead of surfacing it as a generic error.

// ============================================================================
// 5. Error code -> UI treatment (every code the API returns, anywhere)
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
 * QUOTA_EXCEEDED     402    plan limit reached                      showUpgradePrompt(err.message) — see §3.
 *                                                                   Never a generic error toast.
 * PAYLOAD_TOO_LARGE  413    file exceeds the category's size cap    Show the limit; don't retry.
 * TOO_MANY_REQUESTS  429    rate limiter tripped                    Brief "slow down" message; safe to retry
 *                                                                   after a few seconds.
 * INTERNAL           500    unexpected server error                 Generic "something went wrong, try again"
 *                                                                   — err.message is deliberately vague here
 *                                                                   by design, don't try to parse it.
 */

// ============================================================================
// 6. Notification feed — every type across the whole app, one table
// ============================================================================

/**
 * All delivered through the single GET /api/notifications feed + push (see
 * frontend-api-examples.ts §Notifications for listNotifications/
 * setNotificationRead/registerDeviceToken). `data.referenceId` +
 * `data.referenceType` give you the deep-link target for every row below.
 *
 * type                          referenceType        suggested icon/category
 * ------------------------------ -------------------- ------------------------
 * CAPSULE_RELEASED               TimeCapsule          capsule
 * CAPSULE_BOUNCED_RETURNED       TimeCapsule          capsule / warning
 * CAPSULE_ASSIGNED               TimeCapsule          capsule
 * CAPSULE_SCHEDULE_CHANGED       TimeCapsule          capsule
 * SCHEDULED_MESSAGE_CREATED      ScheduledMessage      message
 * SCHEDULED_MESSAGE_SENT         ScheduledMessage      message
 * SCHEDULED_MESSAGE_FAILED       ScheduledMessage      message / warning
 * GUARDIAN_INVITED               Guardian              guardian
 * GUARDIAN_ACCEPTED              Guardian              guardian
 * GUARDIAN_DECLINED              Guardian              guardian / warning
 * GUARDIAN_ASSIGNED              Guardian              guardian
 * GUARDIAN_REMOVED               Guardian              guardian
 * GROUP_ADDED                    Group                 group
 * GROUP_REMOVED                  Group                 group
 * GROUP_ROLE_CHANGED             Group                 group
 * GROUP_MEDIA_UPLOADED           Group                 group / media
 * MEMORY_SHARED_WITH_YOU         (varies)              share
 * SCHEDULED_SHARE_DELIVERED      (varies)              share
 * VOICE_RECORDING_REMINDER       Recording             reminder
 * MEDIA_VIDEO_UPLOADED           (varies)              media
 * MEDIA_PDF_UPLOADED             (varies)              media
 * STORY_SUBMITTED / STORY_APPROVED  Story              story
 * GUESTBOOK_ENTRY_NEW            (varies)              guestbook
 * MEMORIAL_ACTIVATED             Page                  memorial
 * STORAGE_WARNING                (none)                storage / warning — fires at 80/90/100% of plan quota
 * CONTACT_JOINED                 Contact               contact
 * IMAGE_AGING_READY               ImageAgingJob         ai / photo
 * IMAGE_AGING_FAILED              ImageAgingJob         ai / photo / warning
 * PAYMENT_FAILED                  (none)                billing / warning — pair with the Settings > Plan
 *                                                        banner in §1; tapping it should call openBillingPortal()
 *
 * Only IMAGE_AGING_* and PAYMENT_FAILED are NEW as of 2026-10-01 — everything
 * else above already existed. If your notification feed renders by a
 * switch/lookup on `type`, these are the two cases to add.
 */

export { getMe, getCurrentPlanLimits, withQuotaHandling, handleManagePlanClick, ApiError };
