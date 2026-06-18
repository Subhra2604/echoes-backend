import { Queue, type ConnectionOptions } from 'bullmq';
import { redisConnection } from '../../lib/redis.js';

export interface CapsuleJobData {
  capsuleId: string;
}

export const CAPSULE_QUEUE = 'capsule-release';

// BullMQ bundles its own ioredis types; our shared client is compatible at
// runtime, so we present it as BullMQ's ConnectionOptions.
const connection = redisConnection as unknown as ConnectionOptions;

// <Data, Result, Name>: pin Name to string so `.add('release', …)` is accepted.
export const capsuleQueue = new Queue<CapsuleJobData, unknown, string>(CAPSULE_QUEUE, { connection });

/** One-off scheduled release at an absolute moment. */
export async function scheduleOneOff(capsuleId: string, releaseAt: Date): Promise<void> {
  const delay = Math.max(0, releaseAt.getTime() - Date.now());
  await capsuleQueue.add('release', { capsuleId }, {
    jobId: `oneoff:${capsuleId}`,
    delay,
    removeOnComplete: true,
    removeOnFail: false,
  });
}

/**
 * Recurring annual release "in perpetuity" (Note 1). Uses a BullMQ repeatable
 * job with a yearly cron in the OWNER's timezone (snapshotted on the capsule).
 * Cron: `min hour day month *`  ->  fire 09:00 local on the given month/day.
 */
export async function scheduleRecurringAnnual(
  capsuleId: string,
  month: number, // 1-12
  day: number,
  timezone: string,
): Promise<void> {
  const cron = `0 9 ${day} ${month} *`;
  await capsuleQueue.add('release', { capsuleId }, {
    repeat: { pattern: cron, tz: timezone },
    jobId: `recurring:${capsuleId}`,
    removeOnComplete: true,
  });
}

export async function cancelSchedule(capsuleId: string): Promise<void> {
  await capsuleQueue.remove(`oneoff:${capsuleId}`).catch(() => undefined);
  // Remove repeatable schedules tied to this capsule.
  const repeatables = await capsuleQueue.getRepeatableJobs();
  await Promise.all(
    repeatables
      .filter((r) => r.id === `recurring:${capsuleId}`)
      .map((r) => capsuleQueue.removeRepeatableByKey(r.key)),
  );
}
