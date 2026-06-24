import { randomUUID } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { hashToken, generateToken } from '../../lib/crypto.js';
import { screenText, screenImage } from '../moderation/moderation.service.js';
import { presignUpload, presignDownload, headObject, deleteObject, buildObjectKey } from '../../lib/s3.js';
import { notify } from '../notifications/notifications.service.js';
import { PLAN_MEMORIAL_LIMIT } from '../../config/plans.js';
import type { CreatePageInput } from './memorial.dto.js';
import type { SubscriptionPlan } from '../../generated/prisma/enums.js';

/**
 * Memorial pages.
 *
 * Ownership policy: the creator (any Family User) manages the page UNTIL
 * memorial mode is activated for a linked deceased owner; at activation the
 * activating guardian becomes the manager. Both the creator and the current
 * manager can administer the page.
 *
 * Two independent limits apply at creation:
 *   - One page per deceased person (dedup): a linked platform user can have only
 *     one page; for unlinked tributes we dedup on a normalized name.
 *   - Per-plan memorial-creation quota (Free 1 / Basic 3 / Family+ unlimited).
 */

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
  return `${base || 'memorial'}-${randomUUID().slice(0, 8)}`;
}

export async function createPage(creatorUserId: string, input: CreatePageInput) {
  // Dedup: one page per deceased person.
  if (input.deceasedUserId) {
    const existing = await prisma.memorialPage.findUnique({ where: { deceasedUserId: input.deceasedUserId } });
    if (existing) throw Errors.conflict('A memorial page already exists for this person');
  } else {
    // Unlinked tribute: dedup on a normalized name to avoid duplicate pages.
    // NOTE: name-only matching can collide for different people who share a
    // name; a stronger key (name + date of birth/death) can be added later.
    const normalized = input.deceasedName.trim().toLowerCase();
    const dup = await prisma.memorialPage.findFirst({
      where: { deceasedUserId: null, deceasedName: { equals: normalized, mode: 'insensitive' } },
    });
    if (dup) throw Errors.conflict('A memorial page with this name already exists');
  }

  // Per-plan memorial-creation quota.
  const creator = await prisma.user.findUniqueOrThrow({ where: { id: creatorUserId }, select: { plan: true } });
  const limit = PLAN_MEMORIAL_LIMIT[creator.plan as SubscriptionPlan];
  if (limit !== null) {
    const count = await prisma.memorialPage.count({ where: { creatorUserId } });
    if (count >= limit) {
      throw Errors.quota(`Your plan allows up to ${limit} memorial${limit === 1 ? '' : 's'}. Upgrade to create more.`);
    }
  }

  return prisma.memorialPage.create({
    data: {
      slug: slugify(input.deceasedName),
      deceasedName: input.deceasedName,
      deceasedUserId: input.deceasedUserId,
      creatorUserId,
      biography: input.biography,
      privacy: input.privacy,
    },
  });
}

/** A user may administer the page if they created it or currently manage it. */
async function assertCanManage(pageId: string, userId: string) {
  const page = await prisma.memorialPage.findUnique({ where: { id: pageId } });
  if (!page) throw Errors.notFound('Memorial page not found');
  const isManager = page.creatorUserId === userId || page.managerUserId === userId;
  if (!isManager) {
    const collab = await prisma.memorialPageCollaborator.findUnique({
      where: { pageId_userId: { pageId, userId } },
    });
    if (!collab?.canEdit) throw Errors.forbidden('You cannot manage this memorial page');
  }
  return page;
}

/** Read access honoring privacy. [GAP §6] PUBLIC / INVITE_ONLY / PRIVATE. */
export async function getPage(pageId: string, viewerUserId?: string) {
  const page = await prisma.memorialPage.findUnique({
    where: { id: pageId },
    include: {
      timeline: { orderBy: { eventDate: 'asc' } },
      guestbook: { where: { status: 'APPROVED' }, orderBy: { createdAt: 'desc' } },
      stories: { where: { status: 'APPROVED' }, orderBy: { createdAt: 'desc' } },
      photos: { where: { status: 'APPROVED' }, orderBy: { createdAt: 'desc' } },
    },
  });
  if (!page) throw Errors.notFound('Memorial page not found');

  if (page.privacy !== 'PUBLIC') {
    if (!viewerUserId) throw Errors.forbidden('This memorial page is private');
    const allowed =
      page.creatorUserId === viewerUserId ||
      page.managerUserId === viewerUserId ||
      (await prisma.memorialPageCollaborator.findUnique({
        where: { pageId_userId: { pageId, userId: viewerUserId } },
      })) !== null;
    if (!allowed) throw Errors.forbidden('You do not have access to this memorial page');
  }

  // Attach short-lived signed URLs to approved photos.
  const photos = await Promise.all(
    page.photos.map(async (p: { id: string; caption: string | null; s3Key: string }) => ({
      id: p.id,
      caption: p.caption,
      url: await presignDownload(p.s3Key),
    })),
  );
  return { ...page, photos };
}

export async function listMyPages(userId: string) {
  return prisma.memorialPage.findMany({
    where: {
      OR: [
        { creatorUserId: userId },
        { managerUserId: userId },
        { collaborators: { some: { userId } } },
      ],
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function updatePage(pageId: string, userId: string, patch: Record<string, unknown>) {
  await assertCanManage(pageId, userId);
  return prisma.memorialPage.update({ where: { id: pageId }, data: patch });
}

// ── Invitations [GAP §6] invite-only = invite by email with a token ───────────
export async function invitePerson(pageId: string, userId: string, email: string, canEdit: boolean) {
  await assertCanManage(pageId, userId);
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await prisma.memorialPageInvitation.create({
    data: { pageId, email: email.toLowerCase(), tokenHash: hashToken(token), expiresAt },
  });
  const link = `${env.PUBLIC_APP_URL}/memorial/invite?token=${token}`;
  return { link, expiresAt };
}

export async function acceptInvite(userId: string, token: string) {
  const invite = await prisma.memorialPageInvitation.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!invite) throw Errors.notFound('Invitation not found');
  if (invite.acceptedAt) throw Errors.conflict('Invitation already accepted');
  if (invite.expiresAt < new Date()) throw Errors.gone('This invitation has expired');

  await prisma.$transaction([
    prisma.memorialPageCollaborator.upsert({
      where: { pageId_userId: { pageId: invite.pageId, userId } },
      create: { pageId: invite.pageId, userId, canEdit: false },
      update: {},
    }),
    prisma.memorialPageInvitation.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
  ]);
  return { pageId: invite.pageId };
}

// ── Guestbook [GAP §6] auto-moderate, then page owner/guardian approves ───────
export async function addGuestbookEntry(
  pageId: string,
  author: { userId?: string; name: string },
  message: string,
) {
  const page = await prisma.memorialPage.findUnique({ where: { id: pageId } });
  if (!page) throw Errors.notFound('Memorial page not found');

  const screen = screenText(message);
  const status = screen.ok ? 'PENDING' : 'AUTO_BLOCKED';

  const entry = await prisma.guestbookEntry.create({
    data: {
      pageId,
      authorUserId: author.userId,
      authorName: author.name,
      message,
      status,
      moderationReason: screen.reason,
    },
  });

  if (status === 'AUTO_BLOCKED') {
    // [GAP §6] block with a message stating why.
    throw Errors.badRequest(screen.reason ?? 'Your entry was blocked by content moderation', { entryId: entry.id });
  }

  // [GAP §7] notify the page manager of a new entry awaiting approval.
  const manager = page.managerUserId ?? page.creatorUserId;
  await notify(manager, 'GUESTBOOK_ENTRY_NEW', 'New guestbook entry', `${author.name} left a message on ${page.deceasedName}'s page (awaiting approval).`);
  return { id: entry.id, status };
}

export async function moderateGuestbook(pageId: string, userId: string, entryId: string, approve: boolean, reason?: string) {
  await assertCanManage(pageId, userId);
  return prisma.guestbookEntry.update({
    where: { id: entryId },
    data: { status: approve ? 'APPROVED' : 'REJECTED', moderationReason: reason },
  });
}

/** [GAP §6] public reporting/flagging of guestbook entries. */
export async function reportGuestbook(entryId: string) {
  await prisma.guestbookEntry.update({ where: { id: entryId }, data: { reportCount: { increment: 1 } } });
}

export async function listPendingGuestbook(pageId: string, userId: string) {
  await assertCanManage(pageId, userId);
  return prisma.guestbookEntry.findMany({ where: { pageId, status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
}

// ── Stories [Role_Docs] require approval by page owner or guardian ────────────
export async function submitStory(
  pageId: string,
  author: { userId?: string },
  title: string | undefined,
  content: string,
) {
  const page = await prisma.memorialPage.findUnique({ where: { id: pageId } });
  if (!page) throw Errors.notFound('Memorial page not found');

  const screen = screenText(`${title ?? ''} ${content}`);
  const status = screen.ok ? 'PENDING' : 'AUTO_BLOCKED';
  const story = await prisma.storySubmission.create({
    data: { pageId, authorUserId: author.userId, title, content, status, moderationReason: screen.reason },
  });

  if (status === 'AUTO_BLOCKED') {
    throw Errors.badRequest(screen.reason ?? 'Your story was blocked by content moderation', { storyId: story.id });
  }

  const manager = page.managerUserId ?? page.creatorUserId;
  await notify(manager, 'STORY_SUBMITTED', 'New story submitted', `A new story was submitted to ${page.deceasedName}'s page (awaiting approval).`);
  return { id: story.id, status };
}

export async function moderateStory(pageId: string, userId: string, storyId: string, approve: boolean, reason?: string) {
  await assertCanManage(pageId, userId);
  const story = await prisma.storySubmission.update({
    where: { id: storyId },
    data: { status: approve ? 'APPROVED' : 'REJECTED', moderationReason: reason },
  });
  // [GAP §7] notify the author their story was approved.
  if (approve && story.authorUserId) {
    await notify(story.authorUserId, 'STORY_APPROVED', 'Your story was approved', 'Your story is now visible on the memorial page.');
  }
  return story;
}

export async function listPendingStories(pageId: string, userId: string) {
  await assertCanManage(pageId, userId);
  return prisma.storySubmission.findMany({ where: { pageId, status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
}

// ── Timeline ──────────────────────────────────────────────────────────────────
export async function addTimelineEvent(
  pageId: string,
  userId: string,
  data: { eventDate: Date; title: string; description?: string },
) {
  await assertCanManage(pageId, userId);
  return prisma.timelineEvent.create({ data: { pageId, ...data } });
}

// ── Public memorial photos (AWS Rekognition screened) ─────────────────────────
const PHOTO_MAX_BYTES = 50 * 1024 * 1024;

/** Step 1: manager requests a presigned upload for a page photo. */
export async function initPagePhoto(
  pageId: string,
  userId: string,
  input: { filename: string; contentType: string; sizeBytes: number; caption?: string },
) {
  await assertCanManage(pageId, userId);
  const key = buildObjectKey(`memorial/${pageId}`, input.filename);
  const photo = await prisma.memorialPagePhoto.create({
    data: { pageId, uploadedById: userId, s3Key: key, caption: input.caption, status: 'PENDING' },
  });
  const upload = await presignUpload({ key, contentType: input.contentType, maxBytes: PHOTO_MAX_BYTES });
  return { photoId: photo.id, upload };
}

/**
 * Step 2: confirm the object landed, then screen it with AWS Rekognition.
 * Clean -> APPROVED (visible). Flagged -> object deleted + AUTO_BLOCKED + 400.
 */
export async function finalizePagePhoto(pageId: string, userId: string, photoId: string) {
  await assertCanManage(pageId, userId);
  const photo = await prisma.memorialPagePhoto.findFirst({ where: { id: photoId, pageId } });
  if (!photo) throw Errors.notFound('Photo not found');
  if (photo.status === 'APPROVED') return photo;

  const head = await headObject(photo.s3Key).catch(() => null);
  if (!head) throw Errors.badRequest('Object not found in storage — upload may not have completed');

  const screen = await screenImage(photo.s3Key);
  if (!screen.ok) {
    await deleteObject(photo.s3Key).catch(() => undefined);
    await prisma.memorialPagePhoto.update({
      where: { id: photo.id },
      data: { status: 'AUTO_BLOCKED', moderationReason: screen.reason },
    });
    throw Errors.badRequest(screen.reason ?? 'This image was blocked by content moderation', { photoId: photo.id });
  }

  return prisma.memorialPagePhoto.update({ where: { id: photo.id }, data: { status: 'APPROVED' } });
}

export async function listPagePhotos(pageId: string, viewerUserId?: string) {
  // Reuse getPage access control; it returns approved photos with signed URLs.
  const page = await getPage(pageId, viewerUserId);
  return (page as { photos: unknown }).photos;
}

export async function deletePagePhoto(pageId: string, userId: string, photoId: string) {
  await assertCanManage(pageId, userId);
  const photo = await prisma.memorialPagePhoto.findFirst({ where: { id: photoId, pageId } });
  if (!photo) throw Errors.notFound('Photo not found');
  await prisma.memorialPagePhoto.delete({ where: { id: photo.id } });
  await deleteObject(photo.s3Key).catch(() => undefined);
}
