import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { requirePlatformRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  deletePageSchema,
  suspendUserSchema,
  manualReleaseSchema,
  overrideActivationSchema,
  auditQuerySchema,
  userIdParam,
  pageIdParam,
  capsuleIdParam,
  ownerIdParam,
} from './admin.dto.js';
import * as admin from './admin.service.js';
import { listAudit } from './audit.service.js';

export const adminRouter = Router();
adminRouter.use(requireAuth);
// [GAP §9] only Admin and Support Agent platform roles reach these endpoints.
adminRouter.use(requirePlatformRole('ADMIN', 'SUPPORT_AGENT'));

function ctx(req: Parameters<Parameters<typeof asyncHandler>[0]>[0]) {
  return { adminId: req.auth!.userId, ip: req.ip };
}

adminRouter.delete(
  '/pages/:pageId',
  validate({ params: pageIdParam, body: deletePageSchema }),
  asyncHandler(async (req, res) => {
    res.json(await admin.deleteMemorialPage(ctx(req), req.params.pageId, req.body.reason));
  }),
);

adminRouter.post(
  '/users/:userId/suspension',
  validate({ params: userIdParam, body: suspendUserSchema }),
  asyncHandler(async (req, res) => {
    res.json(await admin.setUserSuspension(ctx(req), req.params.userId, req.body.suspend, req.body.reason));
  }),
);

adminRouter.post(
  '/capsules/:capsuleId/manual-release',
  validate({ params: capsuleIdParam, body: manualReleaseSchema }),
  asyncHandler(async (req, res) => {
    res.json(await admin.manualReleaseCapsule(ctx(req), req.params.capsuleId, req.body.reason));
  }),
);

adminRouter.post(
  '/owners/:ownerId/override-activation',
  validate({ params: ownerIdParam, body: overrideActivationSchema }),
  asyncHandler(async (req, res) => {
    res.json(await admin.overrideActivation(ctx(req), req.params.ownerId, req.body.action, req.body.reason));
  }),
);

// [GAP §9] audit log read access for the admin app.
adminRouter.get(
  '/audit',
  validate({ query: auditQuerySchema }),
  asyncHandler(async (req, res) => {
    // Query was validated/coerced by `validate`; cast to the filter shape.
    res.json(await listAudit(req.query as unknown as { targetType?: string; targetId?: string; actorId?: string }));
  }),
);
