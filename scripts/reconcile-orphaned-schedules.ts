/**
 * One-time reconciliation for capsules/scheduled-messages created BEFORE the
 * BullMQ colon-jobId fix shipped (see commit "Fix production bugs in Time
 * Capsules, Scheduled Messages, device-tokens, notifications").
 *
 * Before that fix, `scheduleOneOff` / `scheduleMessageDelivery` threw
 * ("Custom Id cannot contain :") AFTER the DB row was already committed, so
 * the API returned 500 to the client while the row silently persisted with
 * no actual BullMQ job behind it — status SCHEDULED/PENDING, but nothing in
 * the queue will ever fire it.
 *
 * This script finds every such row and re-registers its job using the
 * SAME scheduler functions the app uses, so the resulting job is identical
 * to what a fresh, working request would have created. It's safe to run
 * more than once: both schedulers use a deterministic jobId
 * (oneoff-{capsuleId}, msg-{scheduledMessageId}) and replace any existing
 * job for that id before adding the new one.
 *
 * Usage (run against the target environment's DATABASE_URL/REDIS_URL,
 * typically from inside the API/worker container or a one-off task):
 *   npx tsx scripts/reconcile-orphaned-schedules.ts          # apply
 *   npx tsx scripts/reconcile-orphaned-schedules.ts --dry-run # report only
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { scheduleOneOff } from '../src/modules/capsules/capsules.scheduler.js';
import { scheduleMessageDelivery } from '../src/modules/scheduled-messages/scheduled-messages.scheduler.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`Reconciling orphaned schedules${DRY_RUN ? ' (dry run)' : ''}...`);

  const capsules = await prisma.timeCapsule.findMany({
    where: { releaseType: 'SCHEDULED_DATE', status: 'SCHEDULED', releaseAt: { not: null } },
    select: { id: true, title: true, releaseAt: true, ownerId: true },
  });
  console.log(`Found ${capsules.length} SCHEDULED_DATE capsule(s) in status=SCHEDULED.`);
  for (const c of capsules) {
    console.log(`  capsule ${c.id} ("${c.title}") releaseAt=${c.releaseAt?.toISOString()}`);
    if (!DRY_RUN) await scheduleOneOff(c.id, c.releaseAt!);
  }

  const messages = await prisma.scheduledMessage.findMany({
    where: { status: 'PENDING' },
    select: { id: true, occasion: true, scheduleDate: true, ownerId: true },
  });
  console.log(`Found ${messages.length} scheduled message(s) in status=PENDING.`);
  for (const m of messages) {
    console.log(`  scheduled-message ${m.id} ("${m.occasion}") scheduleDate=${m.scheduleDate.toISOString()}`);
    if (!DRY_RUN) await scheduleMessageDelivery(m.id, m.scheduleDate);
  }

  console.log(DRY_RUN ? 'Dry run complete — no jobs were registered.' : 'Done — all jobs re-registered.');
  await prisma.$disconnect();
  // The imported schedulers open BullMQ Queue/ioredis connections at module
  // load time that don't close themselves — exit explicitly rather than
  // waiting on an event loop that never drains.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
