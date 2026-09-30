import { Queue, type ConnectionOptions } from 'bullmq';
import { redisConnection } from '../../lib/redis.js';

/**
 * BullMQ queue for AI age-progression image generation. Same shape as
 * scheduled-messages.scheduler.ts: one queue, deterministic hyphen-delimited
 * jobId (BullMQ rejects ":" in custom ids — learned the hard way in a Sept 23
 * production bug), retry with exponential backoff.
 */

export interface ImageAgingJobData {
  imageAgingJobId: string;
}

export const IMAGE_AGING_QUEUE = 'image-aging-generation';

const connection = redisConnection as unknown as ConnectionOptions;

export const imageAgingQueue = new Queue<ImageAgingJobData, unknown, string>(IMAGE_AGING_QUEUE, {
  connection,
});

export async function scheduleImageAging(imageAgingJobId: string): Promise<void> {
  const jobId = `aging-${imageAgingJobId}`;
  await imageAgingQueue.add(
    'generate',
    { imageAgingJobId },
    {
      jobId,
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );
}
