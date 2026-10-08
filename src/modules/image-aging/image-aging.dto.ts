import { z } from 'zod';

/**
 * How many years to age the subject by. Any whole number in range — the
 * frontend is free to offer quick-pick chips (10/20/30/50), a free-entry
 * field, or both; this layer can't tell the difference and doesn't need to.
 *
 * The bounds are a safety rail against nonsense input (0, negatives, 9999),
 * not a product opinion: aging a human by more than ~80 years is physically
 * meaningless and would just burn a paid generation on garbage output.
 * Guiding users toward useful values is the frontend's job.
 */
export const ageOffsetEnum = z.number().int().min(1).max(80);

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
