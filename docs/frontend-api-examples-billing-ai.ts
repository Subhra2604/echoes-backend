/**
 * Echoes Backend — Frontend integration guide for the Billing/Plans
 * restructure + AI features (Age-Progression Images, Eulogy enhancements)
 * shipped 2026-09-30.
 *
 * All shapes below were verified with real calls against
 * https://backend.echoesremembered.com on 2026-09-30 — including real Stripe
 * plan reads, real Anthropic eulogy generations, and real Gemini image
 * generations. Full interactive docs: https://backend.echoesremembered.com/docs/
 *
 * See docs/frontend-api-examples.ts for the shared `apiFetch` helper pattern
 * (bearer token + x-refresh-token handling) — reuse it, don't duplicate it.
 * Everything here assumes that same helper.
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
  if (!res.ok) throw new ApiError(res.status, data.error?.code, data.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}

/**
 * Every error response is `{ error: { code, message, details? } }`. The one
 * NEW code to specifically handle everywhere a plan limit applies:
 * `QUOTA_EXCEEDED` (HTTP 402) — show an upgrade prompt, not a generic error
 * toast. Check `err.code === 'QUOTA_EXCEEDED'`, not just the status code,
 * since 402 is used consistently only for this.
 */
class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// ============================================================================
// 1. Billing / Plans
// ============================================================================

interface PlanInfo {
  plan: 'FREE' | 'BASIC' | 'FAMILY' | 'LEGACY_PREMIUM';
  priceUsd: number;
  storageBytes: number;
  memorialLimit: number | null; // null = unlimited
  photoLimit: number | null;
  ads: boolean;
}

/** GET /api/billing/plans — public, no auth. Render your pricing page from this. */
function getPlanCatalog() {
  return apiFetch<{ plans: PlanInfo[] }>('/api/billing/plans');
}
// Real response today:
//   { plans: [
//     { plan: "FREE", priceUsd: 0, storageBytes: 524288000, memorialLimit: 1, photoLimit: 20, ads: true },
//     { plan: "BASIC", priceUsd: 9.99, storageBytes: 5368709120, memorialLimit: 3, photoLimit: null, ads: false },
//     { plan: "FAMILY", priceUsd: 19.99, storageBytes: 21474836480, memorialLimit: null, photoLimit: null, ads: false },
//     { plan: "LEGACY_PREMIUM", priceUsd: 39.99, storageBytes: 214748364800, memorialLimit: null, photoLimit: null, ads: false }
//   ] }

/**
 * POST /api/billing/checkout — starts a Stripe Checkout session.
 * Redirect the browser to the returned `checkoutUrl`; Stripe handles payment,
 * your webhook activates the plan server-side — no further client action
 * needed. NOT YET LIVE: returns 400 "Billing is not configured" until real
 * Stripe keys are added server-side.
 */
function startCheckout(plan: 'BASIC' | 'FAMILY' | 'LEGACY_PREMIUM') {
  return apiFetch<{ checkoutUrl: string }>('/api/billing/checkout', { method: 'POST', body: { plan } });
}
// Usage: const { checkoutUrl } = await startCheckout('BASIC'); window.location.href = checkoutUrl;

/**
 * GET /api/users/me already includes everything needed to render "your
 * current plan" — no separate call needed. Relevant fields:
 *   plan, storageUsedBytes, storageLimitBytes, memorialLimit, adsEnabled
 */

// ============================================================================
// 2. Handling plan-gated features (applies across Capsules, Guardians,
//    Scheduled Messages, Groups, Eulogy, Image Aging)
// ============================================================================

/**
 * Every quota-gated create call can throw QUOTA_EXCEEDED. Wrap creation
 * flows like this rather than a generic try/catch:
 */
async function createCapsuleWithUpgradePrompt(payload: unknown) {
  try {
    return await apiFetch('/api/capsules', { method: 'POST', body: payload });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'QUOTA_EXCEEDED') {
      // err.message is already a friendly, user-facing sentence, e.g.:
      //   "Your plan allows up to 1 time capsule. Upgrade to create more."
      //   "Your plan does not include Guardians. Upgrade to assign one."
      // Show it directly + a button to your pricing page / startCheckout().
      showUpgradePrompt(err.message);
      return null;
    }
    throw err;
  }
}
declare function showUpgradePrompt(message: string): void; // your UI hook

// ============================================================================
// 3. Eulogy — guided categories, Haiku model, PDF export
// ============================================================================

interface Eulogy {
  id: string;
  ownerId: string;
  deceasedName: string | null; // NEW field
  promptAnswers: Record<string, unknown>;
  draftText: string;
  provider: 'ANTHROPIC' | 'OPENAI' | 'GOOGLE';
  model: string; // now "claude-haiku-4-5-20251001" by default, was sonnet
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * POST /api/eulogies — the 3 guided category keys below are RECOGNIZED and
 * prioritized in the generated draft, but not required — any other keys in
 * promptAnswers still work exactly as before (legacy free-form input).
 */
function createEulogy(input: {
  deceasedName: string;
  relationship?: string;
  tone?: 'warm' | 'formal' | 'celebratory' | 'reflective';
  promptAnswers: {
    coreMemory?: string; // a specific memory that captures who they were
    characterOrFeeling?: string; // a defining trait / how they made people feel
    legacyOrLesson?: string; // a lesson or legacy they leave behind
    [key: string]: unknown; // any other free-form answers still work
  };
  pageId?: string;
}) {
  return apiFetch<Eulogy>('/api/eulogies', { method: 'POST', body: input });
}
// Real example used in testing today:
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
// NOTE on `relationship`: it's interpreted as "written from the perspective
// of the deceased's {relationship}" — e.g. relationship: "grandmother" means
// the SPEAKER is the deceased's grandmother (the deceased is the speaker's
// grandchild), not that the deceased was a grandmother. Word your UI copy
// with this in mind, or omit the field.

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
// 4. AI Age-Progression Images — async job flow
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
 * Full flow, 3 steps. This is ASYNC — job creation returns immediately with
 * status QUEUED; the actual Gemini call happens in the background. Poll or
 * wait for the push/in-app notification (type: IMAGE_AGING_READY /
 * IMAGE_AGING_FAILED) to know when it's done. Typical real completion time
 * observed in testing: ~7-15 seconds.
 */

// Step 1: upload the source photo — SAME generic upload flow used elsewhere
// in the app (category: 'memory'), nothing image-aging-specific here.
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
// QUOTA_EXCEEDED example message: "Your plan allows up to 3 AI age-progression
// images per month. Upgrade for more, or try again next month." — handle the
// same way as createCapsuleWithUpgradePrompt() above.

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
//   const job = await createAgingJob(fileKey, 20);
//   const finished = await pollAgingJob(job.id);
//   if (finished.status === 'READY') showImage(finished.downloadUrl!);
//   else showError(finished.errorMessage ?? 'Generation failed');

// ============================================================================
// 5. Notifications for image-aging (reuses the existing notification system —
//    no new endpoints, just 2 new `type` values to handle in your existing
//    notification feed/toast logic)
// ============================================================================
// type: "IMAGE_AGING_READY"  — body: "Your {N}-year age-progression image is ready to view."
// type: "IMAGE_AGING_FAILED" — body: "Your {N}-year age-progression request failed. Please try again."
// Both carry { referenceId: <jobId>, referenceType: "ImageAgingJob" } in `data`
// for deep-linking, same convention as every other notification type already
// handled in the app (e.g. CAPSULE_RELEASED, GUARDIAN_ASSIGNED).

export {
  getPlanCatalog,
  startCheckout,
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
  ApiError,
};
