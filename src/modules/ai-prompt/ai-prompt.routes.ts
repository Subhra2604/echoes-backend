import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { aiPromptLimiter } from '../../middleware/rate-limit.js';
import { askAiPromptSchema } from './ai-prompt.dto.js';
import * as svc from './ai-prompt.service.js';

export const aiPromptRouter = Router();
aiPromptRouter.use(requireAuth);

aiPromptRouter.post(
  '/',
  aiPromptLimiter,
  validate({ body: askAiPromptSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await svc.askAiPrompt(req.auth!.userId, req.body));
  }),
);

aiPromptRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await svc.listAiPrompts(req.auth!.userId));
  }),
);
