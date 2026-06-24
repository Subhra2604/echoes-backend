# Echoes — Backend API

Backend for **Echoes**, a digital legacy platform: a private Memory Vault, AI-assisted
eulogies, Digital Time Capsules, Memorial Pages, and a Legacy Guardian system that
activates "memorial mode" after an owner passes away.

This service is the API for the web and mobile (iOS/Android) clients.

---

## Tech stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node.js 24** (TypeScript, ESM, run via `tsx`) | Active LTS; client left Node-vs-Python to us (GAP §8) |
| Web framework | **Express 5** | Stable, ubiquitous, easy for the client team to maintain |
| Database | **PostgreSQL 17** (PRD requirement) | Relational fit for the role/guardian/capsule model |
| ORM | **Prisma 7** (`@prisma/adapter-pg`, Rust-free) | Type-safe schema as the single source of truth |
| Background jobs | **BullMQ + Redis** | Time-triggered + recurring capsule delivery |
| Storage | **AWS S3** (server-side encryption) + presigned uploads | GAP §4 |
| Email | **AWS SES** | Stays in the AWS ecosystem alongside S3 (GAP §7) |
| Auth | JWT + server-side sessions, **argon2**, **TOTP** (Google Authenticator), Google/Apple OAuth | GAP §1 |
| Payments | **Stripe** | Subscription plans (Free/Basic/Family/Legacy Premium) |
| AI eulogy | **Anthropic** (OpenAI/Google pluggable) | Provider confirmed; text eulogies |
| API docs | **OpenAPI 3 + Swagger UI** (`zod-to-openapi`) | Generated from Zod schemas; served at `/docs` |
| Validation | **Zod** | Every request body/params/query validated |
| Logging | **pino** | Structured logs |

---

## Prerequisites

- **Docker + Docker Compose** (the recommended way to run everything), or
- Node.js **>= 24** with your own Postgres 17 / Redis if running outside Docker.
- AWS (S3 + SES + Rekognition) for full functionality; in dev, email falls back to logging,
  uploads need real S3, and image moderation is skipped without AWS credentials.

---

## Quick start (Docker — runs the whole stack)

This builds the backend image and starts **Postgres, Redis, the API, and the capsule
worker** together. The schema is synced to the database automatically on first boot.

```bash
docker compose build
docker compose up -d
```

That's it. The API is then live:

- API base: `http://localhost:4000`
- Swagger UI: `http://localhost:4000/docs`
- OpenAPI spec: `http://localhost:4000/openapi.json`
- Health: `http://localhost:4000/health`

Useful commands: `docker compose logs -f api` (tail logs), `docker compose ps` (status),
`docker compose down` (stop), `docker compose down -v` (stop and wipe the database volume).

> The image runs `prisma generate` during `docker compose build`, which downloads a Prisma
> engine from `binaries.prisma.sh` — the build machine needs outbound access to that host.
> A one-shot `migrate` service runs `prisma db push` to create the tables, then the `api`
> and `worker` services start.

**Configuration.** Sensible dev defaults are baked into `docker-compose.yml`, so the two
commands above work with no extra setup. To enable integrations or set real secrets, create
a `.env` file next to `docker-compose.yml` (Compose reads it automatically) with any of:
`JWT_SECRET`, `TOTP_ENC_KEY` (64 hex chars), `ANTHROPIC_API_KEY`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `GOOGLE_OAUTH_CLIENT_IDS`, `APPLE_OAUTH_CLIENT_IDS`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*`. **Change `JWT_SECRET` and
`TOTP_ENC_KEY` before any real deployment.**

---

## Running locally without Docker

```bash
npm install
cp .env.example .env          # set DATABASE_URL, REDIS_URL, JWT_SECRET, TOTP_ENC_KEY
docker compose up -d postgres redis   # or bring your own
npm run prisma:generate       # REQUIRED — generated client is git-ignored
npm run prisma:validate
npm run db:push               # or: npm run prisma:migrate  (for migration history)
npm run dev                   # API with hot reload
npm run worker                # capsule delivery worker (second terminal)
```

Type-check at any time with `npm run typecheck`, and build with `npm run build`.

### API documentation (Swagger)

Once the API is running, interactive docs are at **`/docs`** (Swagger UI) and the
raw OpenAPI 3 spec is at **`/openapi.json`**. The spec is generated from the same
Zod schemas used for request validation, so it stays in sync with the code. Use
the "Authorize" button in Swagger UI to paste a Bearer token from `/auth/login`.

### Generating secrets

`TOTP_ENC_KEY` must be 32 bytes of hex (encrypts TOTP secrets at rest):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### One manual migration step

Tagging/search on vault items uses a Postgres array column. After the first migrate,
add a GIN index for tag search (left as a raw step because Prisma doesn't emit GIN
indexes automatically):

```sql
CREATE INDEX vaultitem_tags_gin ON "VaultItem" USING GIN ("tags");
```

---

## Architecture

The API process serves HTTP; a separate **worker** process drains the BullMQ queue and
delivers time capsules. Both share the schema, Prisma client, and Redis connection.

```
src/
  app.ts                 Express app: middleware + router mounting
  server.ts              HTTP server bootstrap (graceful shutdown)
  worker.ts              Capsule-delivery worker bootstrap
  config/env.ts          Zod-validated environment (fail-fast)
  lib/                   prisma, redis, logger, errors, crypto, s3, email
  middleware/            auth (sessions), rbac, validate, error handling
  modules/
    auth/                register, login, email verification, TOTP, Google/Apple OAuth
    users/               profile, self-upgrade to Legacy Owner, account deletion
    guardians/           invite/accept/revoke guardians, activate/cancel memorial mode
    vault/               presigned S3 uploads, quota enforcement, folders, written memories
    capsules/            create/schedule capsules, guardian release, delivery worker
    memorial/            memorial pages, guestbook, stories, timeline, moderation
    eulogy/              AI eulogy generation, Anthropic (stored + versioned)
    notifications/       in-app feed + transactional email + push (stub)
    billing/             Stripe checkout + webhook → subscription plans
    admin/               (Phase 2) moderation overrides + audit log
```

### Session & inactivity model (GAP §1)

"Token expires after 60 min of no activity → must log back in" is implemented as a
**sliding server-side session**: every authenticated request updates `lastActivityAt`
and returns a freshly minted short-lived JWT in the `x-refresh-token` header. If the
idle gap exceeds `SESSION_IDLE_TIMEOUT_MIN` (default 60) or the absolute ceiling is
passed, the session is revoked and the request gets a 401 telling the user to sign in
again. Clients should swap in the refreshed token on each response.

---

## Requirements traceability

Every resolved answer from the gap-analysis document is honored in code; the relevant
spots are tagged in-source with `[GAP §x]`. Summary:

**§1 Auth.** Google + Apple OAuth (verify-ID-token flow, Facebook left optional); TOTP
MFA (Google Authenticator); **email verification mandatory** before any account access;
60-minute idle session expiry; account deletion is **permanent and cascades**, behind a
typed double-confirmation.

**§2 Guardians.** Death verified by **death-certificate upload**; an owner may assign
**multiple** guardians (primary + backups); invitations **expire after 30 days**;
guardians can be **revoked/changed while the owner is alive**; memorial mode is
**reversible** (guardian cancel + admin override); an owner must keep **at least one**
guardian (revoking the last one is blocked).

**§3 Time Capsules.** Three release types: scheduled date, **recurring annual "in
perpetuity"** (anniversary/birthday), and **guardian-controlled** (guardian triggers but
**cannot view, edit, or decline**). Recipient without an account → delivered by **email**;
a **bounced email is returned to the guardian**. Capsules are editable/deletable by the
**owner while alive only**. Timezone is **snapshotted from the owner at creation**.
Video/audio is capped at **60 seconds**.

**§4 Storage.** AWS S3 with **server-side encryption**; quota driven by the subscription
plan (below), enforced before every upload and re-checked against the real object size on
finalize; allowed formats: JPG/PNG/HEIC, MP4/MOV, PDF/written. Uploads use presigned POST
so bytes go straight to S3. Deleting an item frees space immediately.

**Subscription plans (Echoes Remembered framework).** Defined centrally in
`src/config/plans.ts`:

| Plan | Price | Storage | Memorials | Ads |
|---|---|---|---|---|
| Free | $0 | 500 MB | 1 | Yes |
| Basic | $9.99/mo | 5 GB | 3 | No |
| Family | $19.99/mo | 20 GB | Unlimited | No |
| Legacy Premium | $39.99/mo | 200 GB | Unlimited | No |

Plan and storage are independent of the three functional roles (Family User / Legacy Owner
/ Guardian). The free tier is also capped at **20 photos**. Storage warnings fire at **80 /
90 / 100 %** (in `/vault/usage` and as notifications). The `ads` flag is exposed on
`/users/me` and `/billing/plans`. Stripe drives the three paid plans; `/billing/webhook` is
the source of truth for plan changes. **Deferred:** stackable storage add-on packs.

**§5 AI Eulogy.** **Anthropic** (confirmed), English at MVP, **stored + versioned** so drafts
can be edited/regenerated. The prompt template in `eulogy.providers.ts` is a placeholder
pending the product team's wording (client is reviewing the draft output).

**§6 Memorial Pages.** PUBLIC / INVITE_ONLY / PRIVATE; guestbook entries and stories are
**auto-screened for profanity** (text) then approved by the page manager; **reporting/
flagging** supported. **One page per deceased person** (dedup on the linked platform user,
or on a normalized name for unlinked tributes). Ownership policy: the **creator manages the
page until memorial mode activates, after which the activating guardian becomes manager**.

**§7 Notifications.** In-app + email implemented for all listed events (capsule released,
guestbook entry, story approved, guardian activated, video/PDF uploaded, storage warning).
Push is stubbed pending a device-token registry (see below).

**§8 Infra.** Stripe-backed subscription plans with a free baseline; GDPR-friendly (permanent
deletion + audit trail); SLA-oriented separation of API and worker. USA launch; regions later.

**§9 Admin (Phase 2).** Scaffolded service + role-gated routes for delete-page,
suspend-user, manual-release, and override-activation — **every action is audit-logged
with a mandatory reason** (who/what/when/why). Roles: Admin + Support Agent.

---

## Open questions for the client

These were unresolved earlier; current status:

1. **AI eulogy provider** — **resolved: Anthropic**, stored + versioned drafts.
2. **Eulogy prompt template** — client is reviewing the draft output; the placeholder in
   `eulogy.providers.ts` should be replaced with the product team's wording.
3. **Memorial-page de-duplication** — **resolved: one page per person.** Enforced on the
   linked platform user, and on a normalized name for unlinked tributes. *Open sub-point:*
   name-only matching can collide for different people who share a name — a stronger key
   (name + date of birth/death) or an invite-to-co-manage flow can be added if needed.
4. **Per-file size limits** — **resolved:** keep the reasonable defaults (photo 50 MB, audio
   100 MB, video 500 MB, PDF 50 MB).
5. **Push delivery** — **resolved:** strategy accepted; FCM/APNs + device-token registry to
   be added later. The `notify()` fan-out point is already in place.
6. **Content moderation via AWS** — **resolved.** AWS Rekognition screens **public
   memorial-page photos** only (private vault content is never sent to Rekognition). Text
   profanity screening on guestbook/stories is also live.

---

## Subscription-doc items: built now vs. deferred

From the Echoes Remembered pricing framework, the **easy** items are implemented:
per-plan **memorial-count limits** (1/3/∞), the free-tier **20-photo cap**, **storage
warnings** at 80/90/100 %, and the **ads-enabled** flag per plan.

**Deferred to a later phase** (named in the doc, not yet built — the model is structured to
add them without rework): storage add-on packs; Eulogy **Video** Creator; AI Tribute Videos;
AI-crafted legacy timelines; Voice Playback; Private Family Network; and the distinct
"Guest" collaboration level (needs a behavior spec). The Veteran Support Module
(trauma-informed detection, crisis-aware moderation, peer-support pathways) is also deferred
and should be designed with appropriate clinical/veteran-services input.

---

## What's built vs. stubbed

- **Built and working:** auth (email + Google/Apple OAuth + TOTP), vault + plan-based storage
  quotas + photo cap + storage warnings, guardians + memorial activation, capsules
  (scheduled/recurring/guardian) + delivery worker, memorial pages (one-per-person) with a
  public **photo gallery screened by AWS Rekognition** + text moderation, eulogy generation
  (Anthropic), notifications (in-app + email),
  subscription billing (Stripe), audit logging, admin override services, and a full
  **OpenAPI 3 / Swagger** layer at `/docs`.
- **Stubbed / pluggable:** push notifications (no device tokens yet), OpenAI/Google
  eulogy providers (Anthropic live), video → HLS transcoding (progressive playback is fine
  at launch scale).
- **Phase 2 / later:** the separate admin web app (APIs exposed here) and the deferred
  subscription features listed above.
```

