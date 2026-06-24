import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { listMyMemories } from './feed.service.js';

/**
 * Combined feed: GET /api/my-memories
 * Returns memories + voice recordings in one time-sorted, lightweight list.
 * Cursor pagination is time-based (`cursor` = ISO timestamp of the last row).
 */
export const feedRouter = Router();
feedRouter.use(requireAuth);

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().datetime().optional(), // ISO timestamp from a prior page
});

feedRouter.get(
  '/',
  validate({ query: querySchema }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { limit: number; cursor?: string };
    res.json(
      await listMyMemories(req.auth!.userId, {
        limit: q.limit,
        before: q.cursor ? new Date(q.cursor) : undefined,
      }),
    );
  }),
);
