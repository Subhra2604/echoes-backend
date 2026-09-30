-- ============================================================================
-- Rename the 4-tier plan (FREE/BASIC/FAMILY/LEGACY_PREMIUM) to the new 3-tier
-- model (FREE/STARTER/PRO). LEGACY_PREMIUM stays defined but unreferenced by
-- any user-facing surface (see schema.prisma comment) — no real subscriber
-- has ever used any paid plan (Stripe was never fully wired up: secret key
-- and webhook secret are blank), so a pure rename is safe. Verified via
--   SELECT plan, count(*) FROM "User" GROUP BY plan;
--   SELECT plan, count(*) FROM "Subscription" GROUP BY plan;
-- before writing this migration: only FREE rows exist, zero Subscription rows.
--
-- Deliberately hand-written rather than `prisma migrate dev`'s auto-diff,
-- which would have tried to DROP the BASIC/FAMILY enum values and re-add
-- STARTER/PRO (destructive, and would fail outright if any row still used
-- them) instead of a plain relabel. `RENAME VALUE` is supported since PG10
-- and is a pure metadata change — no data rewritten, no rows touched.
-- ============================================================================

ALTER TYPE "SubscriptionPlan" RENAME VALUE 'BASIC' TO 'STARTER';
ALTER TYPE "SubscriptionPlan" RENAME VALUE 'FAMILY' TO 'PRO';

-- ============================================================================
-- New table: append-only log of successful AI eulogy-generation calls, used
-- to enforce a per-plan monthly quota (src/config/plans.ts#
-- PLAN_EULOGY_GENERATION_LIMIT). Purely additive — no existing table touched.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "EulogyGeneration" (
  "id"        UUID         NOT NULL PRIMARY KEY,
  "ownerId"   UUID         NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "EulogyGeneration_ownerId_createdAt_idx"
  ON "EulogyGeneration"("ownerId", "createdAt");
