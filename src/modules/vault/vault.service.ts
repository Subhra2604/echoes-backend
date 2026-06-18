import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import { presignUpload, presignDownload, headObject, deleteObject, buildObjectKey } from '../../lib/s3.js';
import { notify } from '../notifications/notifications.service.js';
import { PLAN_STORAGE_BYTES, PLAN_PHOTO_LIMIT, storageWarningLevel } from '../../config/plans.js';
import {
  MAX_BYTES_BY_TYPE,
  PHOTO_MIME,
  VIDEO_MIME,
  AUDIO_MIME,
  DOC_MIME,
  type InitUploadInput,
  type WrittenMemoryInput,
} from './vault.dto.js';
import type { VaultItemType, SubscriptionPlan } from '../../generated/prisma/enums.js';

const MIME_BY_TYPE: Record<string, string[]> = {
  PHOTO: PHOTO_MIME,
  VIDEO: VIDEO_MIME,
  AUDIO: AUDIO_MIME,
  DOCUMENT: DOC_MIME,
};

async function getVault(userId: string) {
  const vault = await prisma.vault.findUnique({ where: { userId } });
  if (!vault) throw Errors.notFound('Vault not found');
  return vault;
}

/** Remaining quota for a user, in bytes (driven by their subscription plan). */
async function remainingBytes(userId: string): Promise<{ used: bigint; limit: number; free: number }> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plan: true, storageUsedBytes: true },
  });
  const limit = PLAN_STORAGE_BYTES[user.plan as SubscriptionPlan];
  const used = user.storageUsedBytes as bigint;
  return { used, limit, free: limit - Number(used) };
}

export async function getStorageUsage(userId: string) {
  const { used, limit, free } = await remainingBytes(userId);
  const usedBytes = Number(used);
  return {
    usedBytes,
    limitBytes: limit,
    freeBytes: Math.max(0, free),
    usedFraction: limit > 0 ? Math.min(1, usedBytes / limit) : 0,
    // Storage warning thresholds at 80 / 90 / 100 percent.
    warningLevel: storageWarningLevel(usedBytes, limit),
  };
}

/**
 * Step 1 of upload: validate type/format/size + quota, create a PENDING item,
 * and hand back a presigned POST. The client uploads bytes straight to S3.
 */
export async function initUpload(userId: string, input: InitUploadInput) {
  const allowed = MIME_BY_TYPE[input.type];
  if (!allowed || !allowed.includes(input.contentType)) {
    throw Errors.badRequest(`Unsupported format for ${input.type}: ${input.contentType}`);
  }

  const perFileMax = MAX_BYTES_BY_TYPE[input.type];
  if (input.sizeBytes > perFileMax) {
    throw Errors.payload(`File exceeds the ${Math.round(perFileMax / 1024 / 1024)}MB limit for ${input.type}`);
  }

  // [GAP §3] capsule media is capped at 60s; we also reject >60s here for A/V so
  // an over-length clip can never be attached to a capsule later.
  if ((input.type === 'VIDEO' || input.type === 'AUDIO') && input.durationSec && input.durationSec > 60) {
    throw Errors.badRequest('Video and audio uploads are limited to 60 seconds');
  }

  const { free } = await remainingBytes(userId);
  if (input.sizeBytes > free) {
    throw Errors.quota('Not enough storage. Upgrade your plan or free up space.');
  }

  const vault = await getVault(userId);

  // Per-plan photo-count cap (Free is limited to 20 photos).
  if (input.type === 'PHOTO') {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { plan: true } });
    const photoLimit = PLAN_PHOTO_LIMIT[user.plan as SubscriptionPlan];
    if (photoLimit !== null) {
      const photoCount = await prisma.vaultItem.count({ where: { vaultId: vault.id, type: 'PHOTO' } });
      if (photoCount >= photoLimit) {
        throw Errors.quota(`Your plan allows up to ${photoLimit} photos. Upgrade to add more.`);
      }
    }
  }

  if (input.folderId) await assertFolderInVault(input.folderId, vault.id);

  const key = buildObjectKey(userId, input.filename);
  const item = await prisma.vaultItem.create({
    data: {
      vaultId: vault.id,
      folderId: input.folderId,
      type: input.type as VaultItemType,
      title: input.title,
      description: input.description,
      s3Key: key,
      mimeType: input.contentType,
      sizeBytes: BigInt(input.sizeBytes),
      durationSec: input.durationSec,
      uploadStatus: 'PENDING_UPLOAD',
    },
  });

  const presigned = await presignUpload({ key, contentType: input.contentType, maxBytes: perFileMax });
  return { itemId: item.id, upload: presigned };
}

/**
 * Step 2: confirm the object landed in S3, reconcile the real byte size against
 * the user's quota, and mark the item READY. Storage usage is updated here from
 * the *actual* object size (HEAD), not the client-claimed size.
 */
export async function finalizeUpload(userId: string, itemId: string) {
  const item = await prisma.vaultItem.findFirst({
    where: { id: itemId, vault: { userId } },
  });
  if (!item || !item.s3Key) throw Errors.notFound('Upload not found');
  if (item.uploadStatus !== 'PENDING_UPLOAD') return item;

  const head = await headObject(item.s3Key).catch(() => null);
  if (!head) throw Errors.badRequest('Object not found in storage — upload may not have completed');

  const realSize = BigInt(head.sizeBytes);

  // Recheck quota against the real size and commit usage atomically.
  let newUsed = 0;
  let limit = 0;
  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { plan: true, storageUsedBytes: true },
    });
    limit = PLAN_STORAGE_BYTES[user.plan as SubscriptionPlan];
    if (Number(user.storageUsedBytes) + Number(realSize) > limit) {
      // Over quota after measuring real bytes — delete the object and fail.
      throw Errors.quota('Upload would exceed your storage quota.');
    }
    const u = await tx.user.update({
      where: { id: userId },
      data: { storageUsedBytes: { increment: realSize } },
      select: { storageUsedBytes: true },
    });
    newUsed = Number(u.storageUsedBytes);
    return tx.vaultItem.update({
      where: { id: item.id },
      data: { sizeBytes: realSize, uploadStatus: 'READY' },
    });
  }).catch(async (err) => {
    if (item.s3Key) await deleteObject(item.s3Key).catch(() => undefined);
    throw err;
  });

  // [GAP §7] push events: video uploaded / pdf uploaded.
  if (item.type === 'VIDEO') {
    await notify(userId, 'MEDIA_VIDEO_UPLOADED', 'Video uploaded', `“${item.title ?? 'Your video'}” is ready in your vault.`);
  } else if (item.type === 'DOCUMENT' && item.mimeType === 'application/pdf') {
    await notify(userId, 'MEDIA_PDF_UPLOADED', 'PDF uploaded', `“${item.title ?? 'Your document'}” is ready in your vault.`);
  }

  // Storage warning at 80 / 90 / 100 percent of quota.
  const level = storageWarningLevel(newUsed, limit);
  if (level) {
    const msg = level >= 100
      ? 'You have reached your storage limit. Upgrade your plan or free up space to keep adding memories.'
      : `You have used ${level}% of your storage. Consider upgrading your plan soon.`;
    await notify(userId, 'STORAGE_WARNING', 'Storage almost full', msg, { level });
  }

  return updated;
}

export async function createWrittenMemory(userId: string, input: WrittenMemoryInput) {
  const vault = await getVault(userId);
  if (input.folderId) await assertFolderInVault(input.folderId, vault.id);
  return prisma.vaultItem.create({
    data: {
      vaultId: vault.id,
      folderId: input.folderId,
      type: 'WRITTEN',
      title: input.title,
      bodyText: input.bodyText,
      tags: input.tags ?? [],
      uploadStatus: 'READY',
    },
  });
}

export async function listItems(userId: string, folderId?: string) {
  const vault = await getVault(userId);
  return prisma.vaultItem.findMany({
    where: { vaultId: vault.id, ...(folderId ? { folderId } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getItemDownloadUrl(userId: string, itemId: string) {
  const item = await prisma.vaultItem.findFirst({ where: { id: itemId, vault: { userId } } });
  if (!item) throw Errors.notFound('Item not found');
  if (!item.s3Key) throw Errors.badRequest('This item has no downloadable file');
  return { url: await presignDownload(item.s3Key), mimeType: item.mimeType };
}

export async function deleteItem(userId: string, itemId: string) {
  const item = await prisma.vaultItem.findFirst({ where: { id: itemId, vault: { userId } } });
  if (!item) throw Errors.notFound('Item not found');

  await prisma.$transaction(async (tx) => {
    if (item.sizeBytes > 0n) {
      await tx.user.update({
        where: { id: userId },
        data: { storageUsedBytes: { decrement: item.sizeBytes } },
      });
    }
    await tx.vaultItem.delete({ where: { id: item.id } });
  });
  if (item.s3Key) await deleteObject(item.s3Key).catch(() => undefined);
}

// ── Folders ───────────────────────────────────────────────────────────────────
export async function createFolder(userId: string, name: string, parentId?: string) {
  const vault = await getVault(userId);
  if (parentId) await assertFolderInVault(parentId, vault.id);
  return prisma.vaultFolder.create({ data: { vaultId: vault.id, name, parentId } });
}

export async function listFolders(userId: string) {
  const vault = await getVault(userId);
  return prisma.vaultFolder.findMany({ where: { vaultId: vault.id }, orderBy: { name: 'asc' } });
}

async function assertFolderInVault(folderId: string, vaultId: string) {
  const folder = await prisma.vaultFolder.findFirst({ where: { id: folderId, vaultId } });
  if (!folder) throw Errors.badRequest('Folder not found in your vault');
}
