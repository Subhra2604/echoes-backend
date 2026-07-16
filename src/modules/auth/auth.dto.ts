import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(10, 'Use at least 10 characters'),
  fullName: z.string().min(1).max(120),
  timezone: z.string().default('America/New_York'),
});

// Shared 6-digit OTP verification for both signup email verification and
// password-reset confirmation. `purpose` picks which ticket/side-effects
// apply — see verifyCode() in auth.service.ts.
export const verifyCodeSchema = z.object({
  email: z.string().email().toLowerCase(),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
  purpose: z.enum(['VERIFY_EMAIL', 'PASSWORD_RESET']),
});

// Re-issue a new OTP (rate-limited at the service layer).
export const resendOtpSchema = z.object({
  email: z.string().email().toLowerCase(),
});

export const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});

export const totpVerifySchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});

// ── Password reset ──────────────────────────────────────────────────────────
// Three-step flow:
//   1. POST /auth/forgot-password { email }                                    → OTP is sent
//   2. POST /auth/verify-email     { email, otp, purpose: "PASSWORD_RESET" }     → OTP is checked, ticket is marked verified
//   3. POST /auth/reset-password  { email, newPassword }                       → verified ticket is consumed, password is changed

export const forgotPasswordSchema = z.object({
  email: z.string().email().toLowerCase(),
});

export const resetPasswordSchema = z.object({
  email: z.string().email().toLowerCase(),
  newPassword: z.string().min(10, 'Use at least 10 characters'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type VerifyCodeInput = z.infer<typeof verifyCodeSchema>;
export type ResendOtpInput = z.infer<typeof resendOtpSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
