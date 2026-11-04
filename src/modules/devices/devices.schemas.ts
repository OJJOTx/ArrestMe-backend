import { z } from 'zod';
import { PaginationQuerySchema } from '../../shared/http-schemas';

export const RegisterDeviceBodySchema = z.object({
  installationId: z.string().trim().min(8).max(128).optional(),
  deviceName: z.string().trim().min(1).max(100),
  platform: z.literal('ANDROID').default('ANDROID'),
  manufacturer: z.string().trim().min(1).max(64).optional(),
  model: z.string().trim().min(1).max(64).optional(),
  appVersion: z.string().trim().min(1).max(48),
  androidVersion: z.string().trim().min(1).max(32),
  sdkInt: z.number().int().min(26).max(60).optional(),
  fcmToken: z.string().trim().min(20).max(512).optional()
});

export const UpdateDeviceBodySchema = z
  .object({
    deviceName: z.string().trim().min(1).max(100).optional(),
    manufacturer: z.string().trim().min(1).max(64).nullable().optional(),
    model: z.string().trim().min(1).max(64).nullable().optional(),
    appVersion: z.string().trim().min(1).max(48).optional(),
    androidVersion: z.string().trim().min(1).max(32).optional(),
    sdkInt: z.number().int().min(26).max(60).nullable().optional(),
    deviceStatus: z.enum(['ACTIVE', 'INACTIVE']).optional()
  })
  .refine((val) => Object.keys(val).length > 0, {
    message: 'At least one device attribute must be provided.'
  });

export const RegisterPushTokenBodySchema = z.object({
  fcmToken: z.string().trim().min(20).max(512)
});

export const ListDevicesQuerySchema = PaginationQuerySchema.extend({
  includeRevoked: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true')
});

export const DeviceResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  installationId: z.string().nullable(),
  deviceName: z.string(),
  platform: z.literal('ANDROID'),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  appVersion: z.string(),
  androidVersion: z.string(),
  sdkInt: z.number().int().nullable(),
  deviceStatus: z.enum(['ACTIVE', 'INACTIVE', 'REVOKED']),
  lastSeenAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const PaginatedDevicesResponseSchema = z.object({
  items: z.array(DeviceResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int()
});
