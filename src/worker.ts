import 'dotenv/config';

import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma } from './lib/prisma.js';
import { redisConnection } from './lib/redis.js';
import { capsuleWorker } from './modules/capsules/capsules.worker.js';
import { voiceReminderWorker } from './modules/recordings/recordings.worker.js';
import {
  scheduledShareWorker,
  registerDailyScheduledShareJob,
} from './modules/shares/scheduled-shares.worker.js';

logger.info(`Echoes worker started (${env.NODE_ENV})`);

// Register the daily 10 AM scheduled-share delivery job. Idempotent, so safe
// to call on every worker start. Runs asynchronously — a failure here just
// means the recurring job won't fire until next restart, logged loudly.
registerDailyScheduledShareJob().catch((err) =>
  logger.error({ err }, 'failed to register daily scheduled-share delivery job'),
);

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');
  await capsuleWorker.close().catch(() => undefined);
  await voiceReminderWorker.close().catch(() => undefined);
  await scheduledShareWorker.close().catch(() => undefined);
  await disconnectPrisma().catch(() => undefined);
  await redisConnection.quit().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
