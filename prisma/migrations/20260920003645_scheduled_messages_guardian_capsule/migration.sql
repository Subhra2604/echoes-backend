-- Migration: Scheduled Messages, Contact-based Guardian, Time Capsule extensions
--
-- Backfills the SQL for the schema changes that were made to schema.prisma but
-- never generated (the migration folder existed empty). Also extends
-- NotificationType with the new event kinds emitted by these features.
--
-- Adds:
--   - Enum   ScheduledMessageStatus, ScheduledMessageRecipientStatus
--   - Enum   values on NotificationType: GUARDIAN_ASSIGNED / GUARDIAN_REMOVED /
--             CAPSULE_ASSIGNED / CAPSULE_SCHEDULE_CHANGED /
--             SCHEDULED_MESSAGE_CREATED / SCHEDULED_MESSAGE_SENT /
--             SCHEDULED_MESSAGE_FAILED
--   - Table  Guardian             (contact-based resource guardians)
--   - Table  CapsuleRecipient     (multi-recipient capsule delivery)
--   - Table  ScheduledMessage
--   - Table  ScheduledMessageRecipient
--   - Column TimeCapsule.guardianId  (FK to Guardian) + supporting index
--   - Column CapsuleDelivery.capsuleRecipientId  + supporting unique
--
-- Guardrails:
--   - Every DDL uses IF NOT EXISTS / DO $$ EXCEPTION WHEN duplicate_object
--     so re-running the migration on a partially-applied DB is safe.

-- ── 1. Enums ────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "ScheduledMessageStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ScheduledMessageRecipientStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Extend NotificationType. ADD VALUE IF NOT EXISTS is safe on PostgreSQL 9.6+.
-- These must be committed before any table below inserts them, so they run
-- first in the migration (Prisma wraps the file in one implicit transaction;
-- ALTER TYPE ADD VALUE now works in a transaction on PG 12+, which this
-- project already depends on — see PostgreSQL 17 in prisma/schema.prisma).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GUARDIAN_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GUARDIAN_REMOVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CAPSULE_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CAPSULE_SCHEDULE_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SCHEDULED_MESSAGE_CREATED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SCHEDULED_MESSAGE_SENT';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SCHEDULED_MESSAGE_FAILED';

-- ── 2. Guardian (contact-based) ────────────────────────────────────────────
--
-- One row per (owner, contact) resource-guardian assignment. Deliberately
-- separate from GuardianInvitation, which drives the death-certificate
-- memorial-activation flow. Guardian is an instant assignment made from an
-- already-VERIFIED contact.

CREATE TABLE IF NOT EXISTS "Guardian" (
  "id"        UUID         NOT NULL PRIMARY KEY,
  "ownerId"   UUID         NOT NULL REFERENCES "User"("id")    ON DELETE CASCADE,
  "contactId" UUID         NOT NULL REFERENCES "Contact"("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "Guardian_ownerId_contactId_key"
  ON "Guardian"("ownerId", "contactId");
CREATE INDEX IF NOT EXISTS "Guardian_ownerId_idx" ON "Guardian"("ownerId");
CREATE INDEX IF NOT EXISTS "Guardian_contactId_idx" ON "Guardian"("contactId");

-- ── 3. TimeCapsule.guardianId ──────────────────────────────────────────────
--
-- A capsule can point at one Guardian who then has schedule-only edit rights.
-- SET NULL on delete because Guardian deletion is blocked while any capsule
-- still points here (enforced in the service layer); the SET NULL is a safety
-- valve for an admin/DB-level manual removal.

ALTER TABLE "TimeCapsule"
  ADD COLUMN IF NOT EXISTS "guardianId" UUID;

DO $$ BEGIN
  ALTER TABLE "TimeCapsule"
    ADD CONSTRAINT "TimeCapsule_guardianId_fkey"
      FOREIGN KEY ("guardianId") REFERENCES "Guardian"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "TimeCapsule_guardianId_idx"
  ON "TimeCapsule"("guardianId");

-- ── 4. CapsuleRecipient (multi-recipient) ──────────────────────────────────
--
-- One row per (capsule, contact). `email` is a NOT-NULL snapshot at add time,
-- mirroring GroupParticipant.email — a delivery audit trail that survives
-- later edits to the underlying Contact.

CREATE TABLE IF NOT EXISTS "CapsuleRecipient" (
  "id"        UUID         NOT NULL PRIMARY KEY,
  "capsuleId" UUID         NOT NULL REFERENCES "TimeCapsule"("id") ON DELETE CASCADE,
  "contactId" UUID         NOT NULL REFERENCES "Contact"("id")     ON DELETE CASCADE,
  "email"     TEXT         NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "CapsuleRecipient_capsuleId_contactId_key"
  ON "CapsuleRecipient"("capsuleId", "contactId");
CREATE INDEX IF NOT EXISTS "CapsuleRecipient_capsuleId_idx"
  ON "CapsuleRecipient"("capsuleId");
CREATE INDEX IF NOT EXISTS "CapsuleRecipient_contactId_idx"
  ON "CapsuleRecipient"("contactId");

-- ── 5. CapsuleDelivery.capsuleRecipientId ──────────────────────────────────
--
-- Deliveries in the new multi-recipient path carry a non-null FK. The legacy
-- single-recipient path (recipientEmail on TimeCapsule) leaves it null and
-- continues to use its own idempotency guard in the service.

ALTER TABLE "CapsuleDelivery"
  ADD COLUMN IF NOT EXISTS "capsuleRecipientId" UUID;

DO $$ BEGIN
  ALTER TABLE "CapsuleDelivery"
    ADD CONSTRAINT "CapsuleDelivery_capsuleRecipientId_fkey"
      FOREIGN KEY ("capsuleRecipientId") REFERENCES "CapsuleRecipient"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Idempotency for (capsule, recipient, year). PostgreSQL treats each NULL
-- capsuleRecipientId as distinct, so legacy single-recipient rows are not
-- deduplicated here (they keep their existing app-level guard).
CREATE UNIQUE INDEX IF NOT EXISTS "CapsuleDelivery_capsuleId_capsuleRecipientId_occurrenceYear_key"
  ON "CapsuleDelivery"("capsuleId", "capsuleRecipientId", "occurrenceYear");

-- ── 6. ScheduledMessage ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ScheduledMessage" (
  "id"           UUID                     NOT NULL PRIMARY KEY,
  "ownerId"      UUID                     NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "occasion"     TEXT                     NOT NULL,
  "message"      TEXT                     NOT NULL,
  "scheduleDate" TIMESTAMP(3)             NOT NULL,
  "timezone"     TEXT                     NOT NULL,
  "status"       "ScheduledMessageStatus" NOT NULL DEFAULT 'PENDING',
  "sentAt"       TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)             NOT NULL
);

CREATE INDEX IF NOT EXISTS "ScheduledMessage_ownerId_status_idx"
  ON "ScheduledMessage"("ownerId", "status");
CREATE INDEX IF NOT EXISTS "ScheduledMessage_status_scheduleDate_idx"
  ON "ScheduledMessage"("status", "scheduleDate");

-- ── 7. ScheduledMessageRecipient ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ScheduledMessageRecipient" (
  "id"                 UUID                              NOT NULL PRIMARY KEY,
  "scheduledMessageId" UUID                              NOT NULL REFERENCES "ScheduledMessage"("id") ON DELETE CASCADE,
  "contactId"          UUID                              NOT NULL REFERENCES "Contact"("id")          ON DELETE CASCADE,
  "email"              TEXT                              NOT NULL,
  "recipientUserId"    UUID,
  "status"             "ScheduledMessageRecipientStatus" NOT NULL DEFAULT 'QUEUED',
  "deliveredAt"        TIMESTAMP(3)
);

CREATE UNIQUE INDEX IF NOT EXISTS "ScheduledMessageRecipient_scheduledMessageId_contactId_key"
  ON "ScheduledMessageRecipient"("scheduledMessageId", "contactId");
CREATE INDEX IF NOT EXISTS "ScheduledMessageRecipient_scheduledMessageId_idx"
  ON "ScheduledMessageRecipient"("scheduledMessageId");
CREATE INDEX IF NOT EXISTS "ScheduledMessageRecipient_contactId_idx"
  ON "ScheduledMessageRecipient"("contactId");
