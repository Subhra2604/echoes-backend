import { S3Client, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * S3 access layer. [GAP §4] storage = AWS S3 with server-side encryption (SSE).
 * Uploads use presigned POST so bytes go browser/app -> S3 directly (the API
 * never proxies file data). Downloads use short-lived presigned GET URLs.
 */
export const s3 = new S3Client({ region: env.AWS_REGION });

export function buildObjectKey(userId: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `users/${userId}/${randomUUID()}/${safe}`;
}

export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
  key: string;
}

/**
 * Presigned POST for a direct browser/app upload. We constrain content-length
 * server-side so a client cannot exceed the per-file cap or their quota.
 * [GAP §4] SSE is enforced as a required condition on the upload.
 */
export async function presignUpload(params: {
  key: string;
  contentType: string;
  maxBytes: number;
}): Promise<PresignedUpload> {
  const sse = env.S3_SSE; // "AES256" (SSE-S3) or "aws:kms"
  const presigned = await createPresignedPost(s3, {
    Bucket: env.S3_BUCKET,
    Key: params.key,
    Conditions: [
      ['content-length-range', 0, params.maxBytes],
      ['eq', '$Content-Type', params.contentType],
      ['eq', '$x-amz-server-side-encryption', sse],
    ],
    Fields: {
      'Content-Type': params.contentType,
      'x-amz-server-side-encryption': sse,
    },
    Expires: 600, // 10 minutes to start the upload
  });
  return { url: presigned.url, fields: presigned.fields, key: params.key };
}

/** Short-lived GET URL for viewing/downloading a private object. */
export async function presignDownload(key: string, expiresSec = 900): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), {
    expiresIn: expiresSec,
  });
}

/** Confirm an object exists and return its real size (used to finalize uploads). */
export async function headObject(key: string): Promise<{ sizeBytes: number; contentType?: string }> {
  const out = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  return { sizeBytes: Number(out.ContentLength ?? 0), contentType: out.ContentType };
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

/**
 * Upload a small buffer directly to S3 (server-side, not presigned). Used for
 * tiny assets like avatars where a presign + separate POST adds unnecessary
 * round-trips. SSE is applied to match the presigned-upload path.
 */
export async function putObject(params: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      ServerSideEncryption: env.S3_SSE as 'AES256' | 'aws:kms',
    }),
  );
}
