import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/email.js';
import { logger } from '../../lib/logger.js';
import type { NotificationType } from '../../generated/prisma/enums.js';

/**
 * Notifications service. [GAP §7] the client requires push + email + in-app.
 *  - in-app  -> a Notification row (the bell feed), via `notify()`
 *  - email   -> transactional SES messages (verification, invites, capsules)
 *  - push    -> stubbed for MVP (no device-token table yet); see `dispatchPush`.
 *
 * `notify()` is the single entry point other modules call to create an in-app
 * notification; it also fans out to push.
 */

export async function notify(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await prisma.notification.create({
  data: { userId, type, title, body, data: (data ?? undefined) as any},
});
  await dispatchPush(userId, title, body);
}

/**
 * Push fan-out. MVP stub: there is no device-token registry yet, so this only
 * logs. When mobile push (FCM/APNs) is wired up, look up the user's device
 * tokens here and send. Kept as a separate function so the call sites in
 * `notify()` do not change when push lands.
 */
async function dispatchPush(userId: string, title: string, _body: string): Promise<void> {
  logger.debug({ userId, title }, 'push notification (stub — no device tokens yet)');
}

// ── In-app feed (the notification bell) ───────────────────────────────────────

export async function listNotifications(userId: string, unreadOnly = false) {
  return prisma.notification.findMany({
    where: { userId, ...(unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function markRead(userId: string, notificationId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { readAt: new Date() },
  });
}

export async function markAllRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
}

// ── Transactional emails ──────────────────────────────────────────────────────

export async function sendVerificationEmail(email: string, link: string): Promise<void> {
  await sendEmail({
    to: email,
    subject: 'Verify your Echoes account',
    text: `Welcome to Echoes. Please verify your email by visiting: ${link}\n\nThis link expires in 24 hours.`,
    html: emailShell(
      'Verify your email',
      `<p>Welcome to Echoes. Please confirm this is your email address to finish setting up your account.</p>
       ${button('Verify email', link)}
       <p style="color:#6b7280;font-size:13px">This link expires in 24 hours. If you didn’t create an account, you can ignore this message.</p>`,
    ),
  });
}

export async function sendGuardianInvitationEmail(guardianEmail: string, link: string): Promise<void> {
  await sendEmail({
    to: guardianEmail,
    subject: 'You’ve been invited to be a Legacy Guardian on Echoes',
    text: `You have been invited to act as a Legacy Guardian on Echoes. Accept or decline here: ${link}\n\nThis invitation expires in 30 days.`,
    html: emailShell(
      'Legacy Guardian invitation',
      `<p>Someone has chosen you as a <strong>Legacy Guardian</strong> on Echoes. A guardian helps care for a loved one’s digital legacy.</p>
       ${button('View invitation', link)}
       <p style="color:#6b7280;font-size:13px">This invitation expires in 30 days.</p>`,
    ),
  });
}

export async function sendCapsuleEmail(
  recipientEmail: string,
  capsule: { title: string; message: string | null; hasAccount: boolean },
): Promise<void> {
  const signup = capsule.hasAccount
    ? ''
    : `<p style="color:#6b7280;font-size:13px">A free Echoes account lets you keep this message and any media forever.</p>`;
  await sendEmail({
    to: recipientEmail,
    subject: `A message has arrived for you: “${capsule.title}”`,
    text: `${capsule.title}\n\n${capsule.message ?? '(This message includes media — open Echoes to view it.)'}`,
    html: emailShell(
      capsule.title,
      `<p style="white-space:pre-wrap">${escapeHtml(capsule.message ?? 'This message includes media — open Echoes to view it.')}</p>
       ${signup}`,
    ),
  });
}

export async function sendCapsuleReturnedToGuardian(
  guardianEmail: string,
  capsuleTitle: string,
  recipientEmail: string,
): Promise<void> {
  await sendEmail({
    to: guardianEmail,
    subject: `A capsule could not be delivered: “${capsuleTitle}”`,
    text: `The capsule "${capsuleTitle}" could not be delivered to ${recipientEmail} (the email bounced). It has been returned to you as the guardian.`,
    html: emailShell(
      'A capsule was returned to you',
      `<p>The capsule <strong>${escapeHtml(capsuleTitle)}</strong> could not be delivered to <strong>${escapeHtml(recipientEmail)}</strong> — the email bounced.</p>
       <p>It has been returned to you as the guardian so you can follow up with the recipient.</p>`,
    ),
  });
}

// ── tiny HTML helpers (no template engine needed for a handful of emails) ──────

function emailShell(heading: string, inner: string): string {
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;padding:24px">
    <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e7eb">
      <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>
      ${inner}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
      <p style="color:#9ca3af;font-size:12px;margin:0">Echoes — preserving what matters.</p>
    </div></body></html>`;
}

function button(label: string, href: string): string {
  return `<p><a href="${href}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${escapeHtml(label)}</a></p>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function sendVerificationOtp(toEmail: string, otp: string): Promise<void> {
  await sendEmail({
    to: toEmail,
    subject: 'Your Echoes verification code',
    text: `Your verification code is ${otp}. It expires in 10 minutes.\n\nIf you did not request this, you can safely ignore this message.`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;padding:24px">
        <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e7eb">
          <h1 style="font-size:20px;margin:0 0 16px">Verify your email</h1>
          <p style="margin:0 0 12px">Your verification code is:</p>
          <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0;text-align:center">${otp}</p>
          <p style="color:#6b7280;font-size:13px;margin:0">This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
        </div>
      </div>
    `,
  });
}

export async function sendPasswordResetOtp(toEmail: string, otp: string): Promise<void> {
  await sendEmail({
    to: toEmail,
    subject: 'Your Echoes password reset code',
    text: `Your password reset code is ${otp}. It expires in 10 minutes.\n\nIf you didn't request a reset, you can safely ignore this message — your password will not change.`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;padding:24px">
        <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e7eb">
          <h1 style="font-size:20px;margin:0 0 16px">Reset your password</h1>
          <p style="margin:0 0 12px">Use this code to reset your password:</p>
          <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0;text-align:center">${otp}</p>
          <p style="color:#6b7280;font-size:13px;margin:0">This code expires in 10 minutes. If you didn't request a reset, you can ignore this email — your password will not change.</p>
        </div>
      </div>
    `,
  });
}