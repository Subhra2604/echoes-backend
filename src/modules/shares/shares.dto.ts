import { z } from 'zod';

/**
 * Zod schemas for the ContentShare HTTP surface.
 *
 * Sharing model: one API call creates N `ContentShare` rows in a single
 * transaction, one per (content, recipient) pair. The caller supplies either
 * a `memoryId` OR a `voiceRecordingId` plus any combination of `groupIds`
 * and/or `contactIds`. Exactly one content ID and at least one recipient are
 * required.
 */

const uuidList = z.array(z.string().uuid()).max(100);

/**
 * Share-a-content-item payload.
 *
 * XOR validation on the content:
 *   - Exactly one of `memoryId` / `voiceRecordingId` must be present.
 *   - At least one recipient (group or contact) must be supplied.
 *
 * Both checks live in the schema so the service layer treats input as trusted.
 */
export const shareContentSchema = z
  .object({
    memoryId: z.string().uuid().optional(),
    voiceRecordingId: z.string().uuid().optional(),
    groupIds: uuidList.optional().default([]),
    contactIds: uuidList.optional().default([]),
    caption: z.string().trim().max(500).optional(),
  })
  .refine(
    (v) =>
      (v.memoryId !== undefined && v.voiceRecordingId === undefined) ||
      (v.memoryId === undefined && v.voiceRecordingId !== undefined),
    { message: 'Provide exactly one of memoryId or voiceRecordingId' },
  )
  .refine((v) => v.groupIds.length + v.contactIds.length > 0, {
    message: 'Select at least one group or contact to share with',
  })
  .refine((v) => v.groupIds.length + v.contactIds.length <= 100, {
    message: 'Too many recipients in one call (max 100)',
  });

/** Cursor pagination on `sharedAt` (descending). */
export const listReceivedSharesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().datetime().optional(),
  fromUserId: z.string().uuid().optional(),
  /** Filter the inbox by content type. Omit to see both. */
  contentType: z.enum(['MEMORY', 'VOICE_RECORDING']).optional(),
});

/**
 * Query for the two "shares of MY content" endpoints. Works for both
 * memory-scoped and voice-recording-scoped listings.
 */
export const listContentSharesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().datetime().optional(),
  recipientType: z.enum(['GROUP', 'CONTACT']).optional(),
});

// ── URL params ──────────────────────────────────────────────────────────────

export const memoryIdParam = z.object({ memoryId: z.string().uuid() });
export const recordingIdParam = z.object({ recordingId: z.string().uuid() });
export const shareIdParam = z.object({ shareId: z.string().uuid() });

// ── Inferred types ──────────────────────────────────────────────────────────

export type ShareContentInput = z.infer<typeof shareContentSchema>;
export type ListReceivedSharesQuery = z.infer<typeof listReceivedSharesQuerySchema>;
export type ListContentSharesQuery = z.infer<typeof listContentSharesQuerySchema>;
