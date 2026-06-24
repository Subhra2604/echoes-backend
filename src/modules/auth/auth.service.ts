import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import crypto, { randomUUID } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { Errors, AppError } from '../../lib/errors.js';
import { hashToken } from '../../lib/crypto.js';
import { verify as verifyTotp } from './auth.totp.js';
import {
  sendVerificationOtp,
  sendPasswordResetOtp,
} from '../notifications/notifications.service.js';
import type {
  RegisterInput,
  VerifyEmailInput,
  LoginInput,
  ResetPasswordInput,
} from './auth.dto.js';

// OTP policy. Keep these tight: 6 digits = 1M space, attempts are the only
// real defence against online brute-force.
const OTP_TTL_MS = 10 * 60_000;        // 10 minutes
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60_000;     // 1 minute between resends

type OtpPurpose = 'VERIFY_EMAIL' | 'PASSWORD_RESET';

/** Cryptographically uniform 6-digit code (no modulo bias). */
function generateOtp(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export async function register(input: RegisterInput): Promise<{ userId: string }> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw Errors.conflict('An account with that email already exists');

  const passwordHash = await argon2.hash(input.password);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      fullName: input.fullName,
      timezone: input.timezone,
      isFamilyUser: true,
      vault: { create: {} },
    },
  });

  await issueOtp(user.id, user.email, 'VERIFY_EMAIL');
  return { userId: user.id };
}

/**
 * Generate a fresh OTP for a given purpose, invalidate any in-flight ones of
 * the same purpose for this user, send the appropriate email.
 *
 * Used by signup, resend-verification, forgot-password, and resend-reset.
 */
async function issueOtp(
  userId: string,
  email: string,
  purpose: OtpPurpose,
): Promise<void> {
  // Invalidate any previous unconsumed OTP of THIS purpose so the latest sent
  // code is the only accepted one (and attackers can't run two attempt windows
  // in parallel). Note we scope by purpose so a pending VERIFY_EMAIL doesn't
  // collide with a fresh PASSWORD_RESET request and vice-versa.
  await prisma.emailVerificationToken.updateMany({
    where: { userId, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const otp = generateOtp();

  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash: hashToken(otp),
      purpose,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });

  // Useful in dev when SES isn't wired up — the OTP is also in the email body.
  if (env.NODE_ENV !== 'production') {
    const label = purpose === 'VERIFY_EMAIL' ? 'verification' : 'password reset';
    console.log(`[dev] ${label} OTP for ${email}: ${otp}`);
  }

  // if (purpose === 'VERIFY_EMAIL') {
  //   await sendVerificationOtp(email, otp);
  // } else {
  //   await sendPasswordResetOtp(email, otp);
  // }
}

export async function verifyEmail(input: VerifyEmailInput): Promise<void> {
  const generic = Errors.badRequest('Verification code is invalid or has expired');

  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) throw generic;

  if (user.emailVerifiedAt) return;

  const record = await prisma.emailVerificationToken.findFirst({
    where: { userId: user.id, purpose: 'VERIFY_EMAIL', consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) throw generic;

  if (record.expiresAt < new Date()) {
    await prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
    throw generic;
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    await prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
    throw Errors.badRequest('Too many incorrect attempts. Please request a new code.');
  }

  // ── DEV BYPASS ────────────────────────────────────────────────────────────
  // In non-production environments, the fixed code "123456" is accepted in
  // addition to the real OTP. This makes Swagger / Postman testing painless
  // when SES isn't wired up. The production guard makes it physically
  // impossible to ship if env config is wrong (process exits at boot).
  const isDevBypass =
    env.NODE_ENV !== 'production' && input.otp === '123456';

  let matches = isDevBypass;
  if (!matches) {
    const got = Buffer.from(hashToken(input.otp));
    const want = Buffer.from(record.tokenHash);
    matches =
      got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  if (!matches) {
    await prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    throw generic;
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    }),
    prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    }),
  ]);
}

/**
 * Resend a verification OTP. Silently no-ops for unknown/verified accounts so
 * the response doesn't reveal account existence. 60-second cooldown caps email
 * bombing.
 */
export async function resendVerificationOtp(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return;             // don't reveal non-existence
  if (user.emailVerifiedAt) return;

  const latest = await prisma.emailVerificationToken.findFirst({
    where: { userId: user.id, purpose: 'VERIFY_EMAIL' },
    orderBy: { createdAt: 'desc' },
  });
  if (latest) {
    const sinceMs = Date.now() - latest.createdAt.getTime();
    if (sinceMs < RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((RESEND_COOLDOWN_MS - sinceMs) / 1000);
      throw Errors.tooManyRequests(
        `Please wait ${waitSec} seconds before requesting a new code`,
      );
    }
  }

  await issueOtp(user.id, user.email, 'VERIFY_EMAIL');
}

// ── Forgot / reset password ─────────────────────────────────────────────────

/**
 * Start the password-reset flow. Silently no-ops for unknown accounts and for
 * accounts without a local password (OAuth-only). 60s cooldown matches the
 * signup-resend pattern so the team has a single mental model for OTP issuance.
 *
 * The same dev bypass applies at verify time (POST /auth/reset-password):
 * "123456" is accepted whenever NODE_ENV !== "production".
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return;              // don't reveal non-existence
  if (!user.passwordHash) return; // OAuth-only accounts can't reset a password

  const latest = await prisma.emailVerificationToken.findFirst({
    where: { userId: user.id, purpose: 'PASSWORD_RESET' },
    orderBy: { createdAt: 'desc' },
  });
  if (latest) {
    const sinceMs = Date.now() - latest.createdAt.getTime();
    if (sinceMs < RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((RESEND_COOLDOWN_MS - sinceMs) / 1000);
      throw Errors.tooManyRequests(
        `Please wait ${waitSec} seconds before requesting a new code`,
      );
    }
  }

  await issueOtp(user.id, user.email, 'PASSWORD_RESET');
}

/**
 * Finalize the password reset: verify OTP, set the new password hash,
 * and revoke every live session for that user so a stolen access token
 * is invalidated as part of the reset.
 */
export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  // Generic error reused for every failure path — never leak whether the user
  // exists, whether the OTP was wrong, or whether it was expired.
  const generic = Errors.badRequest('Reset code is invalid or has expired');

  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) throw generic;
  if (!user.passwordHash) throw generic;   // OAuth-only — no password to reset

  const record = await prisma.emailVerificationToken.findFirst({
    where: { userId: user.id, purpose: 'PASSWORD_RESET', consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) throw generic;

  if (record.expiresAt < new Date()) {
    await prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
    throw generic;
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    await prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
    throw Errors.badRequest('Too many incorrect attempts. Please request a new code.');
  }

  // Same dev bypass as verifyEmail. "123456" is accepted in non-prod envs only.
  const isDevBypass =
    env.NODE_ENV !== 'production' && input.otp === '123456';

  let matches = isDevBypass;
  if (!matches) {
    const got = Buffer.from(hashToken(input.otp));
    const want = Buffer.from(record.tokenHash);
    matches =
      got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  if (!matches) {
    await prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    throw generic;
  }

  const newHash = await argon2.hash(input.newPassword);

  // Set the new password, burn the OTP, and revoke every live session in one
  // shot. Revoking sessions is a defence-in-depth measure: if an attacker had
  // somehow obtained a valid token, they're kicked out as part of the reset.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    }),
    prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    }),
    prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

// ── session / login / logout (unchanged) ───────────────────────────────────

export interface LoginResult {
  accessToken: string;
  expiresInMinutes: number;
  user: { id: string; email: string; fullName: string };
}

export async function issueSession(
  user: { id: string; email: string; fullName: string },
  meta: { ip?: string; userAgent?: string },
): Promise<LoginResult> {
  const tokenId = randomUUID();
  const absoluteTtlMs = env.SESSION_ABSOLUTE_TTL_HOURS * 3600_000;
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenId,
      expiresAt: new Date(Date.now() + absoluteTtlMs),
      ip: meta.ip,
      userAgent: meta.userAgent,
    },
  });
  const accessToken = jwt.sign({ sub: user.id, jti: tokenId }, env.JWT_SECRET, {
    expiresIn: `${env.SESSION_IDLE_TIMEOUT_MIN}m`,
  });
  return {
    accessToken,
    expiresInMinutes: env.SESSION_IDLE_TIMEOUT_MIN,
    user: { id: user.id, email: user.email, fullName: user.fullName },
  };
}

export async function login(
  input: LoginInput,
  meta: { ip?: string; userAgent?: string },
): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user || !user.passwordHash) throw Errors.unauthorized('Invalid credentials');

  const ok = await argon2.verify(user.passwordHash, input.password);
  if (!ok) throw Errors.unauthorized('Invalid credentials');

  if (!user.emailVerifiedAt) {
    throw Errors.forbidden('Please verify your email before signing in');
  }

  if (user.totpEnabled) {
    if (!input.totpCode) throw new AppError(401, 'TOTP_REQUIRED', 'Authenticator code required');
    if (!user.totpSecret || !verifyTotp(user.totpSecret, input.totpCode)) {
      throw Errors.unauthorized('Invalid authenticator code');
    }
  }
  return issueSession(user, meta);
}

export async function logout(tokenId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { tokenId },
    data: { revokedAt: new Date() },
  });
}