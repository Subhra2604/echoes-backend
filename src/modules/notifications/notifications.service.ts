import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/email.js';
import { sendPush } from '../../lib/push.js';
import { logger } from '../../lib/logger.js';
import type { NotificationType } from '../../generated/prisma/enums.js';
import type { DevicePlatform } from '../../generated/prisma/enums.js';

/**
 * Notifications service. [GAP §7] the client requires push + email + in-app.
 *  - in-app  -> a Notification row (the bell feed), via `notify()`
 *  - email   -> transactional SES messages (verification, invites, capsules)
 *  - push    -> Firebase Cloud Messaging fan-out to the user's device tokens.
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
  await dispatchPush(userId, title, body, data);
}

/**
 * Push fan-out: look up every device token registered for this user and send
 * through FCM. Tokens FCM reports as dead (app uninstalled, token rotated) are
 * pruned so the registry doesn't grow stale.
 */
async function dispatchPush(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const devices = await prisma.deviceToken.findMany({
    where: { userId },
    select: { token: true },
  });
  if (devices.length === 0) return;

  const { invalidTokens } = await sendPush(devices.map((d) => d.token), title, body, data);
  if (invalidTokens.length > 0) {
    await prisma.deviceToken.deleteMany({ where: { token: { in: invalidTokens } } });
  }
}

/**
 * Register (or re-home) a device's FCM token. Tokens are unique per device,
 * not per user — upserting by token means logging in as a different user on
 * the same device correctly moves future push there.
 */
export async function registerDeviceToken(
  userId: string,
  token: string,
  platform: DevicePlatform,
): Promise<void> {
  await prisma.deviceToken.upsert({
    where: { token },
    update: { userId, platform, lastSeenAt: new Date() },
    create: { userId, token, platform },
  });
}

export async function removeDeviceToken(userId: string, token: string): Promise<void> {
  await prisma.deviceToken.deleteMany({ where: { userId, token } });
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

/**
 * Contact invitation email sent when a user adds a non-Echoes email to their
 * contact list. Encourages the recipient to sign up so their pending row
 * auto-flips to VERIFIED when they complete OTP verification (see
 * `reconcilePendingContactsOnVerify` in the contacts service).
 */
export async function sendContactInvitationEmail(
  inviteeEmail: string,
  inviterName: string,
  signupUrl: string,
): Promise<void> {
  await sendEmail({
    to: inviteeEmail,
    subject: `${inviterName} added you as a contact on Echoes`,
    text: `${inviterName} added you as a contact on Echoes — a private space to preserve and share what matters.

Join Echoes to reconnect: ${signupUrl}

When you sign up with this email address, your connection will be linked automatically.

— The Echoes Team
support@echoesremembered.com`,
    html: emailShell({
      preheader: `${inviterName} added you as a contact on Echoes.`,
      heading: `${escapeHtml(inviterName)} added you as a contact on Echoes`,
      inner: `
        <p style="margin:0 0 4px;color:#374151;font-size:15px;line-height:1.6"><strong>${escapeHtml(inviterName)}</strong> would like to stay connected on Echoes — a private space to preserve and share what matters.</p>
        ${button('Join Echoes', signupUrl)}
        <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0">Sign up with <strong>${escapeHtml(inviteeEmail)}</strong> and your connection will be linked automatically.</p>
      `,
    }),
  });
}

export async function sendGuardianInvitationEmail(guardianEmail: string, link: string): Promise<void> {
  await sendEmail({
    to: guardianEmail,
    subject: 'You’ve been invited to be a Legacy Guardian on Echoes',
    text: `You have been invited to act as a Legacy Guardian on Echoes.

Accept or decline here: ${link}

This invitation expires in 30 days.

— The Echoes Team
support@echoesremembered.com`,
    html: emailShell({
      preheader: 'You’ve been invited to be a Legacy Guardian on Echoes.',
      heading: 'Legacy Guardian invitation',
      inner: `
        <p style="margin:0 0 4px;color:#374151;font-size:15px;line-height:1.6">Someone has chosen you as a <strong>Legacy Guardian</strong> on Echoes. A guardian helps care for a loved one’s digital legacy.</p>
        ${button('View invitation', link)}
        <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0">This invitation expires in 30 days.</p>
      `,
    }),
  });
}

export async function sendCapsuleEmail(
  recipientEmail: string,
  capsule: { title: string; message: string | null; hasAccount: boolean },
): Promise<void> {
  const signup = capsule.hasAccount
    ? ''
    : `<p style="color:#6b7280;font-size:13px;line-height:1.6;margin:12px 0 0">A free Echoes account lets you keep this message and any media forever.</p>`;
  await sendEmail({
    to: recipientEmail,
    subject: `A message has arrived for you: “${capsule.title}”`,
    text: `${capsule.title}

${capsule.message ?? '(This message includes media — open Echoes to view it.)'}

— The Echoes Team
support@echoesremembered.com`,
    html: emailShell({
      preheader: `A message has arrived for you: “${capsule.title}”`,
      heading: capsule.title,
      inner: `
        <p style="white-space:pre-wrap;margin:0;color:#374151;font-size:15px;line-height:1.6">${escapeHtml(capsule.message ?? 'This message includes media — open Echoes to view it.')}</p>
        ${signup}
      `,
    }),
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
    text: `The capsule "${capsuleTitle}" could not be delivered to ${recipientEmail} — the email bounced.

It has been returned to you as the guardian so you can follow up with the recipient.

— The Echoes Team
support@echoesremembered.com`,
    html: emailShell({
      preheader: `“${capsuleTitle}” could not be delivered and was returned to you.`,
      heading: 'A capsule was returned to you',
      inner: `
        <p style="margin:0 0 12px;color:#374151;font-size:15px;line-height:1.6">The capsule <strong>${escapeHtml(capsuleTitle)}</strong> could not be delivered to <strong>${escapeHtml(recipientEmail)}</strong> — the email bounced.</p>
        <p style="margin:0;color:#374151;font-size:15px;line-height:1.6">It has been returned to you as the guardian so you can follow up with the recipient.</p>
      `,
    }),
  });
}

// ── tiny HTML helpers (no template engine needed for a handful of emails) ──────

// function emailShell(heading: string, inner: string): string {
//   return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;padding:24px">
//     <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e7eb">
//       <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>
//       ${inner}
//       <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
//       <p style="color:#9ca3af;font-size:12px;margin:0">Echoes — preserving what matters.</p>
//     </div></body></html>`;
// }


function emailShell(opts: {
  preheader: string;
  heading: string;
  inner: string;
}): string {
  const { preheader, heading, inner } = opts;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="light"/>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <!-- preheader: shows as preview text, hidden in body -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;overflow:hidden">

        <!-- Header / brand -->
        <tr>
          <td style="padding:28px 32px 0;text-align:center">
            <span style="font-size:20px;font-weight:700;letter-spacing:-0.5px;color:#111827">Echoes</span>
            <span style="display:block;font-size:12px;color:#9ca3af;margin-top:2px">Preserving what matters</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:24px 32px 8px">
            <h1 style="font-size:19px;line-height:1.3;margin:0 0 12px;color:#111827">${escapeHtml(heading)}</h1>
            ${inner}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:8px 32px 28px">
            <hr style="border:none;border-top:1px solid #eceef1;margin:20px 0 16px"/>
            <p style="color:#9ca3af;font-size:12px;line-height:1.5;margin:0">
              Need help? Contact us at
              <a href="mailto:support@echoesremembered.com" style="color:#6b7280">support@echoesremembered.com</a>.
            </p>
            <p style="color:#c0c4cc;font-size:11px;margin:12px 0 0">
              © ${new Date().getFullYear()} Echoes. All rights reserved.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ---------- Reusable code block ----------
function codeBlock(otp: string): string {
  return `
    <div style="margin:20px 0;padding:18px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;text-align:center">
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;font-family:'SFMono-Regular',Consolas,Menlo,monospace;color:#111827">${otp}</div>
    </div>`;
}
function button(label: string, href: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0">
      <tr><td style="border-radius:8px;background:#111827">
        <a href="${href}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(label)}</a>
      </td></tr>
    </table>`;
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
  subject: `${otp} is your Echoes verification code`,
  text: `Welcome to Echoes.

Your verification code is: ${otp}
This code expires in 10 minutes.

If you didn't create an Echoes account, you can safely ignore this email.

— The Echoes Team
support@echoesremembered.com`,
  html: emailShell({
    preheader: `${otp} — your Echoes verification code (expires in 10 minutes)`,
    heading: 'Confirm your email address',
    inner: `
      <p style="margin:0 0 4px;color:#374151;font-size:15px;line-height:1.6">Welcome to Echoes. Use the code below to verify your email and finish setting up your account.</p>
      ${codeBlock(otp)}
      <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0">This code expires in <strong>10 minutes</strong>. If you didn't create an account, you can safely ignore this email.</p>
    `,
  }),
});
}

export async function sendPasswordResetOtp(toEmail: string, otp: string): Promise<void> {
 await sendEmail({
  to: toEmail,
  subject: `${otp} is your Echoes password reset code`,
  text: `We received a request to reset your Echoes password.

Your password reset code is: ${otp}
This code expires in 10 minutes.

If you didn't request a reset, you can ignore this email — your password will not change.

— The Echoes Team
support@echoesremembered.com`,
  html: emailShell({
    preheader: `${otp} — your Echoes password reset code (expires in 10 minutes)`,
    heading: 'Reset your password',
    inner: `
      <p style="margin:0 0 4px;color:#374151;font-size:15px;line-height:1.6">We received a request to reset the password for your Echoes account. Use the code below to continue.</p>
      ${codeBlock(otp)}
      <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 8px">This code expires in <strong>10 minutes</strong>.</p>
      <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0">If you didn't request a reset, you can safely ignore this email — your password will not change, and no action is needed.</p>
    `,
  }),
});
}