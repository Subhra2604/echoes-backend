// import { prisma } from '../../lib/prisma.js';
// import { Errors } from '../../lib/errors.js';
// import { logger } from '../../lib/logger.js';
// import {
//   generateSignedDownloadUrl,
//   confirmUploaded,
//   deleteFile,
//   assertKeyOwnedBy,
// } from '../../lib/upload-module.js';
// import { PLAN_STORAGE_BYTES } from '../../config/plans.js';
// import { memoriesRepo } from './memories.repo.js';
// import type {
//   CreateMemoryInput,
//   UpdateMemoryInput,
//   ListMemoriesQuery,
// } from './memories.dto.js';
// import type { SubscriptionPlan } from '../../generated/prisma/enums.js';

// /**
//  * Memories service.
//  *
//  * Upload is a two-step flow shared with Profile/Voice:
//  *   1. POST /api/uploads/presign  -> client uploads bytes straight to S3
//  *   2. POST /api/memories         -> client submits metadata + the fileKey
//  *
//  * Bytes never travel through this API process. We HEAD the object on create to
//  * confirm it exists and to read its real size (quota is charged from the real
//  * size, never the client-claimed one).
//  */

// async function assertFolderOwned(userId: string, folderId: string): Promise<void> {
//   const folder = await prisma.folder.findFirst({ where: { id: folderId, userId } });
//   if (!folder) throw Errors.badRequest('Folder not found');
// }

// async function quotaCheck(userId: string, addBytes: number): Promise<void> {
//   const user = await prisma.user.findUniqueOrThrow({
//     where: { id: userId },
//     select: { plan: true, storageUsedBytes: true },
//   });
//   const limit = PLAN_STORAGE_BYTES[user.plan as SubscriptionPlan];
//   if (Number(user.storageUsedBytes) + addBytes > limit) {
//     throw Errors.quota('Not enough storage. Upgrade your plan or free up space.');
//   }
// }

// export async function createMemory(userId: string, input: CreateMemoryInput) {
//   // The key must belong to this user's memory namespace (defence in depth on top
//   // of the presign step that produced it).
//   assertKeyOwnedBy('memory', userId, input.fileKey);

//   if (input.folderId) await assertFolderOwned(userId, input.folderId);

//   // Confirm the object actually landed in S3 and read its real byte size.
//   const head = await confirmUploaded(input.fileKey);
//   console.log('HEAD RESULT', head);
//   if (!head) {
//     throw Errors.badRequest('Uploaded file not found in storage — upload may not have completed');
//   }
//   const sizeBytes = BigInt(head.sizeBytes);

//   await quotaCheck(userId, head.sizeBytes);

//   const tagIds = await memoriesRepo.upsertTagsByName(userId, input.tags ?? []);

//   const memory = await prisma.$transaction(async (tx) => {
//     const m = await tx.memory.create({
//       data: {
//         userId,
//         title: input.title,
//         story: input.story ?? null,
//         contentType: input.contentType,
//         fileKey: input.fileKey,
//         sizeBytes,
//         durationSec: input.durationSec,
//         width: input.width,
//         height: input.height,
//         folderId: input.folderId ?? undefined,
//         visibility: input.visibility,
//         status: 'READY',
//         tags: { createMany: { data: tagIds.map((tagId) => ({ tagId })) } },
//       },
//       include: { tags: { include: { tag: true } }, folder: true },
//     });

//     await tx.user.update({
//       where: { id: userId },
//       data: { storageUsedBytes: { increment: sizeBytes } },
//     });

//     return m;
//   });

//   logger.info(
//     { memoryId: memory.id, userId, bytes: head.sizeBytes },
//     'memory created',
//   );

//   // Hand back a signed URL straight away so the client can render what it just
//   // created without a second round-trip to GET /api/memories/:id.
//   const fileUrl = await generateSignedDownloadUrl(memory.fileKey, 900);
//   return shapeDetail(memory, fileUrl);
// }

// /** Lightweight combined-feed-ready listing — no large file URLs. */
// export async function listMemories(userId: string, q: ListMemoriesQuery) {
// logger.info({ userId, q }, 'before memoriesRepo.list');

//   const rows = await memoriesRepo.list(userId, q);
//   logger.info({ count: rows.length }, 'after memoriesRepo.list');

//   const hasNext = rows.length > q.limit;
//   const items = hasNext ? rows.slice(0, q.limit) : rows;
//   const nextCursor = hasNext ? items[items.length - 1]?.id ?? null : null;

//   const tz = await userTimezone(userId);
//   logger.info({ tz }, 'timezone loaded');

//   return {
//     items: items.map((m: {
//       id: string;
//       title: string;
//       contentType: string;
//       visibility: 'PRIVATE' | 'SHARED' | 'PUBLIC';
//       createdAt: Date;
//     }) => ({
//       id: m.id,
//       type: 'memory' as const,
//       title: m.title,
//       contentType: m.contentType,
//       visibility: m.visibility,
//       createdAt: m.createdAt,
//     })),
//   };
// }

// export async function getMemory(userId: string, id: string) {
//   const m = await memoriesRepo.findByIdForUser(userId, id);
//   if (!m) throw Errors.notFound('Memory not found');

//   const fileUrl = await generateSignedDownloadUrl(m.fileKey, 900);
//   return shapeDetail(m, fileUrl);
// }

// export async function updateMemory(
//   userId: string,
//   id: string,
//   input: UpdateMemoryInput,
// ) {
//   if (input.folderId) await assertFolderOwned(userId, input.folderId);

//   const replaceTagIds = input.tags
//     ? await memoriesRepo.upsertTagsByName(userId, input.tags)
//     : undefined;

//   const updated = await memoriesRepo.update(userId, id, {
//     title: input.title,
//     story: input.story,
//     folderId: input.folderId,
//     visibility: input.visibility,
//     replaceTagIds,
//   });
//   if (!updated) throw Errors.notFound('Memory not found');

//   const fileUrl = await generateSignedDownloadUrl(updated.fileKey, 900);
//   return shapeDetail(updated, fileUrl);
// }

// export async function deleteMemory(userId: string, id: string) {
//   const m = await memoriesRepo.findByIdForUser(userId, id);
//   if (!m) throw Errors.notFound('Memory not found');

//   const ok = await memoriesRepo.softDelete(userId, id);
//   if (!ok) throw Errors.notFound('Memory not found');

//   // Return the storage to the user, then best-effort purge S3.
//   if (m.sizeBytes > 0n) {
//     await prisma.user.update({
//       where: { id: userId },
//       data: { storageUsedBytes: { decrement: m.sizeBytes } },
//     });
//   }
//   await deleteFile(m.fileKey, true).catch((err) =>
//     logger.warn({ err, key: m.fileKey }, 's3 delete failed'),
//   );
//   if (m.thumbnailKey) await deleteFile(m.thumbnailKey);
// }

// // ── helpers ──────────────────────────────────────────────────────────────────

// async function userTimezone(userId: string): Promise<string> {
//   const u = await prisma.user.findUniqueOrThrow({
//     where: { id: userId },
//     select: { timezone: true },
//   });
//   return u.timezone;
// }

// /** Shape the detail response. `fileUrl` is null on create (returned separately). */
// function shapeDetail(
//   m: {
//     id: string;
//     title: string;
//     story: string | null;
//     contentType: string;
//     fileKey: string;
//     sizeBytes: bigint;
//     durationSec: number | null;
//     width: number | null;
//     height: number | null;
//     visibility: 'PRIVATE' | 'SHARED' | 'PUBLIC';
//     folderId: string | null;
//     folder?: { id: string; name: string } | null;
//     createdAt: Date;
//     updatedAt: Date;
//     tags: Array<{ tag: { name: string } }>;
//   },
//   fileUrl: string | null,
// ) {
//   return {
//     id: m.id,
//     type: 'memory' as const,
//     title: m.title,
//     story: m.story,
//     contentType: m.contentType,
//     fileKey: m.fileKey,
//     fileUrl,
//     sizeBytes: Number(m.sizeBytes),
//     durationSec: m.durationSec,
//     width: m.width,
//     height: m.height,
//     visibility: m.visibility,
//     folder: m.folder ? { id: m.folder.id, name: m.folder.name } : null,
//     folderId: m.folderId,
//     tags: m.tags.map((t) => t.tag.name),
//     createdAt: m.createdAt,
//     updatedAt: m.updatedAt,
//   };
// }




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
import { memoriesRepo } from './memories.repo.js';
import type {
  CreateMemoryInput,
  UpdateMemoryInput,
  ListMemoriesQuery,
} from './memories.dto.js';
import type { SubscriptionPlan } from '../../generated/prisma/enums.js';

/**
 * Memories service.
 *
 * MEDIA upload is a two-step flow shared with Profile/Voice:
 *   1. POST /api/uploads/presign  -> client uploads bytes straight to S3
 *   2. POST /api/memories         -> client submits metadata + the fileKey
 * Bytes never travel through this API process. We HEAD the object on create to
 * confirm it exists and to read its real size (quota is charged from the real
 * size, never the client-claimed one).
 *
 * NOTE memories skip the upload/quota path entirely — there is no file, no S3
 * object, and no storage-usage impact.
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

export async function createMemory(userId: string, input: CreateMemoryInput) {
  if (input.folderId) await assertFolderOwned(userId, input.folderId);
  const tagIds = await memoriesRepo.upsertTagsByName(userId, input.tags ?? []);

  if (input.memoryType === 'NOTE') {
    const memory = await prisma.memory.create({
      data: {
        userId,
        memoryType: 'NOTE',
        title: input.title,
        story: input.story, // note body — required, enforced in the DTO
        folderId: input.folderId ?? undefined,
        visibility: input.visibility,
        status: 'READY',
        tags: { createMany: { data: tagIds.map((tagId) => ({ tagId })) } },
      },
      include: { tags: { include: { tag: true } }, folder: true },
    });

    logger.info({ memoryId: memory.id, userId }, 'note memory created');
    return shapeDetail(memory, null);
  }

  // ── MEDIA flow (unchanged) ──
  // The key must belong to this user's memory namespace (defence in depth on top
  // of the presign step that produced it).
  assertKeyOwnedBy('memory', userId, input.fileKey!);

  // Confirm the object actually landed in S3 and read its real byte size.
  const head = await confirmUploaded(input.fileKey!);
  if (!head) {
    throw Errors.badRequest('Uploaded file not found in storage — upload may not have completed');
  }
  const sizeBytes = BigInt(head.sizeBytes);

  await quotaCheck(userId, head.sizeBytes);

  const memory = await prisma.$transaction(async (tx) => {
    const m = await tx.memory.create({
      data: {
        userId,
        memoryType: 'MEDIA',
        title: input.title,
        story: input.story ?? null,
        contentType: input.contentType!,
        fileKey: input.fileKey!,
        sizeBytes,
        durationSec: input.durationSec,
        width: input.width,
        height: input.height,
        folderId: input.folderId ?? undefined,
        visibility: input.visibility,
        status: 'READY',
        tags: { createMany: { data: tagIds.map((tagId) => ({ tagId })) } },
      },
      include: { tags: { include: { tag: true } }, folder: true },
    });

    await tx.user.update({
      where: { id: userId },
      data: { storageUsedBytes: { increment: sizeBytes } },
    });

    return m;
  });

  logger.info(
    { memoryId: memory.id, userId, bytes: head.sizeBytes },
    'memory created',
  );

  // Hand back a signed URL straight away so the client can render what it just
  // created without a second round-trip to GET /api/memories/:id.
  const fileUrl = await generateSignedDownloadUrl(memory.fileKey!, 900);
  return shapeDetail(memory, fileUrl);
}

/** Lightweight combined-feed-ready listing — no large file URLs. */
export async function listMemories(userId: string, q: ListMemoriesQuery) {
  const rows = await memoriesRepo.list(userId, q);

  const hasNext = rows.length > q.limit;
  const items = hasNext ? rows.slice(0, q.limit) : rows;
  const nextCursor = hasNext ? items[items.length - 1]?.id ?? null : null;

  return {
    items: items.map((m: {
      id: string;
      title: string;
      memoryType: 'MEDIA' | 'NOTE';
      contentType: string | null;
      visibility: 'PRIVATE' | 'SHARED' | 'PUBLIC';
      createdAt: Date;
    }) => ({
      id: m.id,
      type: 'memory' as const,
      memoryType: m.memoryType,
      title: m.title,
      contentType: m.contentType,
      visibility: m.visibility,
      createdAt: m.createdAt,
    })),
    nextCursor,
  };
}

export async function getMemory(userId: string, id: string) {
  const m = await memoriesRepo.findByIdForUser(userId, id);
  if (!m) throw Errors.notFound('Memory not found');

  const fileUrl = m.fileKey ? await generateSignedDownloadUrl(m.fileKey, 900) : null;
  return shapeDetail(m, fileUrl);
}

export async function updateMemory(
  userId: string,
  id: string,
  input: UpdateMemoryInput,
) {
  if (input.folderId) await assertFolderOwned(userId, input.folderId);

  const replaceTagIds = input.tags
    ? await memoriesRepo.upsertTagsByName(userId, input.tags)
    : undefined;

  const updated = await memoriesRepo.update(userId, id, {
    title: input.title,
    story: input.story,
    folderId: input.folderId,
    visibility: input.visibility,
    replaceTagIds,
  });
  if (!updated) throw Errors.notFound('Memory not found');

  const fileUrl = updated.fileKey ? await generateSignedDownloadUrl(updated.fileKey, 900) : null;
  return shapeDetail(updated, fileUrl);
}

export async function deleteMemory(userId: string, id: string) {
  const m = await memoriesRepo.findByIdForUser(userId, id);
  if (!m) throw Errors.notFound('Memory not found');

  const ok = await memoriesRepo.softDelete(userId, id);
  if (!ok) throw Errors.notFound('Memory not found');

  // NOTE rows have no file/storage footprint — nothing further to clean up.
  if (m.memoryType === 'NOTE') return;

  // Return the storage to the user, then best-effort purge S3.
  if (m.sizeBytes > 0n) {
    await prisma.user.update({
      where: { id: userId },
      data: { storageUsedBytes: { decrement: m.sizeBytes } },
    });
  }
  if (m.fileKey) {
    await deleteFile(m.fileKey, true).catch((err) =>
      logger.warn({ err, key: m.fileKey }, 's3 delete failed'),
    );
  }
  if (m.thumbnailKey) await deleteFile(m.thumbnailKey);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Shape the detail response. `fileUrl` is null on create for notes, or MEDIA where not requested. */
function shapeDetail(
  m: {
    id: string;
    memoryType: 'MEDIA' | 'NOTE';
    title: string;
    story: string | null;
    contentType: string | null;
    fileKey: string | null;
    sizeBytes: bigint;
    durationSec: number | null;
    width: number | null;
    height: number | null;
    visibility: 'PRIVATE' | 'SHARED' | 'PUBLIC';
    folderId: string | null;
    folder?: { id: string; name: string } | null;
    createdAt: Date;
    updatedAt: Date;
    tags: Array<{ tag: { name: string } }>;
  },
  fileUrl: string | null,
) {
  return {
    id: m.id,
    type: 'memory' as const,
    memoryType: m.memoryType,
    title: m.title,
    story: m.story,
    contentType: m.contentType,
    fileKey: m.fileKey,
    fileUrl,
    sizeBytes: Number(m.sizeBytes),
    durationSec: m.durationSec,
    width: m.width,
    height: m.height,
    visibility: m.visibility,
    folder: m.folder ? { id: m.folder.id, name: m.folder.name } : null,
    folderId: m.folderId,
    tags: m.tags.map((t) => t.tag.name),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}