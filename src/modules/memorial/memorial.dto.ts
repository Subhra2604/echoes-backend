import { z } from 'zod';

export const createPageSchema = z.object({
  deceasedName: z.string().min(1).max(200),
  deceasedUserId: z.string().uuid().optional(), // link if the deceased had an account
  biography: z.string().max(10_000).optional(),
  privacy: z.enum(['PUBLIC', 'INVITE_ONLY', 'PRIVATE']).default('INVITE_ONLY'),
});

export const updatePageSchema = z.object({
  deceasedName: z.string().min(1).max(200).optional(),
  biography: z.string().max(10_000).optional(),
  privacy: z.enum(['PUBLIC', 'INVITE_ONLY', 'PRIVATE']).optional(),
});

export const invitePageSchema = z.object({
  email: z.string().email(),
  canEdit: z.boolean().default(false),
});

export const acceptPageInviteSchema = z.object({ token: z.string().min(10) });

export const guestbookSchema = z.object({
  authorName: z.string().min(1).max(120),
  message: z.string().min(1).max(5000),
});

export const storySchema = z.object({
  title: z.string().max(200).optional(),
  content: z.string().min(1).max(20_000),
});

export const timelineSchema = z.object({
  eventDate: z.coerce.date(),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
});

// Public memorial-page photos (screened by AWS Rekognition on finalize).
export const initPhotoSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/heic', 'image/heif']),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024), // 50 MB cap
  caption: z.string().max(500).optional(),
});

export const photoParam = z.object({ pageId: z.string().uuid(), photoId: z.string().uuid() });

export const moderationDecisionSchema = z.object({
  approve: z.boolean(),
  reason: z.string().max(500).optional(),
});

export const pageIdParam = z.object({ pageId: z.string().uuid() });
export const entryParam = z.object({ pageId: z.string().uuid(), entryId: z.string().uuid() });

export type CreatePageInput = z.infer<typeof createPageSchema>;
