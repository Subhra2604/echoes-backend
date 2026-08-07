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
 * Mental model (post-Aug 2026):
 *   - `ContentShare` is a REFERENCE. Sharing never copies bytes; the
 *     underlying Memory / VoiceRecording row stays owned by the sender, and
 *     its `fileKey` is served to recipients through short-lived signed URLs
 *     after an access check.
 *   - Each row targets exactly one content item (Memory or VoiceRecording)
 *     and exactly one recipient (Group or Contact). Both XORs are enforced
 *     by DB CHECK constraints on top of the enum discriminators.
 *   - **NOT idempotent.** Each POST /api/shares call creates one row per
 *     recipient, even if the same (content, recipient) pair already has a
 *     share row. Sharing the same photo to the same group three times
 *     creates three ContentShare rows — WhatsApp-style repeat messages.
 *   - **Scheduled or immediate.** If the request includes a `scheduledDate`
 *     in the future, rows are created with status=PENDING and no
 *     notification fires — the daily 10 AM cron delivers them. Without a
 *     scheduledDate (or with one in the past), rows are created at
 *     status=SHARED and notifications fire immediately.
 *   - **Feed filter.** Group feeds and contact inboxes only surface
 *     status=SHARED rows. Recipients cannot see PENDING shares.
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
 * One transactional batch: creates exactly (groupIds.length + contactIds.length)
 * ContentShare rows, all pointing at the same content. If scheduledDate is
 * provided and in the future, rows land at status=PENDING and no notifications
 * fire (the daily 10 AM cron delivers them). Otherwise rows land at
 * status=SHARED and notifications fire in the background.
 */
export async function shareContent(senderId: string, input: ShareContentInput) {
  // 1. Resolve the source content and verify the caller owns it.
  let source: ContentSource;
  if (input.memoryId) {
    source = await resolveMemoryForOwner(senderId, input.memoryId);
  } else if (input.voiceRecordingId) {
    source = await resolveRecordingForOwner(senderId, input.voiceRecordingId);
  } else {
    source = await resolveWrittenForOwner(senderId, input.writtenVaultItemId!);
  }

  // 2. Resolve + validate recipients up front.
  const [groupRecipients, contactRecipients] = await Promise.all([
    resolveGroupRecipients(senderId, input.groupIds),
    resolveContactRecipients(senderId, input.contactIds),
  ]);

  const now = new Date();

  // Determine scheduled vs immediate. Any scheduledDate at or before "now"
  // is treated as immediate — no point deferring a share by 0 seconds, and
  // it also protects against clock skew on the client.
  const isScheduled =
    input.scheduledDate != null && input.scheduledDate.getTime() > now.getTime();
  const status: 'PENDING' | 'SHARED' = isScheduled ? 'PENDING' : 'SHARED';
  const scheduledDate = isScheduled ? input.scheduledDate! : null;
  const deliveredAt = isScheduled ? null : now;

  // 3. Build all rows and insert in a single createMany. Each recipient gets
  //    its own row every time — no upsert, no idempotency (Feature 2).
  const baseRow = {
    contentType: source.contentType,
    memoryId: source.contentType === 'MEMORY' ? source.id : null,
    voiceRecordingId:
      source.contentType === 'VOICE_RECORDING' ? source.id : null,
    writtenVaultItemId:
      source.contentType === 'WRITTEN_VAULT' ? source.id : null,
    sharedById: senderId,
    caption: input.caption ?? null,
    status,
    scheduledDate,
    deliveredAt,
    sharedAt: now,
  };

  const rowsToInsert: Array<Record<string, unknown>> = [];
  for (const g of groupRecipients) {
    rowsToInsert.push({
      ...baseRow,
      recipientType: 'GROUP',
      groupId: g.groupId,
      recipientUserId: null,
      recipientEmail: null,
    });
  }
  for (const c of contactRecipients) {
    rowsToInsert.push({
      ...baseRow,
      recipientType: 'CONTACT',
      groupId: null,
      recipientUserId: c.userId,
      recipientEmail: c.email,
    });
  }

  // createMany doesn't return created IDs on Postgres so we do the insert
  // + immediately-following read in a transaction, matching on sharedAt.
  // (Rows all share the exact same sharedAt so a single narrow findMany
  //  reliably returns them.)
  const createdShares = await prisma.$transaction(async (tx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await tx.contentShare.createMany({ data: rowsToInsert as any });

    // If sharing a WRITTEN_VAULT item, sync its writtenStatus so the vault
    // publish lifecycle matches the share it just produced. Never demote from
    // SHARED — the filter on writtenStatus ensures that.
    if (source.contentType === 'WRITTEN_VAULT') {
      await tx.vaultItem.updateMany({
        where: {
          id: source.id,
          writtenStatus: isScheduled
            ? { in: ['DRAFT'] }         // scheduled: only DRAFT -> PENDING
            : { in: ['DRAFT', 'PENDING'] }, // immediate: any non-SHARED -> SHARED
        },
        data: { writtenStatus: isScheduled ? 'PENDING' : 'SHARED' },
      });
    }

    const contentWhere =
      source.contentType === 'MEMORY'
        ? { contentType: 'MEMORY' as const, memoryId: source.id }
        : source.contentType === 'VOICE_RECORDING'
          ? { contentType: 'VOICE_RECORDING' as const, voiceRecordingId: source.id }
          : { contentType: 'WRITTEN_VAULT' as const, writtenVaultItemId: source.id };

    return tx.contentShare.findMany({
      where: {
        sharedById: senderId,
        sharedAt: now,
        ...contentWhere,
      },
      select: {
        id: true,
        contentType: true,
        recipientType: true,
        groupId: true,
        recipientUserId: true,
        recipientEmail: true,
        status: true,
        scheduledDate: true,
        sharedAt: true,
      },
    });
  });

  // 4. Only fire recipient-facing notifications for immediate shares.
  //    Scheduled shares defer their notifications to the delivery cron.
  if (!isScheduled) {
    fanOutNotifications(createdShares, senderId, source).catch((err) =>
      logger.warn({ err }, 'share fan-out notify failed'),
    );
  }

  return {
    contentType: source.contentType,
    contentId: source.id,
    status,
    scheduledDate,
    created: createdShares.length,
    shares: createdShares,
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
      status: 'SHARED', // PENDING (scheduled) shares are invisible until delivered
      ...(q.contentType ? { contentType: q.contentType } : {}),
      ...(q.fromUserId ? { sharedById: q.fromUserId } : {}),
      ...(q.cursor ? { sharedAt: { lt: new Date(q.cursor) } } : {}),
      // Hide shares whose source content was deleted (either side).
      OR: [
        { contentType: 'MEMORY', memory: { deletedAt: null } },
        { contentType: 'VOICE_RECORDING', voiceRecording: { deletedAt: null } },
        { contentType: 'WRITTEN_VAULT' },
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
      status: 'SHARED', // PENDING (scheduled) shares are invisible until delivered
      OR: [
        { contentType: 'MEMORY', memory: { deletedAt: null } },
        { contentType: 'VOICE_RECORDING', voiceRecording: { deletedAt: null } },
        { contentType: 'WRITTEN_VAULT' },
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
    }
  | {
      contentType: 'WRITTEN_VAULT';
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

/**
 * Resolve a WRITTEN VaultItem owned by the caller. Ownership goes via the
 * user's Vault row rather than a direct userId on the item, matching how the
 * rest of the vault module authorizes access.
 */
async function resolveWrittenForOwner(
  ownerId: string,
  writtenVaultItemId: string,
): Promise<ContentSource> {
  const item = await prisma.vaultItem.findFirst({
    where: {
      id: writtenVaultItemId,
      type: 'WRITTEN',
      vault: { userId: ownerId },
    },
    select: { id: true, title: true },
  });
  if (!item) throw Errors.notFound('Written vault entry not found');
  return {
    contentType: 'WRITTEN_VAULT',
    id: item.id,
    title: item.title ?? 'Untitled',
  };
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

// ── Internal: notifications fan-out ──────────────────────────────────────────
//
// Fires the "new share arrived" notification for each row in `shares`. Called
// synchronously from shareContent() for immediate shares, and from the
// delivery cron for scheduled shares after they flip to SHARED.

async function fanOutNotifications(
  shares: Array<{
    contentType: 'MEMORY' | 'VOICE_RECORDING' | 'WRITTEN_VAULT';
    recipientType: 'GROUP' | 'CONTACT';
    groupId: string | null;
    recipientUserId: string | null;
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
    source.contentType === 'MEMORY'
      ? 'memory'
      : source.contentType === 'VOICE_RECORDING'
        ? 'voice recording'
        : 'letter';

  const jobs: Promise<unknown>[] = [];
  for (const s of shares) {
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
 * source content. Includes Memory, VoiceRecording, and (WRITTEN) VaultItem —
 * at most one is non-null per row (enforced by the CHECK constraint).
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
  writtenVaultItem: {
    select: {
      id: true,
      title: true,
      bodyText: true,
      description: true,
      tags: true,
      writtenStatus: true,
      createdAt: true,
      updatedAt: true,
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

type WrittenVaultProjection = {
  id: string;
  title: string | null;
  bodyText: string | null;
  description: string | null;
  tags: string[];
  writtenStatus: 'DRAFT' | 'PENDING' | 'SHARED' | null;
  createdAt: Date;
  updatedAt: Date;
};

type ShareRow = {
  id: string;
  contentType: 'MEMORY' | 'VOICE_RECORDING' | 'WRITTEN_VAULT';
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
  writtenVaultItem: WrittenVaultProjection | null;
};

/**
 * Turn a raw share row (from `shareWithContentSelect`) into the wire shape
 * clients receive — with signed URLs for the file-backed variants. Uses a
 * nested-nullable discriminator: exactly one of `memory` / `voiceRecording` /
 * `writtenVaultItem` is non-null, matched to `contentType`.
 */
async function materializeShareRow(r: ShareRow) {
  let memory = null;
  let voiceRecording = null;
  let writtenVaultItem = null;

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
  } else if (r.contentType === 'WRITTEN_VAULT' && r.writtenVaultItem) {
    // Written entries have no S3 file — the bodyText is served inline. Clients
    // render it directly; no signed URL needed.
    writtenVaultItem = r.writtenVaultItem;
  }

  return {
    id: r.id,
    contentType: r.contentType,
    caption: r.caption,
    sharedAt: r.sharedAt,
    sharedBy: r.sharedBy,
    memory,
    voiceRecording,
    writtenVaultItem,
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
