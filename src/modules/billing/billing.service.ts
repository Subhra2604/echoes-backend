import Stripe from 'stripe';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { notify } from '../notifications/notifications.service.js';
import { planPriceId, PAID_PLANS, BILLING_INTERVALS, TRIAL_PERIOD_DAYS } from '../../config/plans.js';
import type { SubscriptionPlan, BillingInterval, SubscriptionStatus } from '../../generated/prisma/enums.js';

/**
 * Billing. The three sold plans (MEMORY/FAMILY/LEGACY) each map to two Stripe
 * Prices — monthly and yearly — configured in the dashboard, and every checkout
 * starts with a TRIAL_PERIOD_DAYS free trial.
 *
 * Stripe is the source of truth: the local Subscription row and User.plan are
 * only ever written from a verified webhook, never optimistically at checkout
 * time. A trialing subscription grants full plan access (that's the point of the
 * trial) — the quota gates read User.plan and don't care about trial status.
 * Cancellation, including a trial that never converts, downgrades to FREE.
 *
 * (Storage/credit add-on packs are deferred to a later phase.)
 */

export const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;

/** Reverse lookup: Stripe Price ID -> the plan and cadence it represents. */
const PLAN_BY_PRICE: Record<string, { plan: SubscriptionPlan; interval: BillingInterval }> = {};
for (const plan of PAID_PLANS) {
  for (const interval of BILLING_INTERVALS) {
    const price = planPriceId(plan, interval);
    if (price) PLAN_BY_PRICE[price] = { plan, interval };
  }
}

export async function createCheckoutSession(
  userId: string,
  plan: SubscriptionPlan,
  interval: BillingInterval,
) {
  if (!stripe) throw Errors.badRequest('Billing is not configured');
  const priceId = planPriceId(plan, interval);
  if (!priceId) {
    throw Errors.badRequest(`No Stripe price configured for ${plan} billed per ${interval}`);
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const sub = await prisma.subscription.findUnique({ where: { userId } });
  // Checkout is for starting a NEW subscription. A customer who already has
  // one must go through the billing portal instead — Stripe Checkout has no
  // concept of "replace my existing subscription", so calling it again here
  // would create a second, separately-billed subscription alongside the first.
  //
  // "Already subscribed" means a REAL Stripe subscription exists
  // (stripeSubscriptionId is set), not merely that a local row says ACTIVE.
  // The row also exists as a stub created when checkout merely STARTED, and
  // stubs written before the INCOMPLETE fix carry a bogus ACTIVE — trusting
  // status alone locked such users out of ever subscribing. PAST_DUE counts
  // too: a card-failed subscriber still owns a live subscription, and
  // letting them check out again would double-bill them.
  const hasLiveSubscription =
    !!sub?.stripeSubscriptionId &&
    (sub.status === 'ACTIVE' || sub.status === 'TRIALING' || sub.status === 'PAST_DUE');
  if (hasLiveSubscription) {
    throw Errors.badRequest(
      'You already have an active subscription. Use the billing portal to change your plan.',
    );
  }

  // Ensure a Stripe customer + local subscription stub exist. Stub starts
  // INCOMPLETE, not the schema's default ACTIVE — nothing has been confirmed
  // yet at this point (checkout was only just started), and the webhook
  // overwrites this with the real status once Stripe reports one. Only set
  // on `create`: if a row already exists here, leave its real status alone.
  let customerId = sub?.stripeCustomerId ?? undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, metadata: { userId } });
    customerId = customer.id;
    await prisma.subscription.upsert({
      where: { userId },
      create: { userId, stripeCustomerId: customerId, status: 'INCOMPLETE' },
      update: { stripeCustomerId: customerId },
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    // 7-day free trial on every plan. Stripe collects the payment method up
    // front and charges automatically when the trial ends unless cancelled.
    subscription_data: { trial_period_days: TRIAL_PERIOD_DAYS },
    // Mobile-only product: there is no web app to land on, so Stripe returns
    // the user to this backend's own bridge page, which either bounces them
    // into the app via deep link (once one exists) or tells them to switch
    // back manually. Deliberately NOT PUBLIC_APP_URL — that one is for
    // emailed invitation links and must stay an https web URL.
    success_url: `${env.PUBLIC_API_URL}/api/billing/return?status=success`,
    cancel_url: `${env.PUBLIC_API_URL}/api/billing/return?status=cancelled`,
    metadata: { userId, plan, interval },
  });
  return { checkoutUrl: session.url, trialDays: TRIAL_PERIOD_DAYS };
}

/**
 * Self-service plan management for an existing subscriber: change plan,
 * switch monthly/yearly, update the payment method, or cancel. Checkout only
 * ever starts a first subscription (see the guard above) — everything after
 * that goes through this Stripe-hosted portal instead of custom UI/endpoints.
 */
export async function createBillingPortalSession(userId: string) {
  if (!stripe) throw Errors.badRequest('Billing is not configured');
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub?.stripeCustomerId) {
    throw Errors.badRequest('No billing account found — subscribe to a plan first');
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${env.PUBLIC_API_URL}/api/billing/return?status=portal`,
  });
  return { portalUrl: session.url };
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
      if (!userId) break;
      // Re-read the subscription rather than trusting the session alone: only
      // the subscription carries the real status (`trialing` vs `active`),
      // trial_end and period end.
      const subscriptionId = session.subscription as string | null;
      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await applyStripeSubscription(userId, subscription);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      await syncFromSubscription(event.data.object as Stripe.Subscription);
      break;
    }
    case 'invoice.payment_failed': {
      // A failed renewal charge. The subscription itself transitions to
      // past_due separately (customer.subscription.updated handles that) —
      // this case exists purely to tell the user, since Stripe's own dunning
      // emails are the only other signal they'd otherwise get.
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (!customerId) break;
      const local = await prisma.subscription.findFirst({ where: { stripeCustomerId: customerId } });
      if (local) {
        // Stripe redelivers an event if our endpoint doesn't ack fast enough
        // or a request drops — same event.id both times. Without this check,
        // a redelivery (not a new retry failure, the SAME failure reported
        // twice) would double the notification. Keyed on event.id, not
        // invoice.id, so genuinely distinct retry failures on the same
        // invoice over the following days still each notify the user.
        const alreadyNotified = await prisma.notification.findFirst({
          where: { userId: local.userId, type: 'PAYMENT_FAILED', data: { path: ['stripeEventId'], equals: event.id } },
        });
        if (!alreadyNotified) {
          await notify(
            local.userId,
            'PAYMENT_FAILED',
            'Payment failed',
            'We couldn’t process your subscription payment. Please update your payment method to keep your plan active.',
            { stripeSubscriptionId: local.stripeSubscriptionId ?? undefined, stripeEventId: event.id },
          ).catch((err) => logger.warn({ err }, 'PAYMENT_FAILED notify failed'));
        }
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      // Downgrade to FREE on cancellation — including a trial that never
      // converted to a paid subscription.
      const local = await prisma.subscription.findFirst({
        where: { stripeSubscriptionId: subscription.id },
      });
      if (local) {
        await persistPlan({
          userId: local.userId,
          plan: 'FREE',
          status: 'CANCELLED',
          stripeSubscriptionId: subscription.id,
          billingInterval: null,
          trialEndsAt: null,
          currentPeriodEnd: null,
        });
      }
      break;
    }
    default:
      logger.debug({ type: event.type }, 'unhandled stripe event');
  }
}

async function syncFromSubscription(subscription: Stripe.Subscription) {
  const local =
    (await prisma.subscription.findFirst({ where: { stripeSubscriptionId: subscription.id } })) ??
    (await prisma.subscription.findFirst({
      where: { stripeCustomerId: subscription.customer as string },
    }));
  if (!local) return;
  await applyStripeSubscription(local.userId, subscription);
}

/**
 * Write a Stripe subscription's current state onto the local user. The plan and
 * cadence are derived from the Price actually on the subscription, so a plan
 * change or monthly->yearly switch made in Stripe (or via the customer portal)
 * lands here without any extra handling.
 */
async function applyStripeSubscription(userId: string, subscription: Stripe.Subscription) {
  const priceId = subscription.items.data[0]?.price.id;
  const matched = priceId ? PLAN_BY_PRICE[priceId] : undefined;
  if (!matched) {
    logger.warn(
      { userId, priceId, subscriptionId: subscription.id },
      'stripe subscription price does not map to a known plan; ignoring',
    );
    return;
  }

  const status = mapStripeStatus(subscription.status);
  // A cancelled/expired subscription must not leave paid access in place.
  const plan: SubscriptionPlan = status === 'CANCELLED' ? 'FREE' : matched.plan;

  await persistPlan({
    userId,
    plan,
    status,
    stripeSubscriptionId: subscription.id,
    billingInterval: plan === 'FREE' ? null : matched.interval,
    trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
    currentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null,
  });
}

function mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case 'active':
      return 'ACTIVE';
    case 'trialing':
      return 'TRIALING';
    case 'past_due':
    case 'unpaid':
      return 'PAST_DUE';
    case 'canceled':
    case 'incomplete_expired':
      return 'CANCELLED';
    default:
      // 'incomplete' (awaiting first payment) and 'paused'.
      return 'INCOMPLETE';
  }
}

async function persistPlan(input: {
  userId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  stripeSubscriptionId: string | null;
  billingInterval: BillingInterval | null;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}) {
  const fields = {
    plan: input.plan,
    status: input.status,
    stripeSubscriptionId: input.stripeSubscriptionId ?? undefined,
    billingInterval: input.billingInterval,
    trialEndsAt: input.trialEndsAt,
    currentPeriodEnd: input.currentPeriodEnd,
  };
  await prisma.$transaction([
    prisma.subscription.upsert({
      where: { userId: input.userId },
      create: { userId: input.userId, ...fields },
      update: fields,
    }),
    prisma.user.update({ where: { id: input.userId }, data: { plan: input.plan } }),
  ]);
  logger.info(
    { userId: input.userId, plan: input.plan, status: input.status, interval: input.billingInterval },
    'subscription plan updated from billing',
  );
}
