import { z } from 'zod';

/**
 * Zod schemas for the Contacts HTTP surface. Every input that reaches the
 * service layer is validated here first, and the service layer treats the
 * parsed types as trusted.
 */

// ── Common ───────────────────────────────────────────────────────────────────

/**
 * Emails are always stored lowercased so the (ownerId, email) unique constraint
 * cannot be defeated by casing. `.trim().toLowerCase()` runs at parse time.
 */
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email('A valid email address is required');

// ── Requests ─────────────────────────────────────────────────────────────────

export const checkEmailSchema = z.object({
  email: emailField,
});

export const createContactSchema = z.object({
  email: emailField,
  // Optional display label — for a non-Echoes invitee we have no fullName yet,
  // so the client typically supplies something like "Bob at work". Falls back
  // to the email local-part if omitted.
  name: z.string().trim().min(1).max(120).optional(),
});

export const listContactsQuerySchema = z.object({
  // Free-text search across name + email. Case-insensitive substring match.
  search: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['VERIFIED', 'PENDING_INVITATION', 'BLOCKED']).optional(),
  // Cursor-friendly pagination (matches the memories module pattern).
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().datetime().optional(),
});

// ── Params ───────────────────────────────────────────────────────────────────

export const contactIdParam = z.object({
  contactId: z.string().uuid(),
});

// ── Inferred types (imported by service / route layers) ──────────────────────

export type CheckEmailInput = z.infer<typeof checkEmailSchema>;
export type CreateContactInput = z.infer<typeof createContactSchema>;
export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;
