import { z } from 'zod';

/**
 * Zod schemas for the Time Capsule HTTP surface.
 *
 * Supports both the legacy single-recipient shape (recipientEmail /
 * recipientUserId — kept for backwards compatibility with clients still on
 * the old contract) and the new contact-based multi-recipient shape
 * (contactIds + guardianId — spec §15).
 *
 * At least one recipient must be supplied. The service enforces contact
 * ownership + verification and guardian ownership independently.
 */

// ── Common ──────────────────────────────────────────────────────────────────

const titleField = z.string().trim().min(1).max(160);
const messageField = z.string().trim().max(10_000).optional();
const contactIdsField = z
  .array(z.string().uuid())
  .max(100, 'Too many recipients in one call')
  .optional();

// ── Create ─────────────────────────────────────────────────────────────────

export const createCapsuleSchema = z
  .object({
    title: titleField,
    /** Free-text note; called `message` in schema, `note` in spec. Alias below. */
    message: messageField,
    /** Spec §15 alias for `message`. Either one is accepted. */
    note: messageField,
    /** Existing vault item to attach (image / pdf / audio / video). */
    mediaItemId: z.string().uuid().optional(),

    // — Legacy single-recipient path — kept for existing clients.
    recipientEmail: z.string().email().optional(),
    recipientUserId: z.string().uuid().optional(),

    // — New multi-recipient path (spec §15).
    contactIds: contactIdsField,

    // — One guardian per capsule (spec §15).
    guardianId: z.string().uuid().optional(),

    releaseType: z.enum([
      'SCHEDULED_DATE',
      'RECURRING_ANNUAL',
      'GUARDIAN_CONTROLLED',
    ]),

    // SCHEDULED_DATE
    releaseAt: z.coerce.date().optional(),
    /** Spec §15 alias for `releaseAt` — an explicit UTC ISO timestamp. */
    scheduleDate: z.coerce.date().optional(),
    /** Optional IANA timezone override; defaults to owner's profile timezone. */
    timezone: z.string().trim().min(1).max(80).optional(),

    // RECURRING_ANNUAL
    recurMonth: z.number().int().min(1).max(12).optional(),
    recurDay: z.number().int().min(1).max(31).optional(),
  })
  .superRefine((v, ctx) => {
    // Body needs content — either a written note or a media attachment.
    const hasMessage = Boolean(v.message ?? v.note);
    if (!hasMessage && !v.mediaItemId) {
      ctx.addIssue({
        code: 'custom',
        message: 'A capsule needs a message and/or a media item',
        path: ['message'],
      });
    }

    // At least one recipient (legacy email OR contact list).
    const hasRecipient =
      Boolean(v.recipientEmail) ||
      Boolean(v.recipientUserId) ||
      (v.contactIds !== undefined && v.contactIds.length > 0);
    if (!hasRecipient) {
      ctx.addIssue({
        code: 'custom',
        message:
          'A capsule needs at least one recipient — pass contactIds (preferred) or recipientEmail',
        path: ['contactIds'],
      });
    }

    // Release-type-specific rules.
    if (v.releaseType === 'SCHEDULED_DATE') {
      const fireAt = v.releaseAt ?? v.scheduleDate;
      if (!fireAt) {
        ctx.addIssue({
          code: 'custom',
          message: 'scheduleDate (or releaseAt) is required',
          path: ['scheduleDate'],
        });
      } else if (fireAt.getTime() <= Date.now()) {
        ctx.addIssue({
          code: 'custom',
          message: 'scheduleDate must be in the future',
          path: ['scheduleDate'],
        });
      }
    }
    if (
      v.releaseType === 'RECURRING_ANNUAL' &&
      (v.recurMonth == null || v.recurDay == null)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'recurMonth and recurDay are required for recurring capsules',
        path: ['recurMonth'],
      });
    }
  });

// ── Update (owner) ─────────────────────────────────────────────────────────
//
// Owner can edit anything metadata-shaped while the capsule is not yet
// released. Guardian-only edits go through `updateCapsuleScheduleSchema` on
// its dedicated endpoint (spec §14).

export const updateCapsuleSchema = z
  .object({
    title: titleField.optional(),
    message: messageField,
    note: messageField,
    mediaItemId: z.string().uuid().nullable().optional(),
    contactIds: contactIdsField,
    guardianId: z.string().uuid().nullable().optional(),
    recipientEmail: z.string().email().optional(),
    releaseAt: z.coerce.date().optional(),
    scheduleDate: z.coerce.date().optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
    recurMonth: z.number().int().min(1).max(12).optional(),
    recurDay: z.number().int().min(1).max(31).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to update',
  });

// ── Guardian schedule-only patch (spec §14) ────────────────────────────────

export const updateCapsuleScheduleSchema = z
  .object({
    scheduleDate: z.coerce.date().optional(),
    releaseAt: z.coerce.date().optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
    recurMonth: z.number().int().min(1).max(12).optional(),
    recurDay: z.number().int().min(1).max(31).optional(),
  })
  .refine(
    (v) =>
      v.scheduleDate !== undefined ||
      v.releaseAt !== undefined ||
      v.recurMonth !== undefined ||
      v.recurDay !== undefined,
    { message: 'Provide a new schedule date or a recurrence' },
  );

// ── Recipients & guardian sub-endpoints ────────────────────────────────────

export const addCapsuleContactsSchema = z.object({
  contactIds: z
    .array(z.string().uuid())
    .min(1)
    .max(100),
});

export const setCapsuleGuardianSchema = z.object({
  guardianId: z.string().uuid().nullable(),
});

// ── Params ─────────────────────────────────────────────────────────────────

export const capsuleIdParam = z.object({ capsuleId: z.string().uuid() });
export const capsuleContactParam = z.object({
  capsuleId: z.string().uuid(),
  contactId: z.string().uuid(),
});

// ── Inferred types ─────────────────────────────────────────────────────────

export type CreateCapsuleInput = z.infer<typeof createCapsuleSchema>;
export type UpdateCapsuleInput = z.infer<typeof updateCapsuleSchema>;
export type UpdateCapsuleScheduleInput = z.infer<
  typeof updateCapsuleScheduleSchema
>;
export type AddCapsuleContactsInput = z.infer<typeof addCapsuleContactsSchema>;
export type SetCapsuleGuardianInput = z.infer<typeof setCapsuleGuardianSchema>;
