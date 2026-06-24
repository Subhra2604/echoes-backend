import { Router, raw } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as billing from './billing.service.js';
import {
  PLAN_PRICE_USD,
  PLAN_STORAGE_BYTES,
  PLAN_MEMORIAL_LIMIT,
  PLAN_PHOTO_LIMIT,
  PLAN_ADS_ENABLED,
} from '../../config/plans.js';

export const billingRouter = Router();

const checkoutSchema = z.object({
  plan: z.enum(['BASIC', 'FAMILY', 'LEGACY_PREMIUM']),
});

// Public: the plan catalog (prices, storage, limits) for pricing pages.
billingRouter.get('/plans', (_req, res) => {
  const plans = (['FREE', 'BASIC', 'FAMILY', 'LEGACY_PREMIUM'] as const).map((plan) => ({
    plan,
    priceUsd: PLAN_PRICE_USD[plan],
    storageBytes: PLAN_STORAGE_BYTES[plan],
    memorialLimit: PLAN_MEMORIAL_LIMIT[plan],
    photoLimit: PLAN_PHOTO_LIMIT[plan],
    ads: PLAN_ADS_ENABLED[plan],
  }));
  res.json({ plans });
});

billingRouter.post(
  '/checkout',
  requireAuth,
  validate({ body: checkoutSchema }),
  asyncHandler(async (req, res) => {
    res.json(await billing.createCheckoutSession(req.auth!.userId, req.body.plan));
  }),
);

/**
 * Stripe webhook. Must receive the RAW body for signature verification, so this
 * route installs its own `express.raw` parser (the global JSON parser is mounted
 * to skip this path in app.ts). No auth — verified by Stripe signature instead.
 */
billingRouter.post(
  '/webhook',
  raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const signature = req.headers['stripe-signature'] as string | undefined;
    if (!signature) {
      res.status(400).json({ error: 'Missing stripe-signature header' });
      return;
    }
    await billing.handleWebhook(req.body as Buffer, signature);
    res.json({ received: true });
  }),
);
