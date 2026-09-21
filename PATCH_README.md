# Echoes Backend Patch — Scheduled Messages, Guardians, Time Capsules v2, Contacts+Groups, Notifications v2

This patch closes the gap between what `prisma/schema.prisma` already
declared and what the running code (and database) actually had. The schema
was written ahead of the implementation: it already modeled `Guardian`,
`CapsuleRecipient`, `ScheduledMessage`/`ScheduledMessageRecipient`, the full
`NotificationType` enum, and `DeviceToken.isActive/deviceId/appVersion` — but
the migration folder for those models was empty, the generated Prisma client
was stale, and none of the service/route code existed yet. This patch adds
all of it.

## How to apply

```bash
tar -xzf echoes-patch.tar.gz -C /path/to/echoes-backend
cd /path/to/echoes-backend
bash apply-patch.sh
```

Then restart both processes:

```bash
npm run dev          # API
npm run worker:dev   # BullMQ workers
```

The migration is fully idempotent (`CREATE TABLE IF NOT EXISTS`, `DO $$ ...
EXCEPTION WHEN duplicate_object`, `ADD VALUE IF NOT EXISTS`), so re-running
`apply-patch.sh` is always safe.

## What's new

### 1. Scheduled Messages (new module)
Timezone-aware, one-off "occasion" messages (birthday, anniversary, ...) an
owner schedules for one or more of their VERIFIED contacts. Delivery uses
BullMQ **delayed jobs** (not a daily cron) so a message fires at the exact
scheduled instant rather than the next sweep. At fire time, each recipient
gets an email always, plus an in-app + push notification if they have an
Echoes account.

```
POST   /api/scheduled-messages
GET    /api/scheduled-messages          ?filter=for_me|scheduled_by_me&status=&search=&page=&limit=
GET    /api/scheduled-messages/:id
PATCH  /api/scheduled-messages/:id      (owner-only, while PENDING)
DELETE /api/scheduled-messages/:id      (owner-only)
```

### 2. Contact-based Guardians (new endpoints alongside the existing invitation flow)
A **Guardian** is a separate concept from the existing email-invited
`GuardianInvitation` (30-day expiry, accept/decline, memorial activation).
It's an instant assignment on top of an already-VERIFIED contact, and it
grants **schedule-only** edit rights on any Time Capsule that names it as
guardian.

```
POST   /api/guardians                   { contactId }
GET    /api/guardians
GET    /api/guardians/:guardianId
DELETE /api/guardians/:guardianId       (blocked while linked to any active capsule)
GET    /api/guardians/dashboard         everything the caller guards
```

The existing `/api/guardians/invitations`, `/api/guardians/owners`, and
`/api/guardians/owners/:id/activate` routes are untouched.

### 3. Time Capsules v2 (rewritten module)
Capsules now support **multiple contact-based recipients** and an optional
**contact-based guardian**, while every existing single-recipient
(`recipientEmail`/`recipientUserId`) capsule keeps working exactly as before
— both paths are live at once, chosen automatically at release time based on
whether the capsule has any `CapsuleRecipient` rows.

```
POST   /api/capsules                    now accepts contactIds[] + guardianId
GET    /api/capsules
GET    /api/capsules/:id
PATCH  /api/capsules/:id                owner-only, full edit
DELETE /api/capsules/:id
PATCH  /api/capsules/:id/schedule       guardian-only — schedule fields ONLY
GET    /api/capsules/:id/contacts
POST   /api/capsules/:id/contacts
DELETE /api/capsules/:id/contacts/:contactId
PUT    /api/capsules/:id/guardian
POST   /api/capsules/:id/guardian-release   (legacy invitation-guardian path, unchanged)
```

The guardian schedule-only PATCH is enforced twice: the DTO only accepts
`scheduleDate`/`releaseAt`/`timezone`/`recurMonth`/`recurDay`, and the service
verifies the caller's user id matches the assigned Guardian's underlying
contact before touching anything.

Multi-recipient release is idempotent per `(capsule, recipient, year)` via a
database unique index — a duplicate BullMQ job run is a no-op, not a
duplicate email.

### 4. Combined Contacts + Groups endpoint (new)
A single call for picker UIs that need both lists at once:

```
GET /api/contacts-groups?search=&status=&page=&limit=&groupLimit=
→ { contacts: [...], groups: [...], pagination: {...} }
```

This is a read-only aggregator over the existing `contacts` and `groups`
modules — it introduces no new source of truth, so any future change to
contact or group semantics in their own modules is automatically reflected
here.

### 5. Notifications v2 (extended)
- `GET /api/notifications` now accepts `isRead`, `type`, `referenceType`,
  `referenceId`, `page`, `limit` filters and returns a paginated envelope.
  (If you call it with only the old `unreadOnly` flag, you still get the old
  bare-array shape back — nothing breaks for existing clients.)
- `PATCH /api/notifications/:id { isRead }` — toggle read/unread. The old
  `POST /:id/read` route still works too.
- `POST /api/notifications/device-tokens` now accepts optional `deviceId` and
  `appVersion` for per-install tracking.
- Dead push tokens are now flipped to `isActive: false` instead of deleted,
  so device history survives (per spec §19). A token FCM later resurrects is
  automatically re-activated on the next registration call.
- Every notification row now carries `referenceId`/`referenceType` at the top
  level (surfaced from the `data` JSON column) so the frontend can deep-link
  without knowing each feature's internal payload shape.

### Push notifications — no APNs setup needed
Firebase Cloud Messaging (already wired up via `FIREBASE_SERVICE_ACCOUNT_BASE64`)
bridges to APNs internally, so iOS push works through the existing FCM
integration. No separate Apple Push Notification service credentials or
environment variables were added by this patch.

## New NotificationType values
`GUARDIAN_ASSIGNED`, `GUARDIAN_REMOVED`, `CAPSULE_ASSIGNED`,
`CAPSULE_SCHEDULE_CHANGED`, `SCHEDULED_MESSAGE_CREATED`,
`SCHEDULED_MESSAGE_SENT`, `SCHEDULED_MESSAGE_FAILED`.

## Files touched
```
prisma/migrations/20260920003645_scheduled_messages_guardian_capsule/migration.sql   (new)
src/modules/scheduled-messages/*                                                     (new module)
src/modules/guardians/guardians.contact.dto.ts                                       (new)
src/modules/guardians/guardians.contact.service.ts                                   (new)
src/modules/guardians/guardians.contact.routes.ts                                    (new)
src/modules/guardians/guardians.routes.ts                                            (modified — mounts the new contact router)
src/modules/capsules/capsules.dto.ts                                                 (rewritten)
src/modules/capsules/capsules.service.ts                                             (rewritten)
src/modules/capsules/capsules.routes.ts                                              (rewritten)
src/modules/contacts-groups/contacts-groups.routes.ts                                (new module)
src/modules/notifications/notifications.dto.ts                                       (extended)
src/modules/notifications/notifications.service.ts                                   (extended)
src/modules/notifications/notifications.routes.ts                                    (extended)
src/app.ts                                                                           (modified — mounts 2 new routers)
src/worker.ts                                                                        (modified — registers the new worker)
src/openapi.ts                                                                       (modified — registers every new endpoint so it shows in Swagger UI)
apply-patch.sh                                                                       (new)
```

Nothing in `guardians.service.ts` (the invitation flow), `guardians.dto.ts`,
or `capsules.worker.ts`/`capsules.scheduler.ts` was touched — they're reused
as-is.

## Swagger UI
This project documents its API by hand in `src/openapi.ts` (explicit
`registry.registerPath(...)` calls per route) rather than generating the spec
from the Express router — so a route can work perfectly via curl/Postman while
being invisible in Swagger if nobody registered it there. This patch adds
`registerPath` entries for every new endpoint (Scheduled Messages, the
contact-based Guardian endpoints, the new Capsule sub-resources, the combined
Contacts+Groups endpoint, and the Notifications v2 additions) so they all show
up at `/docs` after applying. A few pre-existing Guardian entries in that file
(e.g. `/api/guardians/mine`, `/api/guardians/i-guard`) were already stale
relative to the real routes before this patch — that drift predates this
change and was left as-is to avoid touching unrelated documentation.
