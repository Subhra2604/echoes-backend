import { z } from 'zod';

/**
 * Zod schemas for the memory-sharing HTTP surface.
 *
 * Sharing model: one API call creates N `MemoryShare` rows in a single
 * transaction, one per (memoryId, recipient) pair. The caller supplies any
 * combination of groupIds and/or contactIds; at least one recipient is
 * required.
 */

const uuidList = z.array(z.string().uuid()).max(100);

export const shareMemorySchema = z
  .object({
    /** Groups the caller belongs to that should receive this memory. */
    groupIds: uuidList.optional().default([]),
    /**
     * Contact IDs from the caller's own address book (must be VERIFIED).
     * The service resolves each to its linked userId and stores that as the
     * recipient. `recipientEmail` is snapshotted at share time.
     */
    contactIds: uuidList.optional().default([]),
    /** Optional message that accompanies every share row in this batch. */
    caption: z.string().trim().max(500).optional(),
  })
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
  /** Optional filter: only shares sent by this user (must be in your contacts). */
  fromUserId: z.string().uuid().optional(),
});

export const listMemorySharesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().datetime().optional(),
  recipientType: z.enum(['GROUP', 'CONTACT']).optional(),
});

// ── URL params ──────────────────────────────────────────────────────────────

export const memoryIdParam = z.object({ memoryId: z.string().uuid() });
export const shareIdParam = z.object({ shareId: z.string().uuid() });

// ── Inferred types ──────────────────────────────────────────────────────────

export type ShareMemoryInput = z.infer<typeof shareMemorySchema>;
export type ListReceivedSharesQuery = z.infer<typeof listReceivedSharesQuerySchema>;
export type ListMemorySharesQuery = z.infer<typeof listMemorySharesQuerySchema>;
