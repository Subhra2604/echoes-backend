import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { generateSignedDownloadUrl } from '../../lib/upload-module.js';
import { notify } from '../notifications/notifications.service.js';
import type {
  ShareContentInput,
  ListReceivedSharesQuery,
  ListContentSharesQuery,
} from './shares.dto.js';

/**
 * Content-sharing service (unified for Memory and VoiceRecording).
 *
 * Mental model:
 *   - `ContentShare` is a REFERENCE. Sharing never copies bytes; the
 *     underlying Memory / VoiceRecording row stays owned by the sender, and
 *     its `fileKey` is served to recipients through short-lived signed URLs
 *     after an access check.
 *   - Each row targets exactly one content item (Memory or VoiceRecording)
 *     and exactly one recipient (Group or Contact). Both XORs are enforced
 *     by DB CHECK constraints on top of the enum discriminators.
 *   - Idempotent: re-sharing the same content to the same recipient returns
 *     the existing row. If a soft-deleted row exists (previously unshared),
 *     the row is reactivated instead of a duplicate being created.
 *
 * Permissions summary:
 *   - Only the content owner can share it (no re-sharing of received content).
 *   - Group shares require ACTIVE membership in the target group.
 *   - Contact shares require the target to be one of the caller's VERIFIED
 *     contacts.
 *   - Unshare: sender can always delete; group OWNER/ADMIN can delete shares
 *     to their group as a moderation tool.
 */

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * POST /api/shares
 *
 * One transactional batch: N group shares + M contact shares, all pointing at
 * the same content (either a memory OR a voice recording). Duplicates against
 * active rows are folded (idempotent). Reactivates soft-deleted rows so
 * recipients don't accumulate history.
 */
export async function shareContent(senderId: string, input: ShareContentInput) {
  // 1. Resolve the source content (whichever type was requested) and verify
  //    the caller owns it. Only the owner can share.
  const source = input.memoryId
    ? await resolveMemoryForOwner(senderId, input.memoryId)
    : await resolveRecordingForOwner(senderId, input.voiceRecordingId!);

  // 2. Resolve + validate all recipients up front. Fail fast before opening
  //    the transaction so we don't half-commit.
  const [groupRecipients, contactRecipients] = await Promise.all([
    resolveGroupRecipients(senderId, input.groupIds),
    resolveContactRecipients(senderId, input.contactIds),
  ]);

  const now = new Date();

  // 3. Upsert each share row in a single transaction.
  const shares = await prisma.$transaction(async (tx) => {
    const created: Array<{
      id: string;
      contentType: 'MEMORY' | 'VOICE_RECORDING';
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
        source,
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
        source,
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

  // 4. Fire notifications (best-effort, after commit).
  fanOutNotifications(shares, senderId, source).catch((err) =>
    logger.warn({ err }, 'share fan-out notify failed'),
  );

  return {
    contentType: source.contentType,
    contentId: source.id,
    created: shares.filter((s) => !s.wasAlreadyActive).length,
    alreadyShared: shares.filter((s) => s.wasAlreadyActive).length,
    shares: shares.map((s) => ({
      id: s.id,
      contentType: s.contentType,
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
  q: ListContentSharesQuery,
) {
  const memory = await prisma.memory.findFirst({
    where: { id: memoryId, userId: ownerId, deletedAt: null },
    select: { id: true },
  });
  if (!memory) throw Errors.notFound('Memory not found');
  return listSharesOfContent({ contentType: 'MEMORY', memoryId }, q);
}

/**
 * GET /api/voice-recordings/:recordingId/shares
 * Owner view: who I've shared this recording with.
 */
export async function listVoiceRecordingShares(
  ownerId: string,
  recordingId: string,
  q: ListContentSharesQuery,
) {
  const rec = await prisma.voiceRecording.findFirst({
    where: { id: recordingId, userId: ownerId, deletedAt: null },
    select: { id: true },
  });
  if (!rec) throw Errors.notFound('Voice recording not found');
  return listSharesOfContent(
    { contentType: 'VOICE_RECORDING', voiceRecordingId: recordingId },
    q,
  );
}

/**
 * GET /api/shares/received
 * Recipient inbox: content directly shared with me by contacts (CONTACT
 * recipient type only). Group shares surface via the group's own feed.
 */
export async function listReceivedShares(userId: string, q: ListReceivedSharesQuery) {
  const rows = await prisma.contentShare.findMany({
    where: {
      recipientType: 'CONTACT',
      recipientUserId: userId,
      deletedAt: null,
      ...(q.contentType ? { contentType: q.contentType } : {}),
      ...(q.fromUserId ? { sharedById: q.fromUserId } : {}),
      ...(q.cursor ? { sharedAt: { lt: new Date(q.cursor) } } : {}),
      // Hide shares whose source content was deleted (either side).
      OR: [
        { contentType: 'MEMORY', memory: { deletedAt: null } },
        { contentType: 'VOICE_RECORDING', voiceRecording: { deletedAt: null } },
      ],
    },
    orderBy: { sharedAt: 'desc' },
    take: q.limit,
    select: shareWithContentSelect,
  });

  const items = await Promise.all(rows.map(materializeShareRow));
  const nextCursor =
    rows.length === q.limit ? rows[rows.length - 1]!.sharedAt.toISOString() : null;

  return { items, nextCursor };
}

/**
 * DELETE /api/shares/:shareId
 *
 * - Sender can always delete their own share.
 * - Group OWNER/ADMIN can delete shares that target their group (moderation).
 * - Direct recipients cannot delete; a future block/hide feature covers that.
 */
export async function deleteShare(actorUserId: string, shareId: string): Promise<void> {
  const share = await prisma.contentShare.findFirst({
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

  await prisma.contentShare.update({
    where: { id: share.id },
    data: { deletedAt: new Date() },
  });
}

// ── Group feed integration ───────────────────────────────────────────────────

/**
 * List ContentShare rows targeting a group. Called by the groups module to
 * power GET /api/groups/:groupId/media (kept as one endpoint so the frontend
 * gets a merged feed — memory + voice recording — sorted by sharedAt).
 *
 * Caller must have already asserted ACTIVE participation in the group.
 */
export async function listGroupSharedContent(
  groupId: string,
  q: { limit: number; cursor?: string },
) {
  const rows = await prisma.contentShare.findMany({
    where: {
      recipientType: 'GROUP',
      groupId,
      deletedAt: null,
      OR: [
        { contentType: 'MEMORY', memory: { deletedAt: null } },
        { contentType: 'VOICE_RECORDING', voiceRecording: { deletedAt: null } },
      ],
      ...(q.cursor ? { sharedAt: { lt: new Date(q.cursor) } } : {}),
    },
    orderBy: { sharedAt: 'desc' },
    take: q.limit,
    select: shareWithContentSelect,
  });

  const items = await Promise.all(rows.map(materializeShareRow));
  const nextCursor =
    rows.length === q.limit ? rows[rows.length - 1]!.sharedAt.toISOString() : null;

  return { items, nextCursor };
}

// ── Internal: content resolution ─────────────────────────────────────────────

type ContentSource =
  | {
      contentType: 'MEMORY';
      id: string;
      title: string;
      memoryType: 'MEDIA' | 'NOTE';
    }
  | {
      contentType: 'VOICE_RECORDING';
      id: string;
      title: string;
    };

async function resolveMemoryForOwner(
  ownerId: string,
  memoryId: string,
): Promise<ContentSource> {
  const m = await prisma.memory.findFirst({
    where: { id: memoryId, userId: ownerId, deletedAt: null },
    select: { id: true, title: true, memoryType: true },
  });
  if (!m) throw Errors.notFound('Memory not found');
  return { contentType: 'MEMORY', id: m.id, title: m.title, memoryType: m.memoryType };
}

async function resolveRecordingForOwner(
  ownerId: string,
  recordingId: string,
): Promise<ContentSource> {
  const r = await prisma.voiceRecording.findFirst({
    where: { id: recordingId, userId: ownerId, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!r) throw Errors.notFound('Voice recording not found');
  return { contentType: 'VOICE_RECORDING', id: r.id, title: r.title };
}

// ── Internal: recipient resolution ───────────────────────────────────────────

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
    throw Errors.badRequest('You can only share to groups you are an active member of');
  }
  return memberships;
}

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
  return contacts
    .filter((c) => c.contactUserId !== senderId)
    .map((c) => ({
      userId: c.contactUserId!,
      email: c.contactUser!.email.toLowerCase(),
    }));
}

// ── Internal: upsert (idempotent + reactivate soft-deleted rows) ─────────────

async function upsertShareRow(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  args: {
    source: ContentSource;
    sharedById: string;
    recipientType: 'GROUP' | 'CONTACT';
    groupId: string | null;
    recipientUserId: string | null;
    recipientEmail: string | null;
    caption: string | null;
    now: Date;
  },
) {
  // Build the "where match this recipient" clause. Note: we match on content
  // ID + recipient, but NOT on deletedAt — we want to catch soft-deleted rows
  // and revive them rather than accumulating duplicates.
  const contentWhere =
    args.source.contentType === 'MEMORY'
      ? { contentType: 'MEMORY' as const, memoryId: args.source.id }
      : { contentType: 'VOICE_RECORDING' as const, voiceRecordingId: args.source.id };
  const recipientWhere =
    args.recipientType === 'GROUP'
      ? { recipientType: 'GROUP' as const, groupId: args.groupId! }
      : { recipientType: 'CONTACT' as const, recipientUserId: args.recipientUserId! };

  const existing = await tx.contentShare.findFirst({
    where: { ...contentWhere, ...recipientWhere },
    select: { id: true, deletedAt: true, sharedAt: true },
    orderBy: { sharedAt: 'desc' },
  });

  const base = {
    contentType: args.source.contentType,
    recipientType: args.recipientType,
    groupId: args.groupId,
    recipientUserId: args.recipientUserId,
    recipientEmail: args.recipientEmail,
  };

  if (existing && !existing.deletedAt) {
    return {
      id: existing.id,
      ...base,
      sharedAt: existing.sharedAt,
      wasReactivated: false,
      wasAlreadyActive: true,
    };
  }

  if (existing && existing.deletedAt) {
    const updated = await tx.contentShare.update({
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
      ...base,
      sharedAt: updated.sharedAt,
      wasReactivated: true,
      wasAlreadyActive: false,
    };
  }

  const created = await tx.contentShare.create({
    data: {
      contentType: args.source.contentType,
      memoryId: args.source.contentType === 'MEMORY' ? args.source.id : null,
      voiceRecordingId:
        args.source.contentType === 'VOICE_RECORDING' ? args.source.id : null,
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
    ...base,
    sharedAt: created.sharedAt,
    wasReactivated: false,
    wasAlreadyActive: false,
  };
}

// ── Internal: notifications fan-out ──────────────────────────────────────────

async function fanOutNotifications(
  shares: Array<{
    contentType: 'MEMORY' | 'VOICE_RECORDING';
    recipientType: 'GROUP' | 'CONTACT';
    groupId: string | null;
    recipientUserId: string | null;
    wasAlreadyActive: boolean;
  }>,
  senderId: string,
  source: ContentSource,
) {
  const sender = await prisma.user.findUnique({
    where: { id: senderId },
    select: { fullName: true },
  });
  const senderName = sender?.fullName ?? 'Someone';
  const contentLabel =
    source.contentType === 'MEMORY' ? 'memory' : 'voice recording';

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
            `New ${contentLabel} in "${groupName}"`,
            `${senderName} shared "${source.title}" in ${groupName}.`,
            { groupId: s.groupId, senderId, contentType: s.contentType },
          ),
        );
      }
    } else if (s.recipientType === 'CONTACT' && s.recipientUserId) {
      jobs.push(
        notify(
          s.recipientUserId,
          'MEMORY_SHARED_WITH_YOU',
          `${senderName} shared a ${contentLabel} with you`,
          `${senderName} shared "${source.title}" with you.`,
          { senderId, contentType: source.contentType },
        ),
      );
    }
  }
  await Promise.all(jobs);
}

// ── Internal: read model + materialization ───────────────────────────────────

/**
 * Prisma select shape for any endpoint that returns a share joined with its
 * source content. Includes both Memory and VoiceRecording — at most one is
 * non-null per row (enforced by the CHECK constraint).
 */
const shareWithContentSelect = {
  id: true,
  contentType: true,
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
  voiceRecording: {
    select: {
      id: true,
      title: true,
      duration: true,
      contentType: true,
      fileKey: true,
      sizeBytes: true,
      folderId: true,
      scheduledDate: true,
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

type VoiceRecordingProjection = {
  id: string;
  title: string;
  duration: number;
  contentType: string;
  fileKey: string;
  sizeBytes: bigint | number;
  folderId: string | null;
  scheduledDate: Date | null;
  createdAt: Date;
};

type ShareRow = {
  id: string;
  contentType: 'MEMORY' | 'VOICE_RECORDING';
  caption: string | null;
  sharedAt: Date;
  sharedBy: {
    id: string;
    fullName: string;
    email: string;
    avatarKey: string | null;
  } | null;
  memory: MemoryProjection | null;
  voiceRecording: VoiceRecordingProjection | null;
};

/**
 * Turn a raw share row (from `shareWithContentSelect`) into the wire shape
 * clients receive — with signed URLs for the file-backed variants. Uses a
 * nested-nullable discriminator: exactly one of `memory` / `voiceRecording`
 * is non-null, matched to `contentType`.
 */
async function materializeShareRow(r: ShareRow) {
  let memory = null;
  let voiceRecording = null;

  if (r.contentType === 'MEMORY' && r.memory) {
    const m = r.memory;
    const url =
      m.memoryType === 'MEDIA' && m.fileKey
        ? await generateSignedDownloadUrl(m.fileKey, 3600).catch(() => null)
        : null;
    const thumbnailUrl =
      m.thumbnailKey
        ? await generateSignedDownloadUrl(m.thumbnailKey, 3600).catch(() => null)
        : null;
    memory = {
      ...m,
      sizeBytes: Number(m.sizeBytes),
      url,
      thumbnailUrl,
    };
  } else if (r.contentType === 'VOICE_RECORDING' && r.voiceRecording) {
    const v = r.voiceRecording;
    const url = await generateSignedDownloadUrl(v.fileKey, 3600).catch(() => null);
    voiceRecording = {
      ...v,
      sizeBytes: Number(v.sizeBytes),
      url,
    };
  }

  return {
    id: r.id,
    contentType: r.contentType,
    caption: r.caption,
    sharedAt: r.sharedAt,
    sharedBy: r.sharedBy,
    memory,
    voiceRecording,
  };
}

/**
 * Shared implementation for the two owner-scoped "list shares of X" endpoints.
 * The caller has already asserted ownership of the content.
 */
async function listSharesOfContent(
  content:
    | { contentType: 'MEMORY'; memoryId: string }
    | { contentType: 'VOICE_RECORDING'; voiceRecordingId: string },
  q: ListContentSharesQuery,
) {
  const contentWhere =
    content.contentType === 'MEMORY'
      ? { contentType: 'MEMORY' as const, memoryId: content.memoryId }
      : {
          contentType: 'VOICE_RECORDING' as const,
          voiceRecordingId: content.voiceRecordingId,
        };

  const rows = await prisma.contentShare.findMany({
    where: {
      ...contentWhere,
      deletedAt: null,
      ...(q.recipientType ? { recipientType: q.recipientType } : {}),
      ...(q.cursor ? { sharedAt: { lt: new Date(q.cursor) } } : {}),
    },
    orderBy: { sharedAt: 'desc' },
    take: q.limit,
    select: {
      id: true,
      recipientType: true,
      groupId: true,
      recipientUserId: true,
      recipientEmail: true,
      caption: true,
      sharedAt: true,
      group: { select: { id: true, name: true, avatarKey: true } },
      recipientUser: { select: { id: true, fullName: true, avatarKey: true } },
    },
  });

  const nextCursor =
    rows.length === q.limit ? rows[rows.length - 1]!.sharedAt.toISOString() : null;

  return { items: rows, nextCursor };
}
