import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import {
  generateSignedDownloadUrl,
  assertKeyOwnedBy,
} from '../../lib/upload-module.js';
import { notify } from '../notifications/notifications.service.js';
import { listGroupSharedContent } from '../shares/shares.service.js';
import type {
  CreateGroupInput,
  UpdateGroupInput,
  AddParticipantsInput,
  UpdateParticipantRoleInput,
  TransferOwnershipInput,
  SearchContactsForGroupInput,
  ListMyGroupsQuery,
  ListGroupMediaQuery,
} from './groups.dto.js';

/**
 * Groups service.
 *
 * Design summary:
 *   - Roles (OWNER / ADMIN / MEMBER) are group-scoped; they do NOT affect the
 *     User's platform-level role.
 *   - Adding participants goes through the caller's own VERIFIED contacts — a
 *     defensive layer that ensures the group creator has already opted in to a
 *     relationship with each participant before adding them.
 *   - Media uploads reuse the shared /uploads/presign flow (category=memory):
 *     the client uploads bytes straight to S3, then submits the resulting key
 *     here. Bytes never touch the API process. The uploader's plan quota is
 *     charged from the real S3 HEAD size.
 *   - Read access to media (both metadata list and signed download URLs) is
 *     gated by ACTIVE participation. The S3 prefix under the uploader's user
 *     namespace is only for organization, not access control.
 *   - Text-only messages are not supported: every GroupMedia row requires a
 *     fileKey. Enforced at the DTO layer + here in the service.
 */

// ── Helpers: membership + permission checks ─────────────────────────────────

/**
 * Fetch the caller's ACTIVE participant row, or throw 403. All read/write
 * routes on a group funnel through this so leaked group IDs stay useless.
 */
async function assertActiveMember(groupId: string, userId: string) {
  const p = await prisma.groupParticipant.findFirst({
    where: { groupId, userId, status: 'ACTIVE' },
    select: { id: true, role: true, email: true },
  });
  if (!p) throw Errors.forbidden('You are not a member of this group');
  return p;
}

/**
 * Manager = OWNER or ADMIN. Used for all group-mutation actions: rename,
 * change avatar, add/remove participants, promote/demote roles.
 */
async function assertManager(groupId: string, userId: string) {
  const p = await assertActiveMember(groupId, userId);
  if (p.role !== 'OWNER' && p.role !== 'ADMIN') {
    throw Errors.forbidden('Only group owners and admins can do that');
  }
  return p;
}

/** Owner-only actions: delete group, transfer ownership. */
async function assertOwner(groupId: string, userId: string) {
  const p = await assertActiveMember(groupId, userId);
  if (p.role !== 'OWNER') {
    throw Errors.forbidden('Only the group owner can do that');
  }
  return p;
}

// ── Groups CRUD ──────────────────────────────────────────────────────────────

/**
 * POST /groups — create a new group with the caller as OWNER and any supplied
 * verified contacts as MEMBER. Contacts must belong to the caller (their
 * address book) and be VERIFIED (so we have a real userId to add).
 */
export async function createGroup(creatorId: string, input: CreateGroupInput) {
  const creator = await prisma.user.findUniqueOrThrow({
    where: { id: creatorId },
    select: { email: true },
  });

  // If an avatar key is supplied, it must live under the creator's user
  // namespace (the presign endpoint enforces this at issue time; this is
  // belt-and-braces to prevent someone submitting a foreign key).
  if (input.avatarKey) {
    assertKeyOwnedBy('profile', creatorId, input.avatarKey);
  }

  // Resolve the requested contacts into (userId, email) tuples once. Any
  // contact that isn't owned by the caller, isn't VERIFIED, or has no linked
  // user (shouldn't happen for VERIFIED, but we guard) is rejected up front.
  const participantSnapshots = await resolveContactsToParticipants(
    creatorId,
    input.contactIds,
  );

  const group = await prisma.$transaction(async (tx) => {
    const g = await tx.group.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        avatarKey: input.avatarKey ?? null,
        createdById: creatorId,
      },
    });

    // Owner participant row — creator becomes OWNER automatically per PRD.
    await tx.groupParticipant.create({
      data: {
        groupId: g.id,
        userId: creatorId,
        email: creator.email.toLowerCase(),
        role: 'OWNER',
        status: 'ACTIVE',
        addedById: creatorId,
      },
    });

    if (participantSnapshots.length > 0) {
      await tx.groupParticipant.createMany({
        data: participantSnapshots.map((p) => ({
          groupId: g.id,
          userId: p.userId,
          email: p.email,
          role: 'MEMBER' as const,
          status: 'ACTIVE' as const,
          addedById: creatorId,
        })),
        skipDuplicates: true,
      });
    }

    return g;
  });

  // Fire GROUP_ADDED to every new participant (best effort).
  await Promise.all(
    participantSnapshots.map((p) =>
      notify(
        p.userId,
        'GROUP_ADDED',
        `Added to "${input.name}"`,
        `You were added to the group "${input.name}".`,
        { groupId: group.id },
      ).catch((err) => logger.warn({ err }, 'GROUP_ADDED notify failed')),
    ),
  );

  return getGroup(creatorId, group.id);
}

/**
 * GET /groups/:groupId — full details incl. participants + a fresh signed
 * avatar URL. Only ACTIVE members can read.
 */
export async function getGroup(userId: string, groupId: string) {
  await assertActiveMember(groupId, userId);

  const group = await prisma.group.findFirst({
    where: { id: groupId, deletedAt: null },
    select: {
      id: true,
      name: true,
      description: true,
      avatarKey: true,
      createdById: true,
      createdAt: true,
      updatedAt: true,
      participants: {
        where: { status: 'ACTIVE' },
        select: {
          id: true,
          userId: true,
          email: true,
          role: true,
          status: true,
          joinedAt: true,
          user: {
            select: { id: true, fullName: true, avatarKey: true },
          },
        },
        orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
      },
    },
  });
  if (!group) throw Errors.notFound('Group not found');

  const avatarUrl = group.avatarKey
    ? await generateSignedDownloadUrl(group.avatarKey, 3600).catch(() => null)
    : null;

  return { ...group, avatarUrl };
}

/**
 * GET /groups — groups the caller belongs to. Sorted by most recent activity
 * (fallback: group createdAt when no media has been posted).
 */
export async function listMyGroups(userId: string, q: ListMyGroupsQuery) {
  const rows = await prisma.groupParticipant.findMany({
    where: {
      userId,
      status: 'ACTIVE',
      group: {
        deletedAt: null,
        ...(q.search
          ? { name: { contains: q.search, mode: 'insensitive' } }
          : {}),
        ...(q.cursor ? { createdAt: { lt: new Date(q.cursor) } } : {}),
      },
    },
    orderBy: { group: { createdAt: 'desc' } },
    take: q.limit,
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
          _count: { select: { participants: { where: { status: 'ACTIVE' } } } },
        },
      },
    },
  });

  const items = rows.map((r) => ({
    id: r.group.id,
    name: r.group.name,
    description: r.group.description,
    avatarKey: r.group.avatarKey,
    createdAt: r.group.createdAt,
    updatedAt: r.group.updatedAt,
    myRole: r.role,
    joinedAt: r.joinedAt,
    participantCount: r.group._count.participants,
  }));

  const nextCursor =
    rows.length === q.limit
      ? rows[rows.length - 1]!.group.createdAt.toISOString()
      : null;

  return { items, nextCursor };
}

/** PATCH /groups/:groupId — rename / update description / change avatar. */
export async function updateGroup(
  userId: string,
  groupId: string,
  input: UpdateGroupInput,
) {
  await assertManager(groupId, userId);

  if (input.avatarKey) {
    assertKeyOwnedBy('profile', userId, input.avatarKey);
  }

  await prisma.group.update({
    where: { id: groupId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.avatarKey !== undefined ? { avatarKey: input.avatarKey } : {}),
    },
  });

  return getGroup(userId, groupId);
}

/**
 * DELETE /groups/:groupId — owner-only. Soft-delete the group so history is
 * preserved and cascading removals are cheap. Media S3 objects are left in
 * place for now; a background cleaner can purge them later.
 */
export async function deleteGroup(userId: string, groupId: string): Promise<void> {
  await assertOwner(groupId, userId);
  await prisma.group.update({
    where: { id: groupId },
    data: { deletedAt: new Date() },
  });
}

// ── Participants ────────────────────────────────────────────────────────────

/**
 * GET /groups/search-contacts — the caller's VERIFIED contacts, optionally
 * filtered by search and de-duplicated against an existing group. Powers the
 * "add participants" picker.
 */
export async function searchContactsForGroup(
  ownerId: string,
  q: SearchContactsForGroupInput,
) {
  // If we were given a group, we need to know which of my contacts are already
  // in it, so we can hide them from the picker.
  let excludedUserIds: string[] = [];
  if (q.excludeGroupId) {
    await assertActiveMember(q.excludeGroupId, ownerId);
    const participants = await prisma.groupParticipant.findMany({
      where: { groupId: q.excludeGroupId, status: 'ACTIVE' },
      select: { userId: true },
    });
    excludedUserIds = participants.map((p) => p.userId);
  }

  return prisma.contact.findMany({
    where: {
      ownerId,
      status: 'VERIFIED',
      contactUserId: { not: null, ...(excludedUserIds.length ? { notIn: excludedUserIds } : {}) },
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { email: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { name: 'asc' },
    take: q.limit,
    select: {
      id: true,
      email: true,
      name: true,
      contactUserId: true,
      contactUser: { select: { id: true, fullName: true, avatarKey: true } },
    },
  });
}

/**
 * POST /groups/:groupId/participants — add new members. Anyone with manager
 * role (OWNER or ADMIN) can add. Contacts must be the caller's own VERIFIED
 * contacts. Rejoining a participant who previously LEFT/REMOVED reactivates
 * their row rather than creating a duplicate.
 */
export async function addParticipants(
  userId: string,
  groupId: string,
  input: AddParticipantsInput,
) {
  await assertManager(groupId, userId);

  const group = await prisma.group.findFirst({
    where: { id: groupId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!group) throw Errors.notFound('Group not found');

  const snapshots = await resolveContactsToParticipants(userId, input.contactIds);

  const now = new Date();
  const addedUserIds: string[] = [];

  await prisma.$transaction(async (tx) => {
    for (const snap of snapshots) {
      // Upsert on (groupId, userId): reactivate a previously-left row rather
      // than blowing up on the unique constraint.
      const existing = await tx.groupParticipant.findUnique({
        where: { groupId_userId: { groupId, userId: snap.userId } },
        select: { id: true, status: true },
      });

      if (existing?.status === 'ACTIVE') continue; // already in the group

      if (existing) {
        await tx.groupParticipant.update({
          where: { id: existing.id },
          data: {
            status: 'ACTIVE',
            role: 'MEMBER',
            email: snap.email,
            addedById: userId,
            joinedAt: now,
          },
        });
      } else {
        await tx.groupParticipant.create({
          data: {
            groupId,
            userId: snap.userId,
            email: snap.email,
            role: 'MEMBER',
            status: 'ACTIVE',
            addedById: userId,
          },
        });
      }
      addedUserIds.push(snap.userId);
    }
  });

  await Promise.all(
    addedUserIds.map((uid) =>
      notify(
        uid,
        'GROUP_ADDED',
        `Added to "${group.name}"`,
        `You were added to the group "${group.name}".`,
        { groupId },
      ).catch((err) => logger.warn({ err }, 'GROUP_ADDED notify failed')),
    ),
  );

  return { added: addedUserIds.length };
}

/**
 * DELETE /groups/:groupId/participants/:userId — remove a participant.
 *
 * Manager-only. Owner cannot be removed (must transfer ownership first).
 * Managers may not remove other managers of equal or higher rank — an ADMIN
 * cannot remove another ADMIN or the OWNER.
 */
export async function removeParticipant(
  actorUserId: string,
  groupId: string,
  targetUserId: string,
) {
  const actor = await assertManager(groupId, actorUserId);

  const target = await prisma.groupParticipant.findUnique({
    where: { groupId_userId: { groupId, userId: targetUserId } },
    select: { id: true, role: true, status: true },
  });
  if (!target || target.status !== 'ACTIVE') {
    throw Errors.notFound('Participant not found');
  }
  if (target.role === 'OWNER') {
    throw Errors.conflict('The group owner cannot be removed. Transfer ownership first.');
  }
  if (target.role === 'ADMIN' && actor.role !== 'OWNER') {
    throw Errors.forbidden('Only the owner can remove an admin');
  }
  if (actorUserId === targetUserId) {
    throw Errors.badRequest('Use "leave group" instead of removing yourself');
  }

  const group = await prisma.group.findUniqueOrThrow({
    where: { id: groupId },
    select: { name: true },
  });

  await prisma.groupParticipant.update({
    where: { id: target.id },
    data: { status: 'REMOVED' },
  });

  notify(
    targetUserId,
    'GROUP_REMOVED',
    `Removed from "${group.name}"`,
    `You were removed from the group "${group.name}".`,
    { groupId },
  ).catch((err) => logger.warn({ err }, 'GROUP_REMOVED notify failed'));

  return { status: 'REMOVED' as const };
}

/**
 * POST /groups/:groupId/leave — self-service exit. The OWNER cannot leave
 * without first transferring ownership; everyone else can.
 */
export async function leaveGroup(userId: string, groupId: string) {
  const me = await assertActiveMember(groupId, userId);
  if (me.role === 'OWNER') {
    throw Errors.conflict(
      'The owner cannot leave the group. Transfer ownership first, or delete the group.',
    );
  }
  await prisma.groupParticipant.update({
    where: { id: me.id },
    data: { status: 'LEFT' },
  });
  return { status: 'LEFT' as const };
}

/**
 * PATCH /groups/:groupId/participants/:userId/role — promote / demote.
 *
 * OWNER can promote a MEMBER to ADMIN or demote an ADMIN to MEMBER.
 * ADMINs cannot change roles (guarded per PRD: "except the owner ...
 * promote or demote members").
 * OWNER role transfer is a separate transferOwnership call.
 */
export async function updateParticipantRole(
  actorUserId: string,
  groupId: string,
  targetUserId: string,
  input: UpdateParticipantRoleInput,
) {
  await assertOwner(groupId, actorUserId);

  if (actorUserId === targetUserId) {
    throw Errors.badRequest('You cannot change your own role. Transfer ownership instead.');
  }

  const target = await prisma.groupParticipant.findUnique({
    where: { groupId_userId: { groupId, userId: targetUserId } },
    select: { id: true, role: true, status: true },
  });
  if (!target || target.status !== 'ACTIVE') {
    throw Errors.notFound('Participant not found');
  }
  if (target.role === 'OWNER') {
    throw Errors.badRequest('Owner role can only be changed via transfer ownership');
  }
  if (target.role === input.role) {
    return { role: target.role };
  }

  await prisma.groupParticipant.update({
    where: { id: target.id },
    data: { role: input.role },
  });

  const group = await prisma.group.findUniqueOrThrow({
    where: { id: groupId },
    select: { name: true },
  });

  notify(
    targetUserId,
    'GROUP_ROLE_CHANGED',
    `Your role changed in "${group.name}"`,
    `You are now ${input.role.toLowerCase()} in the group "${group.name}".`,
    { groupId, newRole: input.role },
  ).catch((err) => logger.warn({ err }, 'GROUP_ROLE_CHANGED notify failed'));

  return { role: input.role };
}

/**
 * POST /groups/:groupId/transfer-ownership — hand OWNER to another ACTIVE
 * participant. The old owner is demoted to ADMIN so they still have manager
 * powers unless the new owner further demotes them.
 */
export async function transferOwnership(
  currentOwnerId: string,
  groupId: string,
  input: TransferOwnershipInput,
) {
  await assertOwner(groupId, currentOwnerId);

  if (input.newOwnerUserId === currentOwnerId) {
    throw Errors.badRequest('You are already the owner of this group');
  }

  const newOwner = await prisma.groupParticipant.findUnique({
    where: { groupId_userId: { groupId, userId: input.newOwnerUserId } },
    select: { id: true, status: true },
  });
  if (!newOwner || newOwner.status !== 'ACTIVE') {
    throw Errors.badRequest('New owner must be an active participant of the group');
  }

  // Two updates in one transaction so we never have zero OWNERs. The partial
  // unique index in the migration will also enforce this at the DB level.
  await prisma.$transaction([
    prisma.groupParticipant.updateMany({
      where: { groupId, userId: currentOwnerId },
      data: { role: 'ADMIN' },
    }),
    prisma.groupParticipant.updateMany({
      where: { groupId, userId: input.newOwnerUserId },
      data: { role: 'OWNER' },
    }),
  ]);

  return { status: 'OWNERSHIP_TRANSFERRED' as const };
}

// ── Media (shared-memory feed) ───────────────────────────────────────────────
//
// Direct file uploads to a group are gone (see PRD update: "sharing simply
// creates a reference/message in the chat rather than uploading a new copy").
// The group's media feed now returns MemoryShare rows joined with the
// underlying Memory rows, produced by the shares module. This function is a
// thin wrapper that enforces group membership and delegates.

/**
 * GET /groups/:groupId/media — page through content shared to this group.
 * Each item is a ContentShare + its source (Memory or VoiceRecording) + a
 * signed download URL. Both content types appear in the same time-sorted
 * feed.
 */
export async function listGroupMedia(
  userId: string,
  groupId: string,
  q: ListGroupMediaQuery,
) {
  await assertActiveMember(groupId, userId);
  return listGroupSharedContent(groupId, q);
}

// ── Internal ─────────────────────────────────────────────────────────────────

/**
 * Turn a list of contactIds owned by `callerId` into concrete (userId, email)
 * tuples ready for GroupParticipant creation. Every contact must belong to
 * the caller, be VERIFIED, and have a linked userId — anything else raises.
 *
 * `email` is snapshotted from the linked User (so it's the live email, not
 * whatever the caller labelled the contact with).
 */
async function resolveContactsToParticipants(
  callerId: string,
  contactIds: string[],
): Promise<Array<{ userId: string; email: string }>> {
  if (contactIds.length === 0) return [];

  const contacts = await prisma.contact.findMany({
    where: { id: { in: contactIds }, ownerId: callerId },
    select: {
      id: true,
      status: true,
      contactUserId: true,
      contactUser: { select: { email: true, deletedAt: true } },
    },
  });

  if (contacts.length !== contactIds.length) {
    throw Errors.badRequest('One or more contacts do not exist in your contact list');
  }

  const bad = contacts.filter(
    (c) =>
      c.status !== 'VERIFIED' ||
      !c.contactUserId ||
      !c.contactUser ||
      c.contactUser.deletedAt,
  );
  if (bad.length > 0) {
    throw Errors.badRequest(
      'Only verified contacts on the Echoes platform can be added to a group',
    );
  }

  // Also guard: caller can't add themselves via a contact row (edge case if
  // someone somehow inserted a self-contact).
  return contacts
    .filter((c) => c.contactUserId !== callerId)
    .map((c) => ({
      userId: c.contactUserId!,
      email: c.contactUser!.email.toLowerCase(),
    }));
}
