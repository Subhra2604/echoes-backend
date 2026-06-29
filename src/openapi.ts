import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import {
  registerSchema,
  verifyEmailSchema,
  resendOtpSchema,
  loginSchema,
  totpVerifySchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from './modules/auth/auth.dto.js';
import { updateProfileSchema, deleteAccountSchema } from './modules/users/users.dto.js';
import {
  inviteGuardianSchema, respondInvitationSchema, activateMemorialSchema, cancelMemorialSchema,
  ownerIdParam as gOwnerIdParam, invitationIdParam,
} from './modules/guardians/guardians.dto.js';
import {
  initUploadSchema, finalizeUploadSchema, writtenMemorySchema, createFolderSchema, itemIdParam,
} from './modules/vault/vault.dto.js';
import { updateCapsuleSchema, capsuleIdParam } from './modules/capsules/capsules.dto.js';
import {
  createPageSchema, updatePageSchema, invitePageSchema, acceptPageInviteSchema,
  guestbookSchema, storySchema, timelineSchema, moderationDecisionSchema,
  initPhotoSchema, pageIdParam, entryParam, photoParam,
} from './modules/memorial/memorial.dto.js';
import { generateEulogySchema, reviseEulogySchema, eulogyIdParam } from './modules/eulogy/eulogy.dto.js';
import {
  deletePageSchema, suspendUserSchema, manualReleaseSchema, overrideActivationSchema,
  auditQuerySchema, userIdParam, pageIdParam as adminPageIdParam, capsuleIdParam as adminCapsuleIdParam, ownerIdParam as adminOwnerIdParam,
} from './modules/admin/admin.dto.js';
import {
  presignSchema, deleteFileSchema, signedUrlQuerySchema,
} from './modules/uploads/uploads.dto.js';
import {
  createMemorySchema, updateMemorySchema, listMemoriesQuerySchema, memoryIdParam,
} from './modules/memories/memories.dto.js';
import {
  createRecordingSchema, listRecordingsQuerySchema, recordingIdParam,
} from './modules/recordings/recordings.dto.js';

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description:
    'Access token from /auth/login or /auth/oauth/*. Each authenticated response returns a refreshed token in the x-refresh-token header; the session expires after 60 minutes of inactivity.',
});
const secured = [{ [bearerAuth.name]: [] as string[] }];

const ErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.any().optional(),
  }),
});

const J = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } });
const errs = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((c) => [
      String(c),
      {
        400: { description: 'Validation / bad request', ...J(ErrorSchema) },
        401: { description: 'Unauthorized — token missing, invalid, or session expired', ...J(ErrorSchema) },
        402: { description: 'Quota exceeded — storage or plan limit reached', ...J(ErrorSchema) },
        403: { description: 'Forbidden', ...J(ErrorSchema) },
        404: { description: 'Not found', ...J(ErrorSchema) },
        409: { description: 'Conflict', ...J(ErrorSchema) },
        413: { description: 'Payload too large', ...J(ErrorSchema) },
        429: { description: 'Too many requests — cooldown active', ...J(ErrorSchema) },
      }[c],
    ]),
  );

const Obj = z.object({}).openapi({ description: 'Resource object' });
const ObjList = z.array(z.object({})).openapi({ description: 'List of resource objects' });
const NoContent = { description: 'Success (no content)' };

// ── Auth ──────────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'post', path: '/api/auth/register', tags: ['Auth'], summary: 'Register with email + password',
  request: { body: J(registerSchema) },
  responses: { 201: { description: 'Account created; verification email sent', ...J(z.object({ userId: z.string(), message: z.string() })) }, ...errs(400, 409) },
});
registry.registerPath({
  method: 'post', path: '/api/auth/verify-email', tags: ['Auth'], summary: 'Verify the email using the 6-digit OTP',
  request: { body: J(verifyEmailSchema) },
  responses: { 200: { description: 'Submit the OTP sent to the user via email. ' +
      '\n\n**Dev only:** the code `123456` is also accepted when `NODE_ENV !== "production"`.', ...J(z.object({ message: z.string() })) }, ...errs(400) },
});
registry.registerPath({
  method: 'post', path: '/api/auth/resend-otp', tags: ['Auth'], summary: 'Resend the signup verification OTP',
  description:
    'Re-issues a fresh 6-digit verification code to the given email and invalidates the previous one. Silently no-ops if the email is unknown or already verified, to avoid account enumeration. 60-second cooldown between requests.' +
    '\n\n**Dev only:** the code `123456` continues to be accepted at /auth/verify-email when `NODE_ENV !== "production"`.',
  request: { body: J(resendOtpSchema) },
  responses: { 200: { description: 'Generic acknowledgement', ...J(z.object({ message: z.string() })) }, ...errs(400, 429) },
});
registry.registerPath({
  method: 'post', path: '/api/auth/forgot-password', tags: ['Auth'], summary: 'Request a password-reset OTP',
  description:
    'Sends a 6-digit reset code to the email if the account exists and has a password (OAuth-only accounts cannot reset). Always returns the same generic message to avoid account enumeration. Call again (after the 60s cooldown) to re-issue a fresh code.',
  request: { body: J(forgotPasswordSchema) },
  responses: { 200: { description: 'Generic acknowledgement', ...J(z.object({ message: z.string() })) }, ...errs(400, 429) },
});
registry.registerPath({
  method: 'post', path: '/api/auth/reset-password', tags: ['Auth'], summary: 'Set a new password using the reset OTP',
  description:
    'Verifies the reset OTP and updates the password. Also revokes every live session for the account as a defence-in-depth measure.' +
    '\n\n**Dev only:** the code `123456` is also accepted when `NODE_ENV !== "production"`.',
  request: { body: J(resetPasswordSchema) },
  responses: { 200: { description: 'Password reset', ...J(z.object({ message: z.string() })) }, ...errs(400) },
});
registry.registerPath({
  method: 'post', path: '/api/auth/login', tags: ['Auth'], summary: 'Login (password + optional TOTP)',
  description: 'Returns a JWT access token. If TOTP is enabled and no code is supplied, responds 401 with code TOTP_REQUIRED.',
  request: { body: J(loginSchema) },
  responses: { 200: { description: 'Authenticated', ...J(z.object({ accessToken: z.string(), expiresInMinutes: z.number(), user: Obj })) }, ...errs(401, 403) },
});
registry.registerPath({
  method: 'post', path: '/api/auth/oauth/google', tags: ['Auth'], summary: 'Sign in with a Google ID token',
  request: { body: J(z.object({ idToken: z.string() })) },
  responses: { 200: { description: 'Authenticated', ...J(Obj) }, ...errs(400, 401) },
});
registry.registerPath({
  method: 'post', path: '/api/auth/oauth/apple', tags: ['Auth'], summary: 'Sign in with an Apple ID token',
  request: { body: J(z.object({ idToken: z.string() })) },
  responses: { 200: { description: 'Authenticated', ...J(Obj) }, ...errs(400, 401) },
});
registry.registerPath({
  method: 'post', path: '/api/auth/logout', tags: ['Auth'], summary: 'Revoke the current session', security: secured,
  responses: { 200: { description: 'Logged out', ...J(z.object({ message: z.string() })) }, ...errs(401) },
});
registry.registerPath({
  method: 'post', path: '/api/auth/totp/enroll', tags: ['Auth'], summary: 'Begin TOTP (Google Authenticator) enrollment', security: secured,
  responses: { 200: { description: 'otpauth URI + QR data URL', ...J(z.object({ otpauthUrl: z.string(), qrDataUrl: z.string() })) }, ...errs(401) },
});
registry.registerPath({
  method: 'post', path: '/api/auth/totp/confirm', tags: ['Auth'], summary: 'Confirm and enable TOTP', security: secured,
  request: { body: J(totpVerifySchema) },
  responses: { 200: { description: 'TOTP enabled', ...J(z.object({ message: z.string() })) }, ...errs(400, 401) },
});

// ── Users ─────────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/api/users/me', tags: ['Users'], summary: 'Current user (plan, storage, ads flag)', security: secured,
  responses: { 200: { description: 'Current user', ...J(Obj) }, ...errs(401) },
});
registry.registerPath({
  method: 'patch', path: '/api/users/me', tags: ['Users'], summary: 'Update profile (name, timezone)', security: secured,
  request: { body: J(updateProfileSchema) },
  responses: { 200: { description: 'Updated', ...J(Obj) }, ...errs(400, 401) },
});
registry.registerPath({
  method: 'post', path: '/api/users/me/upgrade-to-legacy-owner', tags: ['Users'], summary: 'Self-upgrade to Legacy Owner', security: secured,
  responses: { 200: { description: 'Upgraded', ...J(z.object({ isLegacyOwner: z.boolean() })) }, ...errs(401) },
});
registry.registerPath({
  method: 'delete', path: '/api/users/me', tags: ['Users'], summary: 'Permanently delete account (cascades)', security: secured,
  description: 'Requires a typed double-confirmation: { confirm: true, confirmPhrase: "DELETE MY ACCOUNT" }.',
  request: { body: J(deleteAccountSchema) },
  responses: { 204: NoContent, ...errs(400, 401) },
});

// ── Guardians ───────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'post', path: '/api/guardians/invitations', tags: ['Guardians'], summary: 'Invite a guardian (30-day expiry, multiple allowed)', security: secured,
  request: { body: J(inviteGuardianSchema) },
  responses: { 201: { description: 'Invitation created', ...J(Obj) }, ...errs(400, 401) },
});
registry.registerPath({
  method: 'post', path: '/api/guardians/invitations/{invitationId}/respond', tags: ['Guardians'], summary: 'Accept or decline a guardian invitation', security: secured,
  request: { params: invitationIdParam, body: J(respondInvitationSchema) },
  responses: { 200: { description: 'Responded', ...J(Obj) }, ...errs(400, 401, 404) },
});
registry.registerPath({
  method: 'delete', path: '/api/guardians/{ownerId}/guardians/{invitationId}', tags: ['Guardians'], summary: 'Revoke a guardian (blocked if it is the last one)', security: secured,
  request: { params: z.object({ ownerId: z.string().uuid(), invitationId: z.string().uuid() }) },
  responses: { 204: NoContent, ...errs(401, 403, 404, 409) },
});
registry.registerPath({
  method: 'get', path: '/api/guardians/mine', tags: ['Guardians'], summary: 'List guardians I have assigned', security: secured,
  responses: { 200: { description: 'My guardians', ...J(ObjList) }, ...errs(401) },
});
registry.registerPath({
  method: 'get', path: '/api/guardians/i-guard', tags: ['Guardians'], summary: 'List owners I am a guardian for', security: secured,
  responses: { 200: { description: 'Owners I guard', ...J(ObjList) }, ...errs(401) },
});
registry.registerPath({
  method: 'post', path: '/api/guardians/{ownerId}/activate', tags: ['Guardians'], summary: 'Activate memorial mode (death certificate required)', security: secured,
  request: { params: gOwnerIdParam, body: J(activateMemorialSchema) },
  responses: { 200: { description: 'Memorial mode active', ...J(Obj) }, ...errs(400, 401, 403) },
});
registry.registerPath({
  method: 'post', path: '/api/guardians/{ownerId}/cancel', tags: ['Guardians'], summary: 'Cancel memorial mode (reversible)', security: secured,
  request: { params: gOwnerIdParam, body: J(cancelMemorialSchema) },
  responses: { 200: { description: 'Memorial mode cancelled', ...J(Obj) }, ...errs(400, 401, 403, 409) },
});

// ── Vault ─────────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/api/vault/usage', tags: ['Vault'], summary: 'Storage usage + warning level (80/90/100%)', security: secured,
  responses: { 200: { description: 'Usage', ...J(z.object({ usedBytes: z.number(), limitBytes: z.number(), freeBytes: z.number(), usedFraction: z.number(), warningLevel: z.number().nullable() })) }, ...errs(401) },
});
registry.registerPath({
  method: 'post', path: '/api/vault/uploads/init', tags: ['Vault'], summary: 'Begin a presigned upload (validates quota, format, photo cap)', security: secured,
  request: { body: J(initUploadSchema) },
  responses: { 201: { description: 'Presigned POST + pending item', ...J(z.object({ itemId: z.string(), upload: Obj })) }, ...errs(400, 401, 413) },
});
registry.registerPath({
  method: 'post', path: '/api/vault/uploads/finalize', tags: ['Vault'], summary: 'Finalize an upload (reconciles real size, commits quota)', security: secured,
  request: { body: J(finalizeUploadSchema) },
  responses: { 200: { description: 'Item ready', ...J(Obj) }, ...errs(400, 401) },
});
registry.registerPath({
  method: 'post', path: '/api/vault/written', tags: ['Vault'], summary: 'Create a written memory', security: secured,
  request: { body: J(writtenMemorySchema) },
  responses: { 201: { description: 'Created', ...J(Obj) }, ...errs(400, 401) },
});
registry.registerPath({
  method: 'get', path: '/api/vault/items', tags: ['Vault'], summary: 'List vault items', security: secured,
  request: { query: z.object({ limit: z.number().optional().default(20) }) },
  responses: { 200: { description: 'Items', ...J(ObjList) }, ...errs(401) },
});
registry.registerPath({
  method: 'get', path: '/api/vault/items/{itemId}/download', tags: ['Vault'], summary: 'Get a short-lived download URL', security: secured,
  request: { params: itemIdParam },
  responses: { 200: { description: 'Signed URL', ...J(z.object({ url: z.string(), mimeType: z.string().nullable() })) }, ...errs(400, 401, 404) },
});
registry.registerPath({
  method: 'delete', path: '/api/vault/items/{itemId}', tags: ['Vault'], summary: 'Delete an item (frees storage immediately)', security: secured,
  request: { params: itemIdParam },
  responses: { 204: NoContent, ...errs(401, 404) },
});
registry.registerPath({
  method: 'post', path: '/api/vault/folders', tags: ['Vault'], summary: 'Create a folder', security: secured,
  request: { body: J(createFolderSchema) },
  responses: { 201: { description: 'Created', ...J(Obj) }, ...errs(400, 401) },
});
registry.registerPath({
  method: 'get', path: '/api/vault/folders', tags: ['Vault'], summary: 'List folders', security: secured,
  responses: { 200: { description: 'Folders', ...J(ObjList) }, ...errs(401) },
});

// ── Capsules ──────────────────────────────────────────────────────────────────
const createCapsuleBody = z.object({
  title: z.string(),
  message: z.string().optional(),
  vaultItemId: z.string().uuid().optional(),
  recipientUserId: z.string().uuid().optional(),
  recipientEmail: z.string().email().optional(),
  releaseType: z.enum(['SCHEDULED_DATE', 'RECURRING_ANNUAL', 'GUARDIAN_CONTROLLED']),
  releaseDate: z.string().datetime().optional().openapi({ description: 'Required for SCHEDULED_DATE / RECURRING_ANNUAL (owner timezone snapshotted at creation)' }),
}).openapi({ description: 'Conditional: releaseDate required unless GUARDIAN_CONTROLLED.' });

registry.registerPath({
  method: 'post', path: '/api/capsules', tags: ['Capsules'], summary: 'Create a time capsule', security: secured,
  request: { body: J(createCapsuleBody) },
  responses: { 201: { description: 'Created + scheduled', ...J(Obj) }, ...errs(400, 401) },
});
registry.registerPath({
  method: 'get', path: '/api/capsules', tags: ['Capsules'], summary: 'List my capsules', security: secured,
  responses: { 200: { description: 'Capsules', ...J(ObjList) }, ...errs(401) },
});
registry.registerPath({
  method: 'patch', path: '/api/capsules/{capsuleId}', tags: ['Capsules'], summary: 'Edit a capsule (owner, while alive only)', security: secured,
  request: { params: capsuleIdParam, body: J(updateCapsuleSchema) },
  responses: { 200: { description: 'Updated', ...J(Obj) }, ...errs(400, 401, 403, 404) },
});
registry.registerPath({
  method: 'delete', path: '/api/capsules/{capsuleId}', tags: ['Capsules'], summary: 'Delete a capsule (owner, while alive only)', security: secured,
  request: { params: capsuleIdParam },
  responses: { 204: NoContent, ...errs(401, 403, 404) },
});
registry.registerPath({
  method: 'post', path: '/api/capsules/{capsuleId}/guardian-release', tags: ['Capsules'],
  summary: 'Guardian-triggered release (cannot view, edit, or decline content)', security: secured,
  request: { params: capsuleIdParam, body: J(z.object({ ownerId: z.string().uuid() })) },
  responses: { 200: { description: 'Released', ...J(Obj) }, ...errs(400, 401, 403, 404) },
});

// ── Memorial ────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'post', path: '/api/memorial/pages', tags: ['Memorial'], summary: 'Create a memorial page (dedup + per-plan quota)', security: secured,
  request: { body: J(createPageSchema) },
  responses: { 201: { description: 'Created', ...J(Obj) }, ...errs(400, 401, 409) },
});
registry.registerPath({
  method: 'get', path: '/api/memorial/pages', tags: ['Memorial'], summary: 'List memorial pages I can access', security: secured,
  responses: { 200: { description: 'Pages', ...J(ObjList) }, ...errs(401) },
});
registry.registerPath({
  method: 'get', path: '/api/memorial/pages/{pageId}', tags: ['Memorial'], summary: 'Get a memorial page (privacy enforced; public pages need no auth)',
  request: { params: pageIdParam },
  responses: { 200: { description: 'Page with approved guestbook, stories, timeline', ...J(Obj) }, ...errs(403, 404) },
});
registry.registerPath({
  method: 'patch', path: '/api/memorial/pages/{pageId}', tags: ['Memorial'], summary: 'Update a memorial page', security: secured,
  request: { params: pageIdParam, body: J(updatePageSchema) },
  responses: { 200: { description: 'Updated', ...J(Obj) }, ...errs(400, 401, 403, 404) },
});
registry.registerPath({
  method: 'post', path: '/api/memorial/pages/{pageId}/invitations', tags: ['Memorial'], summary: 'Invite someone to a page (30-day token)', security: secured,
  request: { params: pageIdParam, body: J(invitePageSchema) },
  responses: { 201: { description: 'Invitation link', ...J(z.object({ link: z.string(), expiresAt: z.string() })) }, ...errs(400, 401, 403, 404) },
});
registry.registerPath({
  method: 'post', path: '/api/memorial/invitations/accept', tags: ['Memorial'], summary: 'Accept a page invitation', security: secured,
  request: { body: J(acceptPageInviteSchema) },
  responses: { 200: { description: 'Joined as collaborator', ...J(z.object({ pageId: z.string() })) }, ...errs(400, 401, 404, 409) },
});
registry.registerPath({
  method: 'post', path: '/api/memorial/pages/{pageId}/guestbook', tags: ['Memorial'], summary: 'Sign the guestbook (auto-moderated; sign-in optional)',
  request: { params: pageIdParam, body: J(guestbookSchema) },
  responses: { 201: { description: 'Submitted (PENDING approval)', ...J(z.object({ id: z.string(), status: z.string() })) }, ...errs(400, 404) },
});
registry.registerPath({
  method: 'get', path: '/api/memorial/pages/{pageId}/guestbook/pending', tags: ['Memorial'], summary: 'List pending guestbook entries (manager)', security: secured,
  request: { params: pageIdParam },
  responses: { 200: { description: 'Pending entries', ...J(ObjList) }, ...errs(401, 403, 404) },
});
registry.registerPath({
  method: 'post', path: '/api/memorial/pages/{pageId}/guestbook/{entryId}/moderate', tags: ['Memorial'], summary: 'Approve/reject a guestbook entry (manager)', security: secured,
  request: { params: entryParam, body: J(moderationDecisionSchema) },
  responses: { 200: { description: 'Moderated', ...J(Obj) }, ...errs(400, 401, 403, 404) },
});
registry.registerPath({
  method: 'post', path: '/api/memorial/pages/{pageId}/guestbook/{entryId}/report', tags: ['Memorial'], summary: 'Report/flag a guestbook entry (public)',
  request: { params: entryParam },
  responses: { 204: NoContent, ...errs(404) },
});
registry.registerPath({
  method: 'post', path: '/api/memorial/pages/{pageId}/stories', tags: ['Memorial'], summary: 'Submit a story (auto-moderated; requires approval)',
  request: { params: pageIdParam, body: J(storySchema) },
  responses: { 201: { description: 'Submitted (PENDING approval)', ...J(z.object({ id: z.string(), status: z.string() })) }, ...errs(400, 404) },
});
registry.registerPath({
  method: 'get', path: '/api/memorial/pages/{pageId}/stories/pending', tags: ['Memorial'], summary: 'List pending stories (manager)', security: secured,
  request: { params: pageIdParam },
  responses: { 200: { description: 'Pending stories', ...J(ObjList) }, ...errs(401, 403, 404) },
});
registry.registerPath({
  method: 'post', path: '/api/memorial/pages/{pageId}/stories/{entryId}/moderate', tags: ['Memorial'], summary: 'Approve/reject a story (manager)', security: secured,
  request: { params: entryParam, body: J(moderationDecisionSchema) },
  responses: { 200: { description: 'Moderated', ...J(Obj) }, ...errs(400, 401, 403, 404) },
});
registry.registerPath({
  method: 'post', path: '/api/memorial/pages/{pageId}/timeline', tags: ['Memorial'], summary: 'Add a timeline event (manager)', security: secured,
  request: { params: pageIdParam, body: J(timelineSchema) },
  responses: { 201: { description: 'Created', ...J(Obj) }, ...errs(400, 401, 403, 404) },
});
registry.registerPath({
  method: 'post', path: '/api/memorial/pages/{pageId}/photos/init', tags: ['Memorial'], summary: 'Begin a public photo upload (manager)', security: secured,
  request: { params: pageIdParam, body: J(initPhotoSchema) },
  responses: { 201: { description: 'Presigned POST + pending photo', ...J(z.object({ photoId: z.string(), upload: Obj })) }, ...errs(400, 401, 403, 404) },
});
registry.registerPath({
  method: 'post', path: '/api/memorial/pages/{pageId}/photos/{photoId}/finalize', tags: ['Memorial'],
  summary: 'Finalize + AWS Rekognition screen a public photo (manager)', security: secured,
  description: 'Runs AWS Rekognition; clean images become APPROVED (publicly visible), flagged images are deleted and blocked.',
  request: { params: photoParam },
  responses: { 200: { description: 'Approved', ...J(Obj) }, ...errs(400, 401, 403, 404) },
});
registry.registerPath({
  method: 'get', path: '/api/memorial/pages/{pageId}/photos', tags: ['Memorial'], summary: 'List approved photos (privacy enforced)',
  request: { params: pageIdParam },
  responses: { 200: { description: 'Approved photos with signed URLs', ...J(ObjList) }, ...errs(403, 404) },
});
registry.registerPath({
  method: 'delete', path: '/api/memorial/pages/{pageId}/photos/{photoId}', tags: ['Memorial'], summary: 'Delete a photo (manager)', security: secured,
  request: { params: photoParam },
  responses: { 204: NoContent, ...errs(401, 403, 404) },
});

// ── Eulogies ──────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'post', path: '/api/eulogies', tags: ['Eulogies'], summary: 'Generate an AI eulogy (stored, versioned)', security: secured,
  request: { body: J(generateEulogySchema) },
  responses: { 201: { description: 'Generated draft', ...J(Obj) }, ...errs(400, 401) },
});
registry.registerPath({
  method: 'get', path: '/api/eulogies', tags: ['Eulogies'], summary: 'List my eulogies', security: secured,
  responses: { 200: { description: 'Eulogies', ...J(ObjList) }, ...errs(401) },
});
registry.registerPath({
  method: 'get', path: '/api/eulogies/{eulogyId}', tags: ['Eulogies'], summary: 'Get a eulogy', security: secured,
  request: { params: eulogyIdParam },
  responses: { 200: { description: 'Eulogy', ...J(Obj) }, ...errs(401, 404) },
});
registry.registerPath({
  method: 'patch', path: '/api/eulogies/{eulogyId}', tags: ['Eulogies'], summary: 'Edit a eulogy draft (bumps version)', security: secured,
  request: { params: eulogyIdParam, body: J(reviseEulogySchema) },
  responses: { 200: { description: 'Updated', ...J(Obj) }, ...errs(400, 401, 404) },
});
registry.registerPath({
  method: 'post', path: '/api/eulogies/{eulogyId}/regenerate', tags: ['Eulogies'], summary: 'Regenerate from the original prompt (new version)', security: secured,
  request: { params: eulogyIdParam },
  responses: { 200: { description: 'Regenerated', ...J(Obj) }, ...errs(401, 404) },
});
registry.registerPath({
  method: 'delete', path: '/api/eulogies/{eulogyId}', tags: ['Eulogies'], summary: 'Delete a eulogy', security: secured,
  request: { params: eulogyIdParam },
  responses: { 204: NoContent, ...errs(401, 404) },
});

// ── Notifications ─────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/api/notifications', tags: ['Notifications'], summary: 'List notifications', security: secured,
  request: { query: z.object({ unreadOnly: z.boolean().optional() }) },
  responses: { 200: { description: 'Notifications', ...J(ObjList) }, ...errs(401) },
});
registry.registerPath({
  method: 'get', path: '/api/notifications/unread-count', tags: ['Notifications'], summary: 'Unread count', security: secured,
  responses: { 200: { description: 'Count', ...J(z.object({ count: z.number() })) }, ...errs(401) },
});
registry.registerPath({
  method: 'post', path: '/api/notifications/{id}/read', tags: ['Notifications'], summary: 'Mark one as read', security: secured,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: { 204: NoContent, ...errs(401) },
});
registry.registerPath({
  method: 'post', path: '/api/notifications/read-all', tags: ['Notifications'], summary: 'Mark all as read', security: secured,
  responses: { 204: NoContent, ...errs(401) },
});

// ── Billing ───────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/api/billing/plans', tags: ['Billing'], summary: 'Plan catalog (prices, storage, limits)',
  responses: { 200: { description: 'Plans', ...J(z.object({ plans: ObjList })) } },
});
registry.registerPath({
  method: 'post', path: '/api/billing/checkout', tags: ['Billing'], summary: 'Create a Stripe Checkout session for a paid plan', security: secured,
  request: { body: J(z.object({ plan: z.enum(['BASIC', 'FAMILY', 'LEGACY_PREMIUM']) })) },
  responses: { 200: { description: 'Checkout URL', ...J(z.object({ checkoutUrl: z.string().nullable() })) }, ...errs(400, 401) },
});
registry.registerPath({
  method: 'post', path: '/api/billing/webhook', tags: ['Billing'], summary: 'Stripe webhook (raw body, signature-verified, no auth)',
  responses: { 200: { description: 'Received', ...J(z.object({ received: z.boolean() })) }, ...errs(400) },
});

// ── Admin (Phase 2) ─────────────────────────────────────────────────────────
registry.registerPath({
  method: 'delete', path: '/api/admin/pages/{pageId}', tags: ['Admin'], summary: 'Delete a memorial page (audited)', security: secured,
  request: { params: adminPageIdParam, body: J(deletePageSchema) },
  responses: { 200: { description: 'Deleted', ...J(Obj) }, ...errs(400, 401, 403, 404) },
});
registry.registerPath({
  method: 'post', path: '/api/admin/users/{userId}/suspension', tags: ['Admin'], summary: 'Suspend / reinstate a user (audited)', security: secured,
  request: { params: userIdParam, body: J(suspendUserSchema) },
  responses: { 200: { description: 'Updated', ...J(Obj) }, ...errs(400, 401, 403, 404) },
});
registry.registerPath({
  method: 'post', path: '/api/admin/capsules/{capsuleId}/manual-release', tags: ['Admin'], summary: 'Manually release a capsule (audited)', security: secured,
  request: { params: adminCapsuleIdParam, body: J(manualReleaseSchema) },
  responses: { 200: { description: 'Released', ...J(Obj) }, ...errs(400, 401, 403, 404) },
});
registry.registerPath({
  method: 'post', path: '/api/admin/owners/{ownerId}/override-activation', tags: ['Admin'], summary: 'Override memorial activation (audited)', security: secured,
  request: { params: adminOwnerIdParam, body: J(overrideActivationSchema) },
  responses: { 200: { description: 'Overridden', ...J(Obj) }, ...errs(400, 401, 403, 404) },
});
registry.registerPath({
  method: 'get', path: '/api/admin/audit', tags: ['Admin'], summary: 'Read the audit log', security: secured,
  request: { query: auditQuerySchema },
  responses: { 200: { description: 'Audit entries', ...J(ObjList) }, ...errs(401, 403) },
});

// ── Uploads (shared presigned-S3 service: profile / memory / voice) ──────────
registry.registerPath({
  method: 'post', path: '/api/uploads/presign', tags: ['Uploads'],
  summary: 'Request presigned S3 upload URL(s)',
  description:
    'Validates each file (MIME + extension + size) for the given category and returns a presigned POST per file. The client uploads bytes directly to S3 — the API never proxies file data. `category` is one of profile | memory | voice and selects the allow-list + size caps.',
  security: secured,
  request: { body: J(presignSchema) },
  responses: {
    200: {
      description: 'Presigned upload(s)',
      ...J(z.object({
        uploads: z.array(z.object({
          filename: z.string(),
          key: z.string(),
          upload: z.object({ url: z.string(), fields: z.record(z.string()), key: z.string() }),
        })),
      })),
    },
    ...errs(400, 401, 402, 413, 429),
  },
});
registry.registerPath({
  method: 'delete', path: '/api/uploads/file', tags: ['Uploads'],
  summary: 'Delete an orphaned uploaded object',
  description: 'Removes an object the caller uploaded but never finalized into a record. Ownership is enforced by the category prefix in the key.',
  security: secured,
  request: { body: J(deleteFileSchema) },
  responses: { 200: { description: 'Deleted', ...J(z.object({ deleted: z.boolean() })) }, ...errs(400, 401) },
});
registry.registerPath({
  method: 'get', path: '/api/uploads/signed-url', tags: ['Uploads'],
  summary: 'Get a short-lived signed GET URL for an owned object',
  security: secured,
  request: { query: signedUrlQuerySchema },
  responses: { 200: { description: 'Signed URL', ...J(z.object({ url: z.string(), expiresSec: z.number() })) }, ...errs(400, 401, 403) },
});

// ── Memories ─────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/api/memories', tags: ['Memories'],
  summary: 'List the caller’s memories (lightweight metadata, no file URLs)',
  security: secured,
  request: { query: listMemoriesQuerySchema },
  responses: { 200: { description: 'Cursor-paginated memory list', ...J(z.object({ items: ObjList, nextCursor: z.string().nullable() })) }, ...errs(401) },
});
registry.registerPath({
  method: 'post', path: '/api/memories', tags: ['Memories'],
  summary: 'Create a memory from an uploaded file key (metadata only)',
  security: secured,
  request: { body: J(createMemorySchema) },
  responses: { 201: { description: 'Memory created', ...J(Obj) }, ...errs(400, 401, 402) },
});
registry.registerPath({
  method: 'get', path: '/api/memories/{id}', tags: ['Memories'],
  summary: 'Get a memory with a signed fileUrl',
  security: secured,
  request: { params: memoryIdParam },
  responses: { 200: { description: 'Memory detail', ...J(Obj) }, ...errs(401, 404) },
});
registry.registerPath({
  method: 'patch', path: '/api/memories/{id}', tags: ['Memories'],
  summary: 'Update memory metadata',
  security: secured,
  request: { params: memoryIdParam, body: J(updateMemorySchema) },
  responses: { 200: { description: 'Updated', ...J(Obj) }, ...errs(400, 401, 404) },
});
registry.registerPath({
  method: 'delete', path: '/api/memories/{id}', tags: ['Memories'],
  summary: 'Delete a memory (soft delete + S3 cleanup, returns storage)',
  security: secured,
  request: { params: memoryIdParam },
  responses: { 204: NoContent, ...errs(401, 404) },
});

// ── Voice Recordings ─────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/api/voice-recordings', tags: ['Voice Recordings'],
  summary: 'List the caller’s voice recordings (lightweight metadata)',
  security: secured,
  request: { query: listRecordingsQuerySchema },
  responses: { 200: { description: 'Cursor-paginated recording list', ...J(z.object({ items: ObjList, nextCursor: z.string().nullable() })) }, ...errs(401) },
});
registry.registerPath({
  method: 'post', path: '/api/voice-recordings', tags: ['Voice Recordings'],
  summary: 'Create a voice recording from an uploaded file key (metadata only)',
  security: secured,
  request: { body: J(createRecordingSchema) },
  responses: { 201: { description: 'Recording created', ...J(Obj) }, ...errs(400, 401, 402) },
});
registry.registerPath({
  method: 'get', path: '/api/voice-recordings/{id}', tags: ['Voice Recordings'],
  summary: 'Get a recording with a signed fileUrl for playback',
  security: secured,
  request: { params: recordingIdParam },
  responses: { 200: { description: 'Recording detail', ...J(Obj) }, ...errs(401, 404) },
});
registry.registerPath({
  method: 'delete', path: '/api/voice-recordings/{id}', tags: ['Voice Recordings'],
  summary: 'Delete a recording (soft delete + S3 cleanup, returns storage)',
  security: secured,
  request: { params: recordingIdParam },
  responses: { 204: NoContent, ...errs(401, 404) },
});

// ── My Memories (combined feed) ──────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/api/my-memories', tags: ['My Memories'],
  summary: 'Combined, time-sorted feed of memories + voice recordings',
  description: 'Lightweight list for the Vault → My Memories screen. Each item carries id, type (memory|voice), title, timezone, contentType, and createdAt. Cursor is the ISO timestamp of the last returned row.',
  security: secured,
  request: { query: z.object({ limit: z.coerce.number().int().min(1).max(50).optional(), cursor: z.string().datetime().optional() }) },
  responses: { 200: { description: 'Feed page', ...J(z.object({ items: ObjList, nextCursor: z.string().nullable() })) }, ...errs(401) },
});

// ── Health ────────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/health', tags: ['System'], summary: 'Health check',
  responses: { 200: { description: 'OK', ...J(z.object({ status: z.string(), service: z.string() })) } },
});

export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Echoes Remembered API',
      version: '0.1.0',
      description:
        'Backend API for Echoes Remembered — a digital legacy platform (Memory Vault, Legacy Guardians, Time Capsules, Memorial Pages, AI eulogies). All authenticated routes use a Bearer JWT; sessions expire after 60 minutes of inactivity and return a refreshed token via the x-refresh-token header.',
    },
    servers: [{ url: '/', description: 'Current host' }],
    tags: [
      { name: 'Auth' }, { name: 'Users' }, { name: 'Guardians' }, { name: 'Vault' },
      { name: 'Capsules' }, { name: 'Memorial' }, { name: 'Eulogies' },
      { name: 'Notifications' }, { name: 'Billing' }, { name: 'Admin' },
      { name: 'Uploads' }, { name: 'Memories' }, { name: 'Voice Recordings' }, { name: 'My Memories' },
      { name: 'System' },
    ],
  });
}