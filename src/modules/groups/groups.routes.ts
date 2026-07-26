import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { writeLimiter } from '../../middleware/rate-limit.js';
import {
  createGroupSchema,
  updateGroupSchema,
  addParticipantsSchema,
  updateParticipantRoleSchema,
  transferOwnershipSchema,
  createGroupMediaSchema,
  searchContactsForGroupSchema,
  listMyGroupsQuerySchema,
  listGroupMediaQuerySchema,
  groupIdParam,
  groupParticipantParam,
  groupMediaParam,
} from './groups.dto.js';
import * as svc from './groups.service.js';

/**
 * Groups HTTP layer. All routes require auth; membership is enforced inside
 * the service (each service call funnels through assertActiveMember / manager /
 * owner guards) so route order or middleware misconfiguration cannot open a
 * hole.
 */
export const groupsRouter = Router();
groupsRouter.use(requireAuth);

// ── Groups CRUD ─────────────────────────────────────────────────────────────

// GET /api/groups — groups I belong to
groupsRouter.get(
  '/',
  validate({ query: listMyGroupsQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = listMyGroupsQuerySchema.parse(req.query);
    res.json(await svc.listMyGroups(req.auth!.userId, q));
  }),
);

// POST /api/groups — create a group
groupsRouter.post(
  '/',
  writeLimiter,
  validate({ body: createGroupSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createGroup(req.auth!.userId, req.body));
  }),
);

// GET /api/groups/search-contacts — my verified contacts, for the picker.
// Lives above /:groupId so it isn't shadowed by the UUID param route.
groupsRouter.get(
  '/search-contacts',
  validate({ query: searchContactsForGroupSchema }),
  asyncHandler(async (req, res) => {
    const q = searchContactsForGroupSchema.parse(req.query);
    res.json(await svc.searchContactsForGroup(req.auth!.userId, q));
  }),
);

// GET /api/groups/:groupId
groupsRouter.get(
  '/:groupId',
  validate({ params: groupIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await svc.getGroup(req.auth!.userId, req.params.groupId));
  }),
);

// PATCH /api/groups/:groupId — rename / change avatar / description
groupsRouter.patch(
  '/:groupId',
  writeLimiter,
  validate({ params: groupIdParam, body: updateGroupSchema }),
  asyncHandler(async (req, res) => {
    res.json(await svc.updateGroup(req.auth!.userId, req.params.groupId, req.body));
  }),
);

// DELETE /api/groups/:groupId — owner-only soft delete
groupsRouter.delete(
  '/:groupId',
  validate({ params: groupIdParam }),
  asyncHandler(async (req, res) => {
    await svc.deleteGroup(req.auth!.userId, req.params.groupId);
    res.status(204).end();
  }),
);

// ── Participants ────────────────────────────────────────────────────────────

// POST /api/groups/:groupId/participants — add members (from my contacts)
groupsRouter.post(
  '/:groupId/participants',
  writeLimiter,
  validate({ params: groupIdParam, body: addParticipantsSchema }),
  asyncHandler(async (req, res) => {
    res
      .status(201)
      .json(await svc.addParticipants(req.auth!.userId, req.params.groupId, req.body));
  }),
);

// DELETE /api/groups/:groupId/participants/:userId — kick a participant
groupsRouter.delete(
  '/:groupId/participants/:userId',
  validate({ params: groupParticipantParam }),
  asyncHandler(async (req, res) => {
    res.json(
      await svc.removeParticipant(
        req.auth!.userId,
        req.params.groupId,
        req.params.userId,
      ),
    );
  }),
);

// PATCH /api/groups/:groupId/participants/:userId/role — promote / demote
groupsRouter.patch(
  '/:groupId/participants/:userId/role',
  writeLimiter,
  validate({ params: groupParticipantParam, body: updateParticipantRoleSchema }),
  asyncHandler(async (req, res) => {
    res.json(
      await svc.updateParticipantRole(
        req.auth!.userId,
        req.params.groupId,
        req.params.userId,
        req.body,
      ),
    );
  }),
);

// POST /api/groups/:groupId/leave — self-service exit
groupsRouter.post(
  '/:groupId/leave',
  validate({ params: groupIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await svc.leaveGroup(req.auth!.userId, req.params.groupId));
  }),
);

// POST /api/groups/:groupId/transfer-ownership — hand OWNER to another member
groupsRouter.post(
  '/:groupId/transfer-ownership',
  writeLimiter,
  validate({ params: groupIdParam, body: transferOwnershipSchema }),
  asyncHandler(async (req, res) => {
    res.json(
      await svc.transferOwnership(req.auth!.userId, req.params.groupId, req.body),
    );
  }),
);

// ── Media ───────────────────────────────────────────────────────────────────

// GET /api/groups/:groupId/media — page through shared media (newest first)
groupsRouter.get(
  '/:groupId/media',
  validate({ params: groupIdParam, query: listGroupMediaQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = listGroupMediaQuerySchema.parse(req.query);
    res.json(await svc.listGroupMedia(req.auth!.userId, req.params.groupId, q));
  }),
);

// POST /api/groups/:groupId/media — finalize an upload (fileKey from /uploads/presign)
groupsRouter.post(
  '/:groupId/media',
  writeLimiter,
  validate({ params: groupIdParam, body: createGroupMediaSchema }),
  asyncHandler(async (req, res) => {
    res
      .status(201)
      .json(await svc.createGroupMedia(req.auth!.userId, req.params.groupId, req.body));
  }),
);

// DELETE /api/groups/:groupId/media/:mediaId
groupsRouter.delete(
  '/:groupId/media/:mediaId',
  validate({ params: groupMediaParam }),
  asyncHandler(async (req, res) => {
    await svc.deleteGroupMedia(req.auth!.userId, req.params.groupId, req.params.mediaId);
    res.status(204).end();
  }),
);
