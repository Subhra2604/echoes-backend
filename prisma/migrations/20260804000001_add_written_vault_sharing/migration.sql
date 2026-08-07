-- Migration: Written Vault publish lifecycle + sharing integration
-- (Client PRD: Written Vault Enhancements + PDF Download)
--
-- Changes:
--   1. Extend SharedContentType enum with WRITTEN_VAULT.
--   2. New WrittenVaultStatus enum (DRAFT, PENDING, SHARED).
--   3. Add writtenStatus column to VaultItem (nullable; only WRITTEN items
--      populate it).
--   4. Add writtenVaultItemId + FK to ContentShare.
--   5. Replace the content-XOR CHECK constraint with a three-way version
--      (MEMORY / VOICE_RECORDING / WRITTEN_VAULT).
--   6. Add supporting indexes.
--
-- Safe to apply against production data: all changes are additive except the
-- CHECK constraint swap, and the swap widens (not narrows) allowed rows —
-- every existing row still satisfies the new constraint.


-- ── 2. New WrittenVaultStatus enum ──────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "WrittenVaultStatus" AS ENUM ('DRAFT', 'PENDING', 'SHARED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ── 3. Add writtenStatus column to VaultItem ────────────────────────────────
ALTER TABLE "VaultItem"
  ADD COLUMN IF NOT EXISTS "writtenStatus" "WrittenVaultStatus";

CREATE INDEX IF NOT EXISTS "VaultItem_writtenStatus_idx"
  ON "VaultItem" ("writtenStatus")
  WHERE "writtenStatus" IS NOT NULL;

-- ── 4. Add writtenVaultItemId + FK to ContentShare ──────────────────────────
ALTER TABLE "ContentShare"
  ADD COLUMN IF NOT EXISTS "writtenVaultItemId" UUID;

DO $$ BEGIN
  ALTER TABLE "ContentShare"
    ADD CONSTRAINT "ContentShare_writtenVaultItemId_fkey"
      FOREIGN KEY ("writtenVaultItemId") REFERENCES "VaultItem"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "ContentShare_writtenVaultItemId_deletedAt_idx"
  ON "ContentShare" ("writtenVaultItemId", "deletedAt");

-- ── 5. Replace content XOR CHECK constraint with a three-way version ────────
--
-- The old constraint enforced "exactly one of memoryId / voiceRecordingId".
-- We drop it and re-add including writtenVaultItemId as a third arm. All
-- existing rows fall into either the MEMORY or VOICE_RECORDING arm and
-- satisfy the new constraint, so no data migration is needed.
ALTER TABLE "ContentShare"
  DROP CONSTRAINT IF EXISTS "ContentShare_content_xor_chk";

ALTER TABLE "ContentShare"
  ADD CONSTRAINT "ContentShare_content_xor_chk" CHECK (
    (
      "contentType" = 'MEMORY'
      AND "memoryId" IS NOT NULL
      AND "voiceRecordingId" IS NULL
      AND "writtenVaultItemId" IS NULL
    )
    OR
    (
      "contentType" = 'VOICE_RECORDING'
      AND "voiceRecordingId" IS NOT NULL
      AND "memoryId" IS NULL
      AND "writtenVaultItemId" IS NULL
    )
    OR
    (
      "contentType" = 'WRITTEN_VAULT'
      AND "writtenVaultItemId" IS NOT NULL
      AND "memoryId" IS NULL
      AND "voiceRecordingId" IS NULL
    )
  );
