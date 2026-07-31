-- DropForeignKey
ALTER TABLE "ContentShare" DROP CONSTRAINT "ContentShare_groupId_fkey";

-- DropForeignKey
ALTER TABLE "ContentShare" DROP CONSTRAINT "ContentShare_memoryId_fkey";

-- DropForeignKey
ALTER TABLE "ContentShare" DROP CONSTRAINT "ContentShare_recipientUserId_fkey";

-- DropForeignKey
ALTER TABLE "ContentShare" DROP CONSTRAINT "ContentShare_sharedById_fkey";

-- DropForeignKey
ALTER TABLE "ContentShare" DROP CONSTRAINT "ContentShare_voiceRecordingId_fkey";

-- AddForeignKey
ALTER TABLE "ContentShare" ADD CONSTRAINT "ContentShare_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "Memory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentShare" ADD CONSTRAINT "ContentShare_voiceRecordingId_fkey" FOREIGN KEY ("voiceRecordingId") REFERENCES "VoiceRecording"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentShare" ADD CONSTRAINT "ContentShare_sharedById_fkey" FOREIGN KEY ("sharedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentShare" ADD CONSTRAINT "ContentShare_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentShare" ADD CONSTRAINT "ContentShare_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
