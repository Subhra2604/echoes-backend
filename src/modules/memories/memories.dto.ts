// import { z } from 'zod';
// import { allowedMimeTypes } from '../../lib/upload-module.js';

// /**
//  * Memory DTOs. The upload itself is handled by /api/uploads/presign; these
//  * schemas cover the metadata-only create/update/list operations. A memory holds
//  * exactly one file (image / video / document), matching the "Add Memory" UI.
//  */

// // MIME types accepted for memories come straight from the shared upload module
// // so the allow-list never drifts between presign validation and create.
// const MEMORY_MIME = allowedMimeTypes('memory') as [string, ...string[]];

// const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

// const titleField = z
//   .string()
//   .trim()
//   .min(1, 'Title is required')
//   .max(200)
//   .refine((s) => wordCount(s) <= 50, 'Title must be 50 words or fewer');

// // Story is optional in the UI ("Story (optional)", 0/500 counter).
// const storyField = z.string().trim().max(500, 'Story must be 500 characters or fewer');

// const tagField = z
//   .string()
//   .trim()
//   .min(1)
//   .max(40)
//   .regex(
//     /^[a-zA-Z0-9 _-]+$/,
//     'Tags may contain letters, numbers, spaces, hyphens, and underscores only',
//   );

// // Visibility is stored UPPERCASE in the DB (Prisma enum), but the UI / spec
// // example use lowercase ("private"). We accept either casing and normalise to
// // the enum value so the frontend can send what reads naturally.
// const visibility = z.preprocess(
//   (v) => (typeof v === 'string' ? v.toUpperCase() : v),
//   z.enum(['PRIVATE', 'SHARED', 'PUBLIC']),
// );

// // export const createMemorySchema = z.object({
// //   title: titleField,
// //   story: storyField.optional(),
// //   contentType: z.enum(MEMORY_MIME),
// //   fileKey: z.string().min(1).max(500),
// //   sizeBytes: z.number().int().positive().optional(),
// //   durationSec: z.number().int().positive().optional(), // for video
// //   width: z.number().int().positive().optional(),
// //   height: z.number().int().positive().optional(),
// //   folderId: z.string().uuid().nullable().optional(),
// //   tags: z.array(tagField).max(30).optional(),
// //   visibility: visibility.default('PRIVATE'),
// // });


// export const createMemorySchema = z.object({
//   memoryType: z.enum(['MEDIA', 'NOTE']).default('MEDIA'), // NEW
//   title: titleField,
//   story: storyField.optional(),
//   contentType: z.enum(MEMORY_MIME).optional(),   // required only for MEDIA — checked below
//   fileKey: z.string().min(1).max(500).optional(), // required only for MEDIA — checked below
//   sizeBytes: z.number().int().positive().optional(),
//   durationSec: z.number().int().positive().optional(),
//   width: z.number().int().positive().optional(),
//   height: z.number().int().positive().optional(),
//   folderId: z.string().uuid().nullable().optional(),
//   tags: z.array(tagField).max(30).optional(),
//   visibility: visibility.default('PRIVATE'),
// }).superRefine((data, ctx) => {
//   if (data.memoryType === 'MEDIA') {
//     if (!data.contentType) ctx.addIssue({ code: 'custom', path: ['contentType'], message: 'contentType is required for media memories' });
//     if (!data.fileKey) ctx.addIssue({ code: 'custom', path: ['fileKey'], message: 'fileKey is required for media memories' });
//   }
//   if (data.memoryType === 'NOTE' && !data.story) {
//     ctx.addIssue({ code: 'custom', path: ['story'], message: 'story is required for written notes' });
//   }
// });

// export const updateMemorySchema = z.object({
//   title: titleField.optional(),
//   story: storyField.nullable().optional(),
//   folderId: z.string().uuid().nullable().optional(),
//   tags: z.array(tagField).max(30).optional(),
//   visibility: visibility.optional(),
// });

// export const listMemoriesQuerySchema = z.object({
//   cursor: z.string().uuid().optional(),
//   limit: z.coerce.number().int().min(1).max(50).default(20),
//   search: z.string().trim().min(1).max(200).optional(),
//   visibility: visibility.optional(),
//   mediaType: z.enum(['image', 'video', 'document', 'audio']).optional(),
// });

// export const memoryIdParam = z.object({ id: z.string().uuid() });

// export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
// export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;
// export type ListMemoriesQuery = z.infer<typeof listMemoriesQuerySchema>;




import { z } from 'zod';
import { allowedMimeTypes } from '../../lib/upload-module.js';

/**
 * Memory DTOs. The upload itself is handled by /api/uploads/presign; these
 * schemas cover the metadata-only create/update/list operations.
 *
 * A memory is one of two shapes, discriminated by `memoryType`:
 *   - MEDIA: an uploaded file (image / video / document) — matches the
 *     existing "Add Memory" UI. contentType + fileKey are required.
 *   - NOTE: authored text only — matches the "Write a Note" UI. `story` is
 *     the note body and is required; contentType/fileKey must be absent.
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

// Story is optional in the media UI ("Story (optional)", 0/500 counter), but
// doubles as the required note body for NOTE memories — validated separately
// below since the length ceilings differ (500 chars vs. a much longer note).
const storyField = z.string().trim().max(500, 'Story must be 500 characters or fewer');
const noteBodyField = z.string().trim().min(1, 'Note is required').max(20000, 'Note must be 20,000 characters or fewer');

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

export const createMemorySchema = z
  .object({
    memoryType: z.enum(['MEDIA', 'NOTE']).default('MEDIA'),
    title: titleField,
    story: z.string().trim().max(20000).optional(), // shape-checked below per memoryType
    contentType: z.enum(MEMORY_MIME).optional(),     // required for MEDIA only
    fileKey: z.string().min(1).max(500).optional(),  // required for MEDIA only
    sizeBytes: z.number().int().positive().optional(),
    durationSec: z.number().int().positive().optional(), // for video
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    folderId: z.string().uuid().nullable().optional(),
    tags: z.array(tagField).max(30).optional(),
    visibility: visibility.default('PRIVATE'),
  })
  .superRefine((data, ctx) => {
    if (data.memoryType === 'MEDIA') {
      if (!data.contentType) {
        ctx.addIssue({ code: 'custom', path: ['contentType'], message: 'contentType is required for media memories' });
      }
      if (!data.fileKey) {
        ctx.addIssue({ code: 'custom', path: ['fileKey'], message: 'fileKey is required for media memories' });
      }
      if (data.story && data.story.length > 500) {
        ctx.addIssue({ code: 'custom', path: ['story'], message: 'Story must be 500 characters or fewer' });
      }
    }
    if (data.memoryType === 'NOTE') {
      if (!data.story || data.story.trim().length === 0) {
        ctx.addIssue({ code: 'custom', path: ['story'], message: 'Note is required' });
      }
      if (data.contentType) {
        ctx.addIssue({ code: 'custom', path: ['contentType'], message: 'contentType must not be set for written notes' });
      }
      if (data.fileKey) {
        ctx.addIssue({ code: 'custom', path: ['fileKey'], message: 'fileKey must not be set for written notes' });
      }
    }
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
  mediaType: z.enum(['image', 'video', 'document', 'audio']).optional(), // MEDIA-only sub-filter
  memoryType: z.enum(['MEDIA', 'NOTE']).optional(),
});

export const memoryIdParam = z.object({ id: z.string().uuid() });

export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;
export type ListMemoriesQuery = z.infer<typeof listMemoriesQuerySchema>;
