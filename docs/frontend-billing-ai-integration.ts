/**
 * Echoes Backend — Billing/Plans (Stripe) + AI Features: single handover file.
 *
 * Covers everything added recently:
 *   - Billing/Plans: Memory/Family/Legacy, monthly+yearly pricing, 7-day
 *     trial, Stripe Checkout (first subscription) + Billing Portal (manage
 *     an existing one) — LIVE, proven end-to-end on real Stripe test-mode
 *     traffic as of 2026-10-06
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
  } | null; // null = never been through checkout
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
//       currentPeriodEnd: null,  // <- genuinely null during an active trial,
//     } }                       //    don't assume it mirrors trialEndsAt
//
// Real example response, a subscription that was cancelled (NOT the same as
// never-subscribed — subscription is a real object here, just cleared out.
// Check subscription === null vs status === 'CANCELLED' for different UI:
// the latter might want a "come back" message instead of a plain pricing page):
//   { ..., plan: "FREE", subscription: { status: "CANCELLED",
//     billingInterval: null, trialEndsAt: null, currentPeriodEnd: null } }
//
// Real example response, never subscribed at all:
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
 * IMPORTANT: gate every feature on `me.plan`, never on `subscription.status`.
 * TRIALING grants FULL access to the plan — that's the point of a trial.
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
//                 eulogyGenerationsPerMonth: 2, imageAgingPerMonth: 0 } },
//     { plan: "FAMILY", ..., priceUsd: { monthly: 14.99, yearly: 149.99 }, storageBytes: 107374182400,
//       limits: { capsules: 15, capsuleReleaseTypes: ["SCHEDULED_DATE"], guardians: 5,
//                 scheduledMessages: 50, groups: 10, eulogyGenerationsPerMonth: 15, imageAgingPerMonth: 5, ... } },
//     { plan: "LEGACY", ..., priceUsd: { monthly: 29.99, yearly: 299.99 }, storageBytes: 322122547200,
//       limits: { capsules: null, capsuleReleaseTypes: ["SCHEDULED_DATE","RECURRING_ANNUAL","GUARDIAN_CONTROLLED"],
//                 guardians: null, scheduledMessages: null, groups: null,
//                 eulogyGenerationsPerMonth: 50, imageAgingPerMonth: 20, ... } }
//   ] }
//
// A limit of 0 means "not on this plan" (show a lock/upsell); null means
// unlimited. Don't render "0" as a quantity. Time Capsules, scheduled
// messages, guardians and sharing groups all start at FAMILY — MEMORY is
// vault-only.

// ============================================================================
// 3. Nav-level feature gating — lock BEFORE the tap, not after
// ============================================================================

/**
 * Cross-reference the CURRENT plan's row from getPlanCatalog() against
 * `me.plan` once at app-shell load, to decide what to show in navigation —
 * instead of only reacting to a 402 after a doomed request.
 *
 *   const { plans } = await getPlanCatalog();
 *   const myLimits = plans.find(p => p.plan === me.plan)!.limits;
 *   if (myLimits.capsules === 0) {
 *     renderNavItem('Time Capsules', { locked: true, onClick: () => showUpgradePrompt(
 *       'Your plan does not include Time Capsules. Upgrade to create one.'
 *     )});
 *   }
 *
 * This is a UX nicety, not a security boundary — the server enforces the
 * real limit on every create call regardless of what the nav shows. Never
 * skip the try/catch in section 5 just because the nav is already gated.
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
 * LIVE as of 2026-10-06 — verified against a real subscriber.
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
 * One "Manage plan" button, two possible actions depending on subscription
 * state. Never call startCheckout() for someone already ACTIVE/TRIALING.
 */
async function handleManagePlanClick(me: Me, choice?: { plan: PaidPlanId; interval: BillingInterval }) {
  if (!me.subscription || me.subscription.status === 'CANCELLED') {
    if (!choice) throw new Error('Pass the plan/interval the user picked on the pricing page');
    const { checkoutUrl } = await startCheckout(choice.plan, choice.interval);
    window.location.href = checkoutUrl;
  } else {
    // ACTIVE, TRIALING, or PAST_DUE -> everything happens in Stripe's portal.
    const { portalUrl } = await openBillingPortal();
    window.location.href = portalUrl;
  }
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
  ageOffset: 10 | 20 | 50;
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
function createAgingJob(fileKey: string, ageOffset: 10 | 20 | 50) {
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
