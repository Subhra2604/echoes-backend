import { Worker, type ConnectionOptions } from 'bullmq';
import { redisConnection } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import {
  SCHEDULED_MESSAGE_QUEUE,
  type ScheduledMessageJobData,
} from './scheduled-messages.scheduler.js';
import { deliverScheduledMessage } from './scheduled-messages.service.js';

const connection = redisConnection as unknown as ConnectionOptions;

/**
 * Scheduled-message delivery worker. Runs in the `npm run worker` process.
 *
 * Delivery is idempotent inside `deliverScheduledMessage`: a duplicate job
 * run only re-processes recipients still in QUEUED status, so retries and
 * accidental re-enqueues are safe.
 */
export const scheduledMessageWorker = new Worker<ScheduledMessageJobData>(
  SCHEDULED_MESSAGE_QUEUE,
  async (job) => {
    logger.info(
      { jobId: job.id, scheduledMessageId: job.data.scheduledMessageId },
      'processing scheduled message',
    );
    await deliverScheduledMessage(job.data.scheduledMessageId);
  },
  { connection, concurrency: 5 },
);

scheduledMessageWorker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, err: err.message },
    'scheduled message delivery job failed',
  );
});

scheduledMessageWorker.on('completed', (job) => {
  logger.debug({ jobId: job.id }, 'scheduled message delivery completed');
});
