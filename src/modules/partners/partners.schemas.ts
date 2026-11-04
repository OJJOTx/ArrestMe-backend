import { z } from 'zod';
import { PaginationQuerySchema, PublicUserSchema } from '../../shared/http-schemas';
import { UsernameSchema } from '../auth/auth.schemas';
import {
  PartnerPermissionResponseSchema,
  SafeDeviceSummarySchema
} from '../permissions/permissions.schemas';
import { ProposalResponseSchema } from '../proposals/proposals.schemas';
import { ScheduledArrestResponseSchema } from '../schedules/schedules.schemas';

export const InviteCodeQueryOrFieldSchema = z
  .string()
  .trim()
  .min(4)
  .max(24)
  .transform((v) => v.toUpperCase());

export const SendPartnerRequestBodySchema = z
  .object({
    username: UsernameSchema.optional(),
    recipientUserId: z.string().uuid().optional(),
    inviteCode: InviteCodeQueryOrFieldSchema.optional()
  })
  .refine((val) => Boolean(val.username || val.recipientUserId || val.inviteCode), {
    message: 'Provide username, recipientUserId, or inviteCode.'
  });

export const DiscoverPartnerQuerySchema = z.object({
  username: UsernameSchema.optional(),
  inviteCode: InviteCodeQueryOrFieldSchema.optional()
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

export const PendingCountsSchema = z.object({
  incomingFriendRequestsCount: z.number().int(),
  outgoingFriendRequestsCount: z.number().int(),
  incomingProposalsCount: z.number().int(),
  outgoingProposalsCount: z.number().int()
});

export const PartnerDiscoveryResponseSchema = z.object({
  found: z.boolean(),
  user: PublicUserSchema.nullable(),
  relationshipState: z.enum([
    'NONE',
    'SELF',
    'PENDING_INCOMING',
    'PENDING_OUTGOING',
    'ACCEPTED',
    'REJECTED',
    'CANCELLED',
    'BLOCKED'
  ]),
  partnershipId: z.string().uuid().nullable(),
  pendingCounts: PendingCountsSchema
});

export const ApprovalPolicyResponseSchema = z.object({
  ownerUserId: z.string().uuid(),
  partnerUserId: z.string().uuid(),
  requireApprovalBeforeArrest: z.boolean(),
  explicitlyConfigured: z.boolean(),
  notes: z.string().nullable(),
  activeStandingAuthorizationsCount: z.number().int(),
  activeStandingAuthorizations: z.array(PartnerPermissionResponseSchema),
  updatedAt: z.string().nullable()
});

export const UpdateApprovalPolicyBodySchema = z.object({
  requireApprovalBeforeArrest: z.boolean(),
  notes: z.string().trim().max(255).nullable().optional()
});

export const PartnerProfileResponseSchema = z.object({
  partnership: PartnershipResponseSchema,
  partner: PublicUserSchema,
  relationshipStatus: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'BLOCKED']),
  myDevices: z.array(SafeDeviceSummarySchema),
  partnerDevices: z.array(SafeDeviceSummarySchema),
  permissionsGrantedToPartner: z.array(PartnerPermissionResponseSchema),
  permissionsReceivedFromPartner: z.array(PartnerPermissionResponseSchema),
  myApprovalPolicyForPartner: ApprovalPolicyResponseSchema,
  partnerApprovalPolicyForMe: ApprovalPolicyResponseSchema,
  pendingProposals: z.array(ProposalResponseSchema),
  activeSchedules: z.array(ScheduledArrestResponseSchema)
});
