import { z } from 'zod';

// Every privileged action requires a reason for the audit trail. [GAP §9]
const reason = z.string().min(3).max(500);

export const deletePageSchema = z.object({ reason });
export const suspendUserSchema = z.object({ reason, suspend: z.boolean().default(true) });
export const manualReleaseSchema = z.object({ reason });
export const overrideActivationSchema = z.object({
  reason,
  // cancel an erroneous activation, or force-activate. [GAP §2] admin override.
  action: z.enum(['CANCEL', 'ACTIVATE']),
});

export const auditQuerySchema = z.object({
  targetType: z.string().max(40).optional(),
  targetId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
});

export const userIdParam = z.object({ userId: z.string().uuid() });
export const pageIdParam = z.object({ pageId: z.string().uuid() });
export const capsuleIdParam = z.object({ capsuleId: z.string().uuid() });
export const ownerIdParam = z.object({ ownerId: z.string().uuid() });
