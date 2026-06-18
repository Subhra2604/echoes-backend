import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(10, 'Use at least 10 characters'),
  fullName: z.string().min(1).max(120),
  timezone: z.string().default('America/New_York'),
});

// Verify with 6-digit OTP rather than an opaque link token.
export const verifyEmailSchema = z.object({
  email: z.string().email().toLowerCase(),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
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

export type RegisterInput = z.infer<typeof registerSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ResendOtpInput = z.infer<typeof resendOtpSchema>;
export type LoginInput = z.infer<typeof loginSchema>;