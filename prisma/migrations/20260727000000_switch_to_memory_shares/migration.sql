-- Migration: switch from direct GroupMedia uploads to reference-based MemoryShare
--
-- Behavior change: users no longer upload NEW bytes into a group. Instead they
-- share an existing Memory (which they already own) into one or more groups
-- and/or directly to one or more contacts. Each share is a REFERENCE row —
-- the S3 object stays under the sender's namespace.
--
-- Safe to apply because GroupMedia is empty in prod (feature was never used
-- before this migration).
--
-- Apply with: npx prisma migrate deploy
-- Manual apply: psql "$DATABASE_URL" -f migration.sql

-- ── Drop the old direct-upload table ──────────────────────────────────────
--
-- Belt-and-braces: fail loudly if somebody snuck data in — we don't want to
-- silently discard user content. If the assertion fires, investigate before
-- forcing the drop.
DO $$
DECLARE
  row_count INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'GroupMedia') THEN
    EXECUTE 'SELECT COUNT(*) FROM "GroupMedia"' INTO row_count;
    IF row_count > 0 THEN
      RAISE EXCEPTION 'GroupMedia is not empty (% rows). Refusing to drop. Migrate the data first.', row_count;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS "GroupMedia";

-- ── New enum for MemoryShare recipient discriminator ──────────────────────
DO $$ BEGIN
  CREATE TYPE "ShareRecipientType" AS ENUM ('GROUP', 'CONTACT');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ── Extend NotificationType with the new direct-share event ───────────────
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MEMORY_SHARED_WITH_YOU';

-- ── MemoryShare ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "MemoryShare" (
  "id"              UUID                 NOT NULL PRIMARY KEY,

  "memoryId"        UUID                 NOT NULL REFERENCES "Memory"("id") ON DELETE CASCADE,
  "sharedById"      UUID                 NOT NULL REFERENCES "User"("id")   ON DELETE CASCADE,

  "recipientType"   "ShareRecipientType" NOT NULL,

  -- Exactly one of these two is set. Enforced by CHECK constraint below.
  "groupId"         UUID                 REFERENCES "Group"("id") ON DELETE CASCADE,
  "recipientUserId" UUID                 REFERENCES "User"("id")  ON DELETE CASCADE,

  -- Denormalized email of the direct-share recipient. Kept for audit /
  -- display when the recipient's User row is later hard-deleted. Null for
  -- group shares.
  "recipientEmail"  TEXT,

  "caption"         VARCHAR(500),

  "sharedAt"        TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"       TIMESTAMP(3),

  -- XOR: recipientType=GROUP <=> groupId set; recipientType=CONTACT <=> recipientUserId set.
  CONSTRAINT "MemoryShare_recipient_xor_chk" CHECK (
    (
      "recipientType" = 'GROUP'
      AND "groupId" IS NOT NULL
      AND "recipientUserId" IS NULL
    )
    OR
    (
      "recipientType" = 'CONTACT'
      AND "recipientUserId" IS NOT NULL
      AND "groupId" IS NULL
    )
  )
);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS "MemoryShare_groupId_sharedAt_idx"
  ON "MemoryShare" ("groupId", "sharedAt" DESC);
CREATE INDEX IF NOT EXISTS "MemoryShare_recipientUserId_sharedAt_idx"
  ON "MemoryShare" ("recipientUserId", "sharedAt" DESC);
CREATE INDEX IF NOT EXISTS "MemoryShare_sharedById_sharedAt_idx"
  ON "MemoryShare" ("sharedById", "sharedAt" DESC);
CREATE INDEX IF NOT EXISTS "MemoryShare_memoryId_deletedAt_idx"
  ON "MemoryShare" ("memoryId", "deletedAt");

-- Partial unique indexes: prevent duplicate ACTIVE shares of the same memory
-- to the same recipient. Soft-deleted rows don't count, so re-sharing after
-- unshare works cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS "MemoryShare_one_active_group_share"
  ON "MemoryShare" ("memoryId", "groupId")
  WHERE "recipientType" = 'GROUP' AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "MemoryShare_one_active_contact_share"
  ON "MemoryShare" ("memoryId", "recipientUserId")
  WHERE "recipientType" = 'CONTACT' AND "deletedAt" IS NULL;
