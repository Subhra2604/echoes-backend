import { z } from 'zod';

/**
 * Zod schemas for the Groups HTTP surface.
 *
 * All routes take a `groupId` UUID path parameter. Search operates over the
 * caller's own contact list, so it lives here rather than in the contacts
 * module (its shape is subtly different — VERIFIED-only, excludes participants
 * already in the group).
 */

// ── Common ───────────────────────────────────────────────────────────────────

const groupNameField = z.string().trim().min(1).max(120);
const groupDescriptionField = z.string().trim().max(500).optional();

const contactIdList = z
  .array(z.string().uuid())
  .min(1, 'At least one contact must be selected')
  .max(200, 'Too many contacts in one call');

// ── Requests ─────────────────────────────────────────────────────────────────

export const createGroupSchema = z.object({
  name: groupNameField,
  description: groupDescriptionField,
  /** S3 key of an image already uploaded via /uploads/presign (category=profile). */
  avatarKey: z.string().min(1).optional(),
  /** Contacts to add as MEMBER (creator becomes OWNER automatically). */
  contactIds: z.array(z.string().uuid()).max(200).optional().default([]),
});

export const updateGroupSchema = z
  .object({
    name: groupNameField.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    avatarKey: z.string().min(1).nullable().optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.description !== undefined || v.avatarKey !== undefined,
    { message: 'Provide at least one field to update' },
  );

export const addParticipantsSchema = z.object({
  contactIds: contactIdList,
});

export const updateParticipantRoleSchema = z.object({
  role: z.enum(['ADMIN', 'MEMBER']), // OWNER is only set via transferOwnership
});

export const transferOwnershipSchema = z.object({
  /** userId of the ACTIVE participant who should become the new OWNER. */
  newOwnerUserId: z.string().uuid(),
});

export const createGroupMediaSchema = z.object({
  /** S3 key of a file already uploaded via /uploads/presign (category=memory). */
  fileKey: z.string().min(1),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(120),
  /**
   * Client-declared size. Server confirms via HEAD before persisting; the real
   * S3 size is what actually charges quota.
   */
  sizeBytes: z.number().int().nonnegative(),
  caption: z.string().trim().max(500).optional(),
});

// ── Search caller's own contacts for group-adding purposes ───────────────────

export const searchContactsForGroupSchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  /** If set, exclude contacts already in this group. */
  excludeGroupId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ── List groups the caller belongs to ────────────────────────────────────────

export const listMyGroupsQuerySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().datetime().optional(),
});

// ── List media in a group ────────────────────────────────────────────────────

export const listGroupMediaQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().datetime().optional(),
});

// ── Params ───────────────────────────────────────────────────────────────────

export const groupIdParam = z.object({
  groupId: z.string().uuid(),
});

export const groupParticipantParam = z.object({
  groupId: z.string().uuid(),
  userId: z.string().uuid(),
});

export const groupMediaParam = z.object({
  groupId: z.string().uuid(),
  mediaId: z.string().uuid(),
});

// ── Inferred types ───────────────────────────────────────────────────────────

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type AddParticipantsInput = z.infer<typeof addParticipantsSchema>;
export type UpdateParticipantRoleInput = z.infer<typeof updateParticipantRoleSchema>;
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;
export type CreateGroupMediaInput = z.infer<typeof createGroupMediaSchema>;
export type SearchContactsForGroupInput = z.infer<typeof searchContactsForGroupSchema>;
export type ListMyGroupsQuery = z.infer<typeof listMyGroupsQuerySchema>;
export type ListGroupMediaQuery = z.infer<typeof listGroupMediaQuerySchema>;
