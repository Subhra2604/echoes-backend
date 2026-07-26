-- Migration: push notifications — device token registry
--
-- Adds a DeviceToken table so notify() can fan out to FCM instead of just
-- logging. One row per installed app instance (token is globally unique, not
-- per-user, so re-logging in on a shared device re-homes it).
--
-- Apply with: psql "$DATABASE_URL" -f migration.sql

DO $$ BEGIN
  CREATE TYPE "DevicePlatform" AS ENUM ('IOS', 'ANDROID', 'WEB');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "DeviceToken" (
  "id"         UUID NOT NULL PRIMARY KEY,
  "userId"     UUID NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "token"      TEXT NOT NULL,
  "platform"   "DevicePlatform" NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "DeviceToken_token_key" ON "DeviceToken"("token");
CREATE INDEX IF NOT EXISTS "DeviceToken_userId_idx" ON "DeviceToken"("userId");
