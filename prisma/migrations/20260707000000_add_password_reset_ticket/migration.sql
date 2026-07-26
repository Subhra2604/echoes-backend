
-- Migration: support OTP-once, verify-then-reset password flow
--
-- Adds two nullable timestamps to EmailVerificationToken:
--   verifiedAt -> set when a PASSWORD_RESET OTP is successfully checked via
--                 POST /auth/verify-email (proves email/OTP ownership).
--   resetAt    -> set once that verified ticket has actually been spent by
--                 POST /auth/reset-password, so it cannot be replayed.
--
-- Apply with: psql "$DATABASE_URL" -f migration.sql
 
ALTER TABLE "EmailVerificationToken"
  ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
 
ALTER TABLE "EmailVerificationToken"
  ADD COLUMN IF NOT EXISTS "resetAt" TIMESTAMP(3);


  