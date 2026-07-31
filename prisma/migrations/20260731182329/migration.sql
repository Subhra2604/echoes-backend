-- DropForeignKey
ALTER TABLE "MemoryShare" DROP CONSTRAINT "MemoryShare_groupId_fkey";

-- DropForeignKey
ALTER TABLE "MemoryShare" DROP CONSTRAINT "MemoryShare_memoryId_fkey";

-- DropForeignKey
ALTER TABLE "MemoryShare" DROP CONSTRAINT "MemoryShare_recipientUserId_fkey";

-- DropForeignKey
ALTER TABLE "MemoryShare" DROP CONSTRAINT "MemoryShare_sharedById_fkey";

-- AddForeignKey
ALTER TABLE "MemoryShare" ADD CONSTRAINT "MemoryShare_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "Memory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryShare" ADD CONSTRAINT "MemoryShare_sharedById_fkey" FOREIGN KEY ("sharedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryShare" ADD CONSTRAINT "MemoryShare_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryShare" ADD CONSTRAINT "MemoryShare_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
