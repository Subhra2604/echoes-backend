import 'dotenv/config';

import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma } from './lib/prisma.js';
import { redisConnection } from './lib/redis.js';
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};
const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`Echoes API listening on :${env.PORT} (${env.NODE_ENV})`);
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close();
  await disconnectPrisma().catch(() => undefined);
  await redisConnection.quit().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));


