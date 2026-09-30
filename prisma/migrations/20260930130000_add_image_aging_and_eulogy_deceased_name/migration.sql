-- ============================================================================
-- AI Age-Progression Image Generator (Gemini 2.5 Flash Image) + small Eulogy
-- addition to support its PDF export title. Purely additive: one new enum,
-- one new table, two new NotificationType values, one new nullable column
-- on the existing Eulogy table. No existing data touched.
-- ============================================================================

CREATE TYPE "ImageAgingStatus" AS ENUM ('QUEUED', 'PROCESSING', 'READY', 'FAILED');

CREATE TABLE IF NOT EXISTS "ImageAgingJob" (
  "id"            UUID              NOT NULL PRIMARY KEY,
  "ownerId"       UUID              NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "sourceFileKey" TEXT              NOT NULL,
  "sourceEtag"    TEXT              NOT NULL,
  "ageOffset"     INTEGER           NOT NULL,
  "status"        "ImageAgingStatus" NOT NULL DEFAULT 'QUEUED',
  "resultFileKey" TEXT,
  "errorMessage"  TEXT,
  "createdAt"     TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"   TIMESTAMP(3)
);

CREATE UNIQUE INDEX IF NOT EXISTS "ImageAgingJob_ownerId_sourceEtag_ageOffset_key"
  ON "ImageAgingJob"("ownerId", "sourceEtag", "ageOffset");

CREATE INDEX IF NOT EXISTS "ImageAgingJob_ownerId_createdAt_idx"
  ON "ImageAgingJob"("ownerId", "createdAt");

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'IMAGE_AGING_READY';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'IMAGE_AGING_FAILED';

ALTER TABLE "Eulogy" ADD COLUMN IF NOT EXISTS "deceasedName" TEXT;
