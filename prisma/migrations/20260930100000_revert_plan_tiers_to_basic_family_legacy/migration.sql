-- ============================================================================
-- Revert the STARTER/PRO rename from the previous migration
-- (20260930090000_rename_plan_tiers_and_eulogy_generation). Business decision:
-- keep the original plan names/prices (FREE/BASIC/FAMILY/LEGACY_PREMIUM) and
-- bring LEGACY_PREMIUM back as a real, purchasable top tier, while keeping
-- all the feature-gating logic added in that same migration (capsule/
-- guardian/scheduled-message/group/eulogy limits, the EulogyGeneration
-- table) unchanged — those are keyed generically off the SubscriptionPlan
-- enum in src/config/plans.ts, not off specific plan names, so nothing
-- else needs to change.
--
-- Same pure-relabel approach as before: no data touched, no rows affected.
-- ============================================================================

ALTER TYPE "SubscriptionPlan" RENAME VALUE 'STARTER' TO 'BASIC';
ALTER TYPE "SubscriptionPlan" RENAME VALUE 'PRO' TO 'FAMILY';
