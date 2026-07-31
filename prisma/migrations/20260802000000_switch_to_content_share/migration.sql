-- Migration: switch from MemoryShare to ContentShare (unified table for
--            sharing both Memory and VoiceRecording).
--
-- Rationale: MemoryShare was memory-only. VoiceRecording sharing was omitted,
-- which meant users could not share their voice recordings — a gap in the
-- PRD. Rather than adding a parallel VoiceRecordingShare table, we replace
-- MemoryShare with a unified ContentShare that discriminates on a small enum.
-- This gives us a single share endpoint, a single feed source, and a single
-- deletion path.
--
-- Safe because MemoryShare is empty in production (the sharing endpoints were
-- never smoke-tested against real users). We still guard with a preflight
-- check that RAISES if any rows are present.

-- ── Preflight: refuse to drop if MemoryShare has data ───────────────────────
DO $$
DECLARE
  row_count INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'MemoryShare') THEN
    EXECUTE 'SELECT COUNT(*) FROM "MemoryShare"' INTO row_count;
    IF row_count > 0 THEN
      RAISE EXCEPTION 'MemoryShare is not empty (% rows). Migrate the data into ContentShare first.', row_count;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS "MemoryShare";

-- ── Enums ───────────────────────────────────────────────────────────────────
--
-- ShareRecipientType already exists (created for MemoryShare); no change.
-- SharedContentType is new.
DO $$ BEGIN
  CREATE TYPE "SharedContentType" AS ENUM ('MEMORY', 'VOICE_RECORDING');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ── ContentShare ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ContentShare" (
  "id"               UUID                 NOT NULL PRIMARY KEY,

  "contentType"      "SharedContentType"  NOT NULL,

  -- Exactly one of these two is set, matched to contentType. Enforced by
  -- CHECK constraint below.
  "memoryId"         UUID                 REFERENCES "Memory"("id")         ON DELETE CASCADE,
  "voiceRecordingId" UUID                 REFERENCES "VoiceRecording"("id") ON DELETE CASCADE,

  "sharedById"       UUID                 NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,

  "recipientType"    "ShareRecipientType" NOT NULL,

  -- Exactly one of these two is set, matched to recipientType.
  "groupId"          UUID                 REFERENCES "Group"("id") ON DELETE CASCADE,
  "recipientUserId"  UUID                 REFERENCES "User"("id")  ON DELETE CASCADE,

  "recipientEmail"   TEXT,

  "caption"          VARCHAR(500),

  "sharedAt"         TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"        TIMESTAMP(3),

  -- Content XOR: contentType matches which FK is set.
  CONSTRAINT "ContentShare_content_xor_chk" CHECK (
    (
      "contentType" = 'MEMORY'
      AND "memoryId" IS NOT NULL
      AND "voiceRecordingId" IS NULL
    )
    OR
    (
      "contentType" = 'VOICE_RECORDING'
      AND "voiceRecordingId" IS NOT NULL
      AND "memoryId" IS NULL
    )
  ),

  -- Recipient XOR: recipientType matches which FK is set.
  CONSTRAINT "ContentShare_recipient_xor_chk" CHECK (
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

-- Lookup indexes.
CREATE INDEX IF NOT EXISTS "ContentShare_groupId_sharedAt_idx"
  ON "ContentShare" ("groupId", "sharedAt" DESC);
CREATE INDEX IF NOT EXISTS "ContentShare_recipientUserId_sharedAt_idx"
  ON "ContentShare" ("recipientUserId", "sharedAt" DESC);
CREATE INDEX IF NOT EXISTS "ContentShare_sharedById_sharedAt_idx"
  ON "ContentShare" ("sharedById", "sharedAt" DESC);
CREATE INDEX IF NOT EXISTS "ContentShare_memoryId_deletedAt_idx"
  ON "ContentShare" ("memoryId", "deletedAt");
CREATE INDEX IF NOT EXISTS "ContentShare_voiceRecordingId_deletedAt_idx"
  ON "ContentShare" ("voiceRecordingId", "deletedAt");

-- Idempotency: prevent duplicate ACTIVE shares of the same content to the
-- same recipient. Four partial unique indexes cover the two content types
-- × two recipient kinds. Soft-deleted rows are excluded, so re-sharing after
-- unshare works cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS "ContentShare_one_active_memory_group_share"
  ON "ContentShare" ("memoryId", "groupId")
  WHERE "contentType" = 'MEMORY' AND "recipientType" = 'GROUP' AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ContentShare_one_active_memory_contact_share"
  ON "ContentShare" ("memoryId", "recipientUserId")
  WHERE "contentType" = 'MEMORY' AND "recipientType" = 'CONTACT' AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ContentShare_one_active_voice_group_share"
  ON "ContentShare" ("voiceRecordingId", "groupId")
  WHERE "contentType" = 'VOICE_RECORDING' AND "recipientType" = 'GROUP' AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ContentShare_one_active_voice_contact_share"
  ON "ContentShare" ("voiceRecordingId", "recipientUserId")
  WHERE "contentType" = 'VOICE_RECORDING' AND "recipientType" = 'CONTACT' AND "deletedAt" IS NULL;
