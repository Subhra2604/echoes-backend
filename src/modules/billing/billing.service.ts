import Stripe from 'stripe';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { planPriceId, PAID_PLANS } from '../../config/plans.js';
import type { SubscriptionPlan } from '../../generated/prisma/enums.js';

/**
 * Billing. Paid platform via Stripe; the FREE plan needs no billing. Each paid
 * plan (BASIC/FAMILY/LEGACY_PREMIUM) maps to a Stripe Price configured in the
 * dashboard. The webhook is the source of truth: a paid plan is granted only
 * once Stripe confirms payment, and the account downgrades to FREE on
 * cancellation. (Storage add-on packs are deferred to a later phase.)
 */

export const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;

// Reverse lookup: Stripe Price ID -> plan, built from the configured prices.
const PLAN_BY_PRICE: Record<string, SubscriptionPlan> = PAID_PLANS.reduce(
  (acc, plan) => {
    const price = planPriceId(plan);
    if (price) acc[price] = plan;
    return acc;
  },
  {} as Record<string, SubscriptionPlan>,
);

export async function createCheckoutSession(userId: string, plan: SubscriptionPlan) {
  if (!stripe) throw Errors.badRequest('Billing is not configured');
  const priceId = planPriceId(plan);
  if (!priceId) throw Errors.badRequest(`No Stripe price configured for ${plan}`);

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  // Ensure a Stripe customer + local subscription stub exist.
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  let customerId = sub?.stripeCustomerId ?? undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, metadata: { userId } });
    customerId = customer.id;
    await prisma.subscription.upsert({
      where: { userId },
      create: { userId, stripeCustomerId: customerId },
      update: { stripeCustomerId: customerId },
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${env.PUBLIC_APP_URL}/settings/plan?status=success`,
    cancel_url: `${env.PUBLIC_APP_URL}/settings/plan?status=cancelled`,
    metadata: { userId, plan },
  });
  return { checkoutUrl: session.url };
}

/** Verify + handle Stripe webhooks. Requires the RAW request body. */
export async function handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) throw Errors.badRequest('Billing is not configured');

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    throw Errors.badRequest(`Invalid Stripe signature: ${(err as Error).message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan as SubscriptionPlan | undefined;
      if (userId && plan) await applyPlan(userId, plan, session.subscription as string | null, 'ACTIVE');
      break;
    }
    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      await syncFromSubscription(subscription);
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      // Downgrade to FREE on cancellation.
      const local = await prisma.subscription.findFirst({ where: { stripeSubscriptionId: subscription.id } });
      if (local) await applyPlan(local.userId, 'FREE', subscription.id, 'CANCELLED');
      break;
    }
    default:
      logger.debug({ type: event.type }, 'unhandled stripe event');
  }
}

async function syncFromSubscription(subscription: Stripe.Subscription) {
  const priceId = subscription.items.data[0]?.price.id;
  const plan = priceId ? PLAN_BY_PRICE[priceId] : undefined;
  const local =
    (await prisma.subscription.findFirst({ where: { stripeSubscriptionId: subscription.id } })) ??
    (await prisma.subscription.findFirst({ where: { stripeCustomerId: subscription.customer as string } }));
  if (!local || !plan) return;
  await applyPlan(local.userId, plan, subscription.id, subscription.status === 'active' ? 'ACTIVE' : 'PAST_DUE');
}

async function applyPlan(
  userId: string,
  plan: SubscriptionPlan,
  stripeSubscriptionId: string | null,
  status: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED',
) {
  await prisma.$transaction([
    prisma.subscription.upsert({
      where: { userId },
      create: { userId, plan, status, stripeSubscriptionId: stripeSubscriptionId ?? undefined },
      update: { plan, status, stripeSubscriptionId: stripeSubscriptionId ?? undefined },
    }),
    prisma.user.update({ where: { id: userId }, data: { plan } }),
  ]);
  logger.info({ userId, plan, status }, 'subscription plan updated from billing');
}
