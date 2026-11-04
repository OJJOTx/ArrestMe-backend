import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { extractRequestContext } from '../../middleware/authenticate';
import { ErrorResponseSchema, UuidParamSchema } from '../../shared/http-schemas';
import {
  AcceptProposalBodySchema,
  AcceptProposalResponseSchema,
  CounterofferProposalBodySchema,
  CreateProposalBodySchema,
  ListProposalsQuerySchema,
  PaginatedProposalsResponseSchema,
  ProposalResponseSchema,
  RejectOrCancelProposalBodySchema
} from './proposals.schemas';
import type { ProposalsService } from './proposals.service';

export function registerProposalsRoutes(
  app: FastifyInstance,
  deps: {
    proposalsService: ProposalsService;
    authenticate: preHandlerHookHandler;
  }
): void {
  const router = app.withTypeProvider<ZodTypeProvider>();

  router.post(
    '/api/v1/proposals',
    {
      preHandler: [deps.authenticate],
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '10 minutes'
        }
      },
      schema: {
        tags: ['Proposals & Negotiations'],
        summary:
          'Submit a versioned Arrest proposal (IMMEDIATE, SCHEDULED, RECURRING, or STANDING_AUTHORIZATION)',
        security: [{ bearerAuth: [] }],
        body: CreateProposalBodySchema,
        response: {
          201: z.object({ proposal: ProposalResponseSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const proposal = await deps.proposalsService.createProposal(
        request.authUser!.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(201).send({ proposal });
    }
  );

  router.get(
    '/api/v1/proposals',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Proposals & Negotiations'],
        summary: 'List Arrest proposals and negotiations for the authenticated user',
        security: [{ bearerAuth: [] }],
        querystring: ListProposalsQuerySchema,
        response: {
          200: PaginatedProposalsResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const page = await deps.proposalsService.listProposals(request.authUser!.id, request.query);
      return reply.status(200).send(page);
    }
  );

  router.get(
    '/api/v1/proposals/:id',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Proposals & Negotiations'],
        summary: 'Get a single Arrest proposal with its immutable revision history',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        response: {
          200: z.object({ proposal: ProposalResponseSchema }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const proposal = await deps.proposalsService.getProposalById(
        request.authUser!.id,
        request.params.id
      );
      return reply.status(200).send({ proposal });
    }
  );

  router.post(
    '/api/v1/proposals/:id/counteroffer',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Proposals & Negotiations'],
        summary:
          'Submit a counteroffer on an active Arrest proposal (creates a new immutable revision)',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: CounterofferProposalBodySchema,
        response: {
          200: z.object({ proposal: ProposalResponseSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const proposal = await deps.proposalsService.counterofferProposal(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send({ proposal });
    }
  );

  router.post(
    '/api/v1/proposals/:id/accept',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Proposals & Negotiations'],
        summary:
          'Accept an exact revision of an Arrest proposal and generate the corresponding authorization or schedule',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: AcceptProposalBodySchema,
        response: {
          200: AcceptProposalResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.proposalsService.acceptProposal(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send(result);
    }
  );

  router.post(
    '/api/v1/proposals/:id/reject',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Proposals & Negotiations'],
        summary: 'Reject an incoming Arrest proposal or counteroffer',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: RejectOrCancelProposalBodySchema.default({}),
        response: {
          200: z.object({ proposal: ProposalResponseSchema }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const proposal = await deps.proposalsService.rejectProposal(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send({ proposal });
    }
  );

  router.post(
    '/api/v1/proposals/:id/cancel',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Proposals & Negotiations'],
        summary: 'Cancel a pending Arrest proposal or negotiation',
        security: [{ bearerAuth: [] }],
        params: UuidParamSchema,
        body: RejectOrCancelProposalBodySchema.default({}),
        response: {
          200: z.object({ proposal: ProposalResponseSchema }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const proposal = await deps.proposalsService.cancelProposal(
        request.authUser!.id,
        request.params.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send({ proposal });
    }
  );
}
