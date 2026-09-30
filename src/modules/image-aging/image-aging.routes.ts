import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { imageAgingLimiter } from '../../middleware/rate-limit.js';
import { createImageAgingJobSchema, imageAgingJobIdParam } from './image-aging.dto.js';
import * as svc from './image-aging.service.js';

/**
 * AI age-progression image job HTTP surface.
 *
 * Client flow: POST /api/uploads/presign (category: 'memory', existing,
 * unchanged) -> upload to S3 -> POST /api/image-aging/jobs { fileKey,
 * ageOffset } -> poll GET /api/image-aging/jobs/:jobId (or wait for the
 * push notification) -> once status: READY, response includes downloadUrl.
 */
export const imageAgingRouter = Router();
imageAgingRouter.use(requireAuth);

imageAgingRouter.post(
  '/jobs',
  imageAgingLimiter,
  validate({ body: createImageAgingJobSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createImageAgingJob(req.auth!.userId, req.body));
  }),
);

imageAgingRouter.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    res.json(await svc.listImageAgingJobs(req.auth!.userId));
  }),
);

imageAgingRouter.get(
  '/jobs/:jobId',
  validate({ params: imageAgingJobIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await svc.getImageAgingJob(req.auth!.userId, req.params.jobId));
  }),
);
