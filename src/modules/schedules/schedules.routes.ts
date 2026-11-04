import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { extractRequestContext } from '../../middleware/authenticate';
import { ErrorResponseSchema, UuidParamSchema } from '../../shared/http-schemas';
import {
  ListScheduledArrestsQuerySchema,
  PaginatedScheduledArrestsResponseSchema,
  ScheduledArrestResponseSchema,
  TriggerScheduledArrestResponseSchema
} from './schedules.schemas';
import type { SchedulesService } from './schedules.service';

export function registerSchedulesRoutes(
  app: FastifyInstance,
  deps: {
    schedulesService: SchedulesService;
    authenticate: preHandlerHookHandler;
  }
): void {
  const router = app.withTypeProvider<ZodTypeProvider>();

  router.get(
    '/api/v1/scheduled-arrests',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Scheduled Arrests'],
        summary: 'List scheduled and recurring Arrest sessions for the authenticated user',
        security: [{ bearerAuth: [] }],
        querystring: ListScheduledArrestsQuerySchema,
        response: {
          200: PaginatedScheduledArrestsResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const page = await deps.schedulesService.listSchedules(request.authUser!.id, request.query);
      return reply.status(200).send(page);
    }
  );

  router.get(
    '/api/v1/scheduled-arrests/:id',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Scheduled Arrests'],
        summary: 'Get a single scheduled or recurring Arrest record by ID',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ schedule: ScheduledArrestResponseSchema }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const schedule = await deps.schedulesService.getScheduleById(
        request.authUser!.id,
        request.params.id
      );
      return reply.status(200).send({ schedule });
    }
  );

  router.post(
    '/api/v1/scheduled-arrests/:id/cancel',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Scheduled Arrests'],
        summary: 'Cancel or revoke a scheduled or recurring Arrest record',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ schedule: ScheduledArrestResponseSchema }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const schedule = await deps.schedulesService.cancelSchedule(
        request.authUser!.id,
        request.params.id,
        extractRequestContext(request)
      );
      return reply.status(200).send({ schedule });
    }
  );

  router.post(
    '/api/v1/scheduled-arrests/:id/trigger',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Scheduled Arrests'],
        summary: 'Materialize a due scheduled or recurring Arrest occurrence into an active session command after verifying authorization and time bounds',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: TriggerScheduledArrestResponseSchema,
          201: TriggerScheduledArrestResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.schedulesService.triggerDueSchedule(
        request.authUser!.id,
        request.params.id,
        extractRequestContext(request)
      );
      return reply.status(result.idempotentReplay ? 200 : 201).send(result);
    }
  );
}
