-- When a subscription has been set to cancel (e.g. the customer pressed
-- "Cancel plan" in Stripe's portal, which by default cancels at the end of the
-- paid period), Stripe keeps it `active` until that date. NULL = not cancelling.
-- Purely additive and nullable: existing rows stay NULL until Stripe's next
-- subscription update for them.
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "cancelAt" TIMESTAMP(3);
