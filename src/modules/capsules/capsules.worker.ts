import { Worker, type ConnectionOptions } from 'bullmq';
import { redisConnection } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import { CAPSULE_QUEUE, type CapsuleJobData } from './capsules.scheduler.js';
import { executeRelease } from './capsules.service.js';

const connection = redisConnection as unknown as ConnectionOptions;

/**
 * Capsule release worker. Runs in a separate process (`npm run worker`) so the
 * API and the time-based delivery pipeline scale independently. BullMQ fires:
 *  - one-off delayed jobs  -> SCHEDULED_DATE capsules
 *  - repeatable cron jobs  -> RECURRING_ANNUAL capsules (Note 1, in perpetuity)
 * Both resolve to a single `executeRelease`, which is idempotent per occurrence.
 */
export const capsuleWorker = new Worker<CapsuleJobData>(
  CAPSULE_QUEUE,
  async (job) => {
    logger.info({ jobId: job.id, capsuleId: job.data.capsuleId }, 'processing capsule release');
    await executeRelease(job.data.capsuleId);
  },
  { connection, concurrency: 5 },
);

capsuleWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'capsule release failed');
});

capsuleWorker.on('completed', (job) => {
  logger.debug({ jobId: job.id }, 'capsule release completed');
});
