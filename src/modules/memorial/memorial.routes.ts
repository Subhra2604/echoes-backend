import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth, optionalAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  createPageSchema,
  updatePageSchema,
  invitePageSchema,
  acceptPageInviteSchema,
  guestbookSchema,
  storySchema,
  timelineSchema,
  moderationDecisionSchema,
  initPhotoSchema,
  pageIdParam,
  entryParam,
  photoParam,
} from './memorial.dto.js';
import * as m from './memorial.service.js';

export const memorialRouter = Router();

// ── Pages ─────────────────────────────────────────────────────────────────────
memorialRouter.post(
  '/pages',
  requireAuth,
  validate({ body: createPageSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await m.createPage(req.auth!.userId, req.body));
  }),
);

memorialRouter.get(
  '/pages',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await m.listMyPages(req.auth!.userId));
  }),
);

// Public-readable when PUBLIC; privacy enforced in the service. optionalAuth so
// a logged-in viewer's collaborator/manager access can be checked too.
memorialRouter.get(
  '/pages/:pageId',
  optionalAuth,
  validate({ params: pageIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await m.getPage(req.params.pageId, req.auth?.userId));
  }),
);

memorialRouter.patch(
  '/pages/:pageId',
  requireAuth,
  validate({ params: pageIdParam, body: updatePageSchema }),
  asyncHandler(async (req, res) => {
    res.json(await m.updatePage(req.params.pageId, req.auth!.userId, req.body));
  }),
);

// ── Invitations ───────────────────────────────────────────────────────────────
memorialRouter.post(
  '/pages/:pageId/invitations',
  requireAuth,
  validate({ params: pageIdParam, body: invitePageSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await m.invitePerson(req.params.pageId, req.auth!.userId, req.body.email, req.body.canEdit));
  }),
);

memorialRouter.post(
  '/invitations/accept',
  requireAuth,
  validate({ body: acceptPageInviteSchema }),
  asyncHandler(async (req, res) => {
    res.json(await m.acceptInvite(req.auth!.userId, req.body.token));
  }),
);

// ── Guestbook ─────────────────────────────────────────────────────────────────
// optionalAuth: signed-in users are attributed; anonymous visitors may still sign.
memorialRouter.post(
  '/pages/:pageId/guestbook',
  optionalAuth,
  validate({ params: pageIdParam, body: guestbookSchema }),
  asyncHandler(async (req, res) => {
    const result = await m.addGuestbookEntry(
      req.params.pageId,
      { userId: req.auth?.userId, name: req.body.authorName },
      req.body.message,
    );
    res.status(201).json(result);
  }),
);

memorialRouter.get(
  '/pages/:pageId/guestbook/pending',
  requireAuth,
  validate({ params: pageIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await m.listPendingGuestbook(req.params.pageId, req.auth!.userId));
  }),
);

memorialRouter.post(
  '/pages/:pageId/guestbook/:entryId/moderate',
  requireAuth,
  validate({ params: entryParam, body: moderationDecisionSchema }),
  asyncHandler(async (req, res) => {
    res.json(await m.moderateGuestbook(req.params.pageId, req.auth!.userId, req.params.entryId, req.body.approve, req.body.reason));
  }),
);

// [GAP §6] anyone can report/flag an entry.
memorialRouter.post(
  '/pages/:pageId/guestbook/:entryId/report',
  validate({ params: entryParam }),
  asyncHandler(async (req, res) => {
    await m.reportGuestbook(req.params.entryId);
    res.status(204).end();
  }),
);

// ── Stories ───────────────────────────────────────────────────────────────────
memorialRouter.post(
  '/pages/:pageId/stories',
  optionalAuth,
  validate({ params: pageIdParam, body: storySchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await m.submitStory(req.params.pageId, { userId: req.auth?.userId }, req.body.title, req.body.content));
  }),
);

memorialRouter.get(
  '/pages/:pageId/stories/pending',
  requireAuth,
  validate({ params: pageIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await m.listPendingStories(req.params.pageId, req.auth!.userId));
  }),
);

memorialRouter.post(
  '/pages/:pageId/stories/:entryId/moderate',
  requireAuth,
  validate({ params: entryParam, body: moderationDecisionSchema }),
  asyncHandler(async (req, res) => {
    res.json(await m.moderateStory(req.params.pageId, req.auth!.userId, req.params.entryId, req.body.approve, req.body.reason));
  }),
);

// ── Timeline ──────────────────────────────────────────────────────────────────
memorialRouter.post(
  '/pages/:pageId/timeline',
  requireAuth,
  validate({ params: pageIdParam, body: timelineSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await m.addTimelineEvent(req.params.pageId, req.auth!.userId, req.body));
  }),
);

// ── Photos (public, AWS Rekognition screened) ─────────────────────────────────
memorialRouter.post(
  '/pages/:pageId/photos/init',
  requireAuth,
  validate({ params: pageIdParam, body: initPhotoSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await m.initPagePhoto(req.params.pageId, req.auth!.userId, req.body));
  }),
);

memorialRouter.post(
  '/pages/:pageId/photos/:photoId/finalize',
  requireAuth,
  validate({ params: photoParam }),
  asyncHandler(async (req, res) => {
    res.json(await m.finalizePagePhoto(req.params.pageId, req.auth!.userId, req.params.photoId));
  }),
);

// Public list (privacy enforced in the service via getPage access control).
memorialRouter.get(
  '/pages/:pageId/photos',
  optionalAuth,
  validate({ params: pageIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await m.listPagePhotos(req.params.pageId, req.auth?.userId));
  }),
);

memorialRouter.delete(
  '/pages/:pageId/photos/:photoId',
  requireAuth,
  validate({ params: photoParam }),
  asyncHandler(async (req, res) => {
    await m.deletePagePhoto(req.params.pageId, req.auth!.userId, req.params.photoId);
    res.status(204).end();
  }),
);
