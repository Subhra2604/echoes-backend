import { Queue, type ConnectionOptions } from 'bullmq';
import { redisConnection } from '../../lib/redis.js';

/**
 * BullMQ plumbing for VoiceRecording scheduled reminders.
 *
 * Same shape as the capsule scheduler — one queue, one job type, deterministic
 * jobIds so we can cancel and reschedule without collecting orphans in Redis.
 *
 * jobId pattern: `voice-reminder:{recordingId}`
 *   → cancel with `queue.remove(jobId)` on delete / date change
 *   → adding again with the same jobId replaces the prior schedule
 */

export interface VoiceReminderJobData {
  recordingId: string;
}

export const VOICE_REMINDER_QUEUE = 'voice-recording-reminder';

const connection = redisConnection as unknown as ConnectionOptions;

export const voiceReminderQueue = new Queue<VoiceReminderJobData, unknown, string>(
  VOICE_REMINDER_QUEUE,
  { connection },
);

/** Deterministic job ID so cancel/replace is straightforward. */
export function voiceReminderJobId(recordingId: string): string {
  return `voice-reminder:${recordingId}`;
}

/**
 * Schedule (or reschedule) a reminder for a recording.
 *
 * Always safe to call:
 *   - Cancels any existing schedule for the same recording first (idempotent
 *     even if there is none).
 *   - Schedules a new one at the requested time. Past timestamps result in
 *     delay=0 so the worker picks it up on the next tick.
 */
export async function scheduleVoiceReminder(
  recordingId: string,
  fireAt: Date,
): Promise<void> {
  const jobId = voiceReminderJobId(recordingId);
  await voiceReminderQueue.remove(jobId).catch(() => undefined);
  const delay = Math.max(0, fireAt.getTime() - Date.now());
  await voiceReminderQueue.add(
    'notify',
    { recordingId },
    {
      jobId,
      delay,
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
}

/** Cancel a pending reminder — no-op if none is queued. */
export async function cancelVoiceReminder(recordingId: string): Promise<void> {
  await voiceReminderQueue
    .remove(voiceReminderJobId(recordingId))
    .catch(() => undefined);
}
