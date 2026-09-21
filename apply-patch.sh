#!/usr/bin/env bash
set -euo pipefail

# Echoes backend patch — apply script.
#
# Run this from the root of your echoes-backend checkout AFTER extracting
# the patch tarball on top of it:
#
#   tar -xzf echoes-patch.tar.gz -C /path/to/echoes-backend
#   cd /path/to/echoes-backend
#   bash apply-patch.sh
#
# What this does:
#   1. npm install       — no new runtime dependencies were introduced, but
#                           this keeps node_modules consistent with package-lock.
#   2. prisma generate    — regenerates the Prisma client from schema.prisma.
#                           schema.prisma already contains every model this
#                           patch needs (Guardian, CapsuleRecipient,
#                           ScheduledMessage, ScheduledMessageRecipient, the
#                           extended NotificationType enum, DeviceToken's
#                           isActive/deviceId/appVersion) — only the generated
#                           client and the database were behind.
#   3. prisma migrate deploy — applies the migration shipped in this patch
#                           (prisma/migrations/20260920..._scheduled_messages_
#                           guardian_capsule/migration.sql). Every statement in
#                           it is idempotent (CREATE ... IF NOT EXISTS / DO $$
#                           ... EXCEPTION WHEN duplicate_object), so it is safe
#                           to run against a fresh database or one that already
#                           has some of these objects from a partial attempt.

echo "── Installing dependencies ─────────────────────────────────────────"
npm install

echo "── Regenerating Prisma client ──────────────────────────────────────"
npx prisma generate

echo "── Applying database migration ─────────────────────────────────────"
npx prisma migrate deploy

echo ""
echo "✅ Patch applied."
echo ""
echo "Next steps:"
echo "  1. Restart the API:    npm run dev      (or your prod start command)"
echo "  2. Restart the worker: npm run worker:dev"
echo ""
echo "See PATCH_README.md for the full list of new/changed endpoints."
