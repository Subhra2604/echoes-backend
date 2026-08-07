import { Worker, type ConnectionOptions } from 'bullmq';
import { redisConnection } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { notify } from '../notifications/notifications.service.js';
import {
  SCHEDULED_SHARE_QUEUE,
  SCHEDULED_SHARE_JOB_NAME,
  SCHEDULED_SHARE_JOB_ID,
  DEFAULT_SCHEDULED_SHARE_CRON,
  scheduledShareQueue,
} from './scheduled-shares.scheduler.js';

/**
 * Scheduled-share delivery worker.
 *
 * Runs one job per day at 10 AM (or whatever pattern is in
 * `SCHEDULED_SHARE_CRON`). The handler:
 *
 *   1. Loads every ContentShare where status=PENDING, scheduledDate<=NOW,
 *      and both the share row and its source content are not soft-deleted.
 *   2. Atomically flips each row to SHARED via a single UPDATE ... WHERE
 *      id IN (...) AND status='PENDING' — the WHERE guard ensures we
 *      deliver each row exactly once even if the job re-runs after a crash.
 *   3. Fires per-recipient notifications (best-effort, in parallel batches).
 *   4. Sends a summary notification back to each sender: "your scheduled
 *      share for X was delivered."
 *
 * Deliberately simple. Not designed for very high throughput; a batch of
 * a few hundred scheduled shares per day is comfortably within a single
 * worker's capacity. If volume climbs into thousands/day, we'd shard by
 * sender or by scheduled date.
 */

const connection = redisConnection as unknown as ConnectionOptions;

// ── The delivery function (exported so it can be invoked manually too) ──
export async function deliverDueScheduledShares(): Promise<{
  attempted: number;
  delivered: number;
}> {
  const now = new Date();

  // Batch: pull up to 500 due rows per run. If more exist we'll get them
  // tomorrow (or the next manual trigger).
  const due = await prisma.contentShare.findMany({
    where: {
      status: 'PENDING',
      scheduledDate: { not: null, lte: now },
      deletedAt: null,
      OR: [
        { contentType: 'MEMORY', memory: { deletedAt: null } },
        { contentType: 'VOICE_RECORDING', voiceRecording: { deletedAt: null } },
        { contentType: 'WRITTEN_VAULT' },
      ],
    },
    orderBy: { scheduledDate: 'asc' },
    take: 500,
    select: {
      id: true,
      contentType: true,
      recipientType: true,
      groupId: true,
      recipientUserId: true,
      sharedById: true,
      memoryId: true,
      voiceRecordingId: true,
      writtenVaultItemId: true,
    },
  });

  if (due.length === 0) {
    logger.info('scheduled-share delivery: no due rows');
    return { attempted: 0, delivered: 0 };
  }

  // Atomic claim: flip status to SHARED. The status=PENDING guard ensures a
  // concurrent invocation (or a retry after crash) doesn't double-fire.
  const claim = await prisma.contentShare.updateMany({
    where: {
      id: { in: due.map((d) => d.id) },
      status: 'PENDING',
    },
    data: { status: 'SHARED', deliveredAt: now },
  });

  if (claim.count === 0) {
    logger.info(
      { candidates: due.length },
      'scheduled-share delivery: another executor won the claim, skipping',
    );
    return { attempted: due.length, delivered: 0 };
  }

  // For any WRITTEN_VAULT items just delivered, promote their writtenStatus
  // from PENDING to SHARED. Never demote from SHARED.
  const writtenIds = Array.from(
    new Set(
      due
        .filter((d) => d.contentType === 'WRITTEN_VAULT' && d.writtenVaultItemId)
        .map((d) => d.writtenVaultItemId as string),
    ),
  );
  if (writtenIds.length > 0) {
    await prisma.vaultItem.updateMany({
      where: { id: { in: writtenIds }, writtenStatus: { not: 'SHARED' } },
      data: { writtenStatus: 'SHARED' },
    });
  }

  logger.info(
    { attempted: due.length, delivered: claim.count },
    'scheduled-share delivery: claim succeeded, firing notifications',
  );

  // Fire notifications outside the transaction — best effort, order not
  // important. Group per source content so we look up sender + source once
  // per unique (senderId, contentType, sourceId) instead of per row.
  const bySource = new Map<
    string,
    {
      senderId: string;
      memoryId: string | null;
      voiceRecordingId: string | null;
      writtenVaultItemId: string | null;
      contentType: 'MEMORY' | 'VOICE_RECORDING' | 'WRITTEN_VAULT';
      shares: typeof due;
    }
  >();
  for (const d of due) {
    const sourceId =
      d.memoryId ?? d.voiceRecordingId ?? d.writtenVaultItemId;
    const key = `${d.sharedById}|${d.contentType}|${sourceId}`;
    if (!bySource.has(key)) {
      bySource.set(key, {
        senderId: d.sharedById,
        memoryId: d.memoryId,
        voiceRecordingId: d.voiceRecordingId,
        writtenVaultItemId: d.writtenVaultItemId,
        contentType: d.contentType,
        shares: [],
      });
    }
    bySource.get(key)!.shares.push(d);
  }

  for (const bundle of bySource.values()) {
    try {
      await fireBundle(bundle);
    } catch (err) {
      logger.warn(
        { err, senderId: bundle.senderId },
        'scheduled-share delivery: bundle fan-out failed (partial)',
      );
    }
  }

  return { attempted: due.length, delivered: claim.count };
}

async function fireBundle(bundle: {
  senderId: string;
  memoryId: string | null;
  voiceRecordingId: string | null;
  writtenVaultItemId: string | null;
  contentType: 'MEMORY' | 'VOICE_RECORDING' | 'WRITTEN_VAULT';
  shares: Array<{
    id: string;
    recipientType: string;
    groupId: string | null;
    recipientUserId: string | null;
  }>;
}) {
  // Resolve sender + source in parallel.
  const [sender, source] = await Promise.all([
    prisma.user.findUnique({
      where: { id: bundle.senderId },
      select: { fullName: true },
    }),
    bundle.contentType === 'MEMORY'
      ? prisma.memory.findUnique({
          where: { id: bundle.memoryId! },
          select: { title: true },
        })
      : bundle.contentType === 'VOICE_RECORDING'
        ? prisma.voiceRecording.findUnique({
            where: { id: bundle.voiceRecordingId! },
            select: { title: true },
          })
        : prisma.vaultItem.findUnique({
            where: { id: bundle.writtenVaultItemId! },
            select: { title: true },
          }),
  ]);
  const senderName = sender?.fullName ?? 'Someone';
  const title = source?.title ?? 'a memory';
  const contentLabel =
    bundle.contentType === 'MEMORY'
      ? 'memory'
      : bundle.contentType === 'VOICE_RECORDING'
        ? 'voice recording'
        : 'letter';

  const jobs: Promise<unknown>[] = [];
  for (const s of bundle.shares) {
    if (s.recipientType === 'GROUP' && s.groupId) {
      const groupId = s.groupId;
      const group = await prisma.group.findUnique({
        where: { id: groupId },
        select: { name: true },
      });
      const groupName = group?.name ?? 'a group';
      const members = await prisma.groupParticipant.findMany({
        where: { groupId, status: 'ACTIVE', userId: { not: bundle.senderId } },
        select: { userId: true },
      });
      for (const m of members) {
        jobs.push(
          notify(
            m.userId,
            'GROUP_MEDIA_UPLOADED',
            `New ${contentLabel} in "${groupName}"`,
            `${senderName} shared "${title}" in ${groupName}.`,
            { groupId, senderId: bundle.senderId, contentType: bundle.contentType },
          ),
        );
      }
    } else if (s.recipientType === 'CONTACT' && s.recipientUserId) {
      jobs.push(
        notify(
          s.recipientUserId,
          'MEMORY_SHARED_WITH_YOU',
          `${senderName} shared a ${contentLabel} with you`,
          `${senderName} shared "${title}" with you.`,
          { senderId: bundle.senderId, contentType: bundle.contentType },
        ),
      );
    }
  }
  // One roll-up notification back to the sender so they know it fired.
  jobs.push(
    notify(
      bundle.senderId,
      'SCHEDULED_SHARE_DELIVERED',
      `Your scheduled share was delivered`,
      `"${title}" was delivered to ${bundle.shares.length} recipient${
        bundle.shares.length === 1 ? '' : 's'
      }.`,
      { contentType: bundle.contentType, count: bundle.shares.length },
    ),
  );
  await Promise.all(jobs);
}

// ── Worker + recurring-job registration ─────────────────────────────────────
export const scheduledShareWorker = new Worker(
  SCHEDULED_SHARE_QUEUE,
  async (_job) => {
    const result = await deliverDueScheduledShares();
    return result;
  },
  { connection, concurrency: 1 }, // singleton — one run at a time is enough
);

scheduledShareWorker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, err: err.message },
    'scheduled-share delivery job failed',
  );
});

/**
 * Register (or re-register) the daily recurring job. Idempotent — call at
 * worker startup. Uses a stable jobId so restarts don't accumulate ghost
 * schedules in Redis.
 */
export async function registerDailyScheduledShareJob(): Promise<void> {
  const cronPattern =
    process.env.SCHEDULED_SHARE_CRON ?? DEFAULT_SCHEDULED_SHARE_CRON;
  const tz = process.env.SCHEDULED_SHARE_TZ ?? undefined;

  // Remove any pre-existing repeatable schedule under this jobId so a changed
  // cron pattern in env takes effect on next restart.
  try {
    const repeatables = await scheduledShareQueue.getJobSchedulers();
    for (const r of repeatables) {
      if (r.key === SCHEDULED_SHARE_JOB_ID) {
        await scheduledShareQueue.removeJobScheduler(r.key);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'failed to inspect existing schedulers (proceeding)');
  }

  await scheduledShareQueue.upsertJobScheduler(
    SCHEDULED_SHARE_JOB_ID,
    { pattern: cronPattern, tz },
    { name: SCHEDULED_SHARE_JOB_NAME, data: {} },
  );

  logger.info(
    { pattern: cronPattern, tz: tz ?? 'server default' },
    'daily scheduled-share delivery job registered',
  );
}
