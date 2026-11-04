import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { extractRequestContext } from '../../middleware/authenticate';
import { ErrorResponseSchema, UuidParamSchema } from '../../shared/http-schemas';
import {
  CreatePartnerPermissionBodySchema,
  ListPartnerPermissionsQuerySchema,
  PaginatedPartnerPermissionsResponseSchema,
  PartnerPermissionResponseSchema,
  UpdatePartnerPermissionBodySchema
} from './permissions.schemas';
import type { PermissionsService } from './permissions.service';

export function registerPermissionsRoutes(
  app: FastifyInstance,
  deps: {
    permissionsService: PermissionsService;
    authenticate: preHandlerHookHandler;
  }
): void {
  const router = app.withTypeProvider<ZodTypeProvider>();

  router.post(
    '/api/v1/partner-permissions',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partner Permissions'],
        summary: 'Grant an explicit, device-scoped, time-bounded delegated Arrest permission to an accepted partner',
        security: [{ bearerAuth: [] }],
        body: CreatePartnerPermissionBodySchema,
        response: {
          201: z.object({ permission: PartnerPermissionResponseSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const permission = await deps.permissionsService.createPermission(
        request.authUser!.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(201).send({ permission });
    }
  );

  router.get(
    '/api/v1/partner-permissions',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partner Permissions'],
        summary: 'List delegated permissions granted by or received by the authenticated user',
        security: [{ bearerAuth: [] }],
        querystring: ListPartnerPermissionsQuerySchema,
        response: {
          200: PaginatedPartnerPermissionsResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const page = await deps.permissionsService.listPermissions(
        request.authUser!.id,
        request.query
      );
      return reply.status(200).send(page);
    }
  );

  router.get(
    '/api/v1/partner-permissions/:id',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partner Permissions'],
        summary: 'Retrieve details of a delegated partner permission',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ permission: PartnerPermissionResponseSchema }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const permission = await deps.permissionsService.getPermissionById(
        request.authUser!.id,
        request.params.id
      );
      return reply.status(200).send({ permission });
    }
  );

  router.patch(
    '/api/v1/partner-permissions/:id',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partner Permissions'],
        summary: 'Update limits or validity of a delegated permission (device owner only)',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: UpdatePartnerPermissionBodySchema,
        response: {
          200: z.object({ permission: PartnerPermissionResponseSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const permission = await deps.permissionsService.updatePermission(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send({ permission });
    }
  );

  router.delete(
    '/api/v1/partner-permissions/:id',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partner Permissions'],
        summary: 'Revoke or surrender a delegated partner permission immediately',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ permission: PartnerPermissionResponseSchema }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const permission = await deps.permissionsService.revokePermission(
        request.authUser!.id,
        request.params.id,
        extractRequestContext(request)
      );
      return reply.status(200).send({ permission });
    }
  );
}
