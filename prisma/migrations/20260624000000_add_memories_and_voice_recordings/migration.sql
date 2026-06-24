-- Migration: add Memories, Voice Recordings, Folders, Tags (+ join table)
--
-- These tables back the Memory and Voice Recording modules, which use the same
-- presigned-S3 upload architecture as the Profile avatar. Only metadata + the
-- S3 object key (`fileKey`) is stored here; file bytes live in S3.
--
-- Apply with: psql "$DATABASE_URL" -f migration.sql
-- (Or let Prisma manage it via `prisma migrate dev` / `prisma db push` once the
--  schema is regenerated in an environment with engine access.)

-- ── Enum ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "MemoryVisibility" AS ENUM ('PRIVATE', 'SHARED', 'PUBLIC');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Folder ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Folder" (
  "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId"    UUID NOT NULL,
  "name"      VARCHAR(120) NOT NULL,
  "parentId"  UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Folder_pkey" PRIMARY KEY ("id")
);

-- ── Tag ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Tag" (
  "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId"    UUID NOT NULL,
  "name"      VARCHAR(40) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- ── Memory ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Memory" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId"       UUID NOT NULL,
  "title"        VARCHAR(500) NOT NULL,
  "story"        TEXT,
  "contentType"  TEXT NOT NULL,
  "fileKey"      TEXT NOT NULL,
  "sizeBytes"    BIGINT NOT NULL DEFAULT 0,
  "durationSec"  INTEGER,
  "width"        INTEGER,
  "height"       INTEGER,
  "thumbnailKey" TEXT,
  "folderId"     UUID,
  "visibility"   "MemoryVisibility" NOT NULL DEFAULT 'PRIVATE',
  "status"       "UploadStatus" NOT NULL DEFAULT 'READY',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  "deletedAt"    TIMESTAMP(3),
  CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- ── MemoryTag (join) ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "MemoryTag" (
  "memoryId" UUID NOT NULL,
  "tagId"    UUID NOT NULL,
  CONSTRAINT "MemoryTag_pkey" PRIMARY KEY ("memoryId", "tagId")
);

-- ── VoiceRecording ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "VoiceRecording" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId"      UUID NOT NULL,
  "title"       VARCHAR(200) NOT NULL,
  "duration"    INTEGER NOT NULL DEFAULT 0,
  "contentType" TEXT NOT NULL,
  "fileKey"     TEXT NOT NULL,
  "sizeBytes"   BIGINT NOT NULL DEFAULT 0,
  "folderId"    UUID,
  "status"      "UploadStatus" NOT NULL DEFAULT 'READY',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "deletedAt"   TIMESTAMP(3),
  CONSTRAINT "VoiceRecording_pkey" PRIMARY KEY ("id")
);

-- ── Unique constraints ───────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "Folder_userId_parentId_name_key"
  ON "Folder" ("userId", "parentId", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "Tag_userId_name_key"
  ON "Tag" ("userId", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "Memory_fileKey_key"
  ON "Memory" ("fileKey");
CREATE UNIQUE INDEX IF NOT EXISTS "VoiceRecording_fileKey_key"
  ON "VoiceRecording" ("fileKey");

-- ── Secondary indexes ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Folder_userId_idx" ON "Folder" ("userId");
CREATE INDEX IF NOT EXISTS "Tag_userId_idx" ON "Tag" ("userId");

CREATE INDEX IF NOT EXISTS "Memory_userId_createdAt_idx"
  ON "Memory" ("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "Memory_userId_visibility_idx"
  ON "Memory" ("userId", "visibility");
CREATE INDEX IF NOT EXISTS "Memory_userId_folderId_idx"
  ON "Memory" ("userId", "folderId");
CREATE INDEX IF NOT EXISTS "Memory_userId_deletedAt_idx"
  ON "Memory" ("userId", "deletedAt");

CREATE INDEX IF NOT EXISTS "MemoryTag_tagId_idx" ON "MemoryTag" ("tagId");

CREATE INDEX IF NOT EXISTS "VoiceRecording_userId_createdAt_idx"
  ON "VoiceRecording" ("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "VoiceRecording_userId_deletedAt_idx"
  ON "VoiceRecording" ("userId", "deletedAt");

-- ── Foreign keys ─────────────────────────────────────────────────────────────
ALTER TABLE "Folder"
  ADD CONSTRAINT "Folder_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Folder"
  ADD CONSTRAINT "Folder_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Folder" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Tag"
  ADD CONSTRAINT "Tag_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Memory"
  ADD CONSTRAINT "Memory_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Memory"
  ADD CONSTRAINT "Memory_folderId_fkey"
  FOREIGN KEY ("folderId") REFERENCES "Folder" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MemoryTag"
  ADD CONSTRAINT "MemoryTag_memoryId_fkey"
  FOREIGN KEY ("memoryId") REFERENCES "Memory" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemoryTag"
  ADD CONSTRAINT "MemoryTag_tagId_fkey"
  FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VoiceRecording"
  ADD CONSTRAINT "VoiceRecording_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceRecording"
  ADD CONSTRAINT "VoiceRecording_folderId_fkey"
  FOREIGN KEY ("folderId") REFERENCES "Folder" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
