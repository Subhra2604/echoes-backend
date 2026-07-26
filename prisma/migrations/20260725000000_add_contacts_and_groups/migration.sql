-- Migration: Contacts & Groups module
--
-- Adds the address-book (Contact) + WhatsApp-style group chat (Group,
-- GroupParticipant, GroupMedia) tables, plus five new NotificationType values
-- for events they emit.
--
-- Apply with: psql "$DATABASE_URL" -f migration.sql
--
-- Guardrails:
--   - All enum creates are idempotent (DO $$ IF NOT EXISTS $$ style).
--   - All tables are CREATE TABLE IF NOT EXISTS so re-runs are safe.
--   - Contact.email + GroupParticipant.email + GroupMedia.uploaderEmail are
--     NOT NULL (PRD: "email mandatory for contact list and for group also").

-- ── Enums ──────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "ContactStatus" AS ENUM ('VERIFIED', 'PENDING_INVITATION', 'BLOCKED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "GroupRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "GroupParticipantStatus" AS ENUM ('ACTIVE', 'REMOVED', 'LEFT');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Extend NotificationType enum with five new event kinds. ADD VALUE is
-- idempotent-safe via IF NOT EXISTS (PostgreSQL 9.6+).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CONTACT_JOINED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GROUP_ADDED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GROUP_REMOVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GROUP_ROLE_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GROUP_MEDIA_UPLOADED';

-- ── Contact ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Contact" (
  "id"               UUID          NOT NULL PRIMARY KEY,
  "ownerId"          UUID          NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "email"            TEXT          NOT NULL,
  "contactUserId"    UUID          REFERENCES "User"("id") ON DELETE SET NULL,
  "name"             TEXT          NOT NULL,
  "status"           "ContactStatus" NOT NULL DEFAULT 'PENDING_INVITATION',
  "invitationSentAt" TIMESTAMP(3),
  "joinedAt"         TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3)  NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "Contact_ownerId_email_key"
  ON "Contact"("ownerId", "email");
CREATE INDEX IF NOT EXISTS "Contact_ownerId_status_idx"
  ON "Contact"("ownerId", "status");
CREATE INDEX IF NOT EXISTS "Contact_contactUserId_idx"
  ON "Contact"("contactUserId");
CREATE INDEX IF NOT EXISTS "Contact_email_idx"
  ON "Contact"("email");

-- ── Group ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Group" (
  "id"          UUID         NOT NULL PRIMARY KEY,
  "name"        VARCHAR(120) NOT NULL,
  "description" VARCHAR(500),
  "avatarKey"   TEXT,
  "createdById" UUID         NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "deletedAt"   TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "Group_createdById_idx" ON "Group"("createdById");
CREATE INDEX IF NOT EXISTS "Group_deletedAt_idx"   ON "Group"("deletedAt");

-- ── GroupParticipant ───────────────────────────────────────────────────────
--
-- One row per (groupId, userId). `email` is a NOT-NULL snapshot of the User's
-- email at add time — the "email mandatory for group also" audit trail.

CREATE TABLE IF NOT EXISTS "GroupParticipant" (
  "id"        UUID                     NOT NULL PRIMARY KEY,
  "groupId"   UUID                     NOT NULL REFERENCES "Group"("id") ON DELETE CASCADE,
  "userId"    UUID                     NOT NULL REFERENCES "User"("id")  ON DELETE CASCADE,
  "email"     TEXT                     NOT NULL,
  "role"      "GroupRole"              NOT NULL DEFAULT 'MEMBER',
  "status"    "GroupParticipantStatus" NOT NULL DEFAULT 'ACTIVE',
  "addedById" UUID                     REFERENCES "User"("id") ON DELETE SET NULL,
  "joinedAt"  TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3)             NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "GroupParticipant_groupId_userId_key"
  ON "GroupParticipant"("groupId", "userId");
CREATE INDEX IF NOT EXISTS "GroupParticipant_groupId_status_idx"
  ON "GroupParticipant"("groupId", "status");
CREATE INDEX IF NOT EXISTS "GroupParticipant_userId_status_idx"
  ON "GroupParticipant"("userId", "status");

-- Enforce "exactly one OWNER per group" at the DB level (belt & braces on top
-- of the application-level guard). Partial unique index only counts ACTIVE
-- OWNER rows so LEFT/REMOVED owners don't block a re-appointment.
CREATE UNIQUE INDEX IF NOT EXISTS "GroupParticipant_one_active_owner_per_group"
  ON "GroupParticipant"("groupId")
  WHERE "role" = 'OWNER' AND "status" = 'ACTIVE';

-- ── GroupMedia ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "GroupMedia" (
  "id"            UUID         NOT NULL PRIMARY KEY,
  "groupId"       UUID         NOT NULL REFERENCES "Group"("id") ON DELETE CASCADE,
  "uploadedById"  UUID         NOT NULL REFERENCES "User"("id")  ON DELETE CASCADE,
  "uploaderEmail" TEXT         NOT NULL,
  "fileName"      VARCHAR(255) NOT NULL,
  "contentType"   TEXT         NOT NULL,
  "fileKey"       TEXT         NOT NULL,
  "sizeBytes"     BIGINT       NOT NULL DEFAULT 0,
  "caption"       VARCHAR(500),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"     TIMESTAMP(3)
);

CREATE UNIQUE INDEX IF NOT EXISTS "GroupMedia_fileKey_key"
  ON "GroupMedia"("fileKey");
CREATE INDEX IF NOT EXISTS "GroupMedia_groupId_createdAt_idx"
  ON "GroupMedia"("groupId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "GroupMedia_uploadedById_idx"
  ON "GroupMedia"("uploadedById");
CREATE INDEX IF NOT EXISTS "GroupMedia_groupId_deletedAt_idx"
  ON "GroupMedia"("groupId", "deletedAt");
