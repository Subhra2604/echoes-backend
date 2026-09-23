-- ============================================================================
-- Fix: TimeCapsule.recipientEmail was never actually made nullable.
--
-- schema.prisma has declared `recipientEmail String?` since the multi-recipient
-- (CapsuleRecipient) path was introduced in 20260920003645_scheduled_messages_
-- guardian_capsule — capsules using contactIds intentionally leave
-- TimeCapsule.recipientEmail null and store recipients in CapsuleRecipient
-- instead. But no migration ever dropped the original NOT NULL constraint from
-- 20260101000000_baseline_init, so every INSERT that omits recipientEmail
-- (i.e. every contactIds-based capsule) fails at the database with:
--   error 23502: null value in column "recipientEmail" of relation
--   "TimeCapsule" violates not-null constraint
-- which surfaces to API clients as a bare 500 with no detail.
--
-- DROP COLUMN ... DROP NOT NULL is a no-op if already nullable, so this is
-- safe to run more than once / re-run in any environment.
-- ============================================================================

ALTER TABLE "TimeCapsule" ALTER COLUMN "recipientEmail" DROP NOT NULL;
