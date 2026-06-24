import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { presignLimiter } from '../../middleware/rate-limit.js';
import {
  presignSchema,
  deleteFileSchema,
  signedUrlQuerySchema,
} from './uploads.dto.js';
import * as svc from './uploads.service.js';

/**
 * Generic upload endpoints, shared by Profile / Memory / Voice.
 *
 *   POST   /api/uploads/presign      -> presigned S3 POST(s) (validated)
 *   DELETE /api/uploads/file         -> delete an orphaned object
 *   GET    /api/uploads/signed-url   -> short-lived GET URL for viewing
 */
export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

uploadsRouter.post(
  '/presign',
  presignLimiter,
  validate({ body: presignSchema }),
  asyncHandler(async (req, res) => {
    res.json(await svc.presign(req.auth!.userId, req.body));
  }),
);

uploadsRouter.delete(
  '/file',
  validate({ body: deleteFileSchema }),
  asyncHandler(async (req, res) => {
    res.json(await svc.removeFile(req.auth!.userId, req.body));
  }),
);

uploadsRouter.get(
  '/signed-url',
  validate({ query: signedUrlQuerySchema }),
  asyncHandler(async (req, res) => {
    res.json(
      await svc.signedUrl(req.auth!.userId, req.query as unknown as {
        key: string;
        expiresSec?: number;
      }),
    );
  }),
);
