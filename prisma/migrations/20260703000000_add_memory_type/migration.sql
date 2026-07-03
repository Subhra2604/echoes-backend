-- Migration: add memoryType (MEDIA/NOTE) to Memory, make file fields optional
--
-- Existing rows backfill as MEDIA via the column default — no data migration
-- script needed. contentType/fileKey become nullable to support NOTE rows,
-- and a CHECK constraint keeps MEDIA rows honest (still file-backed) and NOTE
-- rows honest (never carry a fileKey).
--
-- Apply with: psql "$DATABASE_URL" -f migration.sql

DO $$ BEGIN
  CREATE TYPE "MemoryType" AS ENUM ('MEDIA', 'NOTE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Memory"
  ADD COLUMN IF NOT EXISTS "memoryType" "MemoryType" NOT NULL DEFAULT 'MEDIA';

ALTER TABLE "Memory"
  ALTER COLUMN "contentType" DROP NOT NULL;

ALTER TABLE "Memory"
  ALTER COLUMN "fileKey" DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE "Memory" ADD CONSTRAINT "memory_type_shape_chk" CHECK (
    ("memoryType" = 'MEDIA' AND "fileKey" IS NOT NULL AND "contentType" IS NOT NULL)
    OR
    ("memoryType" = 'NOTE' AND "fileKey" IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "Memory_userId_memoryType_idx" ON "Memory" ("userId", "memoryType");