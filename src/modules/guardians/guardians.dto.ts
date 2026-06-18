import { z } from 'zod';

export const inviteGuardianSchema = z.object({
  guardianEmail: z.string().email(),
  // The very first guardian is primary; subsequent ones are backups. [GAP §2]
  isPrimary: z.boolean().optional(),
});

export const respondInvitationSchema = z.object({
  token: z.string().min(10),
  accept: z.boolean(),
});

export const activateMemorialSchema = z.object({
  // S3 key of a death certificate the guardian already uploaded. [GAP §2]
  deathCertificateKey: z.string().min(1),
});

export const cancelMemorialSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const ownerIdParam = z.object({ ownerId: z.string().uuid() });
export const invitationIdParam = z.object({ invitationId: z.string().uuid() });
