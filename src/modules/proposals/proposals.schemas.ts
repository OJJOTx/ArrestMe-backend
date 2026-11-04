import { z } from 'zod';
import { PaginationQuerySchema, PublicUserSchema } from '../../shared/http-schemas';
import {
  isValidIanaTimezone,
  isValidLocalDateString,
  isValidLocalTimeString
} from '../../shared/time';
import {
  AllowedTimeWindowsSchema,
  BlockingConfigLimitsInputSchema,
  DelegableSessionTypeEnum,
  PartnerPermissionResponseSchema,
  SafeDeviceSummarySchema
} from '../permissions/permissions.schemas';
import { RecurrenceRuleSchema, ScheduledArrestResponseSchema } from '../schedules/schedules.schemas';
import {
  ArrestSessionResponseSchema,
  BlockingConfigurationInputSchema
} from '../sessions/sessions.schemas';

export const ArrestRequestTypeSchema = z.enum([
  'IMMEDIATE',
  'SCHEDULED',
  'RECURRING',
  'STANDING_AUTHORIZATION'
]);

export const ArrestProposalStatusSchema = z.enum([
  'DRAFT',
  'PENDING',
  'COUNTEROFFERED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED'
]);

export const ProposalScheduleInputSchema = z.object({
  localDate: z.string().refine(isValidLocalDateString, {
    message: 'Invalid YYYY-MM-DD local date.'
  }),
  localStartTime: z.string().refine(isValidLocalTimeString, {
    message: 'Invalid HH:MM 24-hour local start time.'
  }),
  localEndTime: z
    .string()
    .refine(isValidLocalTimeString, {
      message: 'Invalid HH:MM 24-hour local end time.'
    })
    .nullable()
    .optional(),
  timezone: z.string().trim().min(1).max(64).refine(isValidIanaTimezone, {
    message: 'Invalid IANA timezone identifier.'
  })
});

export const ProposalScheduleResponseSchema = ProposalScheduleInputSchema.extend({
  scheduledStartUtc: z.string(),
  scheduledEndUtc: z.string()
});

export const ProposalStandingAuthorizationInputSchema = z.object({
  validFromUtc: z.string().datetime().optional(),
  expiresAtUtc: z.string().datetime(),
  maximumSessionDuration: z.number().int().min(1).max(720),
  allowedTimeWindows: AllowedTimeWindowsSchema.nullable().optional(),
  blockingConfigLimits: BlockingConfigLimitsInputSchema.optional()
});

export const ProposalStandingAuthorizationResponseSchema = z.object({
  validFromUtc: z.string(),
  expiresAtUtc: z.string(),
  maximumSessionDuration: z.number().int(),
  allowedTimeWindows: AllowedTimeWindowsSchema.nullable(),
  blockingConfigLimits: BlockingConfigLimitsInputSchema
});

export const CreateProposalBodySchema = z.object({
  targetDeviceId: z.string().uuid(),
  partnerUserId: z.string().uuid().optional(),
  requestType: ArrestRequestTypeSchema.default('IMMEDIATE'),
  sessionType: DelegableSessionTypeEnum.default('PARTNER_ARREST'),
  goal: z.string().trim().min(1).max(255).default('Focus Session'),
  durationMinutes: z.number().int().min(1).max(720).default(45),
  blockingConfiguration: BlockingConfigurationInputSchema.default({
    schemaVersion: 1,
    ruleMode: 'BLOCK_SELECTED',
    allowedCategories: ['CALLS', 'STUDY_APPS'],
    overlayStatusBar: false,
    disableEmergencyExit: false
  }),
  requireApprovalBeforeArrest: z.boolean().default(true),
  schedule: ProposalScheduleInputSchema.nullable().optional(),
  recurrence: RecurrenceRuleSchema.nullable().optional(),
  standingAuthorization: ProposalStandingAuthorizationInputSchema.nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  ttlMinutes: z.number().int().min(5).max(10080).default(1440),
  idempotencyKey: z.string().trim().min(8).max(128).optional()
});

export const CounterofferProposalBodySchema = z.object({
  expectedRevisionNumber: z.number().int().min(1),
  requestType: ArrestRequestTypeSchema.optional(),
  sessionType: DelegableSessionTypeEnum.optional(),
  goal: z.string().trim().min(1).max(255).optional(),
  durationMinutes: z.number().int().min(1).max(720).optional(),
  blockingConfiguration: BlockingConfigurationInputSchema.optional(),
  requireApprovalBeforeArrest: z.boolean().optional(),
  schedule: ProposalScheduleInputSchema.nullable().optional(),
  recurrence: RecurrenceRuleSchema.nullable().optional(),
  standingAuthorization: ProposalStandingAuthorizationInputSchema.nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  ttlMinutes: z.number().int().min(5).max(10080).default(1440)
});

export const AcceptProposalBodySchema = z.object({
  expectedRevisionNumber: z.number().int().min(1),
  startImmediateSession: z.boolean().default(true)
});

export const RejectOrCancelProposalBodySchema = z.object({
  expectedRevisionNumber: z.number().int().min(1).optional(),
  reason: z.string().trim().max(500).optional()
});

export const ListProposalsQuerySchema = PaginationQuerySchema.extend({
  role: z.enum(['incoming', 'outgoing', 'all']).default('all'),
  status: ArrestProposalStatusSchema.optional(),
  partnerUserId: z.string().uuid().optional()
});

export const NormalizedProposalConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  requestType: ArrestRequestTypeSchema,
  targetDeviceId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  initiatingPartnerUserId: z.string().uuid(),
  sessionType: DelegableSessionTypeEnum,
  goal: z.string(),
  durationMinutes: z.number().int(),
  blockingConfiguration: BlockingConfigurationInputSchema,
  requireApprovalBeforeArrest: z.boolean(),
  schedule: ProposalScheduleResponseSchema.nullable(),
  recurrence: RecurrenceRuleSchema.nullable(),
  standingAuthorization: ProposalStandingAuthorizationResponseSchema.nullable()
});

export const ProposalRevisionResponseSchema = z.object({
  id: z.string().uuid(),
  proposalId: z.string().uuid(),
  revisionNumber: z.number().int(),
  proposer: PublicUserSchema,
  recipient: PublicUserSchema,
  normalizedConfiguration: NormalizedProposalConfigurationSchema,
  reason: z.string().nullable(),
  status: ArrestProposalStatusSchema,
  createdAt: z.string(),
  expiresAt: z.string()
});

export const ProposalResponseSchema = z.object({
  proposalId: z.string().uuid(),
  partnershipId: z.string().uuid(),
  owner: PublicUserSchema,
  partner: PublicUserSchema,
  targetDevice: SafeDeviceSummarySchema,
  proposer: PublicUserSchema,
  recipient: PublicUserSchema,
  requestType: ArrestRequestTypeSchema,
  currentRevision: z.number().int(),
  status: ArrestProposalStatusSchema,
  normalizedConfiguration: NormalizedProposalConfigurationSchema,
  reason: z.string().nullable(),
  approvedRevision: z.number().int().nullable(),
  resultingPermissionId: z.string().uuid().nullable(),
  resultingSessionId: z.string().uuid().nullable(),
  resultingScheduleId: z.string().uuid().nullable(),
  expiresAt: z.string(),
  respondedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revisions: z.array(ProposalRevisionResponseSchema).optional()
});

export const PaginatedProposalsResponseSchema = z.object({
  items: z.array(ProposalResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int()
});

export const AcceptProposalResponseSchema = z.object({
  proposal: ProposalResponseSchema,
  permission: PartnerPermissionResponseSchema.nullable(),
  session: ArrestSessionResponseSchema.nullable(),
  schedule: ScheduledArrestResponseSchema.nullable()
});
