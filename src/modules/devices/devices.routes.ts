import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { extractRequestContext } from '../../middleware/authenticate';
import { ErrorResponseSchema, UuidParamSchema } from '../../shared/http-schemas';
import {
  DeviceResponseSchema,
  ListDevicesQuerySchema,
  PaginatedDevicesResponseSchema,
  RegisterDeviceBodySchema,
  RegisterPushTokenBodySchema,
  UpdateDeviceBodySchema
} from './devices.schemas';
import type { DevicesService } from './devices.service';

export function registerDevicesRoutes(
  app: FastifyInstance,
  deps: {
    devicesService: DevicesService;
    authenticate: preHandlerHookHandler;
  }
): void {
  const router = app.withTypeProvider<ZodTypeProvider>();

  router.post(
    '/api/v1/devices',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Devices'],
        summary: 'Register or refresh an Android installation for the authenticated user',
        security: [{ bearerAuth: [] }],
        body: RegisterDeviceBodySchema,
        response: {
          200: z.object({ device: DeviceResponseSchema }),
          201: z.object({ device: DeviceResponseSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const { device, created } = await deps.devicesService.registerDevice(
        request.authUser!.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(created ? 201 : 200).send({ device });
    }
  );

  router.get(
    '/api/v1/devices',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Devices'],
        summary: 'List Android devices belonging to the authenticated user',
        security: [{ bearerAuth: [] }],
        querystring: ListDevicesQuerySchema,
        response: {
          200: PaginatedDevicesResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.devicesService.listMyDevices(request.authUser!.id, request.query);
      return reply.status(200).send(result);
    }
  );

  router.get(
    '/api/v1/devices/:id',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Devices'],
        summary: 'Get details for an owned Android device',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ device: DeviceResponseSchema }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const device = await deps.devicesService.getMyDevice(
        request.authUser!.id,
        request.params.id
      );
      return reply.status(200).send({ device });
    }
  );

  router.patch(
    '/api/v1/devices/:id',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Devices'],
        summary: 'Update device metadata and record connectivity heartbeat',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: UpdateDeviceBodySchema,
        response: {
          200: z.object({ device: DeviceResponseSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const device = await deps.devicesService.updateMyDevice(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send({ device });
    }
  );

  router.delete(
    '/api/v1/devices/:id',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Devices'],
        summary: 'Revoke a lost or retired device and invalidate its tokens, permissions, and queued commands',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ device: DeviceResponseSchema }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const device = await deps.devicesService.revokeMyDevice(
        request.authUser!.id,
        request.params.id,
        extractRequestContext(request)
      );
      return reply.status(200).send({ device });
    }
  );

  router.post(
    '/api/v1/devices/:id/push-token',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Devices'],
        summary: 'Register or rotate the Firebase Cloud Messaging token for a device',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: RegisterPushTokenBodySchema,
        response: {
          200: z.object({
            deviceId: z.string().uuid(),
            status: z.literal('ACTIVE'),
            updatedAt: z.string()
          }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.devicesService.upsertPushToken(
        request.authUser!.id,
        request.params.id,
        request.body.fcmToken,
        extractRequestContext(request)
      );
      return reply.status(200).send(result);
    }
  );
}
