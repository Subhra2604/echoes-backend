import { Queue, type ConnectionOptions } from 'bullmq';
import { redisConnection } from '../../lib/redis.js';

/**
 * BullMQ queue for scheduled-message delivery.
 *
 * We use delayed jobs (not a daily cron) because the client asked for
 * timezone-aware scheduling with per-instant precision — the recipient's
 * "7:00 PM local" needs to fire on the second, not on the next 10-AM cron
 * sweep. Same pattern as capsules.scheduler.ts.
 */

export interface ScheduledMessageJobData {
  scheduledMessageId: string;
}

export const SCHEDULED_MESSAGE_QUEUE = 'scheduled-message-delivery';

// BullMQ carries its own ioredis types; the shared ioredis client is
// runtime-compatible with BullMQ's ConnectionOptions.
const connection = redisConnection as unknown as ConnectionOptions;

export const scheduledMessageQueue = new Queue<
  ScheduledMessageJobData,
  unknown,
  string
>(SCHEDULED_MESSAGE_QUEUE, { connection });

/**
 * Enqueue (or replace) the delayed delivery job for a scheduled message.
 * jobId `msg:<id>` keeps the queue idempotent — re-scheduling an existing
 * message just replaces the pending job with a new delay.
 */
export async function scheduleMessageDelivery(
  scheduledMessageId: string,
  fireAt: Date,
): Promise<void> {
  const delay = Math.max(0, fireAt.getTime() - Date.now());
  const jobId = `msg:${scheduledMessageId}`;

  // If a job with this id already exists, remove it first — BullMQ won't
  // update the delay on `add` when the jobId is taken (it just no-ops).
  await scheduledMessageQueue.remove(jobId).catch(() => undefined);

  await scheduledMessageQueue.add(
    'deliver',
    { scheduledMessageId },
    {
      jobId,
      delay,
      removeOnComplete: true,
      // Keep failed jobs so we can inspect the exception in the dashboard.
      removeOnFail: false,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );
}

/** Cancel a pending delivery job (owner deleted the message before it fired). */
export async function cancelScheduledMessage(
  scheduledMessageId: string,
): Promise<void> {
  await scheduledMessageQueue
    .remove(`msg:${scheduledMessageId}`)
    .catch(() => undefined);
}
