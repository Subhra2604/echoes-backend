-- ============================================================================
-- Fix: DeviceToken.isActive / deviceId / appVersion were never actually added.
--
-- schema.prisma has declared these three columns on DeviceToken since the
-- Notifications v2 patch (see PATCH_README.md, which claims this migration
-- added them), and notifications.service.ts#registerDeviceToken reads/writes
-- all three unconditionally. But no migration file in this repo's history
-- ever ran the ALTER TABLE for them — the original 20260716000000_add_
-- device_tokens migration only created id/userId/token/platform/lastSeenAt/
-- createdAt. Every call to POST /api/notifications/device-tokens has been
-- failing at the database with:
--   error 42703: column "deviceId" of relation "DeviceToken" does not exist
-- which surfaces to API clients as a bare 500 with no detail.
--
-- IF NOT EXISTS / IF EXISTS guards make this safe to re-run in any
-- environment, matching the idempotent style used elsewhere in this project
-- (see apply-patch.sh).
-- ============================================================================

ALTER TABLE "DeviceToken" ADD COLUMN IF NOT EXISTS "deviceId" TEXT;
ALTER TABLE "DeviceToken" ADD COLUMN IF NOT EXISTS "appVersion" TEXT;
ALTER TABLE "DeviceToken" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS "DeviceToken_userId_isActive_idx" ON "DeviceToken"("userId", "isActive");
