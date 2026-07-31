import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { generateSignedDownloadUrl } from '../../lib/upload-module.js';
import { notify } from '../notifications/notifications.service.js';
import type {
  ShareMemoryInput,
  ListReceivedSharesQuery,
  ListMemorySharesQuery,
} from './shares.dto.js';

/**
 * Memory-sharing service.
 *
 * Mental model:
 *   - `MemoryShare` is a REFERENCE. Sharing never copies bytes; the underlying
 *     Memory row stays owned by the sender, and its `fileKey` is served to
 *     recipients through short-lived signed URLs after an access check.
 *   - Each row targets exactly one recipient: either a group (`groupId`) or a
 *     contact user (`recipientUserId`). Enforced by a DB CHECK constraint.
 *   - Sharing is idempotent per (memoryId, recipient). Re-sharing an already
 *     active share returns the existing row; if a soft-deleted row exists
 *     (previously unshared), we reactivate it.
 *   - Only MEDIA memories currently have a fileKey, but NOTE memories are also
 *     shareable per the client PRD ("Everything he can share in group and
 *     individual") — the frontend renders the note body inline and no signed
 *     URL is needed.
 *
 * Permissions summary:
 *   - Only the memory owner can share it (no re-sharing of received content).
 *   - Group shares require ACTIVE membership in the target group.
 *   - Contact shares require the target to be one of the caller's VERIFIED
 *     contacts (the DTO layer validates contactIds; the service resolves and
 *     re-checks status here to close TOCTOU windows).
 *   - Unshare: sender can always delete; group OWNER/ADMIN can delete shares
 *     to their group as a moderation tool.
 */

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * POST /api/memories/:memoryId/share
 *
 * One transactional batch: N group shares + M contact shares, all pointing at
 * the same memory. Duplicates against active rows are folded (idempotent).
 * Reactivates soft-deleted rows so recipients don't accumulate history.
 */
export async function shareMemory(
  senderId: string,
  memoryId: string,
  input: ShareMemoryInput,
) {
  // 1. Verify the memory exists, isn't deleted, and belongs to the caller.
  const memory = await prisma.memory.findFirst({
    where: { id: memoryId, userId: senderId, deletedAt: null },
    select: { id: true, title: true, memoryType: true },
  });
  if (!memory) throw Errors.notFound('Memory not found');

  // 2. Resolve + validate all recipients up front (fail fast before opening tx).
  const [groupRecipients, contactRecipients] = await Promise.all([
    resolveGroupRecipients(senderId, input.groupIds),
    resolveContactRecipients(senderId, input.contactIds),
  ]);

  const now = new Date();

  // 3. Upsert each share row in a single transaction. Order preserved so the
  //    response array lines up with the caller's requested recipients.
  const shares = await prisma.$transaction(async (tx) => {
    const created: Array<{
      id: string;
      recipientType: 'GROUP' | 'CONTACT';
      groupId: string | null;
      recipientUserId: string | null;
      recipientEmail: string | null;
      sharedAt: Date;
      wasReactivated: boolean;
      wasAlreadyActive: boolean;
    }> = [];

    for (const g of groupRecipients) {
      const row = await upsertShareRow(tx, {
        memoryId: memory.id,
        sharedById: senderId,
        recipientType: 'GROUP',
        groupId: g.groupId,
        recipientUserId: null,
        recipientEmail: null,
        caption: input.caption ?? null,
        now,
      });
      created.push(row);
    }
    for (const c of contactRecipients) {
      const row = await upsertShareRow(tx, {
        memoryId: memory.id,
        sharedById: senderId,
        recipientType: 'CONTACT',
        groupId: null,
        recipientUserId: c.userId,
        recipientEmail: c.email,
        caption: input.caption ?? null,
        now,
      });
      created.push(row);
    }
    return created;
  });

  // 4. Fire notifications (best-effort, after commit). Only for newly-active
  //    rows — don't spam recipients who already had the share.
  fanOutNotifications(shares, senderId, memory.title).catch((err) =>
    logger.warn({ err }, 'share fan-out notify failed'),
  );

  return {
    memoryId: memory.id,
    created: shares.filter((s) => !s.wasAlreadyActive).length,
    alreadyShared: shares.filter((s) => s.wasAlreadyActive).length,
    shares: shares.map((s) => ({
      id: s.id,
      recipientType: s.recipientType,
      groupId: s.groupId,
      recipientUserId: s.recipientUserId,
      recipientEmail: s.recipientEmail,
      sharedAt: s.sharedAt,
    })),
  };
}

/**
 * GET /api/memories/:memoryId/shares
 * Owner view: who I've shared this memory with, filterable by recipient type.
 */
export async function listMemoryShares(
  ownerId: string,
  memoryId: string,
  q: ListMemorySharesQuery,
) {
  const memory = await prisma.memory.findFirst({
    where: { id: memoryId, userId: ownerId, deletedAt: null },
    select: { id: true },
  });
  if (!memory) throw Errors.notFound('Memory not found');

  const rows = await prisma.memoryShare.findMany({
    where: {
      memoryId,
      deletedAt: null,
      ...(q.recipientType ? { recipientType: q.recipientType } : {}),
      ...(q.cursor ? { sharedAt: { lt: new Date(q.cursor) } } : {}),
    },
    orderBy: { sharedAt: 'desc' },
    take: q.limit,
    select: sharePublicSelect,
  });

  const nextCursor =
    rows.length === q.limit ? rows[rows.length - 1]!.sharedAt.toISOString() : null;

  return { items: rows, nextCursor };
}

/**
 * GET /api/shares/received
 * Recipient inbox: memories directly shared to me (CONTACT recipient type only —
 * group shares are surfaced via the group's own feed).
 */
export async function listReceivedShares(userId: string, q: ListReceivedSharesQuery) {
  const rows = await prisma.memoryShare.findMany({
    where: {
      recipientType: 'CONTACT',
      recipientUserId: userId,
      deletedAt: null,
      memory: { deletedAt: null }, // hide shares whose source memory was deleted
      ...(q.fromUserId ? { sharedById: q.fromUserId } : {}),
      ...(q.cursor ? { sharedAt: { lt: new Date(q.cursor) } } : {}),
    },
    orderBy: { sharedAt: 'desc' },
    take: q.limit,
    select: shareWithMemorySelect,
  });

  // Sign every MEDIA URL in parallel. NOTE memories skip signing.
  const items = await Promise.all(
    rows.map(async (r) => ({
      ...r,
      memory: await materializeMemory(r.memory),
    })),
  );

  const nextCursor =
    rows.length === q.limit ? rows[rows.length - 1]!.sharedAt.toISOString() : null;

  return { items, nextCursor };
}

/**
 * DELETE /api/shares/:shareId
 *
 * - Sender can always delete their own share.
 * - Group OWNER/ADMIN can delete shares that target their group (moderation).
 * - Direct recipients cannot delete; if they don't want to see it, that's a
 *   future block/hide feature.
 *
 * Soft delete: sets `deletedAt` so re-sharing the same memory to the same
 * recipient later can either resurrect this row or (if the client prefers)
 * create a fresh one.
 */
export async function deleteShare(actorUserId: string, shareId: string): Promise<void> {
  const share = await prisma.memoryShare.findFirst({
    where: { id: shareId, deletedAt: null },
    select: {
      id: true,
      sharedById: true,
      recipientType: true,
      groupId: true,
      recipientUserId: true,
    },
  });
  if (!share) throw Errors.notFound('Share not found');

  const isSender = share.sharedById === actorUserId;
  let isGroupManager = false;
  if (!isSender && share.recipientType === 'GROUP' && share.groupId) {
    const p = await prisma.groupParticipant.findFirst({
      where: {
        groupId: share.groupId,
        userId: actorUserId,
        status: 'ACTIVE',
        role: { in: ['OWNER', 'ADMIN'] },
      },
      select: { id: true },
    });
    isGroupManager = Boolean(p);
  }
  if (!isSender && !isGroupManager) {
    throw Errors.forbidden('You cannot remove this share');
  }

  await prisma.memoryShare.update({
    where: { id: share.id },
    data: { deletedAt: new Date() },
  });
}

// ── Group feed integration ───────────────────────────────────────────────────
//
// The groups service imports this to power GET /api/groups/:groupId/media.
// Kept here (not in groups.service) so the sharing module owns the read model
// end-to-end.

/**
 * List MemoryShares targeting a group, joined to the underlying Memory rows
 * and materialized with signed download URLs.
 *
 * Caller must have already asserted ACTIVE participation in the group.
 */
export async function listGroupSharedMemories(
  groupId: string,
  q: { limit: number; cursor?: string },
) {
  const rows = await prisma.memoryShare.findMany({
    where: {
      recipientType: 'GROUP',
      groupId,
      deletedAt: null,
      memory: { deletedAt: null },
      ...(q.cursor ? { sharedAt: { lt: new Date(q.cursor) } } : {}),
    },
    orderBy: { sharedAt: 'desc' },
    take: q.limit,
    select: shareWithMemorySelect,
  });

  const items = await Promise.all(
    rows.map(async (r) => ({
      ...r,
      memory: await materializeMemory(r.memory),
    })),
  );

  const nextCursor =
    rows.length === q.limit ? rows[rows.length - 1]!.sharedAt.toISOString() : null;

  return { items, nextCursor };
}

// ── Internal ─────────────────────────────────────────────────────────────────

const sharePublicSelect = {
  id: true,
  recipientType: true,
  groupId: true,
  recipientUserId: true,
  recipientEmail: true,
  caption: true,
  sharedAt: true,
  group: { select: { id: true, name: true, avatarKey: true } },
  recipientUser: { select: { id: true, fullName: true, avatarKey: true } },
} as const;

/**
 * Select shape for the "recipient inbox" and "group feed" endpoints. Pulls in
 * enough of the source Memory to render the row without a follow-up call.
 */
const shareWithMemorySelect = {
  id: true,
  caption: true,
  sharedAt: true,
  sharedBy: { select: { id: true, fullName: true, email: true, avatarKey: true } },
  memory: {
    select: {
      id: true,
      title: true,
      story: true,
      memoryType: true,
      contentType: true,
      fileKey: true,
      sizeBytes: true,
      thumbnailKey: true,
      durationSec: true,
      width: true,
      height: true,
      createdAt: true,
    },
  },
} as const;

type MemoryProjection = {
  id: string;
  title: string;
  story: string | null;
  memoryType: 'MEDIA' | 'NOTE';
  contentType: string | null;
  fileKey: string | null;
  sizeBytes: bigint | number;
  thumbnailKey: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  createdAt: Date;
};

/**
 * Convert a raw Memory projection into the shape returned to clients:
 *  - MEDIA memories get a fresh 1-hour signed download URL for `fileKey`.
 *  - NOTE memories skip signing (there's no file).
 *  - `sizeBytes` is BigInt in the DB but serialized as Number for JSON.
 */
async function materializeMemory(m: MemoryProjection) {
  const url =
    m.memoryType === 'MEDIA' && m.fileKey
      ? await generateSignedDownloadUrl(m.fileKey, 3600).catch(() => null)
      : null;
  const thumbnailUrl =
    m.thumbnailKey
      ? await generateSignedDownloadUrl(m.thumbnailKey, 3600).catch(() => null)
      : null;
  return {
    ...m,
    sizeBytes: Number(m.sizeBytes),
    url,
    thumbnailUrl,
  };
}

/**
 * Resolve requested group IDs to (groupId) tuples after asserting the sender
 * is an ACTIVE participant of each. Throws 400 with a helpful message on any
 * miss so the client knows which recipient failed rather than getting a
 * blanket rejection.
 */
async function resolveGroupRecipients(
  senderId: string,
  groupIds: string[],
): Promise<Array<{ groupId: string }>> {
  if (groupIds.length === 0) return [];
  const memberships = await prisma.groupParticipant.findMany({
    where: {
      userId: senderId,
      status: 'ACTIVE',
      groupId: { in: groupIds },
      group: { deletedAt: null },
    },
    select: { groupId: true },
  });
  if (memberships.length !== groupIds.length) {
    throw Errors.badRequest(
      'You can only share to groups you are an active member of',
    );
  }
  return memberships;
}

/**
 * Resolve contact IDs to (userId, email) tuples after asserting each contact
 * belongs to the sender and is VERIFIED (linked to a real user).
 */
async function resolveContactRecipients(
  senderId: string,
  contactIds: string[],
): Promise<Array<{ userId: string; email: string }>> {
  if (contactIds.length === 0) return [];
  const contacts = await prisma.contact.findMany({
    where: { id: { in: contactIds }, ownerId: senderId },
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
      'You can only share directly with verified contacts on the Echoes platform',
    );
  }
  // Guard against sharing to yourself via a self-contact row (shouldn't be
  // possible but belt-and-braces).
  return contacts
    .filter((c) => c.contactUserId !== senderId)
    .map((c) => ({
      userId: c.contactUserId!,
      email: c.contactUser!.email.toLowerCase(),
    }));
}

/**
 * Insert-or-reactivate a MemoryShare row inside a transaction.
 *
 * Cases:
 *   - No existing row              → INSERT, wasAlreadyActive=false
 *   - Existing ACTIVE (deletedAt=null) → return as-is, wasAlreadyActive=true
 *   - Existing SOFT-DELETED        → UPDATE deletedAt=null, sharedAt=now,
 *                                     caption=new, wasReactivated=true
 */
async function upsertShareRow(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  args: {
    memoryId: string;
    sharedById: string;
    recipientType: 'GROUP' | 'CONTACT';
    groupId: string | null;
    recipientUserId: string | null;
    recipientEmail: string | null;
    caption: string | null;
    now: Date;
  },
) {
  const whereClause =
    args.recipientType === 'GROUP'
      ? {
          memoryId: args.memoryId,
          recipientType: 'GROUP' as const,
          groupId: args.groupId!,
        }
      : {
          memoryId: args.memoryId,
          recipientType: 'CONTACT' as const,
          recipientUserId: args.recipientUserId!,
        };

  const existing = await tx.memoryShare.findFirst({
    where: whereClause,
    select: { id: true, deletedAt: true, sharedAt: true },
    orderBy: { sharedAt: 'desc' },
  });

  if (existing && !existing.deletedAt) {
    return {
      id: existing.id,
      recipientType: args.recipientType,
      groupId: args.groupId,
      recipientUserId: args.recipientUserId,
      recipientEmail: args.recipientEmail,
      sharedAt: existing.sharedAt,
      wasReactivated: false,
      wasAlreadyActive: true,
    };
  }

  if (existing && existing.deletedAt) {
    const updated = await tx.memoryShare.update({
      where: { id: existing.id },
      data: {
        deletedAt: null,
        sharedAt: args.now,
        caption: args.caption,
        recipientEmail: args.recipientEmail,
      },
      select: { id: true, sharedAt: true },
    });
    return {
      id: updated.id,
      recipientType: args.recipientType,
      groupId: args.groupId,
      recipientUserId: args.recipientUserId,
      recipientEmail: args.recipientEmail,
      sharedAt: updated.sharedAt,
      wasReactivated: true,
      wasAlreadyActive: false,
    };
  }

  const created = await tx.memoryShare.create({
    data: {
      memoryId: args.memoryId,
      sharedById: args.sharedById,
      recipientType: args.recipientType,
      groupId: args.groupId,
      recipientUserId: args.recipientUserId,
      recipientEmail: args.recipientEmail,
      caption: args.caption,
      sharedAt: args.now,
    },
    select: { id: true, sharedAt: true },
  });
  return {
    id: created.id,
    recipientType: args.recipientType,
    groupId: args.groupId,
    recipientUserId: args.recipientUserId,
    recipientEmail: args.recipientEmail,
    sharedAt: created.sharedAt,
    wasReactivated: false,
    wasAlreadyActive: false,
  };
}

/**
 * Best-effort push/in-app notification after a share batch commits.
 *   - Group share → notify every other ACTIVE participant (using existing
 *     GROUP_MEDIA_UPLOADED type since a shared memory IS media in the group's
 *     view).
 *   - Contact share → notify the recipient with MEMORY_SHARED_WITH_YOU.
 *
 * Only fires for newly-active shares (skips wasAlreadyActive rows).
 */
async function fanOutNotifications(
  shares: Array<{
    recipientType: 'GROUP' | 'CONTACT';
    groupId: string | null;
    recipientUserId: string | null;
    wasAlreadyActive: boolean;
  }>,
  senderId: string,
  memoryTitle: string,
) {
  const sender = await prisma.user.findUnique({
    where: { id: senderId },
    select: { fullName: true },
  });
  const senderName = sender?.fullName ?? 'Someone';

  const jobs: Promise<unknown>[] = [];
  for (const s of shares) {
    if (s.wasAlreadyActive) continue;
    if (s.recipientType === 'GROUP' && s.groupId) {
      const group = await prisma.group.findUnique({
        where: { id: s.groupId },
        select: { name: true },
      });
      const groupName = group?.name ?? 'a group';
      const members = await prisma.groupParticipant.findMany({
        where: { groupId: s.groupId, status: 'ACTIVE', userId: { not: senderId } },
        select: { userId: true },
      });
      for (const m of members) {
        jobs.push(
          notify(
            m.userId,
            'GROUP_MEDIA_UPLOADED',
            `New memory in "${groupName}"`,
            `${senderName} shared "${memoryTitle}" in ${groupName}.`,
            { groupId: s.groupId, senderId },
          ),
        );
      }
    } else if (s.recipientType === 'CONTACT' && s.recipientUserId) {
      jobs.push(
        notify(
          s.recipientUserId,
          'MEMORY_SHARED_WITH_YOU',
          `${senderName} shared a memory with you`,
          `${senderName} shared "${memoryTitle}" with you.`,
          { senderId },
        ),
      );
    }
  }
  await Promise.all(jobs);
}
