import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { writeLimiter } from '../../middleware/rate-limit.js';
import {
  shareContentSchema,
  listReceivedSharesQuerySchema,
  listContentSharesQuerySchema,
  memoryIdParam,
  recordingIdParam,
  shareIdParam,
} from './shares.dto.js';
import * as svc from './shares.service.js';

/**
 * The sharing surface is split across three mount points because the routes
 * are naturally namespaced by resource:
 *   - /api/shares/*                                (POST, GET received, DELETE :id)
 *   - /api/memories/:memoryId/shares               (list shares of MY memory)
 *   - /api/voice-recordings/:recordingId/shares    (list shares of MY recording)
 */

// ── Router 1: /api/shares ───────────────────────────────────────────────────
export const sharesRouter = Router();
sharesRouter.use(requireAuth);

// POST /api/shares — share a memory OR a voice recording to N groups + M contacts.
// Exactly one of memoryId or voiceRecordingId is required.
sharesRouter.post(
  '/',
  writeLimiter,
  validate({ body: shareContentSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await svc.shareContent(req.auth!.userId, req.body));
  }),
);

// GET /api/shares/received — recipient inbox for direct contact-to-contact
// shares. Filterable by contentType and sender.
sharesRouter.get(
  '/received',
  validate({ query: listReceivedSharesQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = listReceivedSharesQuerySchema.parse(req.query);
    res.json(await svc.listReceivedShares(req.auth!.userId, q));
  }),
);

// DELETE /api/shares/:shareId — unshare (sender or group manager).
sharesRouter.delete(
  '/:shareId',
  validate({ params: shareIdParam }),
  asyncHandler(async (req, res) => {
    await svc.deleteShare(req.auth!.userId, req.params.shareId);
    res.status(204).end();
  }),
);

// ── Router 2: /api/memories (memory-scoped share views) ─────────────────────
// Mounted with mergeParams so :memoryId is visible from req.params.
export const memoryScopedSharesRouter = Router({ mergeParams: true });
memoryScopedSharesRouter.use(requireAuth);

// GET /api/memories/:memoryId/shares — owner view of a memory's shares.
memoryScopedSharesRouter.get(
  '/:memoryId/shares',
  validate({ params: memoryIdParam, query: listContentSharesQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = listContentSharesQuerySchema.parse(req.query);
    res.json(await svc.listMemoryShares(req.auth!.userId, req.params.memoryId, q));
  }),
);

// ── Router 3: /api/voice-recordings (recording-scoped share views) ──────────
export const voiceRecordingScopedSharesRouter = Router({ mergeParams: true });
voiceRecordingScopedSharesRouter.use(requireAuth);

// GET /api/voice-recordings/:recordingId/shares — owner view of a recording's shares.
voiceRecordingScopedSharesRouter.get(
  '/:recordingId/shares',
  validate({ params: recordingIdParam, query: listContentSharesQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = listContentSharesQuerySchema.parse(req.query);
    res.json(
      await svc.listVoiceRecordingShares(
        req.auth!.userId,
        req.params.recordingId,
        q,
      ),
    );
  }),
);
