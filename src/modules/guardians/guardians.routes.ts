import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  inviteGuardianSchema,
  respondInvitationSchema,
  activateMemorialSchema,
  cancelMemorialSchema,
  ownerIdParam,
  invitationIdParam,
} from './guardians.dto.js';
import * as g from './guardians.service.js';

export const guardiansRouter = Router();
guardiansRouter.use(requireAuth);

// ── As a Legacy Owner ─────────────────────────────────────────────────────────
guardiansRouter.post(
  '/invitations',
  validate({ body: inviteGuardianSchema }),
  asyncHandler(async (req, res) => {
    const result = await g.inviteGuardian(req.auth!.userId, req.body.guardianEmail, req.body.isPrimary);
    res.status(201).json(result);
  }),
);

guardiansRouter.get(
  '/invitations',
  asyncHandler(async (req, res) => {
    res.json(await g.listMyGuardians(req.auth!.userId));
  }),
);

guardiansRouter.delete(
  '/invitations/:invitationId',
  validate({ params: invitationIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await g.revokeGuardian(req.auth!.userId, req.params.invitationId));
  }),
);

// ── As a Guardian ─────────────────────────────────────────────────────────────
guardiansRouter.post(
  '/invitations/respond',
  validate({ body: respondInvitationSchema }),
  asyncHandler(async (req, res) => {
    res.json(await g.respondToInvitation(req.auth!.userId, req.body.token, req.body.accept));
  }),
);

guardiansRouter.get(
  '/owners',
  asyncHandler(async (req, res) => {
    res.json(await g.listOwnersIGuard(req.auth!.userId));
  }),
);

guardiansRouter.post(
  '/owners/:ownerId/activate',
  validate({ params: ownerIdParam, body: activateMemorialSchema }),
  asyncHandler(async (req, res) => {
    res.json(await g.activateMemorial(req.params.ownerId, req.auth!.userId, req.body.deathCertificateKey));
  }),
);

guardiansRouter.post(
  '/owners/:ownerId/cancel-activation',
  validate({ params: ownerIdParam, body: cancelMemorialSchema }),
  asyncHandler(async (req, res) => {
    res.json(await g.cancelMemorial(req.params.ownerId, req.auth!.userId, req.body.reason, false));
  }),
);
