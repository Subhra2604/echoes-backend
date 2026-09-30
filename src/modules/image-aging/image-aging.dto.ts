import { z } from 'zod';

export const ageOffsetEnum = z.union([z.literal(10), z.literal(20), z.literal(50)]);

/**
 * `fileKey` is the S3 key returned by the existing generic upload flow
 * (POST /api/uploads/presign with category: 'memory') — the source photo
 * upload is not a new upload category, it reuses that one as-is.
 */
export const createImageAgingJobSchema = z.object({
  fileKey: z.string().min(1).max(500),
  ageOffset: ageOffsetEnum,
});

export const imageAgingJobIdParam = z.object({ jobId: z.string().uuid() });

export type CreateImageAgingJobInput = z.infer<typeof createImageAgingJobSchema>;
