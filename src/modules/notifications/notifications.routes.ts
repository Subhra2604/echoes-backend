import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  registerDeviceTokenSchema,
  removeDeviceTokenSchema,
  listNotificationsQuerySchema,
  patchNotificationSchema,
} from './notifications.dto.js';
import * as n from './notifications.service.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

// GET /api/notifications
//   ?unreadOnly | ?isRead | ?type=CAPSULE_ASSIGNED | ?referenceType=TimeCapsule
//   ?referenceId=<uuid> | ?page | ?limit
notificationsRouter.get(
  '/',
  validate({ query: listNotificationsQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = listNotificationsQuerySchema.parse(req.query);
    // If the caller supplied only the legacy `unreadOnly` flag with no other
    // filters, keep the old return shape (a bare array) for compatibility;
    // otherwise return the new paginated envelope.
    const onlyLegacyShape =
      q.unreadOnly !== undefined &&
      q.isRead === undefined &&
      q.type === undefined &&
      q.referenceType === undefined &&
      q.referenceId === undefined &&
      q.page === 1 &&
      q.limit === 50;
    if (onlyLegacyShape) {
      res.json(await n.listNotifications(req.auth!.userId, Boolean(q.unreadOnly)));
      return;
    }
    res.json(await n.listNotificationsFiltered(req.auth!.userId, q));
  }),
);

notificationsRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    res.json({ count: await n.unreadCount(req.auth!.userId) });
  }),
);

// PATCH /api/notifications/:id — toggle read state
notificationsRouter.patch(
  '/:id',
  validate({
    params: z.object({ id: z.string().uuid() }),
    body: patchNotificationSchema,
  }),
  asyncHandler(async (req, res) => {
    if (req.body.isRead) {
      await n.markRead(req.auth!.userId, req.params.id);
    } else {
      await n.markUnread(req.auth!.userId, req.params.id);
    }
    res.status(204).end();
  }),
);

// POST /api/notifications/:id/read — legacy mark-as-read (kept)
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
    await n.registerDeviceToken(
      req.auth!.userId,
      req.body.token,
      req.body.platform,
      { deviceId: req.body.deviceId, appVersion: req.body.appVersion },
    );
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
