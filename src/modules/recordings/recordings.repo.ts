import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Repository for voice recordings. Same idea as memoriesRepo: keep ORM calls
 * out of the service layer.
 */
export const recordingsRepo = {
  findByIdForUser(userId: string, id: string) {
    return prisma.voiceRecording.findFirst({
      where: { id, userId, deletedAt: null },
    });
  },

  /** Lightweight listing — selects only fields the feed needs. */
  list(
    userId: string,
    q: { cursor?: string; limit: number; search?: string; folderId?: string },
  ) {
    const where: Prisma.VoiceRecordingWhereInput = {
      userId,
      deletedAt: null,
      ...(q.folderId && { folderId: q.folderId }),
      ...(q.search && { title: { contains: q.search, mode: 'insensitive' } }),
    };
    return prisma.voiceRecording.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor && { skip: 1, cursor: { id: q.cursor } }),
      select: {
        id: true,
        title: true,
        duration: true,
        contentType: true,
        folderId: true,
        createdAt: true,
      },
    });
  },

  async softDelete(userId: string, id: string): Promise<boolean> {
    const r = await prisma.voiceRecording.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return r.count === 1;
  },
};
