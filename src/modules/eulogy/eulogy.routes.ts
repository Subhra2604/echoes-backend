import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { generateEulogySchema, reviseEulogySchema, eulogyIdParam } from './eulogy.dto.js';
import * as e from './eulogy.service.js';

export const eulogyRouter = Router();
eulogyRouter.use(requireAuth);

eulogyRouter.post(
  '/',
  validate({ body: generateEulogySchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await e.createEulogy(req.auth!.userId, req.body));
  }),
);

eulogyRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await e.listEulogies(req.auth!.userId));
  }),
);

eulogyRouter.get(
  '/:eulogyId',
  validate({ params: eulogyIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await e.getEulogy(req.auth!.userId, req.params.eulogyId));
  }),
);

eulogyRouter.patch(
  '/:eulogyId',
  validate({ params: eulogyIdParam, body: reviseEulogySchema }),
  asyncHandler(async (req, res) => {
    res.json(await e.reviseEulogy(req.auth!.userId, req.params.eulogyId, req.body.draftText));
  }),
);

eulogyRouter.post(
  '/:eulogyId/regenerate',
  validate({ params: eulogyIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await e.regenerateEulogy(req.auth!.userId, req.params.eulogyId));
  }),
);

eulogyRouter.delete(
  '/:eulogyId',
  validate({ params: eulogyIdParam }),
  asyncHandler(async (req, res) => {
    await e.deleteEulogy(req.auth!.userId, req.params.eulogyId);
    res.status(204).end();
  }),
);
