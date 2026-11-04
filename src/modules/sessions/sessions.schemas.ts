import { z } from 'zod';
import { PaginationQuerySchema } from '../../shared/http-schemas';
import { SessionCommandResponseSchema } from '../commands/commands.schemas';
import { AllowedCategoryEnum, BlockingRuleModeEnum } from '../permissions/permissions.schemas';

export const SessionTypeSchema = z.enum(['SELF_ARREST', 'PARTNER_ARREST', 'MUTUAL_ARREST']);

export const AndroidEngineStateSchema = z.enum([
  'IDLE',
  'PREPARING',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'EMERGENCY_STOPPED',
  'INTERRUPTED'
]);

export const CloudSessionStatusSchema = z.enum([
  'REQUESTED',
  'DELIVERED',
  'ACTIVE',
  'PAUSED',
  'INTERRUPTED',
  'COMPLETED',
  'RELEASED_EARLY',
  'EMERGENCY_STOPPED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED'
]);

export const PackageNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(192)
  .refine((pkg) => /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(pkg), {
    message: 'Invalid Android package name.'
  });

export const BlockingConfigurationInputSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  ruleMode: BlockingRuleModeEnum.default('BLOCK_SELECTED'),
  allowedCategories: z
    .array(AllowedCategoryEnum)
    .default(['CALLS', 'STUDY_APPS']),
  overlayStatusBar: z.boolean().default(false),
  disableEmergencyExit: z.boolean().default(false),
  blockedPackages: z.array(PackageNameSchema).max(200).optional(),
  allowedStudyPackages: z.array(PackageNameSchema).max(200).optional()
});

export const CreateSessionBodySchema = z.object({
  sessionType: SessionTypeSchema.default('PARTNER_ARREST'),
  targetDeviceId: z.string().uuid(),
  authorizationId: z.string().uuid().optional(),
  requestedDurationMinutes: z.number().int().min(1).max(720),
  goal: z.string().trim().min(1).max(255).default('Focus Session'),
  blockingConfiguration: BlockingConfigurationInputSchema.default({
    schemaVersion: 1,
    ruleMode: 'BLOCK_SELECTED',
    allowedCategories: ['CALLS', 'STUDY_APPS'],
    overlayStatusBar: false,
    disableEmergencyExit: false
  }),
  commandTtlSeconds: z.number().int().min(30).max(86400).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional()
});

export const ListSessionsQuerySchema = PaginationQuerySchema.extend({
  role: z.enum(['owner', 'initiator', 'all']).default('all'),
  status: CloudSessionStatusSchema.optional(),
  deviceId: z.string().uuid().optional()
});

export const AcknowledgeSessionBodySchema = z.object({
  deviceId: z.string().uuid(),
  outcome: z.enum(['ACCEPTED', 'STARTED', 'REJECTED']),
  localSessionId: z.string().trim().min(1).max(64).optional(),
  localEngineState: AndroidEngineStateSchema.optional(),
  reason: z.string().trim().min(1).max(255).optional()
});

export const SyncEventItemSchema = z.object({
  clientEventId: z.string().trim().min(4).max(128),
  eventType: z.enum([
    'SESSION_STARTED',
    'SESSION_PAUSED',
    'SESSION_RESUMED',
    'SESSION_INTERRUPTED',
    'SESSION_COMPLETED',
    'EMERGENCY_STOPPED',
    'CLOCK_ANOMALY_DETECTED',
    'HEARTBEAT_SYNC'
  ]),
  fromEngineState: AndroidEngineStateSchema.nullable().optional(),
  toEngineState: AndroidEngineStateSchema.nullable().optional(),
  occurredAtClientMs: z.number().int().positive(),
  localSessionId: z.string().trim().min(1).max(64).optional(),
  accumulatedPausedMs: z.number().int().min(0).max(86_400_000).optional(),
  reason: z.string().trim().max(255).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const PostSessionEventsBodySchema = z.object({
  deviceId: z.string().uuid(),
  events: z.array(SyncEventItemSchema).min(1).max(50)
});

export const RemoteSessionCommandBodySchema = z.object({
  reason: z.string().trim().min(1).max(255).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional()
});

export const ArrestSessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
  localSessionId: z.string().nullable(),
  ownerUserId: z.string().uuid(),
  targetDeviceId: z.string().uuid(),
  initiatedByUserId: z.string().uuid(),
  authorizationId: z.string().uuid().nullable(),
  sessionType: SessionTypeSchema,
  goal: z.string(),
  blockingConfiguration: BlockingConfigurationInputSchema,
  requestedDurationMinutes: z.number().int(),
  status: CloudSessionStatusSchema,
  localEngineState: AndroidEngineStateSchema.nullable(),
  requestedAt: z.string(),
  acceptedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  expectedEndAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  completionReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const CreateSessionResponseSchema = z.object({
  session: ArrestSessionResponseSchema,
  command: SessionCommandResponseSchema.nullable(),
  idempotentReplay: z.boolean()
});

export const PaginatedSessionsResponseSchema = z.object({
  items: z.array(ArrestSessionResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int()
});
