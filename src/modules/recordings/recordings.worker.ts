import { Worker, type ConnectionOptions } from 'bullmq';
import { redisConnection } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { notify } from '../notifications/notifications.service.js';
import {
  VOICE_REMINDER_QUEUE,
  type VoiceReminderJobData,
} from './recordings.scheduler.js';

/**
 * VoiceRecording reminder worker.
 *
 * Runs inside the `npm run worker` process alongside the capsule worker. When
 * a reminder job fires:
 *   1. Load the recording. If it's been deleted or the scheduledDate was
 *      cleared, drop the job silently — the API cancels queued jobs on those
 *      transitions, but a stale job that beat the cancel is still possible.
 *   2. Atomically claim the notification: UPDATE ... WHERE scheduleNotifiedAt
 *      IS NULL. If the row was already notified (rare — retries, manual
 *      re-queue), the update touches zero rows and we skip.
 *   3. Fire the notification. Since step 2 succeeded exactly once per row,
 *      this can't fire twice for the same recording.
 *
 * Failure semantics:
 *   - If step 3 fails after step 2 succeeded, the user misses that reminder
 *     (scheduleNotifiedAt is already set). This is the correct default —
 *     re-firing would spam the user on transient notification-provider
 *     outages. An admin recovery script can clear scheduleNotifiedAt for
 *     specific rows if needed.
 */
const connection = redisConnection as unknown as ConnectionOptions;

export const voiceReminderWorker = new Worker<VoiceReminderJobData>(
  VOICE_REMINDER_QUEUE,
  async (job) => {
    const { recordingId } = job.data;

    const rec = await prisma.voiceRecording.findFirst({
      where: { id: recordingId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        title: true,
        scheduledDate: true,
        scheduleNotifiedAt: true,
      },
    });

    if (!rec) {
      logger.debug({ recordingId }, 'reminder job for missing/deleted recording — skipping');
      return;
    }
    if (!rec.scheduledDate) {
      logger.debug({ recordingId }, 'reminder job but scheduledDate was cleared — skipping');
      return;
    }

    // Atomic claim. Only the first executor wins the update; further runs
    // (retries, duplicate jobs) touch zero rows and no-op below.
    const claim = await prisma.voiceRecording.updateMany({
      where: {
        id: recordingId,
        scheduleNotifiedAt: null,
        deletedAt: null,
      },
      data: { scheduleNotifiedAt: new Date() },
    });

    if (claim.count === 0) {
      logger.debug(
        { recordingId },
        'reminder already delivered by a prior execution — skipping',
      );
      return;
    }

    await notify(
      rec.userId,
      'VOICE_RECORDING_REMINDER',
      'Voice recording reminder',
      `Your reminder for "${rec.title}" is here.`,
      { recordingId },
    );

    logger.info({ recordingId, userId: rec.userId }, 'voice reminder delivered');
  },
  { connection, concurrency: 5 },
);

voiceReminderWorker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, recordingId: job?.data?.recordingId, err: err.message },
    'voice reminder job failed',
  );
});

voiceReminderWorker.on('completed', (job) => {
  logger.debug({ jobId: job.id }, 'voice reminder job completed');
});
