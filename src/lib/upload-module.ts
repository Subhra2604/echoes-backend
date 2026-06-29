import { randomUUID } from 'node:crypto';
import { Errors } from './errors.js';
import {
  presignUpload as s3PresignUpload,
  presignDownload as s3PresignDownload,
  deleteObject as s3DeleteObject,
  headObject as s3HeadObject,
  type PresignedUpload,
} from './s3.js';
import { env } from '../config/env.js';
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";


/**
 * Shared, category-aware upload module.
 *
 * One place that knows how to: validate a file (MIME + extension + size),
 * derive a deterministic S3 object key per upload category, presign a direct
 * browser→S3 POST, presign a short-lived download, and delete an object.
 *
 * Profile (avatar), Memory, and Voice flows all go through here instead of
 * re-implementing presign/validation logic. Bytes never travel through the API
 * process — the client POSTs straight to S3 with the returned presigned form.
 *
 *   Upload Module
 *   ├── generatePresignedUrl()       -> presign a direct-to-S3 upload (validated)
 *   ├── validateFile()               -> MIME + extension + size in one call
 *   ├── validateMimeType()           -> MIME + extension only
 *   ├── generateObjectKey()          -> profiles|memories|voices/{userId}/...
 *   ├── generateSignedDownloadUrl()  -> short-lived private GET URL
 *   └── deleteFile()                 -> remove an object from S3
 */

// ── Categories ───────────────────────────────────────────────────────────────

export type UploadCategory = 'profile' | 'memory' | 'voice';

/** S3 top-level prefix per category: profiles/{userId}/, memories/{userId}/, … */
const CATEGORY_PREFIX: Record<UploadCategory, string> = {
  profile: 'profiles',
  memory: 'memories',
  voice: 'voices',
};

// ── Allowed types per category ───────────────────────────────────────────────
//
// Each allowed entry maps a canonical MIME type to the file extensions we accept
// for it. We validate BOTH the declared MIME and the filename extension, so a
// client cannot smuggle an executable past a permissive Content-Type, and vice
// versa.

interface MimeRule {
  /** Accepted lowercase extensions (without the dot) for this MIME type. */
  ext: readonly string[];
  /** Max bytes for files of this MIME type. */
  maxBytes: number;
}

const MB = 1024 * 1024;

const PROFILE_RULES: Record<string, MimeRule> = {
  'image/jpeg': { ext: ['jpg', 'jpeg'], maxBytes: 5 * MB },
  'image/png': { ext: ['png'], maxBytes: 5 * MB },
  'image/webp': { ext: ['webp'], maxBytes: 5 * MB },
  'image/heic': { ext: ['heic'], maxBytes: 5 * MB },
  'image/heif': { ext: ['heif'], maxBytes: 5 * MB },
};

const MEMORY_RULES: Record<string, MimeRule> = {
  // Images — JPG / JPEG / PNG / WEBP
  'image/jpeg': { ext: ['jpg', 'jpeg'], maxBytes: 50 * MB },
  'image/png': { ext: ['png'], maxBytes: 50 * MB },
  'image/webp': { ext: ['webp'], maxBytes: 50 * MB },
  // Documents — PDF / DOC / DOCX
  'application/pdf': { ext: ['pdf'], maxBytes: 50 * MB },
  'application/msword': { ext: ['doc'], maxBytes: 50 * MB },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    ext: ['docx'],
    maxBytes: 50 * MB,
  },
  // Videos — MP4 / MOV / WEBM
  'video/mp4': { ext: ['mp4'], maxBytes: 500 * MB },
  'video/quicktime': { ext: ['mov'], maxBytes: 500 * MB },
  'video/webm': { ext: ['webm'], maxBytes: 500 * MB },
};

const VOICE_RULES: Record<string, MimeRule> = {
  // Audio — MP3 / M4A / WEBM Audio
  'audio/mpeg': { ext: ['mp3'], maxBytes: 100 * MB }, // MP3
  'audio/mp4': { ext: ['m4a', 'mp4'], maxBytes: 100 * MB }, // AAC / M4A container
  'audio/x-m4a': { ext: ['m4a'], maxBytes: 100 * MB },
  'audio/aac': { ext: ['aac', 'm4a'], maxBytes: 100 * MB },
  'audio/webm': { ext: ['webm'], maxBytes: 100 * MB }, // WEBM Audio (Opus)
};

const RULES_BY_CATEGORY: Record<UploadCategory, Record<string, MimeRule>> = {
  profile: PROFILE_RULES,
  memory: MEMORY_RULES,
  voice: VOICE_RULES,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip path-traversal characters and clamp length on any client filename. */
function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name; // drop any path components
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
}

/** Lowercase extension (without dot) parsed from a filename, or '' if none. */
function extensionOf(filename: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename);
  return m?.[1]?.toLowerCase() ?? '';
}

export interface FileDescriptor {
  filename: string;
  contentType: string;
  /** Client-declared size in bytes. Re-checked against the real S3 HEAD later. */
  sizeBytes?: number;
}

export interface ValidatedFile {
  filename: string;
  contentType: string;
  extension: string;
  /** The max bytes permitted for this file's MIME type in this category. */
  maxBytes: number;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Lowercased list of MIME types allowed for a category (handy for DTO enums). */
export function allowedMimeTypes(category: UploadCategory): string[] {
  return Object.keys(RULES_BY_CATEGORY[category]);
}

/**
 * Validate a file's declared MIME type and filename extension for a category.
 * Throws 400 (BAD_REQUEST) when the type/extension pair is not allowed.
 * Returns the matched rule (incl. the per-type byte cap) on success.
 */
export function validateMimeType(
  category: UploadCategory,
  file: FileDescriptor,
): ValidatedFile {
  const rules = RULES_BY_CATEGORY[category];
  const rule = rules[file.contentType];
  if (!rule) {
    throw Errors.badRequest(
      `Unsupported file type for ${category}: ${file.contentType}`,
    );
  }

  const ext = extensionOf(file.filename);
  if (ext && !rule.ext.includes(ext)) {
    throw Errors.badRequest(
      `File extension ".${ext}" does not match its declared type (${file.contentType})`,
    );
  }

  return {
    filename: file.filename,
    contentType: file.contentType,
    extension: ext || rule.ext[0] || '',
    maxBytes: rule.maxBytes,
  };
}

/**
 * Full pre-upload validation: MIME + extension + size. Use before issuing a
 * presigned URL. The size here is the client-declared value; the real byte
 * count is re-validated via `confirmUploaded` after the upload finishes, so a
 * lying client cannot bypass quota.
 */
export function validateFile(
  category: UploadCategory,
  file: FileDescriptor,
): ValidatedFile {
  const validated = validateMimeType(category, file);
  if (file.sizeBytes !== undefined) {
    if (file.sizeBytes <= 0) {
      throw Errors.badRequest(`${file.filename} is empty`);
    }
    if (file.sizeBytes > validated.maxBytes) {
      throw Errors.payload(
        `${file.filename} exceeds the ${Math.round(
          validated.maxBytes / MB,
        )}MB limit for ${file.contentType}`,
      );
    }
  }
  return validated;
}

/**
 * Deterministic S3 object key for a category + user. Layout:
 *
 *   profiles/{userId}/{uuid}/{safe-filename}
 *   memories/{userId}/{uuid}/{safe-filename}
 *   voices/{userId}/{uuid}/{safe-filename}
 *
 * The UUID segment guarantees uniqueness (re-uploading the same filename never
 * collides) and every object stays scoped under the owning user's prefix, which
 * ownership checks and S3 lifecycle/retention rules rely on.
 */
export function generateObjectKey(
  category: UploadCategory,
  userId: string,
  filename: string,
): string {
  return `${CATEGORY_PREFIX[category]}/${userId}/${randomUUID()}/${sanitizeFilename(
    filename,
  )}`;
}

export interface PresignResult {
  /** The S3 object key the client must reference when finalizing metadata. */
  key: string;
  /** Presigned POST: { url, fields } — the client POSTs the file here. */
  upload: PresignedUpload;
  /** The byte cap enforced server-side via the presigned POST conditions. */
  maxBytes: number;
}

/**
 * Validate a file and presign a direct browser→S3 upload for it. The single
 * entry point used by every category's "request upload URL" endpoint.
 *
 * The presigned POST enforces the per-type byte cap and SSE as hard conditions,
 * so the application server never handles the bytes and a client cannot exceed
 * the cap or skip encryption.
 */
export async function generatePresignedUrl(
  category: UploadCategory,
  userId: string,
  file: FileDescriptor,
): Promise<PresignResult> {
  const validated = validateFile(category, file);
  const key = generateObjectKey(category, userId, validated.filename);
  const upload = await s3PresignUpload({
    key,
    contentType: validated.contentType,
    maxBytes: validated.maxBytes,
  });
  return { key, upload, maxBytes: validated.maxBytes };
}

/** Short-lived presigned GET URL for viewing/downloading a private object. */
export function generateSignedDownloadUrl(
  key: string,
  expiresSec = 900,
): Promise<string> {
  return s3PresignDownload(key, expiresSec);
}

/** Remove an object from S3. Best-effort by default (swallows errors). */
export async function deleteFile(key: string, throwOnError = false): Promise<void> {
  try {
    await s3DeleteObject(key);
  } catch (err) {
    if (throwOnError) throw err;
  }
}

/**
 * Confirm an uploaded object exists in S3 and return its real size. Used by the
 * finalize step to reconcile the client-declared size against reality before
 * persisting metadata / charging quota. Returns null when the object is absent.
 */
// export async function confirmUploaded(
//   key: string,
// ): Promise<{ sizeBytes: number; contentType?: string } | null> {
//   return s3HeadObject(key).catch(() => null);
// }

export async function confirmUploaded(
  key: string,
): Promise<{ sizeBytes: number; contentType?: string } | null> {
  try {


  const sts = new STSClient({ region: env.AWS_REGION });

  const whoAmI = await sts.send(new GetCallerIdentityCommand({}));

  console.log("AWS Identity:", whoAmI);
    console.log("Bucket:", env.S3_BUCKET);
  console.log("Region:", env.AWS_REGION);
  console.log("Key:", key);

    const result = await s3HeadObject(key);

    console.log('HEAD RESULT:', result);

    return result;
  }
  catch (err: any) {
    console.dir(err, { depth: null });

    console.log(err.name);
    console.log(err.message);
    console.log(err.$metadata);

    throw err;
}
}

/**
 * Belt-and-braces ownership guard for a finalized key. The client submits the
 * key it received from `generatePresignedUrl`; this ensures it actually lives
 * under the caller's category prefix and cannot point at someone else's object.
 */
export function assertKeyOwnedBy(
  category: UploadCategory,
  userId: string,
  key: string,
): void {
  const expectedPrefix = `${CATEGORY_PREFIX[category]}/${userId}/`;
  if (!key.startsWith(expectedPrefix)) {
    throw Errors.badRequest('File key does not belong to you');
  }
}

/** Expose the per-type cap (handy for messages / pre-checks). */
export function maxBytesFor(
  category: UploadCategory,
  contentType: string,
): number | undefined {
  return RULES_BY_CATEGORY[category][contentType]?.maxBytes;
}
