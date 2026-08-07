import { Queue, type ConnectionOptions } from 'bullmq';
import { redisConnection } from '../../lib/redis.js';

/**
 * BullMQ plumbing for the daily scheduled-share delivery cron.
 *
 * Model:
 *   - One queue: `scheduled-share-delivery`.
 *   - One recurring job registered by the worker at boot with the pattern
 *     `0 10 * * *` (every day at 10:00 in the worker's timezone) — see
 *     scheduled-shares.worker.ts.
 *   - The job's handler queries all PENDING ContentShare rows with
 *     scheduledDate <= NOW() and flips them to SHARED, then fires
 *     notifications.
 *
 * The recurring-job pattern is deterministic (jobId = fixed key), so restarts
 * of the worker process re-register the same schedule idempotently rather
 * than piling up duplicates.
 */

export const SCHEDULED_SHARE_QUEUE = 'scheduled-share-delivery';
export const SCHEDULED_SHARE_JOB_NAME = 'deliver-due';
export const SCHEDULED_SHARE_JOB_ID = 'daily-scheduled-share-delivery';

/** Default: 10:00 daily. Override with env `SCHEDULED_SHARE_CRON`. */
export const DEFAULT_SCHEDULED_SHARE_CRON = '0 10 * * *';

const connection = redisConnection as unknown as ConnectionOptions;

export const scheduledShareQueue = new Queue(
  SCHEDULED_SHARE_QUEUE,
  { connection },
);
