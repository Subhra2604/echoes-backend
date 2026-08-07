-- Standalone migration for the ALTER TYPE ... ADD VALUE.
--
-- Postgres requires a new enum value to be committed before it can be
-- REFERENCED (e.g. inside a CHECK constraint). Prisma runs each migration
-- in its own transaction, so this alteration lives in its own file. The
-- following migration (20260804000001_add_written_vault_sharing) is the one
-- that actually USES 'WRITTEN_VAULT' in the CHECK constraint — it will run
-- in a fresh transaction, after this one has committed.

ALTER TYPE "SharedContentType" ADD VALUE IF NOT EXISTS 'WRITTEN_VAULT';
