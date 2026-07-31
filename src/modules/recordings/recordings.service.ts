import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import {
  generateSignedDownloadUrl,
  confirmUploaded,
  deleteFile,
  assertKeyOwnedBy,
} from '../../lib/upload-module.js';
import { PLAN_STORAGE_BYTES } from '../../config/plans.js';
import { recordingsRepo } from './recordings.repo.js';
import {
  scheduleVoiceReminder,
  cancelVoiceReminder,
} from './recordings.scheduler.js';
import type {
  CreateRecordingInput,
  UpdateRecordingInput,
  ListRecordingsQuery,
} from './recordings.dto.js';
import type { SubscriptionPlan } from '../../generated/prisma/enums.js';

/**
 * Voice recordings service.
 *
 * Browser-recorded audio is uploaded directly to S3 via /api/uploads/presign,
 * then metadata is posted here. Same architecture as Memories and Profile.
 * The client is expected to compress audio before upload (e.g. Opus in WebM, or
 * AAC/M4A); the backend stores whatever format the client produced.
 *
 * Scheduled reminders:
 *   - On create, if scheduledDate is set, enqueue a BullMQ delayed job.
 *   - On update, if scheduledDate changes we (a) reset scheduleNotifiedAt so
 *     the new time gets a fresh reminder, (b) cancel any pending job, and (c)
 *     re-enqueue at the new time (or skip if the new value is null).
 *   - On delete, cancel the queued job so the worker doesn't wake up to a
 *     tombstoned row.
 *   - The worker itself is atomically fire-once via a claim-update on
 *     scheduleNotifiedAt (see recordings.worker.ts).
 */

async function assertFolderOwned(userId: string, folderId: string): Promise<void> {
  const folder = await prisma.folder.findFirst({ where: { id: folderId, userId } });
  if (!folder) throw Errors.badRequest('Folder not found');
}

async function quotaCheck(userId: string, addBytes: number): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plan: true, storageUsedBytes: true },
  });
  const limit = PLAN_STORAGE_BYTES[user.plan as SubscriptionPlan];
  if (Number(user.storageUsedBytes) + addBytes > limit) {
    throw Errors.quota('Not enough storage. Upgrade your plan or free up space.');
  }
}

export async function createRecording(userId: string, input: CreateRecordingInput) {
  assertKeyOwnedBy('voice', userId, input.fileKey);

  if (input.folderId) await assertFolderOwned(userId, input.folderId);

  // HEAD the object to confirm the upload happened and read the real byte size
  // (the client-reported size is never trusted for quota).
  const head = await confirmUploaded(input.fileKey);
  if (!head) {
    throw Errors.badRequest('Uploaded file not found in storage — upload may not have completed');
  }
  const sizeBytes = BigInt(head.sizeBytes);

  await quotaCheck(userId, head.sizeBytes);

  const created = await prisma.$transaction(async (tx) => {
    const rec = await tx.voiceRecording.create({
      data: {
        userId,
        title: input.title,
        duration: input.duration,
        contentType: input.contentType,
        fileKey: input.fileKey,
        sizeBytes,
        folderId: input.folderId ?? undefined,
        status: 'READY',
        scheduledDate: input.scheduledDate ?? null,
      },
    });
    await tx.user.update({
      where: { id: userId },
      data: { storageUsedBytes: { increment: sizeBytes } },
    });
    return rec;
  });

  // Enqueue the reminder AFTER the DB transaction commits — otherwise a rolled-
  // back create could leave a queued job pointing at a nonexistent recording.
  if (created.scheduledDate) {
    await scheduleVoiceReminder(created.id, created.scheduledDate).catch((err) =>
      logger.warn(
        { err, recordingId: created.id },
        'failed to enqueue voice reminder — the DB row is safe; retry via edit',
      ),
    );
  }

  logger.info(
    {
      recordingId: created.id,
      userId,
      duration: created.duration,
      bytes: head.sizeBytes,
      scheduledDate: created.scheduledDate,
    },
    'voice recording created',
  );

  // Hand back a signed URL straight away so the client can play the recording
  // it just created without a second round-trip to GET /api/voice-recordings/:id.
  const fileUrl = await generateSignedDownloadUrl(created.fileKey, 900);
  return shapeRow(created, fileUrl);
}

/**
 * PATCH /api/voice-recordings/:id
 *
 * Only `title` and `scheduledDate` are settable per the client PRD. `scheduledDate`
 * has three-way semantics:
 *   - present (Date)  → set / replace the reminder; also resets
 *                        scheduleNotifiedAt so the new date gets its own fire
 *   - null            → clear the reminder; cancel any queued job
 *   - omitted         → leave the current value alone (no reschedule)
 */
export async function updateRecording(
  userId: string,
  id: string,
  input: UpdateRecordingInput,
) {
  const existing = await recordingsRepo.findByIdForUser(userId, id);
  if (!existing) throw Errors.notFound('Recording not found');

  // Decide up front whether scheduledDate is actually changing (or being
  // explicitly cleared) so we can commit the DB update and the queue mutation
  // together. `undefined` = leave alone; `null` = clear; `Date` = set/replace.
  const scheduleChange: 'unchanged' | 'clear' | { newDate: Date } =
    input.scheduledDate === undefined
      ? 'unchanged'
      : input.scheduledDate === null
        ? 'clear'
        : { newDate: input.scheduledDate };

  const dataForDb: {
    title?: string;
    scheduledDate?: Date | null;
    scheduleNotifiedAt?: Date | null;
  } = {};
  if (input.title !== undefined) dataForDb.title = input.title;
  if (scheduleChange === 'clear') {
    dataForDb.scheduledDate = null;
    // Reset the notify tracker so re-setting the schedule later fires cleanly.
    dataForDb.scheduleNotifiedAt = null;
  } else if (typeof scheduleChange === 'object') {
    dataForDb.scheduledDate = scheduleChange.newDate;
    dataForDb.scheduleNotifiedAt = null; // new date = new reminder
  }

  const updated = await prisma.voiceRecording.update({
    where: { id: existing.id },
    data: dataForDb,
  });

  // Mirror the DB change to the queue. Failures here are logged but don't
  // undo the DB write — an admin can requeue via the same PATCH endpoint.
  if (scheduleChange === 'clear') {
    await cancelVoiceReminder(id).catch((err) =>
      logger.warn({ err, recordingId: id }, 'failed to cancel voice reminder'),
    );
  } else if (typeof scheduleChange === 'object') {
    await scheduleVoiceReminder(id, scheduleChange.newDate).catch((err) =>
      logger.warn({ err, recordingId: id }, 'failed to (re)schedule voice reminder'),
    );
  }

  const fileUrl = await generateSignedDownloadUrl(updated.fileKey, 900);
  return shapeRow(updated, fileUrl);
}

export async function listRecordings(userId: string, q: ListRecordingsQuery) {
  const rows = await recordingsRepo.list(userId, q);
  const hasNext = rows.length > q.limit;
  const items = hasNext ? rows.slice(0, q.limit) : rows;
  const nextCursor = hasNext ? items[items.length - 1]?.id ?? null : null;

  const tz = await userTimezone(userId);

  return {
    items: items.map((r: {
      id: string;
      title: string;
      contentType: string;
      fileKey: string;
      duration: number;
      folderId: string | null;
      scheduledDate: Date | null;
      createdAt: Date;
    }) => ({
      id: r.id,
      type: 'voice' as const,
      title: r.title,
      timezone: tz,
      contentType: r.contentType,
      fileKey: r.fileKey,
      duration: r.duration,
      folderId: r.folderId,
      scheduledDate: r.scheduledDate,
      createdAt: r.createdAt,
    })),
    nextCursor,
  };
}

export async function getRecording(userId: string, id: string) {
  const r = await recordingsRepo.findByIdForUser(userId, id);
  if (!r) throw Errors.notFound('Recording not found');
  const fileUrl = await generateSignedDownloadUrl(r.fileKey, 900);
  return shapeRow(r, fileUrl);
}

export async function deleteRecording(userId: string, id: string) {
  const r = await recordingsRepo.findByIdForUser(userId, id);
  if (!r) throw Errors.notFound('Recording not found');

  const ok = await recordingsRepo.softDelete(userId, id);
  if (!ok) throw Errors.notFound('Recording not found');

  if (r.sizeBytes > 0n) {
    await prisma.user.update({
      where: { id: userId },
      data: { storageUsedBytes: { decrement: r.sizeBytes } },
    });
  }

  // Cancel any pending reminder so the worker doesn't fire a notification
  // for a soft-deleted recording. The worker also guards against this case,
  // but preventing the job from firing at all is cleaner.
  await cancelVoiceReminder(id).catch((err) =>
    logger.warn({ err, recordingId: id }, 'failed to cancel voice reminder on delete'),
  );

  await deleteFile(r.fileKey, true).catch((err) =>
    logger.warn({ err, key: r.fileKey }, 's3 delete failed'),
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function userTimezone(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { timezone: true },
  });
  return u.timezone;
}

function shapeRow(
  r: {
    id: string;
    title: string;
    duration: number;
    contentType: string;
    fileKey: string;
    sizeBytes: bigint;
    folderId: string | null;
    scheduledDate: Date | null;
    createdAt: Date;
  },
  fileUrl: string | null,
) {
  return {
    id: r.id,
    type: 'voice' as const,
    title: r.title,
    duration: r.duration,
    contentType: r.contentType,
    fileKey: r.fileKey,
    fileUrl,
    sizeBytes: Number(r.sizeBytes),
    folderId: r.folderId,
    scheduledDate: r.scheduledDate,
    createdAt: r.createdAt,
  };
}
