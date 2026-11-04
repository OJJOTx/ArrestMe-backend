import { z } from 'zod';
import { PaginationQuerySchema, PublicUserSchema } from '../../shared/http-schemas';
import { UsernameSchema } from '../auth/auth.schemas';

export const SendPartnerRequestBodySchema = z
  .object({
    username: UsernameSchema.optional(),
    recipientUserId: z.string().uuid().optional()
  })
  .refine((val) => Boolean(val.username || val.recipientUserId), {
    message: 'Provide either username or recipientUserId.'
  });

export const ListPartnerRequestsQuerySchema = PaginationQuerySchema.extend({
  direction: z.enum(['incoming', 'outgoing', 'all']).default('all'),
  state: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'BLOCKED']).optional()
});

export const PartnershipResponseSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'BLOCKED']),
  sender: PublicUserSchema,
  recipient: PublicUserSchema,
  partner: PublicUserSchema,
  respondedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const PaginatedPartnershipsResponseSchema = z.object({
  items: z.array(PartnershipResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int()
});
