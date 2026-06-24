import { Redis } from 'ioredis';
import { env } from '../config/env.js';

// BullMQ requires maxRetriesPerRequest: null on its connections.
export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
