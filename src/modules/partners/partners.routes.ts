import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { extractRequestContext } from '../../middleware/authenticate';
import {
  ErrorResponseSchema,
  PaginationQuerySchema,
  UuidParamSchema
} from '../../shared/http-schemas';
import {
  ApprovalPolicyResponseSchema,
  DiscoverPartnerQuerySchema,
  ListPartnerRequestsQuerySchema,
  PaginatedPartnershipsResponseSchema,
  PartnerDiscoveryResponseSchema,
  PartnerProfileResponseSchema,
  PartnershipResponseSchema,
  SendPartnerRequestBodySchema,
  UpdateApprovalPolicyBodySchema
} from './partners.schemas';
import type { PartnersService } from './partners.service';

export function registerPartnersRoutes(
  app: FastifyInstance,
  deps: {
    partnersService: PartnersService;
    authenticate: preHandlerHookHandler;
  }
): void {
  const router = app.withTypeProvider<ZodTypeProvider>();

  router.get(
    '/api/v1/partners/discover',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partners'],
        summary:
          'Discover a user by exact username or invite code and retrieve relationship state and pending counts',
        security: [{ bearerAuth: [] }],
        querystring: DiscoverPartnerQuerySchema,
        response: {
          200: PartnerDiscoveryResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const discovery = await deps.partnersService.discoverUserAndCounts(
        request.authUser!.id,
        request.query
      );
      return reply.status(200).send(discovery);
    }
  );

  router.post(
    '/api/v1/partners/requests',
    {
      preHandler: [deps.authenticate],
      config: {
        rateLimit: {
          max: 25,
          timeWindow: '15 minutes'
        }
      },
      schema: {
        tags: ['Partners'],
        summary: 'Send a partnership invitation by exact username, invite code, or user ID',
        security: [{ bearerAuth: [] }],
        body: SendPartnerRequestBodySchema,
        response: {
          201: z.object({ partnership: PartnershipResponseSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const partnership = await deps.partnersService.sendInvitation(
        request.authUser!.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(201).send({ partnership });
    }
  );

  router.get(
    '/api/v1/partners/requests',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partners'],
        summary: 'List incoming or outgoing partnership requests',
        security: [{ bearerAuth: [] }],
        querystring: ListPartnerRequestsQuerySchema,
        response: {
          200: PaginatedPartnershipsResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const page = await deps.partnersService.listRequests(request.authUser!.id, request.query);
      return reply.status(200).send(page);
    }
  );

  router.post(
    '/api/v1/partners/requests/:id/accept',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partners'],
        summary: 'Accept an incoming partnership invitation',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ partnership: PartnershipResponseSchema }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const partnership = await deps.partnersService.acceptRequest(
        request.authUser!.id,
        request.params.id,
        extractRequestContext(request)
      );
      return reply.status(200).send({ partnership });
    }
  );

  router.post(
    '/api/v1/partners/requests/:id/reject',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partners'],
        summary: 'Reject an incoming partnership invitation',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ partnership: PartnershipResponseSchema }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const partnership = await deps.partnersService.rejectRequest(
        request.authUser!.id,
        request.params.id,
        extractRequestContext(request)
      );
      return reply.status(200).send({ partnership });
    }
  );

  router.get(
    '/api/v1/partners',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partners'],
        summary: 'List accepted partners for the authenticated user',
        security: [{ bearerAuth: [] }],
        querystring: PaginationQuerySchema,
        response: {
          200: PaginatedPartnershipsResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const page = await deps.partnersService.listPartners(request.authUser!.id, request.query);
      return reply.status(200).send(page);
    }
  );

  router.get(
    '/api/v1/partners/:id/profile',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partners'],
        summary:
          'Retrieve comprehensive partner profile including devices, permissions, approval policies, pending proposals, and active schedules',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ profile: PartnerProfileResponseSchema }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const profile = await deps.partnersService.getPartnerProfile(
        request.authUser!.id,
        request.params.id
      );
      return reply.status(200).send({ profile });
    }
  );

  router.get(
    '/api/v1/partners/:id/approval-policy',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partners'],
        summary: 'Retrieve directional approval policies and standing authorizations for a partner',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({
            myApprovalPolicyForPartner: ApprovalPolicyResponseSchema,
            partnerApprovalPolicyForMe: ApprovalPolicyResponseSchema
          }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const policies = await deps.partnersService.getApprovalPoliciesForPartner(
        request.authUser!.id,
        request.params.id
      );
      return reply.status(200).send(policies);
    }
  );

  router.put(
    '/api/v1/partners/:id/approval-policy',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partners'],
        summary:
          'Configure requireApprovalBeforeArrest policy for a partner (does not grant unlimited authority)',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: UpdateApprovalPolicyBodySchema,
        response: {
          200: z.object({
            myApprovalPolicyForPartner: ApprovalPolicyResponseSchema,
            partnerApprovalPolicyForMe: ApprovalPolicyResponseSchema
          }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const policies = await deps.partnersService.updateApprovalPolicyForPartner(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send(policies);
    }
  );

  router.delete(
    '/api/v1/partners/:id',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partners'],
        summary: 'Remove an accepted partner or cancel a pending invitation (revokes delegated permissions)',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ partnership: PartnershipResponseSchema }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const partnership = await deps.partnersService.removeOrCancelPartnership(
        request.authUser!.id,
        request.params.id,
        extractRequestContext(request)
      );
      return reply.status(200).send({ partnership });
    }
  );

  router.post(
    '/api/v1/partners/:id/block',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Partners'],
        summary: 'Block a partner or user and immediately revoke all mutual delegated permissions',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ partnership: PartnershipResponseSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const partnership = await deps.partnersService.blockPartnerOrUser(
        request.authUser!.id,
        request.params.id,
        extractRequestContext(request)
      );
      return reply.status(200).send({ partnership });
    }
  );
}
