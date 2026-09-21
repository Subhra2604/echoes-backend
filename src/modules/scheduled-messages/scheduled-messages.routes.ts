import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { writeLimiter } from '../../middleware/rate-limit.js';
import {
  createScheduledMessageSchema,
  updateScheduledMessageSchema,
  listScheduledMessagesQuerySchema,
  scheduledMessageIdParam,
} from './scheduled-messages.dto.js';
import * as svc from './scheduled-messages.service.js';

/**
 * Scheduled Messages HTTP surface.
 *
 * All routes require auth. The service enforces per-endpoint permissions:
 * write operations are owner-only; reads see messages the caller owns OR is
 * a recipient of.
 */
export const scheduledMessagesRouter = Router();
scheduledMessagesRouter.use(requireAuth);

// POST /api/scheduled-messages
scheduledMessagesRouter.post(
  '/',
  writeLimiter,
  validate({ body: createScheduledMessageSchema }),
  asyncHandler(async (req, res) => {
    res
      .status(201)
      .json(await svc.createScheduledMessage(req.auth!.userId, req.body));
  }),
);

// GET /api/scheduled-messages?filter=for_me|scheduled_by_me&status=&search=&page=&limit=
scheduledMessagesRouter.get(
  '/',
  validate({ query: listScheduledMessagesQuerySchema }),
  asyncHandler(async (req, res) => {
    // Re-parse so defaults / coerced numbers are applied.
    const q = listScheduledMessagesQuerySchema.parse(req.query);
    res.json(await svc.listScheduledMessages(req.auth!.userId, q));
  }),
);

// GET /api/scheduled-messages/:id
scheduledMessagesRouter.get(
  '/:id',
  validate({ params: scheduledMessageIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await svc.getScheduledMessage(req.auth!.userId, req.params.id));
  }),
);

// PATCH /api/scheduled-messages/:id
scheduledMessagesRouter.patch(
  '/:id',
  writeLimiter,
  validate({
    params: scheduledMessageIdParam,
    body: updateScheduledMessageSchema,
  }),
  asyncHandler(async (req, res) => {
    res.json(
      await svc.updateScheduledMessage(
        req.auth!.userId,
        req.params.id,
        req.body,
      ),
    );
  }),
);

// DELETE /api/scheduled-messages/:id
scheduledMessagesRouter.delete(
  '/:id',
  validate({ params: scheduledMessageIdParam }),
  asyncHandler(async (req, res) => {
    await svc.deleteScheduledMessage(req.auth!.userId, req.params.id);
    res.status(204).end();
  }),
);
