import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../lib/errors.js';
import { notify, sendCapsuleEmail, sendCapsuleReturnedToGuardian } from '../notifications/notifications.service.js';
import { scheduleOneOff, scheduleRecurringAnnual, cancelSchedule } from './capsules.scheduler.js';
import type { CreateCapsuleInput } from './capsules.dto.js';

export async function createCapsule(ownerId: string, input: CreateCapsuleInput) {
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });

  // Validate referenced media belongs to the owner and respects the 60s cap. [GAP §3]
  if (input.mediaItemId) {
    const item = await prisma.vaultItem.findFirst({
      where: { id: input.mediaItemId, vault: { userId: ownerId } },
    });
    if (!item) throw Errors.badRequest('Media item not found in your vault');
    if ((item.type === 'VIDEO' || item.type === 'AUDIO') && (item.durationSec ?? 0) > 60) {
      throw Errors.badRequest('Capsule video/audio messages are limited to 60 seconds');
    }
  }

  const guardianControlled = input.releaseType === 'GUARDIAN_CONTROLLED';
  const status = guardianControlled ? 'PENDING_GUARDIAN_RELEASE' : 'SCHEDULED';

  const capsule = await prisma.timeCapsule.create({
    data: {
      ownerId,
      title: input.title,
      message: input.message,
      mediaItemId: input.mediaItemId,
      recipientEmail: input.recipientEmail,
      recipientUserId: input.recipientUserId,
      releaseType: input.releaseType,
      // [GAP §3] timezone = owner's timezone at creation.
      scheduleTimezone: owner.timezone,
      releaseAt: input.releaseAt,
      recurMonth: input.recurMonth,
      recurDay: input.recurDay,
      recurring: input.releaseType === 'RECURRING_ANNUAL',
      guardianControlled,
      status,
    },
  });

  if (input.releaseType === 'SCHEDULED_DATE') {
    await scheduleOneOff(capsule.id, input.releaseAt!);
  } else if (input.releaseType === 'RECURRING_ANNUAL') {
    await scheduleRecurringAnnual(capsule.id, input.recurMonth!, input.recurDay!, owner.timezone);
  }
  // GUARDIAN_CONTROLLED capsules are not scheduled; a guardian triggers them.

  return capsule;
}

/** [GAP §3] Editable by the OWNER WHILE ALIVE only. */
export async function updateCapsule(ownerId: string, capsuleId: string, patch: Record<string, unknown>) {
  const capsule = await assertOwnerCanModify(ownerId, capsuleId);
  if (capsule.status === 'RELEASED') throw Errors.conflict('A released capsule cannot be edited');

  const updated = await prisma.timeCapsule.update({ where: { id: capsuleId }, data: patch });

  // Reschedule if timing changed.
  if (patch.releaseAt && updated.releaseType === 'SCHEDULED_DATE') {
    await cancelSchedule(capsuleId);
    await scheduleOneOff(capsuleId, updated.releaseAt!);
  }
  if ((patch.recurMonth || patch.recurDay) && updated.releaseType === 'RECURRING_ANNUAL') {
    await cancelSchedule(capsuleId);
    await scheduleRecurringAnnual(capsuleId, updated.recurMonth!, updated.recurDay!, updated.scheduleTimezone);
  }
  return updated;
}

/** [GAP §3] Deletable by the OWNER WHILE ALIVE; by the guardian after death = NO. */
export async function deleteCapsule(ownerId: string, capsuleId: string) {
  await assertOwnerCanModify(ownerId, capsuleId);
  await cancelSchedule(capsuleId);
  await prisma.timeCapsule.delete({ where: { id: capsuleId } });
}

async function assertOwnerCanModify(ownerId: string, capsuleId: string) {
  const capsule = await prisma.timeCapsule.findFirst({ where: { id: capsuleId, ownerId } });
  if (!capsule) throw Errors.notFound('Capsule not found');
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
  if (owner.isDeceased) throw Errors.forbidden('Capsules can no longer be edited or deleted');
  return capsule;
}

export async function listCapsules(ownerId: string) {
  return prisma.timeCapsule.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, releaseType: true, status: true, releaseAt: true, recurMonth: true, recurDay: true, recipientEmail: true },
  });
}

/**
 * Guardian triggers a guardian-controlled release. [GAP §3]
 * Strict rules enforced here:
 *   - the guardian must be ACTIVE (owner deceased)
 *   - the guardian does NOT see the content (this returns only a status)
 *   - the guardian CANNOT decline (no such path) and CANNOT edit (no such path)
 */
export async function guardianRelease(ownerId: string, guardianUserId: string, capsuleId: string) {
  const isActive = await prisma.guardianInvitation.findFirst({
    where: { ownerId, guardianId: guardianUserId, status: 'ACCEPTED', owner: { isDeceased: true } },
  });
  if (!isActive) throw Errors.forbidden('You are not an active guardian for this account');

  const capsule = await prisma.timeCapsule.findFirst({ where: { id: capsuleId, ownerId, guardianControlled: true } });
  if (!capsule) throw Errors.notFound('Guardian-controlled capsule not found');
  if (capsule.status === 'RELEASED') throw Errors.conflict('Already released');

  await executeRelease(capsuleId);
  return { status: 'RELEASED' as const };
}

/**
 * Core release routine, called by the worker (scheduled) or guardianRelease.
 * Idempotent per occurrence year so recurring annual capsules never double-send.
 */
export async function executeRelease(capsuleId: string): Promise<void> {
  const capsule = await prisma.timeCapsule.findUnique({ where: { id: capsuleId } });
  if (!capsule) return;

  const occurrenceYear = new Date().getUTCFullYear();
  // Idempotency guard for the (capsule, year) pair.
  const already = await prisma.capsuleDelivery.findFirst({ where: { capsuleId, occurrenceYear } });
  if (already && already.status !== 'BOUNCED') return;

  const recipientHasAccount = !!capsule.recipientUserId;

  const delivery = await prisma.capsuleDelivery.create({
    data: { capsuleId, channel: 'EMAIL', toEmail: capsule.recipientEmail, occurrenceYear, status: 'QUEUED' },
  });

  try {
    // [GAP §3] delivered by email; held/created for the recipient if no account.
    await sendCapsuleEmail(capsule.recipientEmail, {
      title: capsule.title,
      message: capsule.message,
      hasAccount: recipientHasAccount,
    });
    await prisma.capsuleDelivery.update({ where: { id: delivery.id }, data: { status: 'SENT', sentAt: new Date() } });

    // For a non-recurring capsule, mark it released. Recurring stays SCHEDULED.
    if (!capsule.recurring) {
      await prisma.timeCapsule.update({ where: { id: capsuleId }, data: { status: 'RELEASED', releasedAt: new Date() } });
    }
    if (recipientHasAccount) {
      await notify(capsule.recipientUserId!, 'CAPSULE_RELEASED', 'A message has arrived', `You received: "${capsule.title}"`);
    }
  } catch {
    // Delivery failed (e.g. hard bounce). [GAP §3] return to guardian.
    await markBouncedAndReturn(capsule.id, delivery.id);
  }
}

/** [GAP §3] On a bounced email, return the capsule to the owner's guardian. */
export async function markBouncedAndReturn(capsuleId: string, deliveryId: string): Promise<void> {
  const capsule = await prisma.timeCapsule.findUniqueOrThrow({ where: { id: capsuleId } });
  const primaryGuardian = await prisma.guardianInvitation.findFirst({
    where: { ownerId: capsule.ownerId, status: 'ACCEPTED' },
    orderBy: [{ isPrimary: 'desc' }, { priority: 'asc' }],
  });
  await prisma.capsuleDelivery.update({
    where: { id: deliveryId },
    data: { status: 'RETURNED_TO_GUARDIAN', bouncedAt: new Date(), returnedToGuardianId: primaryGuardian?.guardianId ?? null },
  });
  if (primaryGuardian?.guardianId) {
    await notify(primaryGuardian.guardianId, 'CAPSULE_BOUNCED_RETURNED', 'A capsule could not be delivered', `Delivery of "${capsule.title}" to ${capsule.recipientEmail} bounced and has been returned to you.`);
    await sendCapsuleReturnedToGuardian(primaryGuardian.guardianEmail, capsule.title, capsule.recipientEmail);
  }
}
