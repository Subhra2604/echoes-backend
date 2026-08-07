import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  initUploadSchema,
  finalizeUploadSchema,
  writtenMemorySchema,
  updateWrittenMemorySchema,
  createFolderSchema,
  itemIdParam,
  listItemsQuerySchema
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

// ── Written memories (extended for Written Vault sharing + PDF) ──────────────
vaultRouter.post(
  '/written',
  validate({ body: writtenMemorySchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await v.createWrittenMemory(req.auth!.userId, req.body));
  }),
);

// PATCH — update a WRITTEN entry (drafts only; PENDING/SHARED are locked).
vaultRouter.patch(
  '/written/:itemId',
  validate({ params: itemIdParam, body: updateWrittenMemorySchema }),
  asyncHandler(async (req, res) => {
    res.json(
      await v.updateWrittenMemory(req.auth!.userId, req.params.itemId, req.body),
    );
  }),
);

// GET /:itemId/pdf — download a WRITTEN entry as a formatted PDF.
// Owner-only. Streams the PDF directly to the response.
vaultRouter.get(
  '/written/:itemId/pdf',
  validate({ params: itemIdParam }),
  asyncHandler(async (req, res) => {
    const { filename, pdf } = await v.downloadWrittenPdf(
      req.auth!.userId,
      req.params.itemId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    pdf.pipe(res);
  }),
);

// ── Items ─────────────────────────────────────────────────────────────────────
vaultRouter.get(
  '/items',
  validate({ query: listItemsQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      folderId?: string;
      limit: number;
      cursor?: string;
    };
    res.json(
      await v.listItems(req.auth!.userId, {
        folderId: q.folderId,
        limit: Number(q.limit) || 0,
        cursor: q.cursor,
      }),
    );
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
