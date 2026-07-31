import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { writeLimiter } from '../../middleware/rate-limit.js';
import {
  shareMemorySchema,
  listReceivedSharesQuerySchema,
  listMemorySharesQuerySchema,
  memoryIdParam,
  shareIdParam,
} from './shares.dto.js';
import * as svc from './shares.service.js';

/**
 * The sharing surface is split across two mount points because the routes
 * are naturally namespaced by resource:
 *   - /api/memories/:memoryId/share       (create + list shares OF a memory)
 *   - /api/shares/*                       (view + revoke shares)
 */

// ── Router 1: memory-scoped ─────────────────────────────────────────────────
// Mounted at /api/memories in app.ts. Uses mergeParams so :memoryId is visible.
export const memorySharesRouter = Router({ mergeParams: true });
memorySharesRouter.use(requireAuth);

// POST /api/memories/:memoryId/share — share a memory to N groups + M contacts
memorySharesRouter.post(
  '/:memoryId/share',
  writeLimiter,
  validate({ params: memoryIdParam, body: shareMemorySchema }),
  asyncHandler(async (req, res) => {
    const result = await svc.shareMemory(
      req.auth!.userId,
      req.params.memoryId,
      req.body,
    );
    res.status(201).json(result);
  }),
);

// GET /api/memories/:memoryId/shares — sender's view of who this memory reached
memorySharesRouter.get(
  '/:memoryId/shares',
  validate({ params: memoryIdParam, query: listMemorySharesQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = listMemorySharesQuerySchema.parse(req.query);
    res.json(await svc.listMemoryShares(req.auth!.userId, req.params.memoryId, q));
  }),
);

// ── Router 2: share-scoped ──────────────────────────────────────────────────
// Mounted at /api/shares in app.ts.
export const sharesRouter = Router();
sharesRouter.use(requireAuth);

// GET /api/shares/received — recipient inbox (contact-to-contact shares only)
sharesRouter.get(
  '/received',
  validate({ query: listReceivedSharesQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = listReceivedSharesQuerySchema.parse(req.query);
    res.json(await svc.listReceivedShares(req.auth!.userId, q));
  }),
);

// DELETE /api/shares/:shareId — unshare (sender or group manager)
sharesRouter.delete(
  '/:shareId',
  validate({ params: shareIdParam }),
  asyncHandler(async (req, res) => {
    await svc.deleteShare(req.auth!.userId, req.params.shareId);
    res.status(204).end();
  }),
);
