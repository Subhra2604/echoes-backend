import { z } from 'zod';

/**
 * Zod schemas for the Scheduled Messages HTTP surface.
 *
 * A ScheduledMessage is a free-text occasion note (birthday, anniversary,
 * reminder, ...) an owner schedules for one or more of their Contacts. The
 * scheduled instant is timezone-aware: the client passes a wall-clock date
 * and an IANA timezone, and the server resolves both into a single UTC
 * `scheduleDate` (stored) alongside the original `timezone` (kept for display
 * and idempotent reschedules).
 */

// ── Common fields ───────────────────────────────────────────────────────────

const occasionField = z.string().trim().min(1).max(200);
const messageField = z.string().trim().min(1).max(4000);

const contactIdsField = z
  .array(z.string().uuid())
  .min(1, 'At least one contact must be selected')
  .max(100, 'Too many contacts in one call');

/**
 * IANA timezone (`Asia/Kolkata`, `America/New_York`, ...). We accept anything
 * `Intl.DateTimeFormat` accepts — validation is done at the service layer
 * (so a bad zone yields a clear domain error rather than a schema error).
 * Optional here: when omitted, the service falls back to the owner's
 * profile timezone.
 */
const timezoneField = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .optional();

/** Future timestamp; strictness is enforced in the service. */
const futureDateField = z.coerce.date();

// ── Requests ────────────────────────────────────────────────────────────────

export const createScheduledMessageSchema = z
  .object({
    contactIds: contactIdsField,
    occasion: occasionField,
    scheduleDate: futureDateField,
    /** Optional IANA timezone override; defaults to the owner's timezone. */
    timezone: timezoneField,
    message: messageField,
  })
  .strict();

export const updateScheduledMessageSchema = z
  .object({
    contactIds: contactIdsField.optional(),
    occasion: occasionField.optional(),
    scheduleDate: futureDateField.optional(),
    timezone: timezoneField,
    message: messageField.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to update',
  });

// ── List query ──────────────────────────────────────────────────────────────

/**
 * `filter` follows spec §4:
 *   - `for_me`         — messages where the caller is a recipient
 *   - `scheduled_by_me` — messages the caller created (owner view)
 *   - omitted          — both, unioned
 *
 * Cursor-friendly pagination matches the other list endpoints (contacts,
 * groups, memories) so the client can reuse its infra.
 */
export const listScheduledMessagesQuerySchema = z.object({
  filter: z.enum(['for_me', 'scheduled_by_me']).optional(),
  status: z
    .enum(['PENDING', 'SENT', 'FAILED', 'CANCELLED'])
    .optional(),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  page: z.coerce.number().int().min(1).default(1),
});

// ── Params ──────────────────────────────────────────────────────────────────

export const scheduledMessageIdParam = z.object({
  id: z.string().uuid(),
});

// ── Inferred types ──────────────────────────────────────────────────────────

export type CreateScheduledMessageInput = z.infer<
  typeof createScheduledMessageSchema
>;
export type UpdateScheduledMessageInput = z.infer<
  typeof updateScheduledMessageSchema
>;
export type ListScheduledMessagesQuery = z.infer<
  typeof listScheduledMessagesQuerySchema
>;
