import { z } from 'zod';

/**
 * Notification device registration + list schemas.
 *
 * The `platform` enum matches the DevicePlatform Prisma enum — Android, iOS,
 * and Web (which FCM handles too). `deviceId` and `appVersion` are optional
 * per-install metadata used by support to triage delivery problems.
 */

export const registerDeviceTokenSchema = z.object({
  token: z.string().min(20),
  platform: z.enum(['IOS', 'ANDROID', 'WEB']),
  deviceId: z.string().trim().max(120).optional(),
  appVersion: z.string().trim().max(40).optional(),
});

export const removeDeviceTokenSchema = z.object({
  token: z.string().min(20),
});

/**
 * List notifications with optional filters. `type` accepts the exact
 * NotificationType enum values — the frontend uses this to fetch, say,
 * only capsule-related notifications for a specific screen.
 */
export const listNotificationsQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  isRead: z.coerce.boolean().optional(),
  type: z.string().trim().min(1).max(80).optional(),
  referenceType: z.string().trim().min(1).max(80).optional(),
  referenceId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** PATCH /notifications/:id — toggle read state. */
export const patchNotificationSchema = z.object({
  isRead: z.boolean(),
});

export type RegisterDeviceTokenInput = z.infer<typeof registerDeviceTokenSchema>;
export type RemoveDeviceTokenInput = z.infer<typeof removeDeviceTokenSchema>;
export type ListNotificationsQuery = z.infer<
  typeof listNotificationsQuerySchema
>;
export type PatchNotificationInput = z.infer<typeof patchNotificationSchema>;
