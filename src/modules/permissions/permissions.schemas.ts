import { z } from 'zod';
import { PaginationQuerySchema, PublicUserSchema } from '../../shared/http-schemas';
import { isValidIanaTimezone } from '../../shared/time';

export const AllowedCategoryEnum = z.enum(['CALLS', 'STUDY_APPS']);
export const BlockingRuleModeEnum = z.enum([
  'BLOCK_SELECTED',
  'STRICT_ALLOWLIST',
  'WHITELIST_ONLY'
]);
export const DelegableSessionTypeEnum = z.enum(['PARTNER_ARREST', 'MUTUAL_ARREST']);

export const TimeWindowRuleSchema = z
  .object({
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    startMinuteOfDay: z.number().int().min(0).max(1439),
    endMinuteOfDay: z.number().int().min(1).max(1440)
  })
  .refine((w) => w.endMinuteOfDay > w.startMinuteOfDay, {
    message: 'endMinuteOfDay must be greater than startMinuteOfDay.'
  });

export const AllowedTimeWindowsSchema = z.object({
  timezone: z.string().trim().min(1).max(64).refine(isValidIanaTimezone, {
    message: 'Invalid IANA timezone identifier.'
  }),
  windows: z.array(TimeWindowRuleSchema).min(1).max(14)
});

export const BlockingConfigLimitsInputSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  allowedRuleModes: z
    .array(BlockingRuleModeEnum)
    .min(1)
    .default(['BLOCK_SELECTED', 'STRICT_ALLOWLIST']),
  allowDisableEmergencyExit: z.boolean().default(false),
  allowOverlayStatusBar: z.boolean().default(false),
  requiredAllowedCategories: z.array(AllowedCategoryEnum).default(['CALLS']),
  allowCustomPackageLists: z.boolean().default(false),
  dailyMaxSessions: z.number().int().min(1).max(50).optional(),
  cooldownMinutes: z.number().int().min(1).max(1440).optional()
});

export const CreatePartnerPermissionBodySchema = z.object({
  ownerUserId: z.string().uuid().optional(),
  partnerUserId: z.string().uuid(),
  targetDeviceId: z.string().uuid(),
  maximumSessionDuration: z.number().int().min(1).max(720),
  allowedTimeWindows: AllowedTimeWindowsSchema.nullable().optional(),
  allowedSessionTypes: z
    .array(DelegableSessionTypeEnum)
    .min(1)
    .default(['PARTNER_ARREST']),
  blockingConfigLimits: BlockingConfigLimitsInputSchema.optional(),
  oneTimeOnly: z.boolean().default(false),
  validFrom: z.string().datetime().optional(),
  expiresAt: z.string().datetime()
});

export const UpdatePartnerPermissionBodySchema = z
  .object({
    maximumSessionDuration: z.number().int().min(1).max(720).optional(),
    allowedTimeWindows: AllowedTimeWindowsSchema.nullable().optional(),
    allowedSessionTypes: z.array(DelegableSessionTypeEnum).min(1).optional(),
    blockingConfigLimits: BlockingConfigLimitsInputSchema.optional(),
    oneTimeOnly: z.boolean().optional(),
    validFrom: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional()
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one authorization field must be provided.'
  });

export const ListPartnerPermissionsQuerySchema = PaginationQuerySchema.extend({
  role: z.enum(['granted', 'received', 'all']).default('all'),
  activeOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === undefined ? true : v === true || v === 'true'),
  includeConsumed: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true')
});

export const SafeDeviceSummarySchema = z.object({
  id: z.string().uuid(),
  deviceName: z.string(),
  platform: z.literal('ANDROID'),
  deviceStatus: z.enum(['ACTIVE', 'INACTIVE', 'REVOKED'])
});

export const ExactApprovedSessionConfigSchema = z.object({
  sessionType: z.enum(['SELF_ARREST', 'PARTNER_ARREST', 'MUTUAL_ARREST']),
  goal: z.string(),
  durationMinutes: z.number().int(),
  blockingConfiguration: z.object({
    schemaVersion: z.literal(1),
    ruleMode: BlockingRuleModeEnum,
    allowedCategories: z.array(AllowedCategoryEnum),
    overlayStatusBar: z.boolean(),
    disableEmergencyExit: z.boolean(),
    blockedPackages: z.array(z.string()).optional(),
    allowedStudyPackages: z.array(z.string()).optional()
  })
});

export const PartnerPermissionResponseSchema = z.object({
  permissionId: z.string().uuid(),
  owner: PublicUserSchema,
  partner: PublicUserSchema,
  targetDevice: SafeDeviceSummarySchema,
  proposalId: z.string().uuid().nullable().optional(),
  approvedRevision: z.number().int().nullable().optional(),
  boundSessionId: z.string().uuid().nullable().optional(),
  exactBlockingConfiguration: ExactApprovedSessionConfigSchema.nullable().optional(),
  maximumSessionDuration: z.number().int(),
  allowedTimeWindows: AllowedTimeWindowsSchema.nullable(),
  allowedSessionTypes: z.array(z.enum(['SELF_ARREST', 'PARTNER_ARREST', 'MUTUAL_ARREST'])),
  blockingConfigLimits: BlockingConfigLimitsInputSchema,
  oneTimeOnly: z.boolean(),
  usedCount: z.number().int(),
  version: z.number().int(),
  isCurrentlyActive: z.boolean(),
  validFrom: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  revokedByUserId: z.string().uuid().nullable(),
  revokeReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const PaginatedPartnerPermissionsResponseSchema = z.object({
  items: z.array(PartnerPermissionResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int()
});
