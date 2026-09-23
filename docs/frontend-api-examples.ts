/**
 * Echoes Backend — API usage examples for frontend integration.
 *
 * Covers: Scheduled Messages, Guardians (contact-based), Time Capsules
 * (sub-resources), Contacts+Groups, Notifications (extended).
 *
 * All request/response shapes below were verified live against
 * https://backend.echoesremembered.com on 2026-09-23. Full interactive docs
 * (all endpoints, all fields) are at https://backend.echoesremembered.com/docs/.
 *
 * Every endpoint here requires an Authorization header:
 *   Authorization: Bearer <accessToken from POST /api/auth/login>
 *
 * Every authenticated response also carries a fresh token in the
 * `x-refresh-token` response header — swap it in for the next request so the
 * session stays alive (see `apiFetch` below).
 */

const BASE_URL = 'https://backend.echoesremembered.com';

let accessToken = ''; // set this after login

async function apiFetch<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  // Slide the session: the server mints a fresh token on every authenticated
  // request. Always store the latest one.
  const refreshed = res.headers.get('x-refresh-token');
  if (refreshed) accessToken = refreshed;

  if (res.status === 204) return undefined as T; // no body

  const data = await res.json();
  if (!res.ok) {
    // Error shape is always: { error: { code, message, details? } }
    throw new Error(data.error?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

// ============================================================================
// Auth (needed once, to get accessToken)
// ============================================================================

interface LoginResponse {
  accessToken: string;
  expiresInMinutes: number;
  user: { id: string; email: string; fullName: string };
}

async function login(email: string, password: string) {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data: LoginResponse = await res.json();
  accessToken = data.accessToken;
  return data;
}

// ============================================================================
// Guardians (contact-based)
// ============================================================================

interface Guardian {
  id: string;
  ownerId: string;
  contactId: string;
  name: string;
  email: string;
  contactUser: { id: string; fullName: string; avatarKey: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/guardians — assign a VERIFIED contact as a guardian. */
function createGuardian(contactId: string) {
  return apiFetch<Guardian>('/api/guardians', {
    method: 'POST',
    body: { contactId },
  });
}
// Example call:
//   createGuardian("3fa85f64-5717-4562-b3fc-2c963f66afa6")

/** GET /api/guardians — every guardian the caller (as owner) has assigned. */
function listGuardians() {
  return apiFetch<Guardian[]>('/api/guardians');
}

/** GET /api/guardians/dashboard — everything the CALLER guards (as a guardian, not owner). */
interface GuardianDashboard {
  items: Array<{
    resourceType: 'TimeCapsule';
    id: string;
    title: string;
    status: string;
    releaseType: string;
    releaseAt: string | null;
    owner: { id: string; fullName: string; avatarKey: string | null; isDeceased: boolean };
  }>;
  counts: { capsules: number };
}
function getGuardianDashboard() {
  return apiFetch<GuardianDashboard>('/api/guardians/dashboard');
}

/** GET /api/guardians/{guardianId} */
function getGuardian(guardianId: string) {
  return apiFetch<Guardian>(`/api/guardians/${guardianId}`);
}

/** DELETE /api/guardians/{guardianId} — 409 if still linked to an active capsule. */
function deleteGuardian(guardianId: string) {
  return apiFetch<void>(`/api/guardians/${guardianId}`, { method: 'DELETE' });
}

// ============================================================================
// Time Capsules — sub-resources & extended create/update bodies
// ============================================================================

interface CapsuleContact {
  id: string;
  contactId: string;
  email: string;
  name: string;
  status: 'VERIFIED' | 'PENDING_INVITATION' | 'BLOCKED';
}

interface TimeCapsule {
  id: string;
  ownerId: string;
  title: string;
  message: string | null;
  mediaItem: unknown | null;
  releaseType: 'SCHEDULED_DATE' | 'RECURRING_ANNUAL' | 'GUARDIAN_CONTROLLED';
  status: 'DRAFT' | 'SCHEDULED' | 'PENDING_GUARDIAN_RELEASE' | 'RELEASING' | 'RELEASED' | 'CANCELLED';
  scheduleDate: string | null; // alias of releaseAt
  releaseAt: string | null;
  scheduleTimezone: string;
  recurMonth: number | null;
  recurDay: number | null;
  recurring: boolean;
  guardianControlled: boolean;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
  recipientEmail: string | null; // legacy single-recipient path
  contacts: CapsuleContact[]; // current multi-recipient path
  guardian: { id: string; contactId: string; name: string; email: string; userId: string | null } | null;
}

/**
 * POST /api/capsules
 * `timezone` should be an explicit IANA zone (e.g. "Asia/Kolkata") — don't
 * rely on the fallback to the owner's profile timezone.
 * At least one of `contactIds` (preferred) or `recipientEmail` is required.
 */
function createCapsule(input: {
  title: string;
  message?: string;
  releaseType: 'SCHEDULED_DATE' | 'RECURRING_ANNUAL' | 'GUARDIAN_CONTROLLED';
  releaseAt?: string; // required for SCHEDULED_DATE, ISO datetime
  recurMonth?: number; // required for RECURRING_ANNUAL, 1-12
  recurDay?: number; // required for RECURRING_ANNUAL
  timezone: string;
  contactIds?: string[];
  recipientEmail?: string;
  guardianId?: string;
  mediaItemId?: string;
}) {
  return apiFetch<TimeCapsule>('/api/capsules', { method: 'POST', body: input });
}
// Example call (scheduled, multi-recipient):
//   createCapsule({
//     title: "Happy Birthday",
//     message: "See you in a year",
//     releaseType: "SCHEDULED_DATE",
//     releaseAt: "2027-03-11T09:00:00.000Z",
//     timezone: "Asia/Kolkata",
//     contactIds: ["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
//   })

/** PATCH /api/capsules/{capsuleId} — owner-only, full edit, while alive & not RELEASED. */
function updateCapsule(capsuleId: string, patch: Partial<{
  title: string;
  message: string;
  releaseAt: string;
  timezone: string;
  recurMonth: number;
  recurDay: number;
  contactIds: string[];
  guardianId: string | null;
}>) {
  return apiFetch<TimeCapsule>(`/api/capsules/${capsuleId}`, { method: 'PATCH', body: patch });
}

/**
 * PATCH /api/capsules/{capsuleId}/schedule — GUARDIAN-ONLY. Only the assigned
 * guardian's own account may call this (403 for anyone else, including the
 * owner). Only schedule fields are accepted — nothing else.
 */
function updateCapsuleScheduleAsGuardian(capsuleId: string, patch: Partial<{
  releaseAt: string;
  timezone: string;
  recurMonth: number;
  recurDay: number;
}>) {
  return apiFetch<unknown>(`/api/capsules/${capsuleId}/schedule`, { method: 'PATCH', body: patch });
}

/** GET /api/capsules/{capsuleId}/contacts */
function listCapsuleContacts(capsuleId: string) {
  return apiFetch<CapsuleContact[]>(`/api/capsules/${capsuleId}/contacts`);
}

/** POST /api/capsules/{capsuleId}/contacts — add recipients to an existing capsule. */
function addCapsuleContacts(capsuleId: string, contactIds: string[]) {
  return apiFetch<CapsuleContact[]>(`/api/capsules/${capsuleId}/contacts`, {
    method: 'POST',
    body: { contactIds },
  });
}

/** DELETE /api/capsules/{capsuleId}/contacts/{contactId} */
function removeCapsuleContact(capsuleId: string, contactId: string) {
  return apiFetch<void>(`/api/capsules/${capsuleId}/contacts/${contactId}`, { method: 'DELETE' });
}

/** PUT /api/capsules/{capsuleId}/guardian — assign or clear (pass null) the capsule's guardian. */
function setCapsuleGuardian(capsuleId: string, guardianId: string | null) {
  return apiFetch<TimeCapsule>(`/api/capsules/${capsuleId}/guardian`, {
    method: 'PUT',
    body: { guardianId },
  });
}

// ============================================================================
// Scheduled Messages
// ============================================================================

interface ScheduledMessage {
  id: string;
  ownerId: string;
  isMine: boolean;
  occasion: string;
  message: string;
  scheduleDate: string;
  timezone: string;
  status: 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
  sentAt: string | null;
  owner: { id: string; fullName: string; avatarKey: string | null };
  recipients: Array<{
    id: string;
    contactId: string;
    contactName: string | null;
    email: string;
    recipientUserId: string | null;
    status: 'QUEUED' | 'SENT' | 'FAILED';
    deliveredAt: string | null;
  }>;
}

/**
 * POST /api/scheduled-messages
 * `scheduleDate` must be strictly in the future — a past date returns 400.
 * `timezone` is optional; falls back to the owner's profile timezone if
 * omitted (pass it explicitly to be safe).
 */
function createScheduledMessage(input: {
  occasion: string;
  message: string;
  scheduleDate: string; // ISO datetime, must be in the future
  timezone?: string;
  contactIds: string[]; // must all be VERIFIED contacts owned by the caller
}) {
  return apiFetch<ScheduledMessage>('/api/scheduled-messages', { method: 'POST', body: input });
}
// Example call:
//   createScheduledMessage({
//     occasion: "Diwali",
//     message: "Thinking of you today!",
//     scheduleDate: "2026-11-01T14:00:00.000Z",
//     timezone: "Asia/Kolkata",
//     contactIds: ["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
//   })

interface ScheduledMessageListResponse {
  items: ScheduledMessage[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

/** GET /api/scheduled-messages?filter=for_me|scheduled_by_me&status=&search=&page=&limit= */
function listScheduledMessages(query?: {
  filter?: 'for_me' | 'scheduled_by_me';
  status?: 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
  search?: string;
  page?: number;
  limit?: number;
}) {
  const qs = new URLSearchParams(query as Record<string, string>).toString();
  return apiFetch<ScheduledMessageListResponse>(`/api/scheduled-messages${qs ? `?${qs}` : ''}`);
}

/** GET /api/scheduled-messages/{id} */
function getScheduledMessage(id: string) {
  return apiFetch<ScheduledMessage>(`/api/scheduled-messages/${id}`);
}

/** PATCH /api/scheduled-messages/{id} — owner-only, only while status=PENDING. */
function updateScheduledMessage(id: string, patch: Partial<{
  occasion: string;
  message: string;
  scheduleDate: string;
  timezone: string;
  contactIds: string[];
}>) {
  return apiFetch<ScheduledMessage>(`/api/scheduled-messages/${id}`, { method: 'PATCH', body: patch });
}

/** DELETE /api/scheduled-messages/{id} — owner-only. */
function deleteScheduledMessage(id: string) {
  return apiFetch<void>(`/api/scheduled-messages/${id}`, { method: 'DELETE' });
}

// ============================================================================
// Contacts + Groups (combined picker endpoint)
// ============================================================================

interface ContactsGroupsResponse {
  contacts: Array<{
    id: string;
    email: string;
    name: string;
    status: 'VERIFIED' | 'PENDING_INVITATION' | 'BLOCKED';
    contactUserId: string | null;
    contactUser: { id: string; fullName: string; avatarKey: string | null } | null;
  }>;
  groups: Array<{
    id: string;
    name: string;
    description: string | null;
    avatarUrl: string | null;
    participantCount: number;
    myRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    groups: { total: number; limit: number };
  };
}

/** GET /api/contacts-groups?search=&status=&page=&limit=&groupLimit= */
function listContactsAndGroups(query?: {
  search?: string;
  status?: 'VERIFIED' | 'PENDING_INVITATION' | 'BLOCKED';
  page?: number;
  limit?: number;
  groupLimit?: number;
}) {
  const qs = new URLSearchParams(query as Record<string, string>).toString();
  return apiFetch<ContactsGroupsResponse>(`/api/contacts-groups${qs ? `?${qs}` : ''}`);
}

// ============================================================================
// Notifications (extended)
// ============================================================================

interface Notification {
  id: string;
  userId: string;
  type: string; // e.g. "SCHEDULED_MESSAGE_CREATED", "GUARDIAN_ASSIGNED", "CAPSULE_RELEASED", ...
  title: string;
  body: string;
  referenceId: string | null; // deep-link target id
  referenceType: string | null; // e.g. "ScheduledMessage", "TimeCapsule", "Guardian"
  data: Record<string, unknown>;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

interface NotificationListResponse {
  items: Notification[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

/**
 * GET /api/notifications?isRead=&type=&referenceType=&referenceId=&page=&limit=
 * `isRead` and `unreadOnly` must be the literal strings "true"/"false" — not
 * omitted, not any other truthy-looking value.
 */
function listNotifications(query?: {
  isRead?: 'true' | 'false';
  type?: string;
  referenceType?: string;
  referenceId?: string;
  page?: number;
  limit?: number;
}) {
  const qs = new URLSearchParams(query as Record<string, string>).toString();
  return apiFetch<NotificationListResponse>(`/api/notifications${qs ? `?${qs}` : ''}`);
}
// Example call — unread only, page 1, 20 per page:
//   listNotifications({ isRead: "false", page: 1, limit: 20 })

/** PATCH /api/notifications/{id} — toggle read/unread. */
function setNotificationRead(id: string, isRead: boolean) {
  return apiFetch<void>(`/api/notifications/${id}`, { method: 'PATCH', body: { isRead } });
}

/** POST /api/notifications/device-tokens — register this device for push. */
function registerDeviceToken(input: {
  token: string; // FCM registration token, min 20 chars
  platform: 'IOS' | 'ANDROID' | 'WEB';
  deviceId?: string;
  appVersion?: string;
}) {
  return apiFetch<void>('/api/notifications/device-tokens', { method: 'POST', body: input });
}

export {
  login,
  createGuardian,
  listGuardians,
  getGuardianDashboard,
  getGuardian,
  deleteGuardian,
  createCapsule,
  updateCapsule,
  updateCapsuleScheduleAsGuardian,
  listCapsuleContacts,
  addCapsuleContacts,
  removeCapsuleContact,
  setCapsuleGuardian,
  createScheduledMessage,
  listScheduledMessages,
  getScheduledMessage,
  updateScheduledMessage,
  deleteScheduledMessage,
  listContactsAndGroups,
  listNotifications,
  setNotificationRead,
  registerDeviceToken,
};
