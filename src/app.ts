import { randomUUID } from 'node:crypto';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';
import type { AppEnvironment } from './config/environment';
import { createFcmTransport, type FcmTransport } from './config/firebase';
import {
  createAuthenticatePreHandler,
  createMaintenanceKeyPreHandler
} from './middleware/authenticate';
import { registerAuthRoutes } from './modules/auth/auth.routes';
import { AuthService } from './modules/auth/auth.service';
import { registerCommandsRoutes } from './modules/commands/commands.routes';
import { CommandsService } from './modules/commands/commands.service';
import { registerDevicesRoutes } from './modules/devices/devices.routes';
import { DevicesService } from './modules/devices/devices.service';
import { NotificationService } from './modules/notifications/notification.service';
import { registerPartnersRoutes } from './modules/partners/partners.routes';
import { PartnersService } from './modules/partners/partners.service';
import { registerPermissionsRoutes } from './modules/permissions/permissions.routes';
import { PermissionsService } from './modules/permissions/permissions.service';
import { registerReleasesRoutes } from './modules/releases/releases.routes';
import { ReleasesService } from './modules/releases/releases.service';
import { registerSessionsRoutes } from './modules/sessions/sessions.routes';
import { SessionsService } from './modules/sessions/sessions.service';
import { registerUsersRoutes } from './modules/users/users.routes';
import { UsersService } from './modules/users/users.service';
import { registerHealthAndMaintenanceRoutes } from './plugins/health-and-maintenance';
import { AuditService } from './services/audit.service';
import { MaintenanceService } from './services/maintenance.service';
import { JwtService, ScryptPasswordHasher, type PasswordHasher } from './shared/crypto';
import { AppError } from './shared/errors';
import { SystemClock, type Clock } from './shared/time';
import type { DataStore } from './types/repositories';

export interface BuildAppOptions {
  env: AppEnvironment;
  store: DataStore;
  fcmTransport?: FcmTransport;
  clock?: Clock;
  passwordHasher?: PasswordHasher;
  enableRateLimit?: boolean;
  notificationRetryDelayMs?: number;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { env, store } = options;
  const clock = options.clock ?? new SystemClock();
  const passwordHasher = options.passwordHasher ?? new ScryptPasswordHasher();
  const fcmTransport = options.fcmTransport ?? createFcmTransport(env);

  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 64 * 1024, // 64 KiB strict payload cap
    requestTimeout: 30_000, // Well inside Hostinger's 120s LiteSpeed limit
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      if (typeof incoming === 'string' && /^[a-zA-Z0-9._-]{8,64}$/.test(incoming)) {
        return incoming;
      }
      return randomUUID();
    },
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-maintenance-key"]',
          'req.headers.cookie',
          'body.password',
          'body.currentPassword',
          'body.newPassword',
          'body.refreshToken',
          'body.fcmToken'
        ],
        censor: '[REDACTED]'
      }
    }
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', String(request.id));
  });

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: env.ENABLE_SWAGGER_UI ? false : undefined
  });

  await app.register(fastifyCors, {
    origin: (origin, cb) => {
      // Native Android clients omit the Origin header
      if (!origin) {
        cb(null, true);
        return;
      }
      if (env.corsOriginList.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id']
  });

  if (options.enableRateLimit !== false) {
    await app.register(fastifyRateLimit, {
      global: true,
      max: 180,
      timeWindow: '1 minute',
      errorResponseBuilder: (_req, context) => ({
        statusCode: 429,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`
        }
      })
    });
  }

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'ArrestMe Cloud Coordination API',
        description:
          'Production REST backend for the ArrestMe Android focus & digital-detox application (Partner Arrest, Delegated Permissions, Persistent Command Queue, Early Release, and Synchronization).',
        version: env.APP_VERSION
      },
      servers: [
        {
          url: '/',
          description: 'ArrestMe API Server'
        }
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Short-lived HS256 JWT access token'
          },
          maintenanceKey: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Maintenance-Key',
            description: 'Protected secret header for readiness probes and scheduled maintenance'
          }
        }
      }
    },
    transform: jsonSchemaTransform
  });

  if (env.ENABLE_SWAGGER_UI) {
    await app.register(fastifySwaggerUi, {
      routePrefix: '/docs'
    });
  }

  // Error & 404 handlers ensuring machine-readable responses and zero secret/stack leaks
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url.split('?')[0]} does not exist.`
      }
    });
  });

  app.setErrorHandler((err: FastifyError | AppError | Error, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {})
        }
      });
    }

    if (hasZodFastifySchemaValidationErrors(err)) {
      const issues = err.validation.map((v) => ({
        path: v.instancePath || '/',
        message: v.message ?? 'Invalid value'
      }));
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: { issues }
        }
      });
    }

    if (isResponseSerializationError(err)) {
      request.log.error({ err }, 'Response serialization failed');
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred.'
        }
      });
    }

    const fastifyErr = err as FastifyError & { error?: { code: string; message: string } };
    if (fastifyErr.statusCode === 429) {
      return reply.status(429).send({
        error: fastifyErr.error ?? {
          code: 'RATE_LIMIT_EXCEEDED',
          message: fastifyErr.message || 'Too many requests.'
        }
      });
    }

    if (fastifyErr.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || fastifyErr.statusCode === 413) {
      return reply.status(413).send({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request payload exceeds maximum allowed size.'
        }
      });
    }

    if (
      fastifyErr.statusCode &&
      fastifyErr.statusCode >= 400 &&
      fastifyErr.statusCode < 500
    ) {
      return reply.status(fastifyErr.statusCode).send({
        error: {
          code: 'BAD_REQUEST',
          message: fastifyErr.message || 'Invalid client request.'
        }
      });
    }

    request.log.error({ err }, 'Unhandled application error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal error occurred.'
      }
    });
  });

  // Wire services cleanly without circular dependencies
  const jwtService = new JwtService({
    secret: env.JWT_ACCESS_SECRET,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    ttlSeconds: env.ACCESS_TOKEN_TTL_SECONDS
  });

  const auditService = new AuditService(clock);
  const notificationService = new NotificationService(store, fcmTransport, clock, app.log, {
    retryDelayMs: options.notificationRetryDelayMs
  });

  const authService = new AuthService(
    store,
    passwordHasher,
    jwtService,
    auditService,
    clock,
    env.REFRESH_TOKEN_TTL_DAYS
  );
  const usersService = new UsersService(store, auditService, clock);
  const devicesService = new DevicesService(store, auditService, clock);
  const partnersService = new PartnersService(store, notificationService, auditService, clock);
  const permissionsService = new PermissionsService(
    store,
    auditService,
    clock,
    env.MAX_SESSION_DURATION_MINUTES
  );
  const commandsService = new CommandsService(store, auditService, clock);
  const sessionsService = new SessionsService(
    store,
    permissionsService,
    notificationService,
    auditService,
    clock,
    env.DEFAULT_COMMAND_TTL_SECONDS,
    env.MAX_SESSION_DURATION_MINUTES
  );
  const releasesService = new ReleasesService(
    store,
    notificationService,
    auditService,
    clock,
    env.DEFAULT_COMMAND_TTL_SECONDS
  );
  const maintenanceService = new MaintenanceService(
    store,
    notificationService,
    auditService,
    clock
  );

  const authenticate = createAuthenticatePreHandler({ jwtService, store, clock });
  const verifyMaintenanceKey = createMaintenanceKeyPreHandler(env.MAINTENANCE_API_KEY);

  // Register route modules
  registerHealthAndMaintenanceRoutes(app, {
    version: env.APP_VERSION,
    store,
    maintenanceService,
    verifyMaintenanceKey
  });
  registerAuthRoutes(app, { authService, authenticate });
  registerUsersRoutes(app, { usersService, authenticate });
  registerDevicesRoutes(app, { devicesService, authenticate });
  registerPartnersRoutes(app, { partnersService, authenticate });
  registerPermissionsRoutes(app, { permissionsService, authenticate });
  registerSessionsRoutes(app, { sessionsService, authenticate });
  registerCommandsRoutes(app, { commandsService, authenticate });
  registerReleasesRoutes(app, { releasesService, authenticate });

  return app;
}
