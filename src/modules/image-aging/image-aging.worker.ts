import { Worker, type ConnectionOptions } from 'bullmq';
import { redisConnection } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import { IMAGE_AGING_QUEUE, type ImageAgingJobData } from './image-aging.scheduler.js';
import { processImageAgingJob } from './image-aging.service.js';

const connection = redisConnection as unknown as ConnectionOptions;

/**
 * Image-aging job worker. Concurrency deliberately lower than the other
 * workers in this app (concurrency: 5) — a Gemini image call is the
 * slowest/most expensive external call here, so this stays conservative
 * until real latency/cost is observed in production.
 */
export const imageAgingWorker = new Worker<ImageAgingJobData>(
  IMAGE_AGING_QUEUE,
  async (job) => {
    const maxAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
    logger.info(
      { jobId: job.id, imageAgingJobId: job.data.imageAgingJobId, attempt: job.attemptsMade + 1, maxAttempts },
      'processing image-aging job',
    );
    await processImageAgingJob(job.data.imageAgingJobId, isFinalAttempt);
  },
  { connection, concurrency: 3 },
);

imageAgingWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'image-aging job failed');
});

imageAgingWorker.on('completed', (job) => {
  logger.debug({ jobId: job.id }, 'image-aging job completed');
});
