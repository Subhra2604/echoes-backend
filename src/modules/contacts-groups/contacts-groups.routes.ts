import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { prisma } from '../../lib/prisma.js';
import { generateSignedDownloadUrl } from '../../lib/upload-module.js';

/**
 * GET /api/contacts-groups
 *
 * Spec §2: return the caller's contacts AND groups in a single response so
 * the frontend can render pickers without two round-trips.
 *
 * Both slices support offset pagination via the same `page`/`limit` pair;
 * they page independently (the client can request page 1 of contacts and
 * still see all groups by keeping the group limit generous).
 *
 * Kept as an aggregator over the existing tables rather than a new DB layer:
 * this endpoint is a wire-shape convenience for the frontend, not a new
 * source of truth. If either contact or group semantics change in their own
 * modules, this endpoint keeps working without a downstream edit.
 */

const querySchema = z.object({
  // Free-text search (applied to both slices).
  search: z.string().trim().min(1).max(120).optional(),
  // Contact-only narrowing.
  status: z.enum(['VERIFIED', 'PENDING_INVITATION', 'BLOCKED']).optional(),
  // Pagination. Shared page number applies to both slices; separate limits
  // let the frontend ask for e.g. all groups + first 20 contacts in one call.
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  groupLimit: z.coerce.number().int().min(0).max(200).default(50),
});

type Query = z.infer<typeof querySchema>;

export const contactsGroupsRouter = Router();
contactsGroupsRouter.use(requireAuth);

contactsGroupsRouter.get(
  '/',
  validate({ query: querySchema }),
  asyncHandler(async (req, res) => {
    const q = querySchema.parse(req.query);
    res.json(await listContactsAndGroups(req.auth!.userId, q));
  }),
);

async function listContactsAndGroups(userId: string, q: Query) {
  // Fetch both slices in parallel — Prisma opens two connections, but each
  // query is small and the round-trip time savings are worth the concurrency.
  const [contactsResult, groupsResult] = await Promise.all([
    fetchContactsSlice(userId, q),
    fetchGroupsSlice(userId, q),
  ]);

  return {
    contacts: contactsResult.items,
    groups: groupsResult.items,
    pagination: {
      page: q.page,
      limit: q.limit,
      total: contactsResult.total,
      totalPages: Math.ceil(contactsResult.total / q.limit),
      groups: {
        total: groupsResult.total,
        limit: q.groupLimit,
      },
    },
  };
}

async function fetchContactsSlice(userId: string, q: Query) {
  const where = {
    ownerId: userId,
    // Hide contacts whose linked user has been soft-deleted (mirrors the
    // contacts.service filter). PENDING_INVITATION rows (no linked user) stay.
    OR: [
      { contactUserId: null },
      { contactUser: { deletedAt: null } },
    ],
    ...(q.status ? { status: q.status } : {}),
    ...(q.search
      ? {
          OR: [
            { name: { contains: q.search, mode: 'insensitive' as const } },
            { email: { contains: q.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        contactUserId: true,
        invitationSentAt: true,
        joinedAt: true,
        createdAt: true,
        contactUser: {
          select: { id: true, fullName: true, avatarKey: true },
        },
      },
    }),
  ]);

  return { total, items: rows };
}

async function fetchGroupsSlice(userId: string, q: Query) {
  const where = {
    userId,
    status: 'ACTIVE' as const,
    group: {
      deletedAt: null,
      ...(q.search
        ? { name: { contains: q.search, mode: 'insensitive' as const } }
        : {}),
    },
  };

  const [total, rows] = await prisma.$transaction([
    prisma.groupParticipant.count({ where }),
    prisma.groupParticipant.findMany({
      where,
      orderBy: { group: { createdAt: 'desc' } },
      take: q.groupLimit,
      select: {
        role: true,
        joinedAt: true,
        group: {
          select: {
            id: true,
            name: true,
            description: true,
            avatarKey: true,
            createdAt: true,
            updatedAt: true,
            _count: {
              select: { participants: { where: { status: 'ACTIVE' } } },
            },
          },
        },
      },
    }),
  ]);

  // Resolve avatar URLs in parallel — small N (<= groupLimit), so awaiting
  // sequentially would cost real time. Failures degrade to null (client
  // shows a placeholder).
  const items = await Promise.all(
    rows.map(async (r) => ({
      id: r.group.id,
      name: r.group.name,
      description: r.group.description,
      avatarUrl: r.group.avatarKey
        ? await generateSignedDownloadUrl(r.group.avatarKey, 3600).catch(
            () => null,
          )
        : null,
      participantCount: r.group._count.participants,
      myRole: r.role,
      joinedAt: r.joinedAt,
      createdAt: r.group.createdAt,
      updatedAt: r.group.updatedAt,
    })),
  );

  return { total, items };
}
