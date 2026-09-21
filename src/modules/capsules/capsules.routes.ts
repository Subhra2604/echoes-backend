import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { writeLimiter } from '../../middleware/rate-limit.js';
import {
  createCapsuleSchema,
  updateCapsuleSchema,
  updateCapsuleScheduleSchema,
  addCapsuleContactsSchema,
  setCapsuleGuardianSchema,
  capsuleIdParam,
  capsuleContactParam,
} from './capsules.dto.js';
import * as c from './capsules.service.js';

/**
 * Time Capsule HTTP surface.
 *
 * Endpoint map (spec §16):
 *   POST   /capsules
 *   GET    /capsules
 *   GET    /capsules/:capsuleId
 *   PATCH  /capsules/:capsuleId                   (owner-only, full edit)
 *   DELETE /capsules/:capsuleId
 *   PATCH  /capsules/:capsuleId/schedule          (guardian-only, spec §14)
 *   GET    /capsules/:capsuleId/contacts
 *   POST   /capsules/:capsuleId/contacts
 *   DELETE /capsules/:capsuleId/contacts/:contactId
 *   PUT    /capsules/:capsuleId/guardian
 *   POST   /capsules/:capsuleId/guardian-release  (legacy invitation guardian)
 */
export const capsulesRouter = Router();
capsulesRouter.use(requireAuth);

// ── CRUD (owner) ────────────────────────────────────────────────────────────

capsulesRouter.post(
  '/',
  writeLimiter,
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

capsulesRouter.get(
  '/:capsuleId',
  validate({ params: capsuleIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await c.getCapsule(req.auth!.userId, req.params.capsuleId));
  }),
);

capsulesRouter.patch(
  '/:capsuleId',
  writeLimiter,
  validate({ params: capsuleIdParam, body: updateCapsuleSchema }),
  asyncHandler(async (req, res) => {
    res.json(
      await c.updateCapsule(req.auth!.userId, req.params.capsuleId, req.body),
    );
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

// ── Guardian PATCH — spec §14 schedule-only ────────────────────────────────

capsulesRouter.patch(
  '/:capsuleId/schedule',
  writeLimiter,
  validate({ params: capsuleIdParam, body: updateCapsuleScheduleSchema }),
  asyncHandler(async (req, res) => {
    res.json(
      await c.updateCapsuleScheduleByGuardian(
        req.auth!.userId,
        req.params.capsuleId,
        req.body,
      ),
    );
  }),
);

// ── Contacts sub-resource ──────────────────────────────────────────────────

capsulesRouter.get(
  '/:capsuleId/contacts',
  validate({ params: capsuleIdParam }),
  asyncHandler(async (req, res) => {
    res.json(
      await c.listCapsuleContacts(req.auth!.userId, req.params.capsuleId),
    );
  }),
);

capsulesRouter.post(
  '/:capsuleId/contacts',
  writeLimiter,
  validate({ params: capsuleIdParam, body: addCapsuleContactsSchema }),
  asyncHandler(async (req, res) => {
    res
      .status(201)
      .json(
        await c.addCapsuleContacts(
          req.auth!.userId,
          req.params.capsuleId,
          req.body,
        ),
      );
  }),
);

capsulesRouter.delete(
  '/:capsuleId/contacts/:contactId',
  validate({ params: capsuleContactParam }),
  asyncHandler(async (req, res) => {
    await c.removeCapsuleContact(
      req.auth!.userId,
      req.params.capsuleId,
      req.params.contactId,
    );
    res.status(204).end();
  }),
);

// ── Guardian sub-resource ──────────────────────────────────────────────────

capsulesRouter.put(
  '/:capsuleId/guardian',
  writeLimiter,
  validate({ params: capsuleIdParam, body: setCapsuleGuardianSchema }),
  asyncHandler(async (req, res) => {
    res.json(
      await c.setCapsuleGuardian(
        req.auth!.userId,
        req.params.capsuleId,
        req.body,
      ),
    );
  }),
);

// ── Legacy guardian-controlled manual release (unchanged behavior) ─────────

capsulesRouter.post(
  '/:capsuleId/guardian-release',
  validate({ params: capsuleIdParam }),
  asyncHandler(async (req, res) => {
    const ownerId = String(req.body?.ownerId ?? '');
    res.json(
      await c.guardianRelease(ownerId, req.auth!.userId, req.params.capsuleId),
    );
  }),
);
