-- Migration: add scheduledDate to VoiceRecording (+ notification tracking)
--
-- Adds two nullable columns to VoiceRecording:
--   scheduledDate       — user-supplied "remind me at this time"
--   scheduleNotifiedAt  — set the moment a reminder is delivered; NULL until
--                          then. The worker updates this atomically with the
--                          notification insert to guarantee fire-once semantics.
--
-- Also extends NotificationType with VOICE_RECORDING_REMINDER for the new
-- reminder event.

ALTER TABLE "VoiceRecording"
  ADD COLUMN IF NOT EXISTS "scheduledDate"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "scheduleNotifiedAt" TIMESTAMP(3);

-- Support index for admin dashboards / recovery scripts scanning for
-- overdue-but-unnotified recordings. Partial to keep it tiny — active rows
-- with a scheduled date only.
CREATE INDEX IF NOT EXISTS "VoiceRecording_scheduledDate_notifiedAt_idx"
  ON "VoiceRecording" ("scheduledDate", "scheduleNotifiedAt")
  WHERE "scheduledDate" IS NOT NULL AND "deletedAt" IS NULL;

-- Extend the notification-type enum with the new reminder event.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VOICE_RECORDING_REMINDER';
