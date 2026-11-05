import { z } from 'zod';
import { PublicUserSchema } from '../../shared/http-schemas';

export const MessageTypeSchema = z.enum(['TEXT', 'STRUCTURED_REQUEST', 'SYSTEM_EVENT']);
export const MessageDeliveryStatusSchema = z.enum(['SENT', 'DELIVERED', 'READ']);

export const StructuredRequestTypeSchema = z.enum([
  'REQUEST_EARLY_RELEASE',
  'REQUEST_TEMPORARY_APP_ACCESS',
  'REQUEST_ADD_ALLOWED_APP',
  'REQUEST_REMOVE_BLOCKED_APP',
  'REQUEST_CHANGE_BLOCKING_MODE',
  'REQUEST_SESSION_EXTENSION',
  'REQUEST_SCHEDULE_CHANGE',
  'REQUEST_CUSTOM_ACTION'
]);

export const StructuredRequestStatusSchema = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED'
]);

export const ListConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0)
});

export const ListMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  beforeDate: z.string().datetime().optional(),
  afterDate: z.string().datetime().optional()
});

export const SendTextMessageBodySchema = z.object({
  clientMessageId: z.string().min(1).max(64),
  text: z.string().min(1).max(2000)
});

export const CreateStructuredRequestBodySchema = z.object({
  clientMessageId: z.string().min(1).max(64),
  requestType: StructuredRequestTypeSchema,
  sessionId: z.string().uuid().optional(),
  targetPackage: z.string().min(1).max(255).optional(),
  durationMinutes: z.number().int().min(1).max(720).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  messageText: z.string().max(1000).optional()
});

export const RespondStructuredRequestBodySchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().max(500).optional()
});

export const MarkConversationReadBodySchema = z.object({
  lastReadMessageId: z.string().min(1).max(36)
});

export const StructuredRequestSummarySchema = z.object({
  id: z.string(),
  messageId: z.string(),
  conversationId: z.string(),
  requestType: StructuredRequestTypeSchema,
  initiator: PublicUserSchema,
  recipient: PublicUserSchema,
  sessionId: z.string().nullable(),
  status: StructuredRequestStatusSchema,
  durationMinutes: z.number().nullable(),
  targetPackage: z.string().nullable(),
  parameters: z.record(z.string(), z.unknown()).nullable(),
  decisionReason: z.string().nullable(),
  decidedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const MessageItemSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  sender: PublicUserSchema,
  clientMessageId: z.string(),
  messageType: MessageTypeSchema,
  textContent: z.string().nullable(),
  structuredRequest: StructuredRequestSummarySchema.nullable(),
  status: MessageDeliveryStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});

export const ConversationItemSchema = z.object({
  id: z.string(),
  partnershipId: z.string(),
  partner: PublicUserSchema,
  unreadCount: z.number(),
  lastMessage: MessageItemSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const TemporaryGrantItemSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  deviceId: z.string(),
  packageName: z.string(),
  grantedDurationMinutes: z.number(),
  grantedByUserId: z.string(),
  startsAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  isCurrentlyActive: z.boolean(),
  createdAt: z.string()
});
