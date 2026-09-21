import { z } from 'zod';

/**
 * Zod schemas for the contact-based Guardian feature.
 *
 * A resource Guardian is separate from the email-invited GuardianInvitation
 * (see guardians.dto.ts). It's an instant assignment on top of an already-
 * VERIFIED contact — no invitation dance — and grants schedule-only edit
 * rights on TimeCapsules that reference it.
 */

export const createGuardianSchema = z
  .object({
    /**
     * ID of one of the caller's own Contact rows. Must be VERIFIED — an
     * unverified contact has no account, so we couldn't route a
     * GUARDIAN_ASSIGNED notification to them and they couldn't sign in to
     * exercise their schedule-edit rights.
     */
    contactId: z.string().uuid(),
  })
  .strict();

export const guardianIdParam = z.object({
  guardianId: z.string().uuid(),
});
