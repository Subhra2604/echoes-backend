import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import {
  confirmUploaded,
  assertKeyOwnedBy,
  generateSignedDownloadUrl,
} from '../../lib/upload-module.js';
import { getObjectBuffer, putObject, buildObjectKey } from '../../lib/s3.js';
import { notify } from '../notifications/notifications.service.js';
import { generateAgedImage } from './image-aging.providers.js';
import { scheduleImageAging } from './image-aging.scheduler.js';
import { PLAN_IMAGE_AGING_LIMIT } from '../../config/plans.js';
import type { SubscriptionPlan } from '../../generated/prisma/enums.js';
import type { CreateImageAgingJobInput } from './image-aging.dto.js';

/**
 * AI age-progression image job service.
 *
 * Jobs live in a dedicated table (ImageAgingJob), not the permanent Vault/
 * Memory system — the source photo is transient input (already in S3 under
 * the existing 'memory' upload category), only the result is worth keeping.
 * Saving a result to the Vault afterward is a separate, later, user-
 * initiated action, not part of this flow.
 */

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * POST /api/image-aging/jobs
 *
 * Dedup first (identical source photo + age offset, by this owner, returns
 * the existing job as-is — regardless of its status — rather than spending
 * another ~$0.04 on Gemini), THEN quota (a duplicate request should never be
 * blocked by a quota check, since no new spend occurs).
 */
export async function createImageAgingJob(ownerId: string, input: CreateImageAgingJobInput) {
  // The uploaded source photo goes through the existing generic /uploads/presign
  // flow with category 'memory' — this just verifies it belongs to the caller
  // and actually landed in S3.
  assertKeyOwnedBy('memory', ownerId, input.fileKey);
  const head = await confirmUploaded(input.fileKey);
  if (!head) {
    throw Errors.badRequest('Uploaded file not found in storage — upload may not have completed');
  }
  if (!head.etag) {
    // Should not happen for a single-part presigned-POST upload, but guard
    // rather than silently dedup against an empty string.
    throw Errors.badRequest('Could not verify the uploaded file');
  }

  const existing = await prisma.imageAgingJob.findUnique({
    where: {
      ownerId_sourceEtag_ageOffset: {
        ownerId,
        sourceEtag: head.etag,
        ageOffset: input.ageOffset,
      },
    },
  });
  if (existing) return existing;

  await assertImageAgingQuota(ownerId);

  const job = await prisma.imageAgingJob.create({
    data: {
      ownerId,
      sourceFileKey: input.fileKey,
      sourceEtag: head.etag,
      ageOffset: input.ageOffset,
      status: 'QUEUED',
    },
  });

  await scheduleImageAging(job.id);
  return job;
}

export async function listImageAgingJobs(ownerId: string) {
  return prisma.imageAgingJob.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
  });
}

/** GET /api/image-aging/jobs/:jobId — poll status; attaches a signed download URL once READY. */
export async function getImageAgingJob(ownerId: string, jobId: string) {
  const job = await prisma.imageAgingJob.findFirst({ where: { id: jobId, ownerId } });
  if (!job) throw Errors.notFound('Image-aging job not found');
  if (job.status === 'READY' && job.resultFileKey) {
    const downloadUrl = await generateSignedDownloadUrl(job.resultFileKey);
    return { ...job, downloadUrl };
  }
  return job;
}

// ── Quota ────────────────────────────────────────────────────────────────────

/**
 * [Plan gating] max age-progression jobs this plan may create per calendar
 * month. Counted directly off ImageAgingJob.createdAt — unlike eulogies,
 * every attempt here creates a fresh row, no separate log table needed.
 *
 * NOTE: a FAILED job still counts toward the month (no separate success/
 * attempt distinction was requested) — known simplification; easy to adjust
 * to `status: { not: 'FAILED' }` later if that turns out to feel unfair.
 */
async function assertImageAgingQuota(ownerId: string): Promise<void> {
  const owner = await prisma.user.findUniqueOrThrow({
    where: { id: ownerId },
    select: { plan: true },
  });
  const limit = PLAN_IMAGE_AGING_LIMIT[owner.plan as SubscriptionPlan];
  if (limit === null) return;

  const startOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const count = await prisma.imageAgingJob.count({
    where: { ownerId, createdAt: { gte: startOfMonth } },
  });
  if (count >= limit) {
    throw Errors.quota(
      limit === 0
        ? 'Your plan does not include AI age-progression images. Upgrade to use it.'
        : `Your plan allows up to ${limit} AI age-progression image${limit === 1 ? '' : 's'} per month. Upgrade for more, or try again next month.`,
    );
  }
}

// ── Worker entry point ──────────────────────────────────────────────────────

const RESULT_EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Called by the BullMQ worker. `isFinalAttempt` tells us whether this is the
 * last allowed retry — if the call still fails, the row is marked FAILED
 * (with a user-visible reason) before rethrowing, so it never looks stuck in
 * PROCESSING forever. This is new logic: no other worker in this app has a
 * "give up after N attempts -> terminal FAILED row" branch, since capsules/
 * scheduled-messages/voice-reminders are all naturally idempotent without a
 * terminal-failure state.
 */
export async function processImageAgingJob(
  imageAgingJobId: string,
  isFinalAttempt: boolean,
): Promise<void> {
  const job = await prisma.imageAgingJob.findUnique({ where: { id: imageAgingJobId } });
  if (!job) {
    logger.warn({ imageAgingJobId }, 'image-aging job not found — skipping');
    return;
  }
  if (job.status === 'READY' || job.status === 'FAILED') {
    logger.debug({ imageAgingJobId }, 'image-aging job already terminal — skipping');
    return;
  }

  await prisma.imageAgingJob.update({
    where: { id: job.id },
    data: { status: 'PROCESSING' },
  });

  try {
    const source = await getObjectBuffer(job.sourceFileKey);
    const result = await generateAgedImage({
      imageBytes: source.buffer,
      sourceMimeType: source.contentType ?? 'image/jpeg',
      ageOffset: job.ageOffset as 10 | 20 | 50,
    });

    const ext = RESULT_EXT_BY_MIME[result.mimeType] ?? 'png';
    const resultKey = buildObjectKey(job.ownerId, `aged-${job.ageOffset}y.${ext}`);
    await putObject({ key: resultKey, body: result.imageBytes, contentType: result.mimeType });

    await prisma.imageAgingJob.update({
      where: { id: job.id },
      data: { status: 'READY', resultFileKey: resultKey, completedAt: new Date() },
    });

    await notify(
      job.ownerId,
      'IMAGE_AGING_READY',
      'Your aged photo is ready',
      `Your ${job.ageOffset}-year age-progression image is ready to view.`,
      { imageAgingJobId: job.id, referenceId: job.id, referenceType: 'ImageAgingJob' },
    ).catch((err) => logger.warn({ err }, 'IMAGE_AGING_READY notify failed'));

    logger.info({ imageAgingJobId: job.id }, 'image-aging job completed');
  } catch (err) {
    logger.error({ err, imageAgingJobId: job.id, isFinalAttempt }, 'image-aging job attempt failed');

    if (isFinalAttempt) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      await prisma.imageAgingJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', errorMessage, completedAt: new Date() },
      });
      await notify(
        job.ownerId,
        'IMAGE_AGING_FAILED',
        'Your aged photo could not be generated',
        `Your ${job.ageOffset}-year age-progression request failed. Please try again.`,
        { imageAgingJobId: job.id, referenceId: job.id, referenceType: 'ImageAgingJob' },
      ).catch((notifyErr) => logger.warn({ err: notifyErr }, 'IMAGE_AGING_FAILED notify failed'));
    } else {
      // Not the last attempt — leave status at PROCESSING and rethrow so
      // BullMQ's retry/backoff picks it up again. A stray "stuck in
      // PROCESSING" row is only possible if the process crashes mid-retry
      // window; acceptable for this feature's scale, same tradeoff already
      // accepted elsewhere in this app.
    }
    throw err;
  }
}
