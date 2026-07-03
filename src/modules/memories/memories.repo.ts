// import type { Prisma } from '../../generated/prisma/client.js';
// import { prisma } from '../../lib/prisma.js';

// /**
//  * Repository for the Memory domain. Keeps Prisma calls out of the service layer
//  * so the service stays ORM-agnostic and easy to unit-test.
//  */
// export const memoriesRepo = {
//   /** A single memory the caller owns. Soft-deleted rows excluded. */
//   findByIdForUser(userId: string, id: string) {
//     return prisma.memory.findFirst({
//       where: { id, userId, deletedAt: null },
//       include: { tags: { include: { tag: true } }, folder: true },
//     });
//   },

//   /**
//    * Paginated list. Cursor-based on (createdAt desc, id desc) for stable
//    * ordering even when rows share a `createdAt`. Selects only lightweight
//    * columns — no file bytes/URLs are produced here.
//    */
//   // list(
//   //   userId: string,
//   //   q: {
//   //     cursor?: string;
//   //     limit: number;
//   //     search?: string;
//   //     visibility?: 'PRIVATE' | 'SHARED' | 'PUBLIC';
//   //     folderId?: string;
//   //     tags?: string[];
//   //   },
    
//   // ) {
//   //   console.log("query=>",q)
//   //   const where: Prisma.MemoryWhereInput = {
//   //     userId,
//   //     deletedAt: null,
//   //     ...(q.visibility && { visibility: q.visibility }),
//   //     ...(q.folderId && { folderId: q.folderId }),
//   //     ...(q.search && {
//   //       OR: [
//   //         { title: { contains: q.search, mode: 'insensitive' } },
//   //         { story: { contains: q.search, mode: 'insensitive' } },
//   //       ],
//   //     }),
//   //     ...(q.tags?.length && {
//   //       tags: { some: { tag: { name: { in: q.tags } } } },
//   //     }),
//   //   };

//   //   const data = prisma.memory.findMany({
//   //     where,
//   //     orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
//   //     take: q.limit + 1, // +1 sentinel to detect the next page
//   //     ...(q.cursor && { skip: 1, cursor: { id: q.cursor } }),
//   //     select: {
//   //       id: true,
//   //       title: true,
//   //       contentType: true,
//   //       visibility: true,
//   //       folderId: true,
//   //       createdAt: true,
//   //       updatedAt: true,
//   //     },
//   //   });
//   //   console.log("data->",data)
//   //   return data
//   // },


//  list(
//   userId: string,
//   q: {
//     cursor?: string;
//     limit: number;
//     search?: string;
//     visibility?: 'PRIVATE' | 'SHARED' | 'PUBLIC';
//     mediaType?: 'image' | 'video' | 'document' | 'audio';
//   },
// ) {
//   const where: Prisma.MemoryWhereInput = {
//     userId,
//     deletedAt: null,
//     ...(q.visibility && { visibility: q.visibility }),
//     ...(q.mediaType && { contentType: { startsWith: `${q.mediaType}/` } }),
//     ...(q.search && {
//       OR: [
//         { title: { contains: q.search, mode: 'insensitive' } },
//         { story: { contains: q.search, mode: 'insensitive' } },
//       ],
//     }),
//   };

//   return prisma.memory.findMany({
//     where,
//     orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
//     take: q.limit + 1,
//     ...(q.cursor && { skip: 1, cursor: { id: q.cursor } }),
//     select: {
//       id: true,
//       title: true,
//       contentType: true,
//       visibility: true,
//       folderId: true,
//       createdAt: true,
//       updatedAt: true,
//     },
//   });
// },
//   async update(
//     userId: string,
//     id: string,
//     data: {
//       title?: string;
//       story?: string | null;
//       folderId?: string | null;
//       visibility?: 'PRIVATE' | 'SHARED' | 'PUBLIC';
//       replaceTagIds?: string[];
//     },
//   ) {
//     return prisma.$transaction(async (tx) => {
//       const found = await tx.memory.findFirst({
//         where: { id, userId, deletedAt: null },
//         select: { id: true },
//       });
//       if (!found) return null;

//       if (data.replaceTagIds) {
//         await tx.memoryTag.deleteMany({ where: { memoryId: id } });
//         if (data.replaceTagIds.length > 0) {
//           await tx.memoryTag.createMany({
//             data: data.replaceTagIds.map((tagId) => ({ memoryId: id, tagId })),
//           });
//         }
//       }

//       return tx.memory.update({
//         where: { id },
//         data: {
//           ...(data.title !== undefined && { title: data.title }),
//           ...(data.story !== undefined && { story: data.story }),
//           ...(data.folderId !== undefined && { folderId: data.folderId }),
//           ...(data.visibility !== undefined && { visibility: data.visibility }),
//         },
//         include: { tags: { include: { tag: true } }, folder: true },
//       });
//     });
//   },

//   /** Soft-delete. Returns true if a row was actually marked. */
//   async softDelete(userId: string, id: string): Promise<boolean> {
//     const r = await prisma.memory.updateMany({
//       where: { id, userId, deletedAt: null },
//       data: { deletedAt: new Date() },
//     });
//     return r.count === 1;
//   },

//   /**
//    * Upsert tags by normalized (lowercased) name, scoped to the user. Returns IDs
//    * for the deduped input names. Idempotent and case-insensitive.
//    */
//   async upsertTagsByName(userId: string, names: string[]): Promise<string[]> {
//     if (names.length === 0) return [];
//     const norm = Array.from(
//       new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean)),
//     );
//     const rows = await prisma.$transaction(
//       norm.map((name) =>
//         prisma.tag.upsert({
//           where: { userId_name: { userId, name } },
//           create: { userId, name },
//           update: {},
//           select: { id: true },
//         }),
//       ),
//     );
//     return rows.map((r) => r.id);
//   },
// };



import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Repository for the Memory domain. Keeps Prisma calls out of the service layer
 * so the service stays ORM-agnostic and easy to unit-test.
 */
export const memoriesRepo = {
  /** A single memory the caller owns. Soft-deleted rows excluded. */
  findByIdForUser(userId: string, id: string) {
    return prisma.memory.findFirst({
      where: { id, userId, deletedAt: null },
      include: { tags: { include: { tag: true } }, folder: true },
    });
  },

  /**
   * Paginated list. Cursor-based on (createdAt desc, id desc) for stable
   * ordering even when rows share a `createdAt`. Selects only lightweight
   * columns — no file bytes/URLs are produced here.
   *
   * Filtering (memoryType, visibility, mediaType, search) all happens in the
   * `where` clause below — i.e. against the full dataset — before `take`/
   * `skip` are applied, so pagination is always computed on the filtered set.
   */
  list(
    userId: string,
    q: {
      cursor?: string;
      limit: number;
      search?: string;
      visibility?: 'PRIVATE' | 'SHARED' | 'PUBLIC';
      mediaType?: 'image' | 'video' | 'document' | 'audio';
      memoryType?: 'MEDIA' | 'NOTE';
    },
  ) {
    const where: Prisma.MemoryWhereInput = {
      userId,
      deletedAt: null,
      ...(q.memoryType && { memoryType: q.memoryType }),
      ...(q.visibility && { visibility: q.visibility }),
      ...(q.mediaType && { contentType: { startsWith: `${q.mediaType}/` } }),
      ...(q.search && {
        OR: [
          { title: { contains: q.search, mode: 'insensitive' } },
          { story: { contains: q.search, mode: 'insensitive' } },
        ],
      }),
    };

    return prisma.memory.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1, // +1 sentinel to detect the next page
      ...(q.cursor && { skip: 1, cursor: { id: q.cursor } }),
      select: {
        id: true,
        title: true,
        memoryType: true,
        contentType: true,
        visibility: true,
        folderId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  },

  async update(
    userId: string,
    id: string,
    data: {
      title?: string;
      story?: string | null;
      folderId?: string | null;
      visibility?: 'PRIVATE' | 'SHARED' | 'PUBLIC';
      replaceTagIds?: string[];
    },
  ) {
    return prisma.$transaction(async (tx) => {
      const found = await tx.memory.findFirst({
        where: { id, userId, deletedAt: null },
        select: { id: true },
      });
      if (!found) return null;

      if (data.replaceTagIds) {
        await tx.memoryTag.deleteMany({ where: { memoryId: id } });
        if (data.replaceTagIds.length > 0) {
          await tx.memoryTag.createMany({
            data: data.replaceTagIds.map((tagId) => ({ memoryId: id, tagId })),
          });
        }
      }

      return tx.memory.update({
        where: { id },
        data: {
          ...(data.title !== undefined && { title: data.title }),
          ...(data.story !== undefined && { story: data.story }),
          ...(data.folderId !== undefined && { folderId: data.folderId }),
          ...(data.visibility !== undefined && { visibility: data.visibility }),
        },
        include: { tags: { include: { tag: true } }, folder: true },
      });
    });
  },

  /** Soft-delete. Returns true if a row was actually marked. */
  async softDelete(userId: string, id: string): Promise<boolean> {
    const r = await prisma.memory.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return r.count === 1;
  },

  /**
   * Upsert tags by normalized (lowercased) name, scoped to the user. Returns IDs
   * for the deduped input names. Idempotent and case-insensitive.
   */
  async upsertTagsByName(userId: string, names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const norm = Array.from(
      new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean)),
    );
    const rows = await prisma.$transaction(
      norm.map((name) =>
        prisma.tag.upsert({
          where: { userId_name: { userId, name } },
          create: { userId, name },
          update: {},
          select: { id: true },
        }),
      ),
    );
    return rows.map((r) => r.id);
  },
};
