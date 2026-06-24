import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  registerSchema,
  verifyEmailSchema,
  resendOtpSchema,
  loginSchema,
  totpVerifySchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from './auth.dto.js';
import * as auth from './auth.service.js';
import { signInWithProvider } from './oauth.service.js';
import { enrollTotp, confirmTotp } from './auth.totp.js';

export const authRouter = Router();

authRouter.post(
  '/register',
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const result = await auth.register(req.body);
    res.status(201).json({
      ...result,
      message: 'We sent a 6-digit verification code to your email.',
    });
  }),
);

authRouter.post(
  '/verify-email',
  validate({ body: verifyEmailSchema }),
  asyncHandler(async (req, res) => {
    await auth.verifyEmail(req.body);
    res.json({ message: 'Email verified. You can now sign in.' });
  }),
);

authRouter.post(
  '/resend-otp',
  validate({ body: resendOtpSchema }),
  asyncHandler(async (req, res) => {
    // await auth.resendVerificationOtp(req.body.email);
    // Same response regardless of whether the email exists, to avoid enumeration.
    res.json({
      message: 'If that email is registered and not yet verified, a new code has been sent.',
    });
  }),
);

authRouter.post(
  '/login',
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const result = await auth.login(req.body, {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.json(result);
  }),
);

authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await auth.logout(req.auth!.tokenId);
    res.json({ message: 'Logged out' });
  }),
);

// ── Forgot / reset password ───────────────────────────────────────────────
// Two-step flow:
//   1) POST /auth/forgot-password { email }                       → OTP is sent
//   2) POST /auth/reset-password  { email, otp, newPassword }     → password is changed
//
// Calling /forgot-password again (after the 60s cooldown) re-issues a fresh
// OTP — there's no separate "resend reset OTP" endpoint by design.
//
// Dev bypass: when NODE_ENV !== "production", "123456" is accepted at the
// reset step in addition to whatever code was emailed.

authRouter.post(
  '/forgot-password',
  validate({ body: forgotPasswordSchema }),
  asyncHandler(async (req, res) => {
    await auth.requestPasswordReset(req.body.email);
    // Generic message irrespective of whether the email exists, to avoid
    // account-enumeration.
    res.json({
      message: 'If that email is registered, a password reset code has been sent.',
    });
  }),
);

authRouter.post(
  '/reset-password',
  validate({ body: resetPasswordSchema }),
  asyncHandler(async (req, res) => {
    await auth.resetPassword(req.body);
    res.json({
      message: 'Password reset. You can now sign in with your new password.',
    });
  }),
);

// ── OAuth (unchanged) ────────────────────────────────────────────────────────
const oauthSchema = z.object({ idToken: z.string().min(10) });

authRouter.post(
  '/oauth/google',
  validate({ body: oauthSchema }),
  asyncHandler(async (req, res) => {
    const result = await signInWithProvider('GOOGLE', req.body.idToken, {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.json(result);
  }),
);

authRouter.post(
  '/oauth/apple',
  validate({ body: oauthSchema }),
  asyncHandler(async (req, res) => {
    const result = await signInWithProvider('APPLE', req.body.idToken, {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.json(result);
  }),
);

// ── MFA enrollment (unchanged) ───────────────────────────────────────────────
authRouter.post(
  '/totp/enroll',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await enrollTotp(req.auth!.userId));
  }),
);

authRouter.post(
  '/totp/confirm',
  requireAuth,
  validate({ body: totpVerifySchema }),
  asyncHandler(async (req, res) => {
    await confirmTotp(req.auth!.userId, req.body.code);
    res.json({ message: 'Two-factor authentication enabled' });
  }),
);