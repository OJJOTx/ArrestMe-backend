import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { extractRequestContext } from '../../middleware/authenticate';
import { ErrorResponseSchema } from '../../shared/http-schemas';
import {
  AuthSessionResponseSchema,
  AuthTokensResponseSchema,
  ChangePasswordBodySchema,
  LoginBodySchema,
  LogoutBodySchema,
  RefreshBodySchema,
  RegisterBodySchema
} from './auth.schemas';
import type { AuthService } from './auth.service';

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: {
    authService: AuthService;
    authenticate: preHandlerHookHandler;
  }
): void {
  const router = app.withTypeProvider<ZodTypeProvider>();

  router.post(
    '/api/v1/auth/register',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes'
        }
      },
      schema: {
        tags: ['Authentication'],
        summary: 'Register a new ArrestMe user account',
        body: RegisterBodySchema,
        response: {
          201: AuthSessionResponseSchema,
          400: ErrorResponseSchema,
          409: ErrorResponseSchema,
          429: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.authService.register(request.body, extractRequestContext(request));
      return reply.status(201).send(result);
    }
  );

  router.post(
    '/api/v1/auth/login',
    {
      config: {
        rateLimit: {
          max: 15,
          timeWindow: '15 minutes'
        }
      },
      schema: {
        tags: ['Authentication'],
        summary: 'Authenticate user and issue short-lived access + rotating refresh tokens',
        body: LoginBodySchema,
        response: {
          200: AuthSessionResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          429: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.authService.login(request.body, extractRequestContext(request));
      return reply.status(200).send(result);
    }
  );

  router.post(
    '/api/v1/auth/refresh',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '15 minutes'
        }
      },
      schema: {
        tags: ['Authentication'],
        summary: 'Rotate refresh token and issue a fresh token pair',
        body: RefreshBodySchema,
        response: {
          200: z.object({ tokens: AuthTokensResponseSchema }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          429: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.authService.refresh(
        request.body.refreshToken,
        extractRequestContext(request)
      );
      return reply.status(200).send(result);
    }
  );

  router.post(
    '/api/v1/auth/logout',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Revoke current refresh token family',
        body: LogoutBodySchema,
        response: {
          200: z.object({ status: z.literal('logged_out') }),
          400: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      await deps.authService.logout(request.body.refreshToken, extractRequestContext(request));
      return reply.status(200).send({ status: 'logged_out' as const });
    }
  );

  router.post(
    '/api/v1/auth/logout-all',
    {
      preHandler: [deps.authenticate],
      schema: {
        tags: ['Authentication'],
        summary: 'Revoke all active refresh token sessions for the authenticated user',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            status: z.literal('logged_out_all'),
            revokedCount: z.number().int()
          }),
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.authService.logoutAll(
        request.authUser!.id,
        extractRequestContext(request)
      );
      return reply.status(200).send({
        status: 'logged_out_all' as const,
        revokedCount: result.revokedCount
      });
    }
  );

  router.post(
    '/api/v1/auth/change-password',
    {
      preHandler: [deps.authenticate],
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes'
        }
      },
      schema: {
        tags: ['Authentication'],
        summary: 'Change password and revoke all prior refresh tokens',
        security: [{ bearerAuth: [] }],
        body: ChangePasswordBodySchema,
        response: {
          200: z.object({ tokens: AuthTokensResponseSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const result = await deps.authService.changePassword(
        request.authUser!.id,
        request.body,
        extractRequestContext(request)
      );
      return reply.status(200).send(result);
    }
  );
}
