import type { FastifyReply, FastifyRequest } from 'fastify';
import { safeCompareSecret, type JwtService } from '../shared/crypto';
import { Errors } from '../shared/errors';
import type { Clock } from '../shared/time';
import type { DataStore } from '../types/repositories';
import type { RequestContextMeta } from '../services/audit.service';

export interface AuthenticatedPrincipal {
  id: string;
  username: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthenticatedPrincipal;
  }
}

export function extractRequestContext(request: FastifyRequest): RequestContextMeta {
  const rawUa = request.headers['user-agent'];
  return {
    ipAddress: request.ip ?? null,
    requestId: String(request.id),
    userAgent: typeof rawUa === 'string' ? rawUa.slice(0, 255) : null
  };
}

export function createAuthenticatePreHandler(deps: {
  jwtService: JwtService;
  store: DataStore;
  clock: Clock;
}) {
  return async function authenticate(
    request: FastifyRequest,
    _reply: FastifyReply
  ): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw Errors.unauthorized('UNAUTHORIZED', 'Missing or invalid Authorization Bearer header.');
    }

    const rawToken = authHeader.slice('Bearer '.length).trim();
    if (!rawToken) {
      throw Errors.unauthorized('UNAUTHORIZED', 'Missing access token.');
    }

    const claims = deps.jwtService.verifyAccessToken(rawToken, deps.clock.nowMs());
    const user = await deps.store.repositories.users.findById(claims.sub);
    if (!user || user.accountStatus === 'DELETED') {
      throw Errors.unauthorized('UNAUTHORIZED', 'Authenticated account is no longer valid.');
    }
    if (user.accountStatus === 'SUSPENDED') {
      throw Errors.forbidden('ACCOUNT_SUSPENDED', 'This account has been suspended.');
    }

    request.authUser = {
      id: user.id,
      username: user.username,
      email: user.email
    };
  };
}

export function createMaintenanceKeyPreHandler(expectedKey: string | undefined) {
  return async function verifyMaintenanceKey(
    request: FastifyRequest,
    _reply: FastifyReply
  ): Promise<void> {
    const headerVal = request.headers['x-maintenance-key'];
    const provided = typeof headerVal === 'string' ? headerVal.trim() : undefined;

    if (!expectedKey || !safeCompareSecret(provided, expectedKey)) {
      throw Errors.unauthorized('UNAUTHORIZED', 'Invalid or missing maintenance key.');
    }
  };
}
