import { z } from 'zod';
import { PaginationQuerySchema, PublicUserSchema } from '../../shared/http-schemas';
import {
  isValidIanaTimezone,
  isValidLocalDateString,
  isValidLocalTimeString
} from '../../shared/time';
import { SafeDeviceSummarySchema } from '../permissions/permissions.schemas';
import { BlockingConfigurationInputSchema, SessionTypeSchema } from '../sessions/sessions.schemas';

export const ScheduledArrestStatusSchema = z.enum([
  'SCHEDULED',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
  'REVOKED',
  'EXPIRED'
]);

export const RecurrenceRuleSchema = z.object({
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  localStartTime: z.string().refine(isValidLocalTimeString, {
    message: 'Invalid HH:MM 24-hour local time.'
  }),
  localEndTime: z
    .string()
    .refine(isValidLocalTimeString, {
      message: 'Invalid HH:MM 24-hour local time.'
    })
    .nullable()
    .optional(),
  durationMinutes: z.number().int().min(1).max(720),
  timezone: z.string().trim().min(1).max(64).refine(isValidIanaTimezone, {
    message: 'Invalid IANA timezone identifier.'
  }),
  endDate: z.string().refine(isValidLocalDateString, {
    message: 'Invalid YYYY-MM-DD local date.'
  }),
  maxOccurrences: z.number().int().min(1).max(365)
});

export const ListScheduledArrestsQuerySchema = PaginationQuerySchema.extend({
  role: z.enum(['owner', 'partner', 'all']).default('all'),
  status: ScheduledArrestStatusSchema.optional(),
  partnerUserId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional()
});

export const ScheduledArrestResponseSchema = z.object({
  scheduleId: z.string().uuid(),
  proposalId: z.string().uuid().nullable(),
  permissionId: z.string().uuid().nullable(),
  owner: PublicUserSchema,
  partner: PublicUserSchema,
  targetDevice: SafeDeviceSummarySchema,
  scheduleType: z.enum(['SCHEDULED', 'RECURRING']),
  sessionType: SessionTypeSchema,
  goal: z.string(),
  durationMinutes: z.number().int(),
  blockingConfiguration: BlockingConfigurationInputSchema,
  timezone: z.string(),
  scheduledStartAt: z.string().nullable(),
  scheduledEndAt: z.string().nullable(),
  recurrenceRule: RecurrenceRuleSchema.nullable(),
  occurrencesCompleted: z.number().int(),
  maxOccurrences: z.number().int(),
  nextOccurrenceAt: z.string().nullable(),
  status: ScheduledArrestStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});

export const PaginatedScheduledArrestsResponseSchema = z.object({
  items: z.array(ScheduledArrestResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int()
});
