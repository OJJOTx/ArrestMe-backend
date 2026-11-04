import { z } from 'zod';
import { PaginationQuerySchema, PublicUserSchema } from '../../shared/http-schemas';
import { SessionCommandResponseSchema } from '../commands/commands.schemas';

export const ReleaseRequestStatusSchema = z.enum([
  'PENDING',
  'APPROVED',
  'DENIED',
  'EXPIRED',
  'CANCELLED'
]);

export const CreateReleaseRequestBodySchema = z.object({
  reason: z.string().trim().min(3).max(500)
});

export const ReleaseDecisionBodySchema = z.object({
  decisionReason: z.string().trim().min(1).max(500).optional()
});

export const ListReleaseRequestsQuerySchema = PaginationQuerySchema.extend({
  role: z.enum(['incoming', 'outgoing', 'all']).default('all'),
  status: ReleaseRequestStatusSchema.optional()
});

export const ReleaseRequestResponseSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  requester: PublicUserSchema,
  approver: PublicUserSchema,
  reason: z.string(),
  status: ReleaseRequestStatusSchema,
  decisionReason: z.string().nullable(),
  resolutionCommandId: z.string().uuid().nullable(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  updatedAt: z.string()
});

export const ReleaseDecisionResponseSchema = z.object({
  releaseRequest: ReleaseRequestResponseSchema,
  command: SessionCommandResponseSchema
});

export const PaginatedReleaseRequestsResponseSchema = z.object({
  items: z.array(ReleaseRequestResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int()
});
