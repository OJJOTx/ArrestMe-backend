import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { extractRequestContext } from '../../middleware/authenticate';
import { ErrorResponseSchema } from '../../shared/http-schemas';
import {
  CurrentUserResponseSchema,
  InviteCodeResponseSchema,
  UpdateProfileBodySchema
} from './users.schemas';
import type { UsersService } from './users.service';

export function registerUsersRoutes(
  app: FastifyInstance,
  deps: {
    usersService: UsersService;
    authenticate: preHandlerHookHandler;
  }
): void {
  const router = app.withTypeProvider<ZodTypeProvider>();

  router.get(
    '/api/v1/users/me',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Retrieve current authenticated user profile',
        security: [{ bearerAuth: [] }],
        response: {
          200: CurrentUserResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const user = await deps.usersService.getMe(request.authUser!.id);
      return reply.status(200).send({ user });
    }
  );

  router.patch(
    '/api/v1/users/me',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Update basic display profile for the authenticated user',
        security: [{ bearerAuth: [] }],
        body: UpdateProfileBodySchema,
        response: {
          200: CurrentUserResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const user = await deps.usersService.updateMe(
        request.authUser!.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send({ user });
    }
  );

  router.get(
    '/api/v1/users/me/invite-code',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Retrieve or initialize the current user optional partner invitation code',
        security: [{ bearerAuth: [] }],
        response: {
          200: InviteCodeResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.usersService.getOrEnsureInviteCode(request.authUser!.id);
      return reply.status(200).send(result);
    }
  );

  router.post(
    '/api/v1/users/me/invite-code/regenerate',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Regenerate the current user optional partner invitation code',
        security: [{ bearerAuth: [] }],
        response: {
          200: InviteCodeResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.usersService.regenerateInviteCode(
        request.authUser!.id,
        extractRequestContext(request)
      );
      return reply.status(200).send(result);
    }
  );
}
