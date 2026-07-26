import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { writeLimiter } from '../../middleware/rate-limit.js';
import {
  checkEmailSchema,
  createContactSchema,
  listContactsQuerySchema,
  contactIdParam,
} from './contacts.dto.js';
import * as svc from './contacts.service.js';

/**
 * Contacts HTTP layer.
 *
 * All routes require auth. `POST /check-email` in particular is gated so it
 * isn't a public email-enumeration endpoint — the platform surface exposes
 * user existence only to authenticated callers.
 *
 * Write routes get the shared `writeLimiter` (60 req/min per IP+user) to keep
 * signup-related email sends from being abused.
 */
export const contactsRouter = Router();
contactsRouter.use(requireAuth);

// POST /api/contacts/check-email — does this email belong to an Echoes user?
contactsRouter.post(
  '/check-email',
  writeLimiter,
  validate({ body: checkEmailSchema }),
  asyncHandler(async (req, res) => {
    res.json(await svc.checkEmailExists(req.body));
  }),
);

// GET /api/contacts — the caller's address book, with search + status filters.
contactsRouter.get(
  '/',
  validate({ query: listContactsQuerySchema }),
  asyncHandler(async (req, res) => {
    // Re-parse `req.query` so numeric / default fields are typed correctly.
    const q = listContactsQuerySchema.parse(req.query);
    res.json(await svc.listContacts(req.auth!.userId, q));
  }),
);

// POST /api/contacts — add an email. Creates VERIFIED or PENDING_INVITATION
// based on whether the target already has an account.
contactsRouter.post(
  '/',
  writeLimiter,
  validate({ body: createContactSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createContact(req.auth!.userId, req.body));
  }),
);

// DELETE /api/contacts/:contactId — remove from the caller's address book.
contactsRouter.delete(
  '/:contactId',
  validate({ params: contactIdParam }),
  asyncHandler(async (req, res) => {
    await svc.deleteContact(req.auth!.userId, req.params.contactId);
    res.status(204).end();
  }),
);
