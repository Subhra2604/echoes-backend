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
    await auth.resendVerificationOtp(req.body.email);
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