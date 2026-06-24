import { z } from 'zod';

/**
 * Generic, category-aware upload DTOs. The same `/api/uploads/presign` endpoint
 * serves Profile, Memory, and Voice uploads; the `category` discriminates which
 * validation rule set the shared upload module applies.
 */

export const uploadCategory = z.enum(['profile', 'memory', 'voice']);

const presignFileSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive(),
});

export const presignSchema = z.object({
  category: uploadCategory,
  files: z.array(presignFileSchema).min(1).max(10),
});

export const deleteFileSchema = z.object({
  category: uploadCategory,
  key: z.string().min(1).max(500),
});

export const signedUrlQuerySchema = z.object({
  key: z.string().min(1).max(500),
  // Optional override for link lifetime (seconds), clamped server-side.
  expiresSec: z.coerce.number().int().min(60).max(3600).optional(),
});

export type PresignInput = z.infer<typeof presignSchema>;
export type DeleteFileInput = z.infer<typeof deleteFileSchema>;
export type SignedUrlQuery = z.infer<typeof signedUrlQuerySchema>;
