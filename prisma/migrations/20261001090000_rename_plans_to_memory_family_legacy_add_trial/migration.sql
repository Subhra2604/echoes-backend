-- Client's final pricing: three sold tiers named Memory / Family / Legacy.
-- BASIC -> MEMORY and LEGACY_PREMIUM -> LEGACY are RENAMES, not drop+recreate,
-- so every existing User.plan / Subscription.plan value carries over untouched.
-- FAMILY keeps its name. FREE stays as the unsold floor state for accounts with
-- no active paid subscription.
ALTER TYPE "SubscriptionPlan" RENAME VALUE 'BASIC' TO 'MEMORY';
ALTER TYPE "SubscriptionPlan" RENAME VALUE 'LEGACY_PREMIUM' TO 'LEGACY';

-- 7-day free trial: Stripe reports `trialing` as a distinct subscription status
-- and we mirror it, so the app can tell "paying" from "in trial".
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'TRIALING';

-- Monthly vs yearly billing (two Stripe Prices per plan).
DO $$ BEGIN
  CREATE TYPE "BillingInterval" AS ENUM ('MONTH', 'YEAR');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "billingInterval" "BillingInterval";
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);
