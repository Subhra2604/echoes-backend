import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { writeLimiter } from '../../middleware/rate-limit.js';
import {
  createGuardianSchema,
  guardianIdParam,
} from './guardians.contact.dto.js';
import * as svc from './guardians.contact.service.js';

/**
 * Contact-based guardians router.
 *
 * Mounted under the same `/api/guardians` prefix as the existing invitation
 * routes. The URL paths deliberately live at the collection root
 * (`POST /`, `GET /`, `GET /:guardianId`, `DELETE /:guardianId`) to match
 * spec §5–§7, while the invitation flow keeps its own `/invitations`,
 * `/owners`, `/owners/:id/activate` paths. Two Express routers can share a
 * prefix safely.
 *
 * Dashboard endpoint lives here too so a guardian can see everything
 * assigned to them (spec §13).
 */
export const guardiansContactRouter = Router();
guardiansContactRouter.use(requireAuth);

// GET /api/guardians/dashboard — placed above /:guardianId so the UUID param
// route doesn't shadow it.
guardiansContactRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    res.json(await svc.listGuardianDashboard(req.auth!.userId));
  }),
);

// POST /api/guardians
guardiansContactRouter.post(
  '/',
  writeLimiter,
  validate({ body: createGuardianSchema }),
  asyncHandler(async (req, res) => {
    res
      .status(201)
      .json(await svc.createGuardian(req.auth!.userId, req.body.contactId));
  }),
);

// GET /api/guardians
guardiansContactRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await svc.listGuardians(req.auth!.userId));
  }),
);

// GET /api/guardians/:guardianId
guardiansContactRouter.get(
  '/:guardianId',
  validate({ params: guardianIdParam }),
  asyncHandler(async (req, res) => {
    res.json(
      await svc.getGuardian(req.auth!.userId, req.params.guardianId),
    );
  }),
);

// DELETE /api/guardians/:guardianId
guardiansContactRouter.delete(
  '/:guardianId',
  validate({ params: guardianIdParam }),
  asyncHandler(async (req, res) => {
    await svc.deleteGuardian(req.auth!.userId, req.params.guardianId);
    res.status(204).end();
  }),
);
