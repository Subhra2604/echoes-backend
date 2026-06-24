import { prisma } from '../../lib/prisma.js';

/**
 * Combined "My Memories" feed.
 *
 * Merges Memories and Voice Recordings into a single, time-sorted, lightweight
 * list for the Vault → My Memories screen. No large file URLs are returned here
 * (the client fetches a signed URL from the detail endpoint when a row is
 * opened). Both sources are owner-scoped and exclude soft-deleted rows.
 */

export interface FeedItem {
  id: string;
  type: 'memory' | 'voice';
  title: string;
  timezone: string;
  contentType: string;
  visibility: 'PRIVATE' | 'SHARED' | 'PUBLIC' | null;
  duration: number | null;
  createdAt: Date;
}

export async function listMyMemories(
  userId: string,
  opts: { limit: number; before?: Date },
): Promise<{ items: FeedItem[]; nextCursor: string | null }> {
  const tz = (
    await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true },
    })
  ).timezone;

  const beforeFilter = opts.before ? { createdAt: { lt: opts.before } } : {};

  // Over-fetch from each source by `limit`, merge, then truncate. We pull limit+1
  // from the merged set to know whether a further page exists.
  const [memories, recordings] = await Promise.all([
    prisma.memory.findMany({
      where: { userId, deletedAt: null, ...beforeFilter },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
      select: {
        id: true,
        title: true,
        contentType: true,
        visibility: true,
        createdAt: true,
      },
    }),
    prisma.voiceRecording.findMany({
      where: { userId, deletedAt: null, ...beforeFilter },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
      select: {
        id: true,
        title: true,
        contentType: true,
        duration: true,
        createdAt: true,
      },
    }),
  ]);

  const merged: FeedItem[] = [
    ...memories.map((m: {
      id: string;
      title: string;
      contentType: string;
      visibility: 'PRIVATE' | 'SHARED' | 'PUBLIC';
      createdAt: Date;
    }) => ({
      id: m.id,
      type: 'memory' as const,
      title: m.title,
      timezone: tz,
      contentType: m.contentType,
      visibility: m.visibility,
      duration: null,
      createdAt: m.createdAt,
    })),
    ...recordings.map((r: {
      id: string;
      title: string;
      contentType: string;
      duration: number;
      createdAt: Date;
    }) => ({
      id: r.id,
      type: 'voice' as const,
      title: r.title,
      timezone: tz,
      contentType: r.contentType,
      visibility: null,
      duration: r.duration,
      createdAt: r.createdAt,
    })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const hasNext = merged.length > opts.limit;
  const items = hasNext ? merged.slice(0, opts.limit) : merged;
  // Cursor is the createdAt of the last returned row (encoded as ISO by the
  // route). Ties across the two tables are broken by the time-only cursor, which
  // is acceptable for an activity feed.
  const last = items[items.length - 1];
  const nextCursor = hasNext && last ? last.createdAt.toISOString() : null;

  return { items, nextCursor };
}
