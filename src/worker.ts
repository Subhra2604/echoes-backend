import 'dotenv/config';

import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma } from './lib/prisma.js';
import { redisConnection } from './lib/redis.js';
import { capsuleWorker } from './modules/capsules/capsules.worker.js';
import { voiceReminderWorker } from './modules/recordings/recordings.worker.js';

logger.info(`Echoes worker started (${env.NODE_ENV})`);

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');
  await capsuleWorker.close().catch(() => undefined);
  await voiceReminderWorker.close().catch(() => undefined);
  await disconnectPrisma().catch(() => undefined);
  await redisConnection.quit().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
