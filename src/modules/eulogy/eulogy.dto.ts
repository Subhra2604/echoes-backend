import { z } from 'zod';

export const generateEulogySchema = z.object({
  deceasedName: z.string().min(1).max(200),
  relationship: z.string().max(100).optional(),
  promptAnswers: z.record(z.string(), z.unknown()).default({}),
  tone: z.enum(['warm', 'formal', 'celebratory', 'reflective']).optional(),
  pageId: z.string().uuid().optional(), // optionally attach to a memorial page
});

export const reviseEulogySchema = z.object({
  draftText: z.string().min(1).max(20_000),
});

export const eulogyIdParam = z.object({ eulogyId: z.string().uuid() });

export type GenerateEulogyInput = z.infer<typeof generateEulogySchema>;
