import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  initUploadSchema,
  finalizeUploadSchema,
  writtenMemorySchema,
  createFolderSchema,
  itemIdParam,
} from './vault.dto.js';
import * as v from './vault.service.js';

export const vaultRouter = Router();
vaultRouter.use(requireAuth);

vaultRouter.get(
  '/usage',
  asyncHandler(async (req, res) => {
    res.json(await v.getStorageUsage(req.auth!.userId));
  }),
);

// ── Uploads (presigned, two-step) ─────────────────────────────────────────────
vaultRouter.post(
  '/uploads/init',
  validate({ body: initUploadSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await v.initUpload(req.auth!.userId, req.body));
  }),
);

vaultRouter.post(
  '/uploads/finalize',
  validate({ body: finalizeUploadSchema }),
  asyncHandler(async (req, res) => {
    res.json(await v.finalizeUpload(req.auth!.userId, req.body.itemId));
  }),
);

// ── Written memories ──────────────────────────────────────────────────────────
vaultRouter.post(
  '/written',
  validate({ body: writtenMemorySchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await v.createWrittenMemory(req.auth!.userId, req.body));
  }),
);

// ── Items ─────────────────────────────────────────────────────────────────────
vaultRouter.get(
  '/items',
  validate({ query: z.object({ folderId: z.string().uuid().optional() }) }),
  asyncHandler(async (req, res) => {
    res.json(await v.listItems(req.auth!.userId, req.query.folderId as string | undefined));
  }),
);

vaultRouter.get(
  '/items/:itemId/download',
  validate({ params: itemIdParam }),
  asyncHandler(async (req, res) => {
    res.json(await v.getItemDownloadUrl(req.auth!.userId, req.params.itemId));
  }),
);

vaultRouter.delete(
  '/items/:itemId',
  validate({ params: itemIdParam }),
  asyncHandler(async (req, res) => {
    await v.deleteItem(req.auth!.userId, req.params.itemId);
    res.status(204).end();
  }),
);

// ── Folders ───────────────────────────────────────────────────────────────────
vaultRouter.post(
  '/folders',
  validate({ body: createFolderSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await v.createFolder(req.auth!.userId, req.body.name, req.body.parentId));
  }),
);

vaultRouter.get(
  '/folders',
  asyncHandler(async (req, res) => {
    res.json(await v.listFolders(req.auth!.userId));
  }),
);
