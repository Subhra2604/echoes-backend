-- Migration: Feature 2 (repeat sharing) + Feature 3 (scheduled delivery)
--
-- Changes:
--   1. Drop the four partial unique indexes that enforced "one active share
--      per (content, recipient)" — the product now allows the same content
--      to be re-shared to the same recipient multiple times (each share is
--      a distinct message, WhatsApp-style).
--   2. Add ContentShareStatus enum (PENDING, SHARED).
--   3. Add scheduledDate + status + deliveredAt columns to ContentShare.
--   4. Add support index for the daily 10 AM delivery cron.
--   5. Extend NotificationType with SCHEDULED_SHARE_DELIVERED.
--
-- Existing rows keep status=SHARED (the default), so nothing needs
-- retroactive re-classification.

-- ── 1. Drop idempotency indexes ─────────────────────────────────────────────
DROP INDEX IF EXISTS "ContentShare_one_active_memory_group_share";
DROP INDEX IF EXISTS "ContentShare_one_active_memory_contact_share";
DROP INDEX IF EXISTS "ContentShare_one_active_voice_group_share";
DROP INDEX IF EXISTS "ContentShare_one_active_voice_contact_share";

-- ── 2. New status enum ──────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ContentShareStatus" AS ENUM ('PENDING', 'SHARED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ── 3. New columns on ContentShare ──────────────────────────────────────────
ALTER TABLE "ContentShare"
  ADD COLUMN IF NOT EXISTS "status"        "ContentShareStatus" NOT NULL DEFAULT 'SHARED',
  ADD COLUMN IF NOT EXISTS "scheduledDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deliveredAt"   TIMESTAMP(3);

-- Backfill deliveredAt for the SHARED rows already in the table so the audit
-- trail is consistent. sharedAt is the closest existing timestamp to when the
-- notification would have fired.
UPDATE "ContentShare"
   SET "deliveredAt" = "sharedAt"
 WHERE "status" = 'SHARED' AND "deliveredAt" IS NULL;

-- ── 4. Delivery-cron support index ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "ContentShare_status_scheduledDate_idx"
  ON "ContentShare" ("status", "scheduledDate")
  WHERE "deletedAt" IS NULL;

-- ── 5. Extend NotificationType ──────────────────────────────────────────────
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SCHEDULED_SHARE_DELIVERED';
