import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { extractRequestContext } from '../../middleware/authenticate';
import { ErrorResponseSchema, UuidParamSchema } from '../../shared/http-schemas';
import { SessionCommandResponseSchema } from '../commands/commands.schemas';
import {
  AcknowledgeSessionBodySchema,
  ArrestSessionResponseSchema,
  CreateSessionBodySchema,
  CreateSessionResponseSchema,
  ListSessionsQuerySchema,
  LiveSessionDashboardResponseSchema,
  PaginatedSessionsResponseSchema,
  PostSessionEventsBodySchema,
  RemoteSessionCommandBodySchema
} from './sessions.schemas';
import type { SessionsService } from './sessions.service';

export function registerSessionsRoutes(
  app: FastifyInstance,
  deps: {
    sessionsService: SessionsService;
    authenticate: preHandlerHookHandler;
  }
): void {
  const router = app.withTypeProvider<ZodTypeProvider>();

  router.post(
    '/api/v1/sessions',
    {
      preHandler: [deps.authenticate],
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '15 minutes'
        }
      },
      schema: {
        tags: ['Sessions'],
        summary: 'Create an authorized remote Partner Arrest or Self Arrest session and queue START_ARREST command',
        security: [{ bearerAuth: [] }],
        headers: z.object({
          'idempotency-key': z.string().trim().min(8).max(128).optional()
        }),
        body: CreateSessionBodySchema,
        response: {
          200: CreateSessionResponseSchema,
          201: CreateSessionResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const headerIdem = request.headers['idempotency-key'];
      const result = await deps.sessionsService.createSession(
        request.authUser!.id,
        {
          ...request.body,
          idempotencyKey: request.body.idempotencyKey ?? headerIdem
        },
        extractRequestContext(request)
      );
      return reply.status(result.idempotentReplay ? 200 : 201).send(result);
    }
  );

  router.get(
    '/api/v1/sessions',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Sessions'],
        summary: 'List cloud-coordinated Arrest sessions for the authenticated user',
        security: [{ bearerAuth: [] }],
        querystring: ListSessionsQuerySchema,
        response: {
          200: PaginatedSessionsResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const page = await deps.sessionsService.listSessions(request.authUser!.id, request.query);
      return reply.status(200).send(page);
    }
  );

  // Registered before /api/v1/sessions/:id so literal `active` never collides with `:id`
  router.get(
    '/api/v1/sessions/active',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Sessions'],
        summary: 'List currently active or in-progress Arrest sessions for the authenticated user',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({ items: z.array(ArrestSessionResponseSchema) }),
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const items = await deps.sessionsService.listActiveSessions(request.authUser!.id);
      return reply.status(200).send({ items });
    }
  );

  router.get(
    '/api/v1/sessions/live-dashboard',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Sessions'],
        summary: 'Retrieve enriched live controller & owner session dashboard items',
        security: [{ bearerAuth: [] }],
        response: {
          200: LiveSessionDashboardResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const items = await deps.sessionsService.listLiveDashboardSessions(request.authUser!.id);
      return reply.status(200).send({ items });
    }
  );

  router.get(
    '/api/v1/sessions/:id',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Sessions'],
        summary: 'Retrieve details of a specific Arrest session',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ session: ArrestSessionResponseSchema }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const session = await deps.sessionsService.getSessionById(
        request.authUser!.id,
        request.params.id
      );
      return reply.status(200).send({ session });
    }
  );

  router.post(
    '/api/v1/sessions/:id/acknowledge',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Sessions'],
        summary: 'Acknowledge local Android engine acceptance, activation, or rejection of a session',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: AcknowledgeSessionBodySchema,
        response: {
          200: z.object({ session: ArrestSessionResponseSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const session = await deps.sessionsService.acknowledgeSession(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send({ session });
    }
  );

  router.post(
    '/api/v1/sessions/:id/events',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Sessions'],
        summary: 'Synchronize deduplicated Android SessionController lifecycle events',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: PostSessionEventsBodySchema,
        response: {
          200: z.object({
            session: ArrestSessionResponseSchema,
            processedCount: z.number().int(),
            duplicateCount: z.number().int()
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.sessionsService.recordSessionEvents(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send(result);
    }
  );

  router.post(
    '/api/v1/sessions/:id/end',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Sessions'],
        summary: 'Queue a remote END_SESSION command (initiating authority only)',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: RemoteSessionCommandBodySchema,
        response: {
          200: z.object({ command: SessionCommandResponseSchema }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.sessionsService.queueRemoteEndSession(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send(result);
    }
  );

  router.post(
    '/api/v1/sessions/:id/sync',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Sessions'],
        summary: 'Queue a SYNC_SESSION command requesting state reconciliation from the target device',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: RemoteSessionCommandBodySchema,
        response: {
          200: z.object({ command: SessionCommandResponseSchema }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.sessionsService.queueSyncSessionCommand(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send(result);
    }
  );
}
