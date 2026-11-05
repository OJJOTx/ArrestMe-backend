import { z } from 'zod';

export const CommandTypeSchema = z.enum([
  'START_ARREST',
  'REQUEST_RELEASE',
  'APPROVE_RELEASE',
  'DENY_RELEASE',
  'END_SESSION',
  'SYNC_SESSION',
  'APPLY_TEMPORARY_APP_ACCESS',
  'REVOKE_TEMPORARY_APP_ACCESS',
  'UPDATE_SESSION_RULES'
]);

export const CommandStatusSchema = z.enum([
  'PENDING',
  'DELIVERED',
  'ACKNOWLEDGED',
  'EXECUTED',
  'REJECTED',
  'EXPIRED',
  'FAILED'
]);

export const PollDeviceCommandsQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  includeAcknowledged: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true')
});

export const AcknowledgeCommandBodySchema = z.object({
  deviceId: z.string().uuid(),
  status: z.enum(['ACKNOWLEDGED', 'EXECUTED', 'REJECTED', 'FAILED']),
  localSessionId: z.string().trim().min(1).max(64).optional(),
  executedAtClientMs: z.number().int().positive().optional(),
  failureReason: z.string().trim().min(1).max(255).optional(),
  resultMetadata: z.record(z.string(), z.unknown()).optional()
});

export const SessionCommandResponseSchema = z.object({
  sequenceNo: z.number().int(),
  commandId: z.string().uuid(),
  sessionId: z.string().uuid(),
  targetDeviceId: z.string().uuid(),
  issuedByUserId: z.string().uuid(),
  commandType: CommandTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  status: CommandStatusSchema,
  idempotencyKey: z.string(),
  resultMetadata: z.record(z.string(), z.unknown()).nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  deliveredAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  executedAt: z.string().nullable(),
  updatedAt: z.string()
});

export const PollDeviceCommandsResponseSchema = z.object({
  items: z.array(SessionCommandResponseSchema),
  nextCursorSequence: z.number().int(),
  serverTime: z.string()
});
