import { z } from 'zod';
import { allowedMimeTypes } from '../../lib/upload-module.js';

/**
 * Memory DTOs. The upload itself is handled by /api/uploads/presign; these
 * schemas cover the metadata-only create/update/list operations. A memory holds
 * exactly one file (image / video / document), matching the "Add Memory" UI.
 */

// MIME types accepted for memories come straight from the shared upload module
// so the allow-list never drifts between presign validation and create.
const MEMORY_MIME = allowedMimeTypes('memory') as [string, ...string[]];

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const titleField = z
  .string()
  .trim()
  .min(1, 'Title is required')
  .max(200)
  .refine((s) => wordCount(s) <= 50, 'Title must be 50 words or fewer');

// Story is optional in the UI ("Story (optional)", 0/500 counter).
const storyField = z.string().trim().max(500, 'Story must be 500 characters or fewer');

const tagField = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(
    /^[a-zA-Z0-9 _-]+$/,
    'Tags may contain letters, numbers, spaces, hyphens, and underscores only',
  );

// Visibility is stored UPPERCASE in the DB (Prisma enum), but the UI / spec
// example use lowercase ("private"). We accept either casing and normalise to
// the enum value so the frontend can send what reads naturally.
const visibility = z.preprocess(
  (v) => (typeof v === 'string' ? v.toUpperCase() : v),
  z.enum(['PRIVATE', 'SHARED', 'PUBLIC']),
);

export const createMemorySchema = z.object({
  title: titleField,
  story: storyField.optional(),
  contentType: z.enum(MEMORY_MIME),
  fileKey: z.string().min(1).max(500),
  sizeBytes: z.number().int().positive().optional(),
  durationSec: z.number().int().positive().optional(), // for video
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  folderId: z.string().uuid().nullable().optional(),
  tags: z.array(tagField).max(30).optional(),
  visibility: visibility.default('PRIVATE'),
});

export const updateMemorySchema = z.object({
  title: titleField.optional(),
  story: storyField.nullable().optional(),
  folderId: z.string().uuid().nullable().optional(),
  tags: z.array(tagField).max(30).optional(),
  visibility: visibility.optional(),
});

export const listMemoriesQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().min(1).max(200).optional(),
  visibility: visibility.optional(),
  // folderId: z.string().uuid().optional(),
  // tags: z
  //   .string()
  //   .optional()
  //   .transform((s) =>
  //     s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
  //   ),
});

export const memoryIdParam = z.object({ id: z.string().uuid() });

export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;
export type ListMemoriesQuery = z.infer<typeof listMemoriesQuerySchema>;
