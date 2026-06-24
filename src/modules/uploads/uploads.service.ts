import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import {
  generatePresignedUrl,
  generateSignedDownloadUrl,
  deleteFile,
  validateFile,
  assertKeyOwnedBy,
  type UploadCategory,
} from '../../lib/upload-module.js';
import { PLAN_STORAGE_BYTES } from '../../config/plans.js';
import type { SubscriptionPlan } from '../../generated/prisma/enums.js';
import type { PresignInput, DeleteFileInput, SignedUrlQuery } from './uploads.dto.js';

/**
 * Generic upload service shared by Profile / Memory / Voice.
 *
 * Flow (identical to the Profile avatar architecture):
 *   1. POST /uploads/presign  -> validate + return presigned POST(s) for S3
 *   2. client uploads bytes straight to S3 (API never touches the bytes)
 *   3. client submits metadata to the relevant module (memories / voice / users)
 *
 * `DELETE /uploads/file` and `GET /uploads/signed-url` are convenience helpers
 * for orphan cleanup and ad-hoc viewing; module-level delete still owns quota
 * accounting for persisted records.
 */

/** Aggregate declared size against the caller's remaining plan storage. */
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

/**
 * Step 1: validate every file (MIME + extension + size) for the category, run a
 * declared-size quota pre-check, then issue presigned POSTs. We validate the
 * whole batch before issuing any URL so a single bad file rejects the request.
 */
export async function presign(userId: string, input: PresignInput) {
  const category = input.category as UploadCategory;
console.log({
  bucket: process.env.S3_BUCKET,
  region: process.env.AWS_REGION,
});
  let total = 0;
  for (const f of input.files) {
    validateFile(category, {
      filename: f.filename,
      contentType: f.contentType,
      sizeBytes: f.sizeBytes,
    });
    total += f.sizeBytes;
  }
  await quotaCheck(userId, total);

  const uploads = await Promise.all(
    input.files.map(async (f) => {
      const { key, upload } = await generatePresignedUrl(category, userId, {
        filename: f.filename,
        contentType: f.contentType,
        sizeBytes: f.sizeBytes,
      });
      return { filename: f.filename, key, upload };
    }),
  );

  return { uploads };
}

/**
 * Delete an object directly from S3. Intended for orphan cleanup — e.g. the
 * client presigned + uploaded a file but abandoned the form before submitting
 * metadata. Ownership is enforced by the category prefix in the key.
 *
 * NOTE: this does not adjust `storageUsedBytes` because orphaned objects were
 * never finalized into a record (quota is only charged at create-time in each
 * module). Deleting a *persisted* memory/recording goes through that module so
 * quota is returned correctly.
 */
export async function removeFile(userId: string, input: DeleteFileInput) {
  assertKeyOwnedBy(input.category as UploadCategory, userId, input.key);
  await deleteFile(input.key, true);
  return { deleted: true };
}

/** Issue a short-lived signed GET URL for an object the caller owns. */
export async function signedUrl(userId: string, q: SignedUrlQuery) {
  // Any of the three category prefixes is acceptable, but the object must be
  // under this user's namespace.
  const owned =
    q.key.startsWith(`profiles/${userId}/`) ||
    q.key.startsWith(`memories/${userId}/`) ||
    q.key.startsWith(`voices/${userId}/`);
  if (!owned) throw Errors.forbidden('You do not have access to this file');

  const url = await generateSignedDownloadUrl(q.key, q.expiresSec ?? 900);
  return { url, expiresSec: q.expiresSec ?? 900 };
}
