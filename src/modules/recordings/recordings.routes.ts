import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { writeLimiter } from '../../middleware/rate-limit.js';
import {
  createRecordingSchema,
  listRecordingsQuerySchema,
  recordingIdParam,
  type ListRecordingsQuery,
} from './recordings.dto.js';
import * as svc from './recordings.service.js';

/**
 * Voice recordings HTTP layer. Mounted at /api/voice-recordings. Upload is via
 * /api/uploads/presign (category "voice"); these endpoints handle metadata only.
 */
export const recordingsRouter = Router();
recordingsRouter.use(requireAuth);

recordingsRouter.get(
  '/',
  validate({ query: listRecordingsQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ListRecordingsQuery;
    res.json(await svc.listRecordings(req.auth!.userId, q));
  }),
);

recordingsRouter.post(
  '/',
  writeLimiter,
  validate({ body: createRecordingSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createRecording(req.auth!.userId, req.body));
  }),
);

recordingsRouter.get(
  '/:id',
  validate({ params: recordingIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await svc.getRecording(req.auth!.userId, req.params.id));
  }),
);

recordingsRouter.delete(
  '/:id',
  validate({ params: recordingIdParam }),
  asyncHandler(async (req, res) => {
    await svc.deleteRecording(req.auth!.userId, req.params.id);
    res.status(204).end();
  }),
);
