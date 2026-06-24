# Memory & Voice Recording — Backend Implementation

This change adds the **Memory** and **Voice Recording** modules using the **same
presigned-S3 upload architecture** as the Profile avatar. Files go **browser → S3
directly**; the API only validates, presigns, and stores **metadata**.

## 1. Run it

```bash
# 1. Install deps
npm install

# 2. Apply the schema to the database — pick ONE:
npx prisma db push
#   …or run the SQL migration directly:
psql "$DATABASE_URL" -f prisma/migrations/20260624000000_add_memories_and_voice_recordings/migration.sql

# 3. Typecheck + run
npm run typecheck
npm run dev
```

> **Prisma client:** the generated client in `src/generated/prisma` already
> includes the `memory`, `voiceRecording`, `folder`, `tag`, and `memoryTag`
> delegates from this iteration. `postinstall` re-runs `prisma generate` so a
> normal `npm install` keeps it in sync if you change the schema. If you run in
> a sandbox without engine network access, use
> `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 npm install --ignore-scripts` and
> the committed client is used as-is.

## 2. Architecture (identical for profile / memory / voice)

1. Client calls `POST /api/uploads/presign` with `{ category, files[] }`.
2. Backend validates **MIME + extension + size + auth + quota** and returns a
   presigned S3 POST (`{ key, upload: { url, fields } }`) per file.
3. Client uploads bytes **directly to S3** (API never proxies bytes; SSE enforced).
4. Client submits **metadata only** to `POST /api/memories` or
   `POST /api/voice-recordings` with the returned `fileKey`.
5. Backend HEADs the object (confirms it exists + reads the real byte size for
   quota), then stores the metadata row. The 201 response includes a signed
   `fileUrl` so the client can render/play the new item without a second GET.

S3 key layout:

```
profiles/{userId}/{uuid}/{filename}
memories/{userId}/{uuid}/{filename}
voices/{userId}/{uuid}/{filename}
```

Private bucket + short-lived signed GET URLs for viewing/playback (15 min).

## 3. Supported types

- **Memory images:** JPG, JPEG, PNG, WEBP
- **Memory videos:** MP4, MOV, WEBM
- **Memory documents:** PDF, DOC, DOCX
- **Voice audio:** MP3, M4A, WEBM Audio

## 4. API list

### Uploads (shared)
```
POST   /api/uploads/presign        # presigned S3 upload URL(s)
DELETE /api/uploads/file           # delete an orphaned object
GET    /api/uploads/signed-url     # short-lived signed GET URL
```

### Memories
```
GET    /api/memories               # lightweight list (no file URLs)
POST   /api/memories               # create from fileKey; 201 returns signed fileUrl
GET    /api/memories/:id           # detail + signed fileUrl
PATCH  /api/memories/:id           # update metadata
DELETE /api/memories/:id           # soft delete + S3 cleanup + quota refund
```

### Voice Recordings
```
GET    /api/voice-recordings       # lightweight list
POST   /api/voice-recordings       # create from fileKey; 201 returns signed fileUrl
GET    /api/voice-recordings/:id   # detail + signed fileUrl for playback
DELETE /api/voice-recordings/:id   # soft delete + S3 cleanup + quota refund
```

### Combined feed
```
GET    /api/my-memories            # memories + voice, time-sorted, lightweight
```

Each list and the combined feed return `{ items, nextCursor }`. The combined
feed cursor is the ISO timestamp of the last returned row.

Swagger UI at `/docs`, raw spec at `/openapi.json` (all routes registered).

## 5. Security

- Private S3 bucket; signed URLs for viewing/downloading (15 min default).
- Ownership enforced on every query (`where: { userId }`) **and** on the S3 key
  prefix (`assertKeyOwnedBy`).
- MIME + extension + size validation before presigning. The presigned POST
  itself carries hard `content-length-range` + `Content-Type` + SSE conditions,
  so a lying client cannot upload past the cap or skip encryption.
- Rate limiting: `presignLimiter` (20/min) on presign, `writeLimiter` (60/min)
  on create/update.
- Input sanitization on filenames (path-traversal stripped) and tags.
- Per-plan storage quota checked at presign (declared size) and again at create
  using the **real** size returned by S3 HEAD.
- `visibility` accepts either casing (`"private"` or `"PRIVATE"`) on the wire
  and is normalised to the Prisma enum.

## 6. Files added

```
src/lib/upload-module.ts                         # shared category-aware upload module
src/middleware/rate-limit.ts                     # presign + write limiters
src/modules/uploads/uploads.dto.ts
src/modules/uploads/uploads.service.ts
src/modules/uploads/uploads.routes.ts
src/modules/memories/memories.dto.ts
src/modules/memories/memories.repo.ts
src/modules/memories/memories.service.ts
src/modules/memories/memories.routes.ts
src/modules/recordings/recordings.dto.ts
src/modules/recordings/recordings.repo.ts
src/modules/recordings/recordings.service.ts
src/modules/recordings/recordings.routes.ts
src/modules/feed/feed.service.ts                 # combined My Memories feed
src/modules/feed/feed.routes.ts
prisma/migrations/20260624000000_add_memories_and_voice_recordings/migration.sql
```

## 7. Files modified

```
prisma/schema.prisma   # + Memory, Folder, Tag, MemoryTag, VoiceRecording, MemoryVisibility; User relations
src/lib/s3.ts          # + putObject (server-side small uploads, e.g. avatars)
src/app.ts             # mount /api/uploads, /api/memories, /api/voice-recordings, /api/my-memories
src/openapi.ts         # register all new endpoints + tags
```

## 8. Changes in this iteration

- `createMemory` and `createRecording` now return a signed `fileUrl` in their
  201 response so the client can render the new item without a second `GET`.
- `visibility` DTO accepts lowercase (`"private"`) as well as uppercase to match
  the spec example.
- This document was updated to remove a stale note claiming the generated
  Prisma client needed regeneration; it is current with the schema.
