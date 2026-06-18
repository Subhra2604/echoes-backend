import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { createCapsuleSchema, updateCapsuleSchema, capsuleIdParam } from './capsules.dto.js';
import * as c from './capsules.service.js';

export const capsulesRouter = Router();
capsulesRouter.use(requireAuth);

// ── As a Legacy Owner (while alive) ───────────────────────────────────────────
capsulesRouter.post(
  '/',
  validate({ body: createCapsuleSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await c.createCapsule(req.auth!.userId, req.body));
  }),
);

capsulesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await c.listCapsules(req.auth!.userId));
  }),
);

// [GAP §3] editable/deletable by the owner WHILE ALIVE only (enforced in service).
capsulesRouter.patch(
  '/:capsuleId',
  validate({ params: capsuleIdParam, body: updateCapsuleSchema }),
  asyncHandler(async (req, res) => {
    res.json(await c.updateCapsule(req.auth!.userId, req.params.capsuleId, req.body));
  }),
);

capsulesRouter.delete(
  '/:capsuleId',
  validate({ params: capsuleIdParam }),
  asyncHandler(async (req, res) => {
    await c.deleteCapsule(req.auth!.userId, req.params.capsuleId);
    res.status(204).end();
  }),
);

// ── As a Guardian (after death) ───────────────────────────────────────────────
// [GAP §3] guardian-controlled release: the guardian triggers delivery but does
// NOT see content, CANNOT edit, and CANNOT decline. The route only accepts the
// owner + capsule ids; the service verifies active guardianship.
capsulesRouter.post(
  '/:capsuleId/guardian-release',
  validate({ params: capsuleIdParam }),
  asyncHandler(async (req, res) => {
    const ownerId = String(req.body?.ownerId ?? '');
    res.json(await c.guardianRelease(ownerId, req.auth!.userId, req.params.capsuleId));
  }),
);
