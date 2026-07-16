import { z } from 'zod';

export const registerDeviceTokenSchema = z.object({
  token: z.string().min(20),
  platform: z.enum(['IOS', 'ANDROID', 'WEB']),
});

export const removeDeviceTokenSchema = z.object({
  token: z.string().min(20),
});

export type RegisterDeviceTokenInput = z.infer<typeof registerDeviceTokenSchema>;
export type RemoveDeviceTokenInput = z.infer<typeof removeDeviceTokenSchema>;
