import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { extractRequestContext } from '../../middleware/authenticate';
import { ErrorResponseSchema, UuidParamSchema } from '../../shared/http-schemas';
import {
  CreateReleaseRequestBodySchema,
  ListReleaseRequestsQuerySchema,
  PaginatedReleaseRequestsResponseSchema,
  ReleaseDecisionBodySchema,
  ReleaseDecisionResponseSchema,
  ReleaseRequestResponseSchema
} from './releases.schemas';
import type { ReleasesService } from './releases.service';

export function registerReleasesRoutes(
  app: FastifyInstance,
  deps: {
    releasesService: ReleasesService;
    authenticate: preHandlerHookHandler;
  }
): void {
  const router = app.withTypeProvider<ZodTypeProvider>();

  router.post(
    '/api/v1/sessions/:id/release-requests',
    {
      preHandler: [deps.authenticate],
      config: {
        rateLimit: {
          max: 15,
          timeWindow: '15 minutes'
        }
      },
      schema: {
        tags: ['Releases'],
        summary: 'Submit an early release request for an active Partner Arrest session',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: CreateReleaseRequestBodySchema,
        response: {
          201: z.object({ releaseRequest: ReleaseRequestResponseSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const releaseRequest = await deps.releasesService.createReleaseRequest(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(201).send({ releaseRequest });
    }
  );

  router.get(
    '/api/v1/release-requests',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Releases'],
        summary: 'List early release requests involving the authenticated user',
        security: [{ bearerAuth: [] }],
        querystring: ListReleaseRequestsQuerySchema,
        response: {
          200: PaginatedReleaseRequestsResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const page = await deps.releasesService.listReleaseRequests(
        request.authUser!.id,
        request.query
      );
      return reply.status(200).send(page);
    }
  );

  router.post(
    '/api/v1/release-requests/:id/approve',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Releases'],
        summary: 'Approve an early release request and queue an APPROVE_RELEASE command for the target device',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: ReleaseDecisionBodySchema,
        response: {
          200: ReleaseDecisionResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.releasesService.approveReleaseRequest(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send(result);
    }
  );

  router.post(
    '/api/v1/release-requests/:id/deny',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Releases'],
        summary: 'Deny an early release request and queue a DENY_RELEASE notification command for the target device',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: ReleaseDecisionBodySchema,
        response: {
          200: ReleaseDecisionResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.releasesService.denyReleaseRequest(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send(result);
    }
  );
}
