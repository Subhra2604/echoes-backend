import { z } from 'zod';

export const createCapsuleSchema = z
  .object({
    title: z.string().min(1).max(160),
    message: z.string().max(10_000).optional(),
    mediaItemId: z.string().uuid().optional(),
    recipientEmail: z.string().email(),
    recipientUserId: z.string().uuid().optional(),
    releaseType: z.enum(['SCHEDULED_DATE', 'RECURRING_ANNUAL', 'GUARDIAN_CONTROLLED']),
    // SCHEDULED_DATE
    releaseAt: z.coerce.date().optional(),
    // RECURRING_ANNUAL (Note 1: anniversary/birthday, every year)
    recurMonth: z.number().int().min(1).max(12).optional(),
    recurDay: z.number().int().min(1).max(31).optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.message && !v.mediaItemId) {
      ctx.addIssue({ code: 'custom', message: 'A capsule needs a message and/or a media item', path: ['message'] });
    }
    if (v.releaseType === 'SCHEDULED_DATE') {
      if (!v.releaseAt) ctx.addIssue({ code: 'custom', message: 'releaseAt is required', path: ['releaseAt'] });
      else if (v.releaseAt.getTime() <= Date.now()) ctx.addIssue({ code: 'custom', message: 'releaseAt must be in the future', path: ['releaseAt'] });
    }
    if (v.releaseType === 'RECURRING_ANNUAL' && (v.recurMonth == null || v.recurDay == null)) {
      ctx.addIssue({ code: 'custom', message: 'recurMonth and recurDay are required for recurring capsules', path: ['recurMonth'] });
    }
  });

export const updateCapsuleSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  message: z.string().max(10_000).optional(),
  recipientEmail: z.string().email().optional(),
  releaseAt: z.coerce.date().optional(),
  recurMonth: z.number().int().min(1).max(12).optional(),
  recurDay: z.number().int().min(1).max(31).optional(),
});

export const capsuleIdParam = z.object({ capsuleId: z.string().uuid() });

export type CreateCapsuleInput = z.infer<typeof createCapsuleSchema>;
