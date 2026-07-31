import { z } from 'zod';
import { allowedMimeTypes } from '../../lib/upload-module.js';

/**
 * Voice recording DTOs. Audio is uploaded via /api/uploads/presign (category
 * "voice"); these schemas cover metadata-only create/list operations.
 */

const VOICE_MIME = allowedMimeTypes('voice') as [string, ...string[]];

const MAX_DURATION_SEC = 60 * 60; // 1 hour hard ceiling

const titleField = z.string().trim().min(1).max(200);

/**
 * ISO-8601 datetime string, converted to a Date object at parse time so the
 * service layer never handles raw strings. Accepts both Z and +HH:MM suffixes.
 */
const scheduledDateField = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

export const createRecordingSchema = z.object({
  title: titleField,
  duration: z.number().int().min(0).max(MAX_DURATION_SEC),
  contentType: z.enum(VOICE_MIME),
  fileKey: z.string().min(1).max(500),
  folderId: z.string().uuid().nullable().optional(),
  /**
   * Optional reminder time. When set, a delayed job is scheduled to fire a
   * VOICE_RECORDING_REMINDER notification to the owner at this instant.
   * A past timestamp fires (essentially) immediately on the next worker tick,
   * which is intentional — it makes back-filling reminders trivial.
   */
  scheduledDate: scheduledDateField.optional(),
});

/**
 * Update payload for PATCH /api/voice-recordings/:id.
 *
 * Deliberately narrow: only `title` and `scheduledDate` may be changed. Any
 * other field must be handled through the create-and-migrate path (delete +
 * re-upload). `scheduledDate` accepts:
 *   - a datetime string → set or replace the reminder
 *   - `null`            → clear the reminder (removes the queued job)
 *   - omitted           → leave the current value alone
 *
 * At least one of the two fields must be present so we never issue a no-op
 * request that just bumps `updatedAt`.
 */
export const updateRecordingSchema = z
  .object({
    title: titleField.optional(),
    scheduledDate: scheduledDateField.nullable().optional(),
  })
  .refine(
    (v) => v.title !== undefined || v.scheduledDate !== undefined,
    { message: 'Provide at least one field to update (title or scheduledDate)' },
  );

export const listRecordingsQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().min(1).max(200).optional(),
  folderId: z.string().uuid().optional(),
});

export const recordingIdParam = z.object({ id: z.string().uuid() });

export type CreateRecordingInput = z.infer<typeof createRecordingSchema>;
export type UpdateRecordingInput = z.infer<typeof updateRecordingSchema>;
export type ListRecordingsQuery = z.infer<typeof listRecordingsQuerySchema>;
