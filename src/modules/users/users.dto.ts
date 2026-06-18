import { z } from 'zod';

export const updateProfileSchema = z.object({
  fullName: z.string().min(1).max(200).optional(),
  timezone: z.string().min(1).max(64).optional(), // IANA tz; used for capsule scheduling
});

// [GAP §1] account deletion is PERMANENT and cascades; the client asked for an
// "are you sure" confirmation twice. The backend enforces an explicit typed
// confirmation in addition to whatever the UI prompts.
export const deleteAccountSchema = z.object({
  confirm: z.literal(true),
  confirmPhrase: z.literal('DELETE MY ACCOUNT'),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
