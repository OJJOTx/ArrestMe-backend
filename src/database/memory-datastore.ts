import { Errors } from '../shared/errors';
import type { AllowedTimeWindowsConfig } from '../shared/time';
import {
  NON_TERMINAL_CLOUD_SESSION_STATUSES,
  TERMINAL_CLOUD_SESSION_STATUSES,
  type AndroidEngineState,
  type ArrestSessionRecord,
  type AuditLogRecord,
  type AuditResult,
  type BlockingConfigLimitsV1,
  type BlockingConfigurationV1,
  type CloudSessionStatus,
  type CommandStatus,
  type CommandType,
  type DevicePushTokenRecord,
  type DeviceRecord,
  type DeviceStatus,
  type PartnerPermissionRecord,
  type PartnershipRecord,
  type PartnershipState,
  type PushDeliveryStatus,
  type RefreshTokenRecord,
  type ReleaseRequestRecord,
  type ReleaseRequestStatus,
  type SessionCommandRecord,
  type SessionSyncEventRecord,
  type SessionType,
  type UserRecord
} from '../types/domain';
import type {
  AuditLogsRepository,
  CommandsRepository,
  DataStore,
  DevicesRepository,
  PartnerPermissionsRepository,
  PartnershipsRepository,
  PushTokensRepository,
  RefreshTokensRepository,
  ReleaseRequestsRepository,
  RepositoryBundle,
  SessionsRepository,
  UsersRepository
} from '../types/repositories';

interface MemoryState {
  users: UserRecord[];
  refreshTokens: RefreshTokenRecord[];
  devices: DeviceRecord[];
  pushTokens: DevicePushTokenRecord[];
  partnerships: PartnershipRecord[];
  partnerPermissions: PartnerPermissionRecord[];
  sessions: ArrestSessionRecord[];
  commands: SessionCommandRecord[];
  syncEvents: SessionSyncEventRecord[];
  releaseRequests: ReleaseRequestRecord[];
  auditLogs: AuditLogRecord[];
  nextCommandSeq: number;
  nextSyncEventId: number;
  nextAuditId: number;
}

function cloneDeep<T>(value: T): T {
  return structuredClone(value);
}

function canonicalPair(userA: string, userB: string): [string, string] {
  return userA < userB ? [userA, userB] : [userB, userA];
}

export class InMemoryDataStore implements DataStore {
  private state: MemoryState = {
    users: [],
    refreshTokens: [],
    devices: [],
    pushTokens: [],
    partnerships: [],
    partnerPermissions: [],
    sessions: [],
    commands: [],
    syncEvents: [],
    releaseRequests: [],
    auditLogs: [],
    nextCommandSeq: 1,
    nextSyncEventId: 1,
    nextAuditId: 1
  };

  private txChain: Promise<void> = Promise.resolve();
  private healthy = true;
  public readonly repositories: RepositoryBundle;

  constructor() {
    this.repositories = this.buildRepos();
  }

  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  getAuditLogsSnapshot(): AuditLogRecord[] {
    return cloneDeep(this.state.auditLogs);
  }

  getPushTokensSnapshot(): DevicePushTokenRecord[] {
    return cloneDeep(this.state.pushTokens);
  }

  async withTransaction<T>(fn: (repos: RepositoryBundle) => Promise<T>): Promise<T> {
    let releaseLock!: () => void;
    const prev = this.txChain;
    this.txChain = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await prev;
    const snapshot = cloneDeep(this.state);
    try {
      const result = await fn(this.repositories);
      return result;
    } catch (err) {
      this.state = snapshot;
      throw err;
    } finally {
      releaseLock();
    }
  }

  async ping(): Promise<boolean> {
    return this.healthy;
  }

  async close(): Promise<void> {
    // No external socket resources to close
  }

  private buildRepos(): RepositoryBundle {
    const users: UsersRepository = {
      create: async (user) => {
        if (this.state.users.some((u) => u.email === user.email)) {
          throw Errors.conflict('EMAIL_ALREADY_REGISTERED', 'Email address is already registered.');
        }
        if (this.state.users.some((u) => u.username === user.username)) {
          throw Errors.conflict('USERNAME_ALREADY_TAKEN', 'Username is already taken.');
        }
        const copy = cloneDeep(user);
        this.state.users.push(copy);
        return cloneDeep(copy);
      },
      findById: async (id) => {
        const found = this.state.users.find((u) => u.id === id);
        return found ? cloneDeep(found) : null;
      },
      findByIds: async (ids) => {
        const set = new Set(ids);
        const map = new Map<string, UserRecord>();
        for (const u of this.state.users) {
          if (set.has(u.id)) map.set(u.id, cloneDeep(u));
        }
        return map;
      },
      findByEmail: async (email) => {
        const found = this.state.users.find((u) => u.email === email);
        return found ? cloneDeep(found) : null;
      },
      findByUsername: async (username) => {
        const found = this.state.users.find((u) => u.username === username);
        return found ? cloneDeep(found) : null;
      },
      updateProfile: async (userId, updates) => {
        const target = this.state.users.find((u) => u.id === userId);
        if (!target) return null;
        if (updates.displayName !== undefined) target.displayName = updates.displayName;
        if (updates.avatarUrl !== undefined) target.avatarUrl = updates.avatarUrl;
        target.updatedAt = cloneDeep(updates.updatedAt);
        return cloneDeep(target);
      },
      updatePasswordHash: async (userId, passwordHash, updatedAt) => {
        const target = this.state.users.find((u) => u.id === userId);
        if (target) {
          target.passwordHash = passwordHash;
          target.updatedAt = cloneDeep(updatedAt);
        }
      },
      updateLastLogin: async (userId, lastLoginAt) => {
        const target = this.state.users.find((u) => u.id === userId);
        if (target) {
          target.lastLoginAt = cloneDeep(lastLoginAt);
          target.updatedAt = cloneDeep(lastLoginAt);
        }
      }
    };

    const refreshTokens: RefreshTokensRepository = {
      create: async (token) => {
        const copy = cloneDeep(token);
        this.state.refreshTokens.push(copy);
        return cloneDeep(copy);
      },
      findByHashForUpdate: async (tokenHash) => {
        const found = this.state.refreshTokens.find((t) => t.tokenHash === tokenHash);
        return found ? cloneDeep(found) : null;
      },
      revokeById: async (id, params) => {
        const target = this.state.refreshTokens.find((t) => t.id === id && t.revokedAt === null);
        if (target) {
          target.revokedAt = cloneDeep(params.revokedAt);
          target.revokedReason = params.revokedReason;
          if (params.replacedById !== undefined) target.replacedById = params.replacedById;
        }
      },
      revokeFamily: async (familyId, revokedAt, revokedReason) => {
        let count = 0;
        for (const t of this.state.refreshTokens) {
          if (t.familyId === familyId && t.revokedAt === null) {
            t.revokedAt = cloneDeep(revokedAt);
            t.revokedReason = revokedReason;
            count++;
          }
        }
        return count;
      },
      revokeAllForUser: async (userId, revokedAt, revokedReason) => {
        let count = 0;
        for (const t of this.state.refreshTokens) {
          if (t.userId === userId && t.revokedAt === null) {
            t.revokedAt = cloneDeep(revokedAt);
            t.revokedReason = revokedReason;
            count++;
          }
        }
        return count;
      },
      deleteExpiredBefore: async (cutoff) => {
        const before = this.state.refreshTokens.length;
        this.state.refreshTokens = this.state.refreshTokens.filter(
          (t) => t.expiresAt.getTime() >= cutoff.getTime()
        );
        return before - this.state.refreshTokens.length;
      }
    };

    const devices: DevicesRepository = {
      create: async (device) => {
        const copy = cloneDeep(device);
        this.state.devices.push(copy);
        return cloneDeep(copy);
      },
      findById: async (id) => {
        const found = this.state.devices.find((d) => d.id === id);
        return found ? cloneDeep(found) : null;
      },
      findByIdForUpdate: async (id) => {
        const found = this.state.devices.find((d) => d.id === id);
        return found ? cloneDeep(found) : null;
      },
      findByIds: async (ids) => {
        const set = new Set(ids);
        const map = new Map<string, DeviceRecord>();
        for (const d of this.state.devices) {
          if (set.has(d.id)) map.set(d.id, cloneDeep(d));
        }
        return map;
      },
      findByUserAndInstallation: async (userId, installationId) => {
        const found = this.state.devices.find(
          (d) => d.userId === userId && d.installationId === installationId
        );
        return found ? cloneDeep(found) : null;
      },
      listByUser: async (userId, options) => {
        const filtered = this.state.devices
          .filter(
            (d) =>
              d.userId === userId && (options.includeRevoked || d.deviceStatus !== 'REVOKED')
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return {
          items: cloneDeep(filtered.slice(options.offset, options.offset + options.limit)),
          total: filtered.length,
          limit: options.limit,
          offset: options.offset
        };
      },
      listActiveByUser: async (userId) => {
        return cloneDeep(
          this.state.devices
            .filter((d) => d.userId === userId && d.deviceStatus === 'ACTIVE')
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        );
      },
      update: async (
        id,
        updates: {
          deviceName?: string;
          manufacturer?: string | null;
          model?: string | null;
          appVersion?: string;
          androidVersion?: string;
          sdkInt?: number | null;
          deviceStatus?: DeviceStatus;
          lastSeenAt?: Date;
          revokedAt?: Date | null;
          updatedAt: Date;
        }
      ) => {
        const target = this.state.devices.find((d) => d.id === id);
        if (!target) return null;
        if (updates.deviceName !== undefined) target.deviceName = updates.deviceName;
        if (updates.manufacturer !== undefined) target.manufacturer = updates.manufacturer;
        if (updates.model !== undefined) target.model = updates.model;
        if (updates.appVersion !== undefined) target.appVersion = updates.appVersion;
        if (updates.androidVersion !== undefined) target.androidVersion = updates.androidVersion;
        if (updates.sdkInt !== undefined) target.sdkInt = updates.sdkInt;
        if (updates.deviceStatus !== undefined) target.deviceStatus = updates.deviceStatus;
        if (updates.lastSeenAt !== undefined) target.lastSeenAt = cloneDeep(updates.lastSeenAt);
        if (updates.revokedAt !== undefined) target.revokedAt = cloneDeep(updates.revokedAt);
        target.updatedAt = cloneDeep(updates.updatedAt);
        return cloneDeep(target);
      },
      touchLastSeen: async (id, seenAt) => {
        const target = this.state.devices.find(
          (d) => d.id === id && d.deviceStatus !== 'REVOKED'
        );
        if (target) {
          target.lastSeenAt = cloneDeep(seenAt);
          target.updatedAt = cloneDeep(seenAt);
        }
      }
    };

    const pushTokens: PushTokensRepository = {
      upsertForDevice: async (params) => {
        for (const pt of this.state.pushTokens) {
          if (
            pt.deviceId === params.deviceId &&
            pt.tokenHash !== params.tokenHash &&
            pt.tokenStatus === 'ACTIVE'
          ) {
            pt.tokenStatus = 'REVOKED';
            pt.invalidatedReason = 'ROTATED_ON_DEVICE';
            pt.updatedAt = cloneDeep(params.now);
          }
        }

        let existing = this.state.pushTokens.find((pt) => pt.tokenHash === params.tokenHash);
        if (existing) {
          existing.deviceId = params.deviceId;
          existing.fcmToken = params.fcmToken;
          existing.tokenStatus = 'ACTIVE';
          existing.invalidatedReason = null;
          existing.lastValidatedAt = cloneDeep(params.now);
          existing.updatedAt = cloneDeep(params.now);
        } else {
          existing = {
            id: params.id,
            deviceId: params.deviceId,
            fcmToken: params.fcmToken,
            tokenHash: params.tokenHash,
            tokenStatus: 'ACTIVE',
            invalidatedReason: null,
            lastValidatedAt: cloneDeep(params.now),
            createdAt: cloneDeep(params.now),
            updatedAt: cloneDeep(params.now)
          };
          this.state.pushTokens.push(existing);
        }
        return cloneDeep(existing);
      },
      listActiveForDevice: async (deviceId) => {
        const dev = this.state.devices.find((d) => d.id === deviceId);
        if (!dev || dev.deviceStatus !== 'ACTIVE') return [];
        return cloneDeep(
          this.state.pushTokens.filter(
            (pt) => pt.deviceId === deviceId && pt.tokenStatus === 'ACTIVE'
          )
        );
      },
      listActiveForUser: async (userId) => {
        const activeDeviceIds = new Set(
          this.state.devices
            .filter((d) => d.userId === userId && d.deviceStatus === 'ACTIVE')
            .map((d) => d.id)
        );
        return cloneDeep(
          this.state.pushTokens.filter(
            (pt) => activeDeviceIds.has(pt.deviceId) && pt.tokenStatus === 'ACTIVE'
          )
        );
      },
      markTokenInvalid: async (tokenHash, reason, now) => {
        const target = this.state.pushTokens.find((pt) => pt.tokenHash === tokenHash);
        if (target) {
          target.tokenStatus = 'INVALID';
          target.invalidatedReason = reason.slice(0, 128);
          target.updatedAt = cloneDeep(now);
        }
      },
      revokeAllForDevice: async (deviceId, reason, now) => {
        let count = 0;
        for (const pt of this.state.pushTokens) {
          if (pt.deviceId === deviceId && pt.tokenStatus === 'ACTIVE') {
            pt.tokenStatus = 'REVOKED';
            pt.invalidatedReason = reason.slice(0, 128);
            pt.updatedAt = cloneDeep(now);
            count++;
          }
        }
        return count;
      }
    };

    const partnerships: PartnershipsRepository = {
      findById: async (id) => {
        const found = this.state.partnerships.find((p) => p.id === id);
        return found ? cloneDeep(found) : null;
      },
      findByIdForUpdate: async (id) => {
        const found = this.state.partnerships.find((p) => p.id === id);
        return found ? cloneDeep(found) : null;
      },
      findByPairForUpdate: async (userA, userB) => {
        const [low, high] = canonicalPair(userA, userB);
        const found = this.state.partnerships.find(
          (p) => p.userLowId === low && p.userHighId === high
        );
        return found ? cloneDeep(found) : null;
      },
      findByPair: async (userA, userB) => {
        const [low, high] = canonicalPair(userA, userB);
        const found = this.state.partnerships.find(
          (p) => p.userLowId === low && p.userHighId === high
        );
        return found ? cloneDeep(found) : null;
      },
      create: async (record) => {
        const dup = this.state.partnerships.find(
          (p) => p.userLowId === record.userLowId && p.userHighId === record.userHighId
        );
        if (dup) {
          throw Errors.conflict(
            'PARTNERSHIP_CONFLICT',
            'A partnership record already exists between these users.'
          );
        }
        const copy = cloneDeep(record);
        this.state.partnerships.push(copy);
        return cloneDeep(copy);
      },
      update: async (id, updates) => {
        const target = this.state.partnerships.find((p) => p.id === id);
        if (!target) {
          throw Errors.notFound('PARTNERSHIP_NOT_FOUND', 'Partnership record was not found.');
        }
        if (updates.senderUserId !== undefined) target.senderUserId = updates.senderUserId;
        if (updates.recipientUserId !== undefined) target.recipientUserId = updates.recipientUserId;
        target.state = updates.state;
        if (updates.blockedByUserId !== undefined)
          target.blockedByUserId = updates.blockedByUserId;
        if (updates.respondedAt !== undefined)
          target.respondedAt = cloneDeep(updates.respondedAt);
        target.updatedAt = cloneDeep(updates.updatedAt);
        return cloneDeep(target);
      },
      listRequestsForUser: async (userId, options) => {
        const desiredState: PartnershipState = options.state ?? 'PENDING';
        const filtered = this.state.partnerships
          .filter((p) => {
            if (p.state !== desiredState) return false;
            if (options.direction === 'incoming') return p.recipientUserId === userId;
            if (options.direction === 'outgoing') return p.senderUserId === userId;
            return p.senderUserId === userId || p.recipientUserId === userId;
          })
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

        return {
          items: cloneDeep(filtered.slice(options.offset, options.offset + options.limit)),
          total: filtered.length,
          limit: options.limit,
          offset: options.offset
        };
      },
      listAcceptedPartnersForUser: async (userId, options) => {
        const filtered = this.state.partnerships
          .filter(
            (p) =>
              p.state === 'ACCEPTED' &&
              (p.senderUserId === userId || p.recipientUserId === userId)
          )
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        return {
          items: cloneDeep(filtered.slice(options.offset, options.offset + options.limit)),
          total: filtered.length,
          limit: options.limit,
          offset: options.offset
        };
      }
    };

    const partnerPermissions: PartnerPermissionsRepository = {
      create: async (record) => {
        const copy = cloneDeep(record);
        this.state.partnerPermissions.push(copy);
        return cloneDeep(copy);
      },
      findById: async (permissionId) => {
        const found = this.state.partnerPermissions.find((p) => p.permissionId === permissionId);
        return found ? cloneDeep(found) : null;
      },
      findByIdForUpdate: async (permissionId) => {
        const found = this.state.partnerPermissions.find((p) => p.permissionId === permissionId);
        return found ? cloneDeep(found) : null;
      },
      listForUser: async (userId, options) => {
        const filtered = this.state.partnerPermissions
          .filter((p) => {
            const roleMatch =
              options.role === 'granted'
                ? p.ownerUserId === userId
                : options.role === 'received'
                  ? p.partnerUserId === userId
                  : p.ownerUserId === userId || p.partnerUserId === userId;
            if (!roleMatch) return false;
            if (options.activeOnly) {
              if (p.revokedAt !== null) return false;
              if (p.expiresAt.getTime() <= options.now.getTime()) return false;
              if (p.oneTimeOnly && p.usedCount >= 1) return false;
            }
            return true;
          })
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        return {
          items: cloneDeep(filtered.slice(options.offset, options.offset + options.limit)),
          total: filtered.length,
          limit: options.limit,
          offset: options.offset
        };
      },
      update: async (
        permissionId,
        updates: {
          maximumSessionDuration?: number;
          allowedTimeWindows?: AllowedTimeWindowsConfig | null;
          allowedSessionTypes?: SessionType[];
          blockingConfigLimits?: BlockingConfigLimitsV1;
          oneTimeOnly?: boolean;
          validFrom?: Date;
          expiresAt?: Date;
          version: number;
          updatedAt: Date;
        }
      ) => {
        const target = this.state.partnerPermissions.find((p) => p.permissionId === permissionId);
        if (!target) {
          throw Errors.notFound('PERMISSION_NOT_FOUND', 'Partner permission was not found.');
        }
        if (updates.maximumSessionDuration !== undefined)
          target.maximumSessionDuration = updates.maximumSessionDuration;
        if (updates.allowedTimeWindows !== undefined)
          target.allowedTimeWindows = cloneDeep(updates.allowedTimeWindows);
        if (updates.allowedSessionTypes !== undefined)
          target.allowedSessionTypes = cloneDeep(updates.allowedSessionTypes);
        if (updates.blockingConfigLimits !== undefined)
          target.blockingConfigLimits = cloneDeep(updates.blockingConfigLimits);
        if (updates.oneTimeOnly !== undefined) target.oneTimeOnly = updates.oneTimeOnly;
        if (updates.validFrom !== undefined) target.validFrom = cloneDeep(updates.validFrom);
        if (updates.expiresAt !== undefined) target.expiresAt = cloneDeep(updates.expiresAt);
        target.version = updates.version;
        target.updatedAt = cloneDeep(updates.updatedAt);
        return cloneDeep(target);
      },
      incrementUsedCount: async (permissionId, now) => {
        const target = this.state.partnerPermissions.find((p) => p.permissionId === permissionId);
        if (target) {
          target.usedCount += 1;
          target.updatedAt = cloneDeep(now);
        }
      },
      revokeById: async (permissionId, params) => {
        const target = this.state.partnerPermissions.find((p) => p.permissionId === permissionId);
        if (!target) return null;
        if (target.revokedAt === null) {
          target.revokedAt = cloneDeep(params.now);
          target.revokedByUserId = params.revokedByUserId;
          target.revokeReason = params.revokeReason;
          target.updatedAt = cloneDeep(params.now);
        }
        return cloneDeep(target);
      },
      revokeBetweenUsers: async (userA, userB, params) => {
        let count = 0;
        for (const p of this.state.partnerPermissions) {
          const matchesPair =
            (p.ownerUserId === userA && p.partnerUserId === userB) ||
            (p.ownerUserId === userB && p.partnerUserId === userA);
          if (matchesPair && p.revokedAt === null) {
            p.revokedAt = cloneDeep(params.now);
            p.revokedByUserId = params.revokedByUserId;
            p.revokeReason = params.revokeReason;
            p.updatedAt = cloneDeep(params.now);
            count++;
          }
        }
        return count;
      },
      revokeAllForDevice: async (deviceId, params) => {
        let count = 0;
        for (const p of this.state.partnerPermissions) {
          if (p.targetDeviceId === deviceId && p.revokedAt === null) {
            p.revokedAt = cloneDeep(params.now);
            p.revokedByUserId = params.revokedByUserId;
            p.revokeReason = params.revokeReason;
            p.updatedAt = cloneDeep(params.now);
            count++;
          }
        }
        return count;
      }
    };

    const sessions: SessionsRepository = {
      create: async (session) => {
        if (
          session.idempotencyKey &&
          this.state.sessions.some(
            (s) =>
              s.initiatedByUserId === session.initiatedByUserId &&
              s.idempotencyKey === session.idempotencyKey
          )
        ) {
          throw Errors.conflict(
            'IDEMPOTENCY_CONFLICT',
            'A session request with this idempotency key already exists.'
          );
        }
        const copy = cloneDeep(session);
        this.state.sessions.push(copy);
        return cloneDeep(copy);
      },
      findById: async (sessionId) => {
        const found = this.state.sessions.find((s) => s.sessionId === sessionId);
        return found ? cloneDeep(found) : null;
      },
      findByIdForUpdate: async (sessionId) => {
        const found = this.state.sessions.find((s) => s.sessionId === sessionId);
        return found ? cloneDeep(found) : null;
      },
      findByInitiatorAndIdempotencyKey: async (initiatedByUserId, idempotencyKey) => {
        const found = this.state.sessions.find(
          (s) => s.initiatedByUserId === initiatedByUserId && s.idempotencyKey === idempotencyKey
        );
        return found ? cloneDeep(found) : null;
      },
      findActiveForDeviceForUpdate: async (targetDeviceId) => {
        const found = this.state.sessions
          .filter(
            (s) =>
              s.targetDeviceId === targetDeviceId &&
              NON_TERMINAL_CLOUD_SESSION_STATUSES.includes(s.status)
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        return found ? cloneDeep(found) : null;
      },
      listActiveForUser: async (userId) => {
        return cloneDeep(
          this.state.sessions
            .filter(
              (s) =>
                (s.ownerUserId === userId || s.initiatedByUserId === userId) &&
                NON_TERMINAL_CLOUD_SESSION_STATUSES.includes(s.status)
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        );
      },
      listForUser: async (userId, options) => {
        const filtered = this.state.sessions
          .filter((s) => {
            const roleOk =
              options.role === 'owner'
                ? s.ownerUserId === userId
                : options.role === 'initiator'
                  ? s.initiatedByUserId === userId
                  : s.ownerUserId === userId || s.initiatedByUserId === userId;
            if (!roleOk) return false;
            if (options.status && s.status !== options.status) return false;
            if (options.deviceId && s.targetDeviceId !== options.deviceId) return false;
            return true;
          })
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        return {
          items: cloneDeep(filtered.slice(options.offset, options.offset + options.limit)),
          total: filtered.length,
          limit: options.limit,
          offset: options.offset
        };
      },
      countSessionsByAuthorizationSince: async (authorizationId, since) => {
        return this.state.sessions.filter(
          (s) =>
            s.authorizationId === authorizationId &&
            s.requestedAt.getTime() >= since.getTime() &&
            !['REJECTED', 'EXPIRED', 'CANCELLED'].includes(s.status)
        ).length;
      },
      findLatestSessionByAuthorization: async (authorizationId) => {
        const found = this.state.sessions
          .filter(
            (s) =>
              s.authorizationId === authorizationId &&
              !['REJECTED', 'EXPIRED', 'CANCELLED'].includes(s.status)
          )
          .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0];
        return found ? cloneDeep(found) : null;
      },
      updateStatusAndFields: async (
        sessionId,
        updates: {
          status?: CloudSessionStatus;
          localSessionId?: string | null;
          localEngineState?: AndroidEngineState | null;
          blockingConfiguration?: BlockingConfigurationV1;
          acceptedAt?: Date | null;
          startedAt?: Date | null;
          expectedEndAt?: Date | null;
          completedAt?: Date | null;
          completionReason?: string | null;
          updatedAt: Date;
        }
      ) => {
        const target = this.state.sessions.find((s) => s.sessionId === sessionId);
        if (!target) {
          throw Errors.notFound('SESSION_NOT_FOUND', 'Arrest session was not found.');
        }
        if (updates.status !== undefined) target.status = updates.status;
        if (updates.localSessionId !== undefined) target.localSessionId = updates.localSessionId;
        if (updates.localEngineState !== undefined)
          target.localEngineState = updates.localEngineState;
        if (updates.blockingConfiguration !== undefined)
          target.blockingConfiguration = cloneDeep(updates.blockingConfiguration);
        if (updates.acceptedAt !== undefined) target.acceptedAt = cloneDeep(updates.acceptedAt);
        if (updates.startedAt !== undefined) target.startedAt = cloneDeep(updates.startedAt);
        if (updates.expectedEndAt !== undefined)
          target.expectedEndAt = cloneDeep(updates.expectedEndAt);
        if (updates.completedAt !== undefined) target.completedAt = cloneDeep(updates.completedAt);
        if (updates.completionReason !== undefined)
          target.completionReason = updates.completionReason;
        target.updatedAt = cloneDeep(updates.updatedAt);
        return cloneDeep(target);
      },
      recordSyncEventIfNew: async (event) => {
        const existing = this.state.syncEvents.find(
          (e) => e.sessionId === event.sessionId && e.clientEventId === event.clientEventId
        );
        if (existing) {
          return { inserted: false, record: cloneDeep(existing) };
        }
        const created: SessionSyncEventRecord = {
          ...cloneDeep(event),
          id: this.state.nextSyncEventId++
        };
        this.state.syncEvents.push(created);
        return { inserted: true, record: cloneDeep(created) };
      }
    };

    const commands: CommandsRepository = {
      create: async (command) => {
        if (this.state.commands.some((c) => c.idempotencyKey === command.idempotencyKey)) {
          throw Errors.conflict('IDEMPOTENCY_CONFLICT', 'Duplicate command idempotency key.');
        }
        const created: SessionCommandRecord = {
          ...cloneDeep(command),
          sequenceNo: this.state.nextCommandSeq++
        };
        this.state.commands.push(created);
        return cloneDeep(created);
      },
      findById: async (commandId) => {
        const found = this.state.commands.find((c) => c.commandId === commandId);
        return found ? cloneDeep(found) : null;
      },
      findByIdForUpdate: async (commandId) => {
        const found = this.state.commands.find((c) => c.commandId === commandId);
        return found ? cloneDeep(found) : null;
      },
      findByIdempotencyKey: async (idempotencyKey) => {
        const found = this.state.commands.find((c) => c.idempotencyKey === idempotencyKey);
        return found ? cloneDeep(found) : null;
      },
      findLatestBySessionAndType: async (sessionId, commandType: CommandType) => {
        const found = this.state.commands
          .filter((c) => c.sessionId === sessionId && c.commandType === commandType)
          .sort((a, b) => b.sequenceNo - a.sequenceNo)[0];
        return found ? cloneDeep(found) : null;
      },
      expireOverdueCommands: async (now) => {
        const expiredCommandIds: string[] = [];
        const startArrestSessions = new Set<string>();

        for (const c of this.state.commands) {
          if (
            ['PENDING', 'DELIVERED', 'ACKNOWLEDGED'].includes(c.status) &&
            c.expiresAt.getTime() <= now.getTime()
          ) {
            c.status = 'EXPIRED';
            c.failureReason = 'Command TTL elapsed before device execution';
            c.updatedAt = cloneDeep(now);
            expiredCommandIds.push(c.commandId);
            if (c.commandType === 'START_ARREST') {
              startArrestSessions.add(c.sessionId);
            }
          }
        }

        const expiredSessionIds: string[] = [];
        for (const s of this.state.sessions) {
          if (
            startArrestSessions.has(s.sessionId) &&
            (s.status === 'REQUESTED' || s.status === 'DELIVERED')
          ) {
            s.status = 'EXPIRED';
            s.completedAt = cloneDeep(now);
            s.completionReason = 'START_ARREST command expired prior to device execution';
            s.updatedAt = cloneDeep(now);
            expiredSessionIds.push(s.sessionId);
          }
        }

        return { expiredCommandIds, expiredSessionIds };
      },
      expireOverdueForDevice: async (deviceId, now) => {
        let count = 0;
        const startArrestSessions = new Set<string>();

        for (const c of this.state.commands) {
          if (
            c.targetDeviceId === deviceId &&
            ['PENDING', 'DELIVERED', 'ACKNOWLEDGED'].includes(c.status) &&
            c.expiresAt.getTime() <= now.getTime()
          ) {
            c.status = 'EXPIRED';
            c.failureReason = 'Command TTL elapsed before device execution';
            c.updatedAt = cloneDeep(now);
            count++;
            if (c.commandType === 'START_ARREST') startArrestSessions.add(c.sessionId);
          }
        }

        for (const s of this.state.sessions) {
          if (
            startArrestSessions.has(s.sessionId) &&
            (s.status === 'REQUESTED' || s.status === 'DELIVERED')
          ) {
            s.status = 'EXPIRED';
            s.completedAt = cloneDeep(now);
            s.completionReason = 'START_ARREST command expired prior to device execution';
            s.updatedAt = cloneDeep(now);
          }
        }

        return count;
      },
      expirePendingForDeviceRevocation: async (deviceId, reason, now) => {
        let count = 0;
        for (const c of this.state.commands) {
          if (
            c.targetDeviceId === deviceId &&
            ['PENDING', 'DELIVERED', 'ACKNOWLEDGED'].includes(c.status)
          ) {
            c.status = 'EXPIRED';
            c.failureReason = reason;
            c.updatedAt = cloneDeep(now);
            count++;
          }
        }
        for (const s of this.state.sessions) {
          if (
            s.targetDeviceId === deviceId &&
            (s.status === 'REQUESTED' || s.status === 'DELIVERED')
          ) {
            s.status = 'CANCELLED';
            s.completedAt = cloneDeep(now);
            s.completionReason = reason;
            s.updatedAt = cloneDeep(now);
          }
        }
        return count;
      },
      pollActionableForDevice: async (deviceId, options) => {
        const statusSet = new Set(options.statuses);
        const list = this.state.commands
          .filter(
            (c) =>
              c.targetDeviceId === deviceId &&
              c.sequenceNo > options.afterSequence &&
              statusSet.has(c.status) &&
              c.expiresAt.getTime() > options.now.getTime()
          )
          .sort((a, b) => a.sequenceNo - b.sequenceNo)
          .slice(0, options.limit);
        return cloneDeep(list);
      },
      markDeliveredBatch: async (commandIds, now) => {
        const set = new Set(commandIds);
        const deliveredStartSessions = new Set<string>();
        for (const c of this.state.commands) {
          if (set.has(c.commandId) && c.status === 'PENDING') {
            c.status = 'DELIVERED';
            c.deliveredAt = c.deliveredAt ?? cloneDeep(now);
            c.updatedAt = cloneDeep(now);
            if (c.commandType === 'START_ARREST') {
              deliveredStartSessions.add(c.sessionId);
            }
          }
        }
        for (const s of this.state.sessions) {
          if (deliveredStartSessions.has(s.sessionId) && s.status === 'REQUESTED') {
            s.status = 'DELIVERED';
            s.updatedAt = cloneDeep(now);
          }
        }
      },
      updateCommandStatus: async (
        commandId,
        updates: {
          status: CommandStatus;
          acknowledgedAt?: Date | null;
          executedAt?: Date | null;
          resultMetadata?: Record<string, unknown> | null;
          failureReason?: string | null;
          updatedAt: Date;
        }
      ) => {
        const target = this.state.commands.find((c) => c.commandId === commandId);
        if (!target) {
          throw Errors.notFound('COMMAND_NOT_FOUND', 'Command was not found.');
        }
        target.status = updates.status;
        if (updates.acknowledgedAt !== undefined)
          target.acknowledgedAt = cloneDeep(updates.acknowledgedAt);
        if (updates.executedAt !== undefined) target.executedAt = cloneDeep(updates.executedAt);
        if (updates.resultMetadata !== undefined)
          target.resultMetadata = cloneDeep(updates.resultMetadata);
        if (updates.failureReason !== undefined) target.failureReason = updates.failureReason;
        target.updatedAt = cloneDeep(updates.updatedAt);
        return cloneDeep(target);
      },
      updatePushDelivery: async (
        commandId,
        updates: {
          pushDeliveryStatus: PushDeliveryStatus;
          incrementAttempts: boolean;
          lastPushAttemptAt: Date;
          updatedAt: Date;
        }
      ) => {
        const target = this.state.commands.find((c) => c.commandId === commandId);
        if (target) {
          target.pushDeliveryStatus = updates.pushDeliveryStatus;
          if (updates.incrementAttempts) target.pushAttempts += 1;
          target.lastPushAttemptAt = cloneDeep(updates.lastPushAttemptAt);
          target.updatedAt = cloneDeep(updates.updatedAt);
        }
      },
      listRetryablePushCommands: async (now, limit) => {
        return cloneDeep(
          this.state.commands
            .filter(
              (c) =>
                c.pushDeliveryStatus === 'FAILED_RETRYABLE' &&
                c.status === 'PENDING' &&
                c.expiresAt.getTime() > now.getTime() &&
                c.pushAttempts < 5
            )
            .sort((a, b) => a.sequenceNo - b.sequenceNo)
            .slice(0, limit)
        );
      }
    };

    const releaseRequests: ReleaseRequestsRepository = {
      create: async (request) => {
        const copy = cloneDeep(request);
        this.state.releaseRequests.push(copy);
        return cloneDeep(copy);
      },
      findById: async (id) => {
        const found = this.state.releaseRequests.find((r) => r.id === id);
        return found ? cloneDeep(found) : null;
      },
      findByIdForUpdate: async (id) => {
        const found = this.state.releaseRequests.find((r) => r.id === id);
        return found ? cloneDeep(found) : null;
      },
      findPendingBySessionForUpdate: async (sessionId) => {
        const found = this.state.releaseRequests.find(
          (r) => r.sessionId === sessionId && r.status === 'PENDING'
        );
        return found ? cloneDeep(found) : null;
      },
      listForUser: async (userId, options) => {
        const filtered = this.state.releaseRequests
          .filter((r) => {
            const roleOk =
              options.role === 'incoming'
                ? r.approverUserId === userId
                : options.role === 'outgoing'
                  ? r.requesterUserId === userId
                  : r.approverUserId === userId || r.requesterUserId === userId;
            if (!roleOk) return false;
            if (options.status && r.status !== options.status) return false;
            return true;
          })
          .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());

        return {
          items: cloneDeep(filtered.slice(options.offset, options.offset + options.limit)),
          total: filtered.length,
          limit: options.limit,
          offset: options.offset
        };
      },
      updateDecision: async (
        id,
        updates: {
          status: ReleaseRequestStatus;
          decisionReason?: string | null;
          resolutionCommandId?: string | null;
          decidedAt: Date;
          updatedAt: Date;
        }
      ) => {
        const target = this.state.releaseRequests.find((r) => r.id === id);
        if (!target) {
          throw Errors.notFound('RELEASE_REQUEST_NOT_FOUND', 'Release request was not found.');
        }
        target.status = updates.status;
        target.decisionReason = updates.decisionReason ?? null;
        target.resolutionCommandId = updates.resolutionCommandId ?? null;
        target.decidedAt = cloneDeep(updates.decidedAt);
        target.updatedAt = cloneDeep(updates.updatedAt);
        return cloneDeep(target);
      },
      expirePendingForSession: async (sessionId, now) => {
        let count = 0;
        for (const r of this.state.releaseRequests) {
          if (r.sessionId === sessionId && r.status === 'PENDING') {
            r.status = 'EXPIRED';
            r.decisionReason = 'Session ended before release request was resolved';
            r.decidedAt = cloneDeep(now);
            r.updatedAt = cloneDeep(now);
            count++;
          }
        }
        return count;
      },
      expirePendingForEndedSessions: async (now) => {
        let count = 0;
        for (const r of this.state.releaseRequests) {
          if (r.status !== 'PENDING') continue;
          const s = this.state.sessions.find((sess) => sess.sessionId === r.sessionId);
          if (
            !s ||
            TERMINAL_CLOUD_SESSION_STATUSES.includes(s.status) ||
            (s.expectedEndAt !== null && s.expectedEndAt.getTime() <= now.getTime())
          ) {
            r.status = 'EXPIRED';
            r.decisionReason = 'Linked session ended or expired before decision';
            r.decidedAt = cloneDeep(now);
            r.updatedAt = cloneDeep(now);
            count++;
          }
        }
        return count;
      }
    };

    const auditLogs: AuditLogsRepository = {
      append: async (entry: {
        actorUserId?: string | null;
        actorDeviceId?: string | null;
        action: string;
        resourceType: string;
        resourceId: string;
        result: AuditResult;
        ipAddress?: string | null;
        requestId?: string | null;
        metadata?: Record<string, unknown> | null;
        createdAt: Date;
      }) => {
        const record: AuditLogRecord = {
          id: this.state.nextAuditId++,
          actorUserId: entry.actorUserId ?? null,
          actorDeviceId: entry.actorDeviceId ?? null,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          result: entry.result,
          ipAddress: entry.ipAddress ?? null,
          requestId: entry.requestId ?? null,
          metadata: cloneDeep(entry.metadata ?? null),
          createdAt: cloneDeep(entry.createdAt)
        };
        this.state.auditLogs.push(record);
        return cloneDeep(record);
      },
      listByActor: async (actorUserId, limit) => {
        return cloneDeep(
          this.state.auditLogs
            .filter((a) => a.actorUserId === actorUserId)
            .sort((a, b) => b.id - a.id)
            .slice(0, limit)
        );
      }
    };

    return {
      users,
      refreshTokens,
      devices,
      pushTokens,
      partnerships,
      partnerPermissions,
      sessions,
      commands,
      releaseRequests,
      auditLogs
    };
  }
}
