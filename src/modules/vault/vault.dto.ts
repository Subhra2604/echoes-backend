import { z } from 'zod';

// Storage allocation per plan lives in src/config/plans.ts (PLAN_STORAGE_BYTES).

// Allowed formats. Photos JPG/PNG/HEIC; videos MP4/MOV; audio; docs PDF.
export const PHOTO_MIME = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'];
export const VIDEO_MIME = ['video/mp4', 'video/quicktime'];
export const AUDIO_MIME = ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-m4a'];
export const DOC_MIME = ['application/pdf'];

// Per-file ceilings (bytes). Photos 50MB, audio 100MB, video 500MB, docs 50MB.
export const MAX_BYTES_BY_TYPE = {
  PHOTO: 50 * 1024 * 1024,
  VIDEO: 500 * 1024 * 1024,
  AUDIO: 100 * 1024 * 1024,
  DOCUMENT: 50 * 1024 * 1024,
} as const;

export const initUploadSchema = z.object({
  type: z.enum(['PHOTO', 'VIDEO', 'AUDIO', 'DOCUMENT']),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  durationSec: z.number().int().positive().optional(), // required-ish for VIDEO/AUDIO
  folderId: z.string().uuid().optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
});

export const finalizeUploadSchema = z.object({
  itemId: z.string().uuid(),
});

// Written Vault: title/body plus optional sharing envelope. `action` decides
// the write path:
//   - DRAFT: just save the row; no shares; `groupIds`/`contactIds`/
//            `scheduledDate` are ignored.
//   - SAVE : must include recipients. If `scheduledDate` in the future, rows
//            are created at PENDING and delivered by the daily 10 AM cron.
//            Otherwise rows are created at SHARED and notifications fire
//            immediately.
export const writtenMemorySchema = z
  .object({
    title: z.string().max(200).optional(),
    bodyText: z.string().min(1),
    folderId: z.string().uuid().optional(),
    tags: z.array(z.string().max(40)).max(30).optional(),

    // ── New envelope for the "Save Draft" vs "Save (and share)" split ──
    action: z.enum(['DRAFT', 'SAVE']).default('SAVE'),
    groupIds: z.array(z.string().uuid()).max(100).optional().default([]),
    contactIds: z.array(z.string().uuid()).max(100).optional().default([]),
    scheduledDate: z
      .string()
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .optional(),
  })
  .refine(
    (v) => v.action === 'DRAFT' || v.groupIds.length + v.contactIds.length > 0,
    {
      message:
        'Select at least one group or contact to share with, or use action=DRAFT to save without sharing',
    },
  );

// Editing an existing written entry — only permitted while writtenStatus=DRAFT.
export const updateWrittenMemorySchema = z.object({
  title: z.string().max(200).optional(),
  bodyText: z.string().min(1).optional(),
  folderId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().max(40)).max(30).optional(),
});

export const createFolderSchema = z.object({
  name: z.string().min(1).max(120),
  parentId: z.string().uuid().optional(),
});

export const itemIdParam = z.object({ itemId: z.string().uuid() });

export const listItemsQuerySchema = z.object({
  folderId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(), // opaque value from a prior page
});

export type ListItemsQuery = z.infer<typeof listItemsQuerySchema>;

export type InitUploadInput = z.infer<typeof initUploadSchema>;
export type WrittenMemoryInput = z.infer<typeof writtenMemorySchema>;
export type UpdateWrittenMemoryInput = z.infer<typeof updateWrittenMemorySchema>;
