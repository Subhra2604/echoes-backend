import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { writeLimiter } from '../../middleware/rate-limit.js';
import {
  createMemorySchema,
  updateMemorySchema,
  listMemoriesQuerySchema,
  memoryIdParam,
  type ListMemoriesQuery,
} from './memories.dto.js';
import * as svc from './memories.service.js';

/**
 * Memories HTTP layer. Each route is a thin shim that delegates to the service.
 * Validation runs before the handler, so handlers can trust `req.body`/params.
 * The upload itself is handled by /api/uploads/presign — these endpoints only
 * deal with metadata.
 */
export const memoriesRouter = Router();
memoriesRouter.use(requireAuth);

memoriesRouter.get(
  '/',
  validate({ query: listMemoriesQuerySchema }),
  asyncHandler(async (req, res) => {
    console.log('validated query =>', req.query);
    const q = listMemoriesQuerySchema.parse(req.query);
    console.log('limit =>', q.limit);
    res.json(await svc.listMemories(req.auth!.userId, q));
  }),
);

memoriesRouter.post(
  '/',
  writeLimiter,
  validate({ body: createMemorySchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createMemory(req.auth!.userId, req.body));
  }),
);

memoriesRouter.get(
  '/:id',
  validate({ params: memoryIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await svc.getMemory(req.auth!.userId, req.params.id));
  }),
);

memoriesRouter.patch(
  '/:id',
  writeLimiter,
  validate({ params: memoryIdParam, body: updateMemorySchema }),
  asyncHandler(async (req, res) => {
    res.json(await svc.updateMemory(req.auth!.userId, req.params.id, req.body));
  }),
);

memoriesRouter.delete(
  '/:id',
  validate({ params: memoryIdParam }),
  asyncHandler(async (req, res) => {
    await svc.deleteMemory(req.auth!.userId, req.params.id);
    res.status(204).end();
  }),
);
