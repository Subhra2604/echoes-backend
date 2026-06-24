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
import type {
  CreateRecordingInput,
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
  console.log('HEAD RESULT', head);
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
      },
    });
    await tx.user.update({
      where: { id: userId },
      data: { storageUsedBytes: { increment: sizeBytes } },
    });
    return rec;
  });

  logger.info(
    { recordingId: created.id, userId, duration: created.duration, bytes: head.sizeBytes },
    'voice recording created',
  );

  // Hand back a signed URL straight away so the client can play the recording
  // it just created without a second round-trip to GET /api/voice-recordings/:id.
  const fileUrl = await generateSignedDownloadUrl(created.fileKey, 900);
  return shapeRow(created, fileUrl);
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
      duration: number;
      folderId: string | null;
      createdAt: Date;
    }) => ({
      id: r.id,
      type: 'voice' as const,
      title: r.title,
      timezone: tz,
      contentType: r.contentType,
      duration: r.duration,
      folderId: r.folderId,
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
    createdAt: r.createdAt,
  };
}
