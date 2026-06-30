import { z } from 'zod';
import { allowedMimeTypes } from '../../lib/upload-module.js';

/**
 * Voice recording DTOs. Audio is uploaded via /api/uploads/presign (category
 * "voice"); these schemas cover metadata-only create/list operations.
 */

const VOICE_MIME = allowedMimeTypes('voice') as [string, ...string[]];

const MAX_DURATION_SEC = 60 * 60; // 1 hour hard ceiling

const titleField = z.string().trim().min(1).max(200);

export const createRecordingSchema = z.object({
  title: titleField,
  duration: z.number().int().min(0).max(MAX_DURATION_SEC),
  contentType: z.enum(VOICE_MIME),
  fileKey: z.string().min(1).max(500),
  folderId: z.string().uuid().nullable().optional(),
});

export const listRecordingsQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().min(1).max(200).optional(),
  folderId: z.string().uuid().optional(),
});

export const recordingIdParam = z.object({ id: z.string().uuid() });

export type CreateRecordingInput = z.infer<typeof createRecordingSchema>;
export type ListRecordingsQuery = z.infer<typeof listRecordingsQuerySchema>;
