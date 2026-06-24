import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { updateProfileSchema, deleteAccountSchema } from './users.dto.js';
import * as u from './users.service.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

usersRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    res.json(await u.getMe(req.auth!.userId));
  }),
);

usersRouter.patch(
  '/me',
  validate({ body: updateProfileSchema }),
  asyncHandler(async (req, res) => {
    res.json(await u.updateProfile(req.auth!.userId, req.body));
  }),
);

// [Role_Docs] self-upgrade to Legacy Owner.
usersRouter.post(
  '/me/upgrade-to-legacy-owner',
  asyncHandler(async (req, res) => {
    res.json(await u.upgradeToLegacyOwner(req.auth!.userId));
  }),
);

// [GAP §1] permanent, cascading deletion behind a typed double-confirmation.
usersRouter.delete(
  '/me',
  validate({ body: deleteAccountSchema }),
  asyncHandler(async (req, res) => {
    await u.deleteAccount(req.auth!.userId);
    res.status(204).end();
  }),
);
