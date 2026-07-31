-- RenameIndex (idempotent for fresh applies)
--
-- Originally emitted by `prisma migrate dev` on a machine where the
-- `_add_voice_recording_schedule` migration had already been applied
-- with the short index name. On a fresh database the index does not exist
-- under the old name (it will be created under the NEW name by the
-- follow-on migration), so this rename must be a no-op there.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'VoiceRecording_scheduledDate_notifiedAt_idx'
  ) THEN
    ALTER INDEX "VoiceRecording_scheduledDate_notifiedAt_idx"
      RENAME TO "VoiceRecording_scheduledDate_scheduleNotifiedAt_idx";
  END IF;
END $$;
