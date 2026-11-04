import { randomUUID } from 'node:crypto';
import type { AuditService, RequestContextMeta } from '../../services/audit.service';
import {
  generateOpaqueRefreshToken,
  sha256Hex,
  type JwtService,
  type PasswordHasher
} from '../../shared/crypto';
import { Errors } from '../../shared/errors';
import type { Clock } from '../../shared/time';
import type { AuthenticatedUserProfile, UserRecord } from '../../types/domain';
import type { DataStore, RepositoryBundle } from '../../types/repositories';

export function serializeAuthenticatedUser(user: UserRecord): AuthenticatedUserProfile {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    accountStatus: user.accountStatus,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null
  };
}

export interface AuthTokensBundle {
  accessToken: string;
  accessTokenExpiresAt: string;
  expiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  tokenType: 'Bearer';
}

export class AuthService {
  private dummyPasswordHashPromise: Promise<string> | null = null;

  constructor(
    private readonly store: DataStore,
    private readonly passwordHasher: PasswordHasher,
    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
    private readonly clock: Clock,
    private readonly refreshTokenTtlDays: number
  ) {}

  async register(
    input: {
      username: string;
      email: string;
      password: string;
      displayName?: string;
    },
    context?: RequestContextMeta
  ): Promise<{ user: AuthenticatedUserProfile; tokens: AuthTokensBundle }> {
    const existingEmail = await this.store.repositories.users.findByEmail(input.email);
    if (existingEmail) {
      throw Errors.conflict('EMAIL_ALREADY_REGISTERED', 'Email address is already registered.');
    }

    const existingUsername = await this.store.repositories.users.findByUsername(input.username);
    if (existingUsername) {
      throw Errors.conflict('USERNAME_ALREADY_TAKEN', 'Username is already taken.');
    }

    const passwordHash = await this.passwordHasher.hash(input.password);
    const now = this.clock.now();
    const userId = randomUUID();

    return this.store.withTransaction(async (repos) => {
      const createdUser = await repos.users.create({
        id: userId,
        username: input.username,
        email: input.email,
        passwordHash,
        displayName: input.displayName ?? input.username,
        avatarUrl: null,
        accountStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now
      });

      const tokens = await this.issueTokenPairInTx(repos, createdUser, {
        familyId: randomUUID(),
        deviceId: null,
        context
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId: createdUser.id,
        action: 'AUTH_REGISTER',
        resourceType: 'USER',
        resourceId: createdUser.id,
        result: 'SUCCESS',
        context
      });

      return {
        user: serializeAuthenticatedUser(createdUser),
        tokens
      };
    });
  }

  async login(
    input: { email: string; password: string; deviceId?: string },
    context?: RequestContextMeta
  ): Promise<{ user: AuthenticatedUserProfile; tokens: AuthTokensBundle }> {
    const user = await this.store.repositories.users.findByEmail(input.email);

    if (!user) {
      // Constant-work dummy verify to mitigate email-enumeration timing side-channels
      const dummyHash = await this.getDummyPasswordHash();
      await this.passwordHasher.verify(input.password, dummyHash);
      throw Errors.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    const validPassword = await this.passwordHasher.verify(input.password, user.passwordHash);
    if (!validPassword) {
      await this.auditService.record(this.store.repositories.auditLogs, {
        actorUserId: user.id,
        action: 'AUTH_LOGIN_FAILED',
        resourceType: 'USER',
        resourceId: user.id,
        result: 'DENIED',
        context
      });
      throw Errors.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    if (user.accountStatus === 'SUSPENDED') {
      throw Errors.forbidden('ACCOUNT_SUSPENDED', 'This account has been suspended.');
    }
    if (user.accountStatus !== 'ACTIVE') {
      throw Errors.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    return this.store.withTransaction(async (repos) => {
      const now = this.clock.now();
      await repos.users.updateLastLogin(user.id, now);

      let verifiedDeviceId: string | null = null;
      if (input.deviceId) {
        const device = await repos.devices.findById(input.deviceId);
        if (device && device.userId === user.id && device.deviceStatus === 'ACTIVE') {
          verifiedDeviceId = device.id;
        }
      }

      const updatedUser: UserRecord = { ...user, lastLoginAt: now, updatedAt: now };
      const tokens = await this.issueTokenPairInTx(repos, updatedUser, {
        familyId: randomUUID(),
        deviceId: verifiedDeviceId,
        context
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId: user.id,
        actorDeviceId: verifiedDeviceId,
        action: 'AUTH_LOGIN',
        resourceType: 'USER',
        resourceId: user.id,
        result: 'SUCCESS',
        context
      });

      return {
        user: serializeAuthenticatedUser(updatedUser),
        tokens
      };
    });
  }

  async refresh(
    rawRefreshToken: string,
    context?: RequestContextMeta
  ): Promise<{ tokens: AuthTokensBundle }> {
    const tokenHash = sha256Hex(rawRefreshToken);

    // Note: When token reuse is detected, we must commit the family revocation BEFORE throwing!
    const outcome = await this.store.withTransaction(
      async (
        repos
      ): Promise<
        | { ok: true; tokens: AuthTokensBundle }
        | { ok: false; reason: 'NOT_FOUND' | 'REUSED' | 'REVOKED' | 'EXPIRED' | 'SUSPENDED' }
      > => {
        const existing = await repos.refreshTokens.findByHashForUpdate(tokenHash);
        if (!existing) {
          return { ok: false, reason: 'NOT_FOUND' };
        }

        const now = this.clock.now();

        if (existing.revokedAt !== null) {
          if (existing.revokedReason === 'ROTATED') {
            const revokedCount = await repos.refreshTokens.revokeFamily(
              existing.familyId,
              now,
              'REUSE_DETECTED'
            );
            await this.auditService.record(repos.auditLogs, {
              actorUserId: existing.userId,
              actorDeviceId: existing.deviceId,
              action: 'AUTH_REFRESH_REUSE_DETECTED',
              resourceType: 'REFRESH_TOKEN_FAMILY',
              resourceId: existing.familyId,
              result: 'DENIED',
              context,
              metadata: { revokedActiveTokensInFamily: revokedCount }
            });
            return { ok: false, reason: 'REUSED' };
          }
          return { ok: false, reason: 'REVOKED' };
        }

        if (existing.expiresAt.getTime() <= now.getTime()) {
          await repos.refreshTokens.revokeById(existing.id, {
            revokedAt: now,
            revokedReason: 'EXPIRED'
          });
          return { ok: false, reason: 'EXPIRED' };
        }

        const user = await repos.users.findById(existing.userId);
        if (!user || user.accountStatus !== 'ACTIVE') {
          await repos.refreshTokens.revokeFamily(existing.familyId, now, 'USER_INACTIVE');
          return {
            ok: false,
            reason: user?.accountStatus === 'SUSPENDED' ? 'SUSPENDED' : 'REVOKED'
          };
        }

        const newTokenId = randomUUID();
        await repos.refreshTokens.revokeById(existing.id, {
          revokedAt: now,
          revokedReason: 'ROTATED',
          replacedById: newTokenId
        });

        const tokens = await this.issueTokenPairInTx(repos, user, {
          tokenId: newTokenId,
          familyId: existing.familyId,
          deviceId: existing.deviceId,
          context
        });

        return { ok: true, tokens };
      }
    );

    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'REUSED':
          throw Errors.unauthorized(
            'REFRESH_TOKEN_REUSED',
            'Refresh token reuse detected. Session family has been revoked for security.'
          );
        case 'REVOKED':
          throw Errors.unauthorized('REFRESH_TOKEN_REVOKED', 'Refresh token has been revoked.');
        case 'EXPIRED':
          throw Errors.unauthorized('REFRESH_TOKEN_EXPIRED', 'Refresh token has expired.');
        case 'SUSPENDED':
          throw Errors.forbidden('ACCOUNT_SUSPENDED', 'This account has been suspended.');
        default:
          throw Errors.unauthorized('INVALID_REFRESH_TOKEN', 'Invalid refresh token.');
      }
    }

    return { tokens: outcome.tokens };
  }

  async logout(rawRefreshToken: string, context?: RequestContextMeta): Promise<void> {
    const tokenHash = sha256Hex(rawRefreshToken);
    await this.store.withTransaction(async (repos) => {
      const existing = await repos.refreshTokens.findByHashForUpdate(tokenHash);
      if (!existing || existing.revokedAt !== null) {
        return;
      }
      const now = this.clock.now();
      await repos.refreshTokens.revokeFamily(existing.familyId, now, 'USER_LOGOUT');
      await this.auditService.record(repos.auditLogs, {
        actorUserId: existing.userId,
        actorDeviceId: existing.deviceId,
        action: 'AUTH_LOGOUT',
        resourceType: 'REFRESH_TOKEN_FAMILY',
        resourceId: existing.familyId,
        result: 'SUCCESS',
        context
      });
    });
  }

  async logoutAll(userId: string, context?: RequestContextMeta): Promise<{ revokedCount: number }> {
    return this.store.withTransaction(async (repos) => {
      const now = this.clock.now();
      const revokedCount = await repos.refreshTokens.revokeAllForUser(
        userId,
        now,
        'USER_LOGOUT_ALL'
      );
      await this.auditService.record(repos.auditLogs, {
        actorUserId: userId,
        action: 'AUTH_LOGOUT_ALL',
        resourceType: 'USER',
        resourceId: userId,
        result: 'SUCCESS',
        context,
        metadata: { revokedCount }
      });
      return { revokedCount };
    });
  }

  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
    context?: RequestContextMeta
  ): Promise<{ tokens: AuthTokensBundle }> {
    const user = await this.store.repositories.users.findById(userId);
    if (!user || user.accountStatus !== 'ACTIVE') {
      throw Errors.unauthorized('UNAUTHORIZED', 'Account is not active.');
    }

    const validCurrent = await this.passwordHasher.verify(input.currentPassword, user.passwordHash);
    if (!validCurrent) {
      await this.auditService.record(this.store.repositories.auditLogs, {
        actorUserId: userId,
        action: 'AUTH_CHANGE_PASSWORD_FAILED',
        resourceType: 'USER',
        resourceId: userId,
        result: 'DENIED',
        context
      });
      throw Errors.unauthorized('INVALID_CREDENTIALS', 'Current password is incorrect.');
    }

    const newHash = await this.passwordHasher.hash(input.newPassword);

    return this.store.withTransaction(async (repos) => {
      const now = this.clock.now();
      await repos.users.updatePasswordHash(userId, newHash, now);
      await repos.refreshTokens.revokeAllForUser(userId, now, 'PASSWORD_CHANGED');

      const tokens = await this.issueTokenPairInTx(repos, user, {
        familyId: randomUUID(),
        deviceId: null,
        context
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId: userId,
        action: 'AUTH_PASSWORD_CHANGED',
        resourceType: 'USER',
        resourceId: userId,
        result: 'SUCCESS',
        context
      });

      return { tokens };
    });
  }

  private async issueTokenPairInTx(
    repos: RepositoryBundle,
    user: { id: string; username: string },
    options: {
      tokenId?: string;
      familyId: string;
      deviceId: string | null;
      context?: RequestContextMeta;
    }
  ): Promise<AuthTokensBundle> {
    const now = this.clock.now();
    const access = this.jwtService.signAccessToken(user, now.getTime());

    const rawRefreshToken = generateOpaqueRefreshToken();
    const refreshTokenHash = sha256Hex(rawRefreshToken);
    const refreshExpiresAt = new Date(
      now.getTime() + this.refreshTokenTtlDays * 24 * 60 * 60 * 1000
    );

    await repos.refreshTokens.create({
      id: options.tokenId ?? randomUUID(),
      userId: user.id,
      familyId: options.familyId,
      tokenHash: refreshTokenHash,
      deviceId: options.deviceId,
      userAgent: options.context?.userAgent ?? null,
      ipAddress: options.context?.ipAddress ?? null,
      expiresAt: refreshExpiresAt,
      revokedAt: null,
      revokedReason: null,
      replacedById: null,
      createdAt: now
    });

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      expiresInSeconds: access.expiresInSeconds,
      refreshToken: rawRefreshToken,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      tokenType: 'Bearer'
    };
  }

  private getDummyPasswordHash(): Promise<string> {
    if (!this.dummyPasswordHashPromise) {
      this.dummyPasswordHashPromise = this.passwordHasher.hash('DummyConstantWorkPassword!99');
    }
    return this.dummyPasswordHashPromise;
  }
}
