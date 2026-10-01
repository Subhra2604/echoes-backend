import { Router, raw } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as billing from './billing.service.js';
import {
  PLAN_DISPLAY,
  PLAN_PRICING,
  PLAN_STORAGE_BYTES,
  PLAN_MEMORIAL_LIMIT,
  PLAN_PHOTO_LIMIT,
  PLAN_CAPSULE_LIMIT,
  PLAN_CAPSULE_RELEASE_TYPES,
  PLAN_GUARDIAN_LIMIT,
  PLAN_SCHEDULED_MESSAGE_LIMIT,
  PLAN_GROUP_LIMIT,
  PLAN_GROUP_PARTICIPANT_LIMIT,
  PLAN_EULOGY_GENERATION_LIMIT,
  PLAN_IMAGE_AGING_LIMIT,
  PLAN_ADS_ENABLED,
  PAID_PLANS,
  TRIAL_PERIOD_DAYS,
} from '../../config/plans.js';

export const billingRouter = Router();

const checkoutSchema = z.object({
  plan: z.enum(['MEMORY', 'FAMILY', 'LEGACY']),
  interval: z.enum(['MONTH', 'YEAR']).default('MONTH'),
});

/**
 * Public: the plan catalog for pricing pages. Includes the unsold FREE tier so
 * a lapsed account can be shown its current limits — filter on `purchasable`
 * to render the pricing page itself.
 */
billingRouter.get('/plans', (_req, res) => {
  const plans = (['FREE', ...PAID_PLANS] as const).map((plan) => ({
    plan,
    name: PLAN_DISPLAY[plan].name,
    tagline: PLAN_DISPLAY[plan].tagline,
    purchasable: PAID_PLANS.includes(plan),
    priceUsd: PLAN_PRICING[plan],
    storageBytes: PLAN_STORAGE_BYTES[plan],
    ads: PLAN_ADS_ENABLED[plan],
    // null = unlimited, 0 = feature not included on this plan
    limits: {
      memorials: PLAN_MEMORIAL_LIMIT[plan],
      photos: PLAN_PHOTO_LIMIT[plan],
      capsules: PLAN_CAPSULE_LIMIT[plan],
      capsuleReleaseTypes: PLAN_CAPSULE_RELEASE_TYPES[plan],
      guardians: PLAN_GUARDIAN_LIMIT[plan],
      scheduledMessages: PLAN_SCHEDULED_MESSAGE_LIMIT[plan],
      groups: PLAN_GROUP_LIMIT[plan],
      groupParticipants: PLAN_GROUP_PARTICIPANT_LIMIT[plan],
      eulogyGenerationsPerMonth: PLAN_EULOGY_GENERATION_LIMIT[plan],
      imageAgingPerMonth: PLAN_IMAGE_AGING_LIMIT[plan],
    },
  }));
  res.json({ trialDays: TRIAL_PERIOD_DAYS, plans });
});

billingRouter.post(
  '/checkout',
  requireAuth,
  validate({ body: checkoutSchema }),
  asyncHandler(async (req, res) => {
    res.json(await billing.createCheckoutSession(req.auth!.userId, req.body.plan, req.body.interval));
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
