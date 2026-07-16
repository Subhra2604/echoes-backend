import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { registerDeviceTokenSchema, removeDeviceTokenSchema } from './notifications.dto.js';
import * as n from './notifications.service.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get(
  '/',
  validate({ query: z.object({ unreadOnly: z.coerce.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    res.json(await n.listNotifications(req.auth!.userId, Boolean(req.query.unreadOnly)));
  }),
);

notificationsRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    res.json({ count: await n.unreadCount(req.auth!.userId) });
  }),
);

notificationsRouter.post(
  '/:id/read',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    await n.markRead(req.auth!.userId, req.params.id);
    res.status(204).end();
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    await n.markAllRead(req.auth!.userId);
    res.status(204).end();
  }),
);

// ── Push device tokens ──────────────────────────────────────────────────────

notificationsRouter.post(
  '/device-tokens',
  validate({ body: registerDeviceTokenSchema }),
  asyncHandler(async (req, res) => {
    await n.registerDeviceToken(req.auth!.userId, req.body.token, req.body.platform);
    res.status(204).end();
  }),
);

notificationsRouter.delete(
  '/device-tokens',
  validate({ body: removeDeviceTokenSchema }),
  asyncHandler(async (req, res) => {
    await n.removeDeviceToken(req.auth!.userId, req.body.token);
    res.status(204).end();
  }),
);
