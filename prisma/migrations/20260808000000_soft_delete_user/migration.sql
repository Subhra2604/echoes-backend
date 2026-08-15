-- Migration: Soft-delete lifecycle for User accounts
-- (Product decision: no grace period, no restore endpoint, email freed
--  immediately for reuse by a fresh registration.)
--
-- Changes:
--   1. Drop the plain unique index on User.email.
--   2. Create a PARTIAL unique index — only rows where deletedAt IS NULL are
--      constrained. This lets one active user + N soft-deleted users share
--      the same email string.
--
-- The `deletedAt` column already exists on User (line 268 of schema.prisma).
-- No new column is added by this migration; the change is purely to the
-- uniqueness constraint on email.
--
-- Safe against existing data: all current users have deletedAt IS NULL, so
-- the partial index enforces the exact same constraint as the old full index.

-- 1. Drop the existing full unique index. Prisma created it as an INDEX (not
--    a CONSTRAINT), so DROP INDEX is the right form. IF EXISTS keeps the
--    migration idempotent if it's replayed against a fresh DB.
DROP INDEX IF EXISTS "public"."User_email_key";

-- 2. Create the partial unique index. Constraint semantics:
--      - Two ACTIVE users can never share an email  (uniqueness enforced)
--      - Deleted users don't participate in the check (WHERE deletedAt IS NULL)
--      - New registration with a formerly-deleted email → INSERT succeeds,
--        old row stays put with status DELETED.
CREATE UNIQUE INDEX "User_email_active_key"
  ON "User" ("email")
  WHERE "deletedAt" IS NULL;
