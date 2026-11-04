import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { extractRequestContext } from '../../middleware/authenticate';
import { ErrorResponseSchema, UuidParamSchema } from '../../shared/http-schemas';
import {
  AcknowledgeCommandBodySchema,
  PollDeviceCommandsQuerySchema,
  PollDeviceCommandsResponseSchema,
  SessionCommandResponseSchema
} from './commands.schemas';
import type { CommandsService } from './commands.service';

export function registerCommandsRoutes(
  app: FastifyInstance,
  deps: {
    commandsService: CommandsService;
    authenticate: preHandlerHookHandler;
  }
): void {
  const router = app.withTypeProvider<ZodTypeProvider>();

  router.get(
    '/api/v1/devices/:id/commands',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Commands'],
        summary: 'Retrieve pending/delivered commands for an owned Android device using monotonic sequence cursor',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        querystring: PollDeviceCommandsQuerySchema,
        response: {
          200: PollDeviceCommandsResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.commandsService.pollDeviceCommands(
        request.authUser!.id,
        request.params.id,
        request.query
      );
      return reply.status(200).send(result);
    }
  );

  router.post(
    '/api/v1/commands/:id/acknowledge',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Commands'],
        summary: 'Idempotently report command receipt, execution, rejection, or failure from the target Android device',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: AcknowledgeCommandBodySchema,
        response: {
          200: z.object({
            command: SessionCommandResponseSchema,
            idempotentReplay: z.boolean()
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.commandsService.acknowledgeCommand(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send(result);
    }
  );
}
