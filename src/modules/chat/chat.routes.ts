import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ErrorResponseSchema, UuidParamSchema } from '../../shared/http-schemas';
import {
  ConversationItemSchema,
  CreateStructuredRequestBodySchema,
  ListConversationsQuerySchema,
  ListMessagesQuerySchema,
  MarkConversationReadBodySchema,
  MessageItemSchema,
  RespondStructuredRequestBodySchema,
  SendTextMessageBodySchema,
  StructuredRequestSummarySchema,
  TemporaryGrantItemSchema
} from './chat.schemas';
import type { ChatService } from './chat.service';

export function registerChatRoutes(
  app: FastifyInstance,
  deps: {
    chatService: ChatService;
    authenticate: preHandlerHookHandler;
  }
): void {
  const router = app.withTypeProvider<ZodTypeProvider>();

  // List all conversations for the user
  router.get(
    '/api/v1/conversations',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Chat & Structured Requests'],
        summary: 'List user conversations with partner summary and unread counts',
        security: [{ bearerAuth: [] }],
        querystring: ListConversationsQuerySchema,
        response: {
          200: z.object({
            items: z.array(ConversationItemSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number()
          }),
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const res = await deps.chatService.listConversations(request.authUser!.id, request.query);
      return reply.status(200).send(res);
    }
  );

  // Get or create conversation for partnership
  router.get(
    '/api/v1/conversations/partnership/:partnershipId',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Chat & Structured Requests'],
        summary: 'Get or create conversation for an accepted partnership',
        security: [{ bearerAuth: [] }],
        params: z.object({ partnershipId: z.string().uuid() }),
        response: {
          200: z.object({ conversation: ConversationItemSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const conv = await deps.chatService.getOrCreateConversationForPartnership(
        request.authUser!.id,
        request.params.partnershipId
      );
      return reply.status(200).send({ conversation: conv });
    }
  );

  // Get conversation by ID
  router.get(
    '/api/v1/conversations/:id',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Chat & Structured Requests'],
        summary: 'Get conversation details by conversation ID',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ conversation: ConversationItemSchema }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const conv = await deps.chatService.getConversationById(request.authUser!.id, request.params.id);
      return reply.status(200).send({ conversation: conv });
    }
  );

  // List messages in a conversation
  router.get(
    '/api/v1/conversations/:id/messages',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Chat & Structured Requests'],
        summary: 'List messages in a conversation',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        querystring: ListMessagesQuerySchema,
        response: {
          200: z.object({
            items: z.array(MessageItemSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number()
          }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const res = await deps.chatService.listMessages(
        request.authUser!.id,
        request.params.id,
        request.query
      );
      return reply.status(200).send(res);
    }
  );

  // Send a text message
  router.post(
    '/api/v1/conversations/:id/messages',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Chat & Structured Requests'],
        summary: 'Send a text message in a conversation',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: SendTextMessageBodySchema,
        response: {
          201: z.object({ message: MessageItemSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const msg = await deps.chatService.sendTextMessage(
        request.authUser!.id,
        request.params.id,
        request.body.clientMessageId,
        request.body.text
      );
      return reply.status(201).send({ message: msg });
    }
  );

  // Create a structured request embedded in chat
  router.post(
    '/api/v1/conversations/:id/structured-requests',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Chat & Structured Requests'],
        summary: 'Create a structured request (early release, temporary app access, rule change, extension)',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: CreateStructuredRequestBodySchema,
        response: {
          201: z.object({ message: MessageItemSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const msg = await deps.chatService.createStructuredRequest(
        request.authUser!.id,
        request.params.id,
        request.body
      );
      return reply.status(201).send({ message: msg });
    }
  );

  // Mark conversation read
  router.post(
    '/api/v1/conversations/:id/read',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Chat & Structured Requests'],
        summary: 'Mark messages read up to a message ID',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: MarkConversationReadBodySchema,
        response: {
          200: z.object({ message: z.string() }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      await deps.chatService.markConversationRead(
        request.authUser!.id,
        request.params.id,
        request.body.lastReadMessageId
      );
      return reply.status(200).send({ message: 'Conversation read marker updated.' });
    }
  );

  // Respond to a structured request (APPROVE or REJECT)
  router.post(
    '/api/v1/structured-requests/:id/respond',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Chat & Structured Requests'],
        summary: 'Respond to a pending structured request (APPROVE or REJECT)',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: RespondStructuredRequestBodySchema,
        response: {
          200: z.object({ request: StructuredRequestSummarySchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const res = await deps.chatService.respondToStructuredRequest(
        request.authUser!.id,
        request.params.id,
        request.body
      );
      return reply.status(200).send({ request: res });
    }
  );

  // Cancel a structured request (by initiator)
  router.post(
    '/api/v1/structured-requests/:id/cancel',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Chat & Structured Requests'],
        summary: 'Cancel an initiator pending structured request',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ request: StructuredRequestSummarySchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const res = await deps.chatService.cancelStructuredRequest(
        request.authUser!.id,
        request.params.id
      );
      return reply.status(200).send({ request: res });
    }
  );

  // List active temporary grants for a session
  router.get(
    '/api/v1/sessions/:id/temporary-grants',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Chat & Structured Requests'],
        summary: 'List active temporary app access grants for an active session',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ items: z.array(TemporaryGrantItemSchema) }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const items = await deps.chatService.listActiveTemporaryGrants(
        request.authUser!.id,
        request.params.id
      );
      return reply.status(200).send({ items });
    }
  );

  // Revoke temporary grant early
  router.post(
    '/api/v1/sessions/:id/temporary-grants/:grantId/revoke',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Chat & Structured Requests'],
        summary: 'Revoke temporary app access grant early by controlling partner',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid(), grantId: z.string().uuid() }),
        response: {
          200: z.object({ message: z.string() }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      await deps.chatService.revokeTemporaryGrant(
        request.authUser!.id,
        request.params.grantId
      );
      return reply.status(200).send({ message: 'Temporary grant revoked.' });
    }
  );
}
