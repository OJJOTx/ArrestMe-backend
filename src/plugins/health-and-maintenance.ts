import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { extractRequestContext } from '../middleware/authenticate';
import type { MaintenanceService } from '../services/maintenance.service';
import { Errors } from '../shared/errors';
import { ErrorResponseSchema } from '../shared/http-schemas';
import type { DataStore } from '../types/repositories';

const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('ArrestMe API'),
  version: z.string()
});

const ReadinessResponseSchema = z.object({
  status: z.enum(['ready', 'degraded']),
  service: z.literal('ArrestMe API'),
  version: z.string(),
  database: z.enum(['reachable', 'unreachable'])
});

const MaintenanceResponseSchema = z.object({
  ranAt: z.string(),
  expiredCommandsCount: z.number().int(),
  expiredSessionsCount: z.number().int(),
  expiredReleaseRequestsCount: z.number().int(),
  purgedRefreshTokensCount: z.number().int(),
  retriedPushNotificationsSent: z.number().int()
});

export function registerHealthAndMaintenanceRoutes(
  app: FastifyInstance,
  deps: {
    version: string;
    store: DataStore;
    maintenanceService: MaintenanceService;
    verifyMaintenanceKey: preHandlerHookHandler;
  }
): void {
  const router = app.withTypeProvider<ZodTypeProvider>();

  const healthPayload = () => ({
    status: 'ok' as const,
    service: 'ArrestMe API' as const,
    version: deps.version
  });

  router.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Public lightweight liveness probe (never exposes infrastructure details)',
        response: {
          200: HealthResponseSchema
        }
      }
    },
    async (_request, reply) => reply.status(200).send(healthPayload())
  );

  router.get(
    '/api/v1/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Versioned public liveness endpoint',
        response: {
          200: HealthResponseSchema
        }
      }
    },
    async (_request, reply) => reply.status(200).send(healthPayload())
  );

  router.get(
    '/api/v1/health/ready',
    {
      preHandler: [deps.verifyMaintenanceKey],
      schema: {
        tags: ['Health'],
        summary: 'Protected readiness check verifying database connectivity',
        security: [{ maintenanceKey: [] }],
        response: {
          200: ReadinessResponseSchema,
          401: ErrorResponseSchema,
          503: ErrorResponseSchema
        }
      }
    },
    async (_request, reply) => {
      const dbOk = await deps.store.ping();
      if (!dbOk) {
        throw Errors.serviceUnavailable('Database connection check failed.');
      }
      return reply.status(200).send({
        status: 'ready' as const,
        service: 'ArrestMe API' as const,
        version: deps.version,
        database: 'reachable' as const
      });
    }
  );

  router.post(
    '/api/v1/internal/maintenance/run',
    {
      preHandler: [deps.verifyMaintenanceKey],
      schema: {
        tags: ['Maintenance'],
        summary: 'Protected maintenance job for expiring stale commands/sessions and retrying pending FCM wakeups',
        security: [{ maintenanceKey: [] }],
        response: {
          200: MaintenanceResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const summary = await deps.maintenanceService.runMaintenanceCycle(
        extractRequestContext(request)
      );
      return reply.status(200).send(summary);
    }
  );
}
