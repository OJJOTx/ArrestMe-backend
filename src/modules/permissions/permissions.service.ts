import { randomUUID } from 'node:crypto';
import type { AuditService, RequestContextMeta } from '../../services/audit.service';
import { Errors } from '../../shared/errors';
import {
  isWithinAllowedTimeWindows,
  type AllowedTimeWindowsConfig,
  type Clock
} from '../../shared/time';
import type {
  BlockingConfigLimitsV1,
  BlockingConfigurationV1,
  DeviceRecord,
  ExactApprovedSessionConfig,
  PaginatedResult,
  PartnerPermissionRecord,
  PublicUserProfile,
  SessionType,
  UserRecord
} from '../../types/domain';
import type { DataStore, RepositoryBundle } from '../../types/repositories';
import { serializePublicUser } from '../users/users.service';

export interface SerializedPartnerPermission {
  permissionId: string;
  owner: PublicUserProfile;
  partner: PublicUserProfile;
  targetDevice: {
    id: string;
    deviceName: string;
    platform: 'ANDROID';
    deviceStatus: 'ACTIVE' | 'INACTIVE' | 'REVOKED';
  };
  proposalId: string | null;
  approvedRevision: number | null;
  exactBlockingConfiguration: ExactApprovedSessionConfig | null;
  maximumSessionDuration: number;
  allowedTimeWindows: AllowedTimeWindowsConfig | null;
  allowedSessionTypes: SessionType[];
  blockingConfigLimits: BlockingConfigLimitsV1;
  oneTimeOnly: boolean;
  usedCount: number;
  version: number;
  isCurrentlyActive: boolean;
  validFrom: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revokeReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_BLOCKING_LIMITS: BlockingConfigLimitsV1 = {
  schemaVersion: 1,
  allowedRuleModes: ['BLOCK_SELECTED', 'STRICT_ALLOWLIST'],
  allowDisableEmergencyExit: false,
  allowOverlayStatusBar: false,
  requiredAllowedCategories: ['CALLS'],
  allowCustomPackageLists: false
};

export class PermissionsService {
  constructor(
    private readonly store: DataStore,
    private readonly auditService: AuditService,
    private readonly clock: Clock,
    private readonly maxSystemDurationMinutes: number
  ) {}

  async createPermission(
    actorUserId: string,
    input: {
      ownerUserId?: string;
      partnerUserId: string;
      targetDeviceId: string;
      maximumSessionDuration: number;
      allowedTimeWindows?: AllowedTimeWindowsConfig | null;
      allowedSessionTypes?: ('PARTNER_ARREST' | 'MUTUAL_ARREST')[];
      blockingConfigLimits?: BlockingConfigLimitsV1;
      oneTimeOnly?: boolean;
      validFrom?: string;
      expiresAt: string;
    },
    context?: RequestContextMeta
  ): Promise<SerializedPartnerPermission> {
    if (input.ownerUserId && input.ownerUserId !== actorUserId) {
      await this.auditService.record(this.store.repositories.auditLogs, {
        actorUserId,
        action: 'PERMISSION_GRANT_DENIED_NOT_OWNER',
        resourceType: 'PARTNER_PERMISSION',
        resourceId: input.targetDeviceId,
        result: 'DENIED',
        context,
        metadata: { attemptedOwnerId: input.ownerUserId }
      });
      throw Errors.forbidden(
        'FORBIDDEN',
        'Only the device owner may grant delegated Arrest permissions.'
      );
    }

    if (input.partnerUserId === actorUserId) {
      throw Errors.badRequest(
        'SELF_ACTION_NOT_ALLOWED',
        'Delegated permissions must be granted to a distinct partner account.'
      );
    }

    if (input.maximumSessionDuration > this.maxSystemDurationMinutes) {
      throw Errors.badRequest(
        'PERMISSION_LIMIT_EXCEEDED',
        `maximumSessionDuration cannot exceed ${this.maxSystemDurationMinutes} minutes.`
      );
    }

    const now = this.clock.now();
    const validFrom = input.validFrom ? new Date(input.validFrom) : now;
    const expiresAt = new Date(input.expiresAt);

    if (expiresAt.getTime() <= validFrom.getTime() || expiresAt.getTime() <= now.getTime()) {
      throw Errors.badRequest(
        'BAD_REQUEST',
        'expiresAt must be in the future and strictly after validFrom.'
      );
    }

    const created = await this.store.withTransaction(async (repos) => {
      const targetDevice = await repos.devices.findByIdForUpdate(input.targetDeviceId);
      if (!targetDevice || targetDevice.userId !== actorUserId) {
        await this.auditService.record(repos.auditLogs, {
          actorUserId,
          action: 'PERMISSION_GRANT_DENIED_DEVICE_OWNERSHIP',
          resourceType: 'DEVICE',
          resourceId: input.targetDeviceId,
          result: 'DENIED',
          context
        });
        throw Errors.forbidden(
          'PERMISSION_SCOPE_MISMATCH',
          'Target device does not belong to the authenticated owner.'
        );
      }

      if (targetDevice.deviceStatus !== 'ACTIVE') {
        throw Errors.conflict(
          'DEVICE_REVOKED',
          'Delegated permissions can only target an ACTIVE device.'
        );
      }

      const partnership = await repos.partnerships.findByPairForUpdate(
        actorUserId,
        input.partnerUserId
      );
      if (!partnership || partnership.state !== 'ACCEPTED') {
        throw Errors.forbidden(
          'PARTNERSHIP_REQUIRED',
          'An accepted partnership is required before granting delegated Arrest permissions.'
        );
      }

      const limits: BlockingConfigLimitsV1 = {
        ...DEFAULT_BLOCKING_LIMITS,
        ...(input.blockingConfigLimits ?? {}),
        allowedRuleModes: Array.from(
          new Set(
            input.blockingConfigLimits?.allowedRuleModes ??
              DEFAULT_BLOCKING_LIMITS.allowedRuleModes
          )
        ),
        requiredAllowedCategories: Array.from(
          new Set(
            input.blockingConfigLimits?.requiredAllowedCategories ??
              DEFAULT_BLOCKING_LIMITS.requiredAllowedCategories
          )
        )
      };

      const record = await repos.partnerPermissions.create({
        permissionId: randomUUID(),
        ownerUserId: actorUserId,
        partnerUserId: input.partnerUserId,
        targetDeviceId: input.targetDeviceId,
        maximumSessionDuration: input.maximumSessionDuration,
        allowedTimeWindows: input.allowedTimeWindows ?? null,
        allowedSessionTypes: Array.from(
          new Set(input.allowedSessionTypes ?? ['PARTNER_ARREST'])
        ),
        blockingConfigLimits: limits,
        oneTimeOnly: input.oneTimeOnly ?? false,
        usedCount: 0,
        version: 1,
        validFrom,
        expiresAt,
        revokedAt: null,
        revokedByUserId: null,
        revokeReason: null,
        createdAt: now,
        updatedAt: now
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId,
        actorDeviceId: targetDevice.id,
        action: 'PARTNER_PERMISSION_GRANTED',
        resourceType: 'PARTNER_PERMISSION',
        resourceId: record.permissionId,
        result: 'SUCCESS',
        context,
        metadata: {
          partnerUserId: record.partnerUserId,
          targetDeviceId: record.targetDeviceId,
          maximumSessionDuration: record.maximumSessionDuration,
          oneTimeOnly: record.oneTimeOnly,
          expiresAt: record.expiresAt.toISOString()
        }
      });

      return record;
    });

    return this.hydrateSingle(created);
  }

  async listPermissions(
    userId: string,
    options: {
      role: 'granted' | 'received' | 'all';
      activeOnly: boolean;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<SerializedPartnerPermission>> {
    const now = this.clock.now();
    const page = await this.store.repositories.partnerPermissions.listForUser(userId, {
      ...options,
      now
    });

    const userIds = page.items.flatMap((p) => [p.ownerUserId, p.partnerUserId]);
    const deviceIds = page.items.map((p) => p.targetDeviceId);
    const [users, devices] = await Promise.all([
      this.store.repositories.users.findByIds(userIds),
      this.store.repositories.devices.findByIds(deviceIds)
    ]);

    return {
      ...page,
      items: page.items.map((item) => this.formatPermission(item, users, devices, now))
    };
  }

  async getPermissionById(
    userId: string,
    permissionId: string
  ): Promise<SerializedPartnerPermission> {
    const record = await this.store.repositories.partnerPermissions.findById(permissionId);
    if (!record || (record.ownerUserId !== userId && record.partnerUserId !== userId)) {
      throw Errors.notFound('PERMISSION_NOT_FOUND', 'Partner permission was not found.');
    }
    return this.hydrateSingle(record);
  }

  async updatePermission(
    actorUserId: string,
    permissionId: string,
    updates: {
      maximumSessionDuration?: number;
      allowedTimeWindows?: AllowedTimeWindowsConfig | null;
      allowedSessionTypes?: ('PARTNER_ARREST' | 'MUTUAL_ARREST')[];
      blockingConfigLimits?: BlockingConfigLimitsV1;
      oneTimeOnly?: boolean;
      validFrom?: string;
      expiresAt?: string;
    },
    context?: RequestContextMeta
  ): Promise<SerializedPartnerPermission> {
    if (
      updates.maximumSessionDuration !== undefined &&
      updates.maximumSessionDuration > this.maxSystemDurationMinutes
    ) {
      throw Errors.badRequest(
        'PERMISSION_LIMIT_EXCEEDED',
        `maximumSessionDuration cannot exceed ${this.maxSystemDurationMinutes} minutes.`
      );
    }

    // Use an explicit outcome discriminated union when recording a security-denial audit log
    // inside the transaction so the audit entry commits cleanly before returning 403!
    const outcome = await this.store.withTransaction(
      async (
        repos
      ): Promise<
        | { ok: true; record: PartnerPermissionRecord }
        | { ok: false; code: 'NOT_FOUND' | 'FORBIDDEN_NOT_OWNER' | 'REVOKED' | 'BAD_DATES' }
      > => {
        const existing = await repos.partnerPermissions.findByIdForUpdate(permissionId);
        if (!existing) {
          return { ok: false, code: 'NOT_FOUND' };
        }

        if (existing.ownerUserId !== actorUserId) {
          // If the partner tries to edit/expand their own permission, record a DENIED security audit!
          if (existing.partnerUserId === actorUserId) {
            await this.auditService.record(repos.auditLogs, {
              actorUserId,
              action: 'PARTNER_PERMISSION_ESCALATION_BLOCKED',
              resourceType: 'PARTNER_PERMISSION',
              resourceId: permissionId,
              result: 'DENIED',
              context
            });
            return { ok: false, code: 'FORBIDDEN_NOT_OWNER' };
          }
          return { ok: false, code: 'NOT_FOUND' };
        }

        if (existing.revokedAt !== null) {
          return { ok: false, code: 'REVOKED' };
        }

        const now = this.clock.now();
        const nextValidFrom = updates.validFrom ? new Date(updates.validFrom) : existing.validFrom;
        const nextExpiresAt = updates.expiresAt ? new Date(updates.expiresAt) : existing.expiresAt;

        if (
          nextExpiresAt.getTime() <= nextValidFrom.getTime() ||
          nextExpiresAt.getTime() <= now.getTime()
        ) {
          return { ok: false, code: 'BAD_DATES' };
        }

        const nextVersion = existing.version + 1;
        const updated = await repos.partnerPermissions.update(permissionId, {
          maximumSessionDuration: updates.maximumSessionDuration,
          allowedTimeWindows: updates.allowedTimeWindows,
          allowedSessionTypes: updates.allowedSessionTypes
            ? Array.from(new Set(updates.allowedSessionTypes))
            : undefined,
          blockingConfigLimits: updates.blockingConfigLimits,
          oneTimeOnly: updates.oneTimeOnly,
          validFrom: updates.validFrom ? nextValidFrom : undefined,
          expiresAt: updates.expiresAt ? nextExpiresAt : undefined,
          version: nextVersion,
          updatedAt: now
        });

        await this.auditService.record(repos.auditLogs, {
          actorUserId,
          actorDeviceId: existing.targetDeviceId,
          action: 'PARTNER_PERMISSION_UPDATED_BY_OWNER',
          resourceType: 'PARTNER_PERMISSION',
          resourceId: permissionId,
          result: 'SUCCESS',
          context,
          metadata: {
            previousVersion: existing.version,
            newVersion: nextVersion,
            maximumSessionDuration: updated.maximumSessionDuration,
            expiresAt: updated.expiresAt.toISOString()
          }
        });

        return { ok: true, record: updated };
      }
    );

    if (!outcome.ok) {
      switch (outcome.code) {
        case 'FORBIDDEN_NOT_OWNER':
          throw Errors.forbidden(
            'FORBIDDEN',
            'Only the device owner can modify or expand delegated permissions.'
          );
        case 'REVOKED':
          throw Errors.conflict(
            'PERMISSION_REVOKED',
            'Revoked permissions cannot be modified. Create a new authorization instead.'
          );
        case 'BAD_DATES':
          throw Errors.badRequest(
            'BAD_REQUEST',
            'expiresAt must be in the future and strictly after validFrom.'
          );
        default:
          throw Errors.notFound('PERMISSION_NOT_FOUND', 'Partner permission was not found.');
      }
    }

    return this.hydrateSingle(outcome.record);
  }

  async revokePermission(
    actorUserId: string,
    permissionId: string,
    context?: RequestContextMeta
  ): Promise<SerializedPartnerPermission> {
    const updated = await this.store.withTransaction(async (repos) => {
      const existing = await repos.partnerPermissions.findByIdForUpdate(permissionId);
      if (
        !existing ||
        (existing.ownerUserId !== actorUserId && existing.partnerUserId !== actorUserId)
      ) {
        throw Errors.notFound('PERMISSION_NOT_FOUND', 'Partner permission was not found.');
      }

      if (existing.revokedAt !== null) {
        return existing;
      }

      const now = this.clock.now();
      const reason =
        existing.ownerUserId === actorUserId
          ? 'Revoked explicitly by device owner'
          : 'Surrendered voluntarily by authorized partner';

      const revoked = await repos.partnerPermissions.revokeById(permissionId, {
        revokedByUserId: actorUserId,
        revokeReason: reason,
        now
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId,
        actorDeviceId: existing.targetDeviceId,
        action: 'PARTNER_PERMISSION_REVOKED',
        resourceType: 'PARTNER_PERMISSION',
        resourceId: permissionId,
        result: 'SUCCESS',
        context,
        metadata: { reason }
      });

      return revoked!;
    });

    return this.hydrateSingle(updated);
  }

  /**
   * Authoritative transactional check used when a partner initiates a remote session.
   * Locks the permission row (`FOR UPDATE`), verifies partnership, device scope, time
   * bounds, session limits, blocking rule limits, daily caps, cooldowns, and one-time usage.
   */
  async validateAndConsumeForSessionInTx(
    repos: RepositoryBundle,
    params: {
      authorizationId: string;
      initiatorUserId: string;
      ownerUserId: string;
      targetDeviceId: string;
      sessionType: SessionType;
      requestedDurationMinutes: number;
      blockingConfiguration: BlockingConfigurationV1;
      now: Date;
      context?: RequestContextMeta;
    }
  ): Promise<PartnerPermissionRecord> {
    const partnership = await repos.partnerships.findByPairForUpdate(
      params.ownerUserId,
      params.initiatorUserId
    );
    if (!partnership || partnership.state !== 'ACCEPTED') {
      throw Errors.forbidden(
        'PARTNERSHIP_REQUIRED',
        'Active accepted partnership is required to initiate a Partner Arrest session.'
      );
    }

    const permission = await repos.partnerPermissions.findByIdForUpdate(params.authorizationId);
    if (!permission) {
      throw Errors.forbidden('PERMISSION_NOT_FOUND', 'Specified partner permission does not exist.');
    }

    if (
      permission.partnerUserId !== params.initiatorUserId ||
      permission.ownerUserId !== params.ownerUserId
    ) {
      throw Errors.forbidden(
        'PERMISSION_SCOPE_MISMATCH',
        'Partner permission does not authorize this initiator and owner pair.'
      );
    }

    if (permission.targetDeviceId !== params.targetDeviceId) {
      throw Errors.forbidden(
        'PERMISSION_SCOPE_MISMATCH',
        'Partner permission is scoped to a different target device.'
      );
    }

    if (permission.revokedAt !== null) {
      throw Errors.forbidden('PERMISSION_REVOKED', 'Partner authorization has been revoked.');
    }

    if (params.now.getTime() < permission.validFrom.getTime()) {
      throw Errors.forbidden(
        'PERMISSION_NOT_YET_VALID',
        'Partner authorization is not yet active.'
      );
    }

    if (params.now.getTime() >= permission.expiresAt.getTime()) {
      throw Errors.forbidden('PERMISSION_EXPIRED', 'Partner authorization has expired.');
    }

    if (permission.oneTimeOnly && permission.usedCount >= 1) {
      throw Errors.forbidden(
        'PERMISSION_EXHAUSTED',
        'This one-time partner authorization has already been used.'
      );
    }

    const approvalPolicy = await repos.approvalPolicies.findByOwnerAndPartnerForUpdate(
      params.ownerUserId,
      params.initiatorUserId
    );
    if (
      approvalPolicy &&
      approvalPolicy.explicitlyConfigured &&
      approvalPolicy.requireApprovalBeforeArrest &&
      !permission.oneTimeOnly &&
      !permission.exactBlockingConfiguration
    ) {
      throw Errors.forbidden(
        'APPROVAL_REQUIRED',
        'Device owner requires explicit per-session request approval before initiating an Arrest session.'
      );
    }

    if (permission.exactBlockingConfiguration) {
      const exact = permission.exactBlockingConfiguration;
      const cfg = params.blockingConfiguration;
      const exactCfg = exact.blockingConfiguration;
      const sameSet = (a: readonly string[] = [], b: readonly string[] = []) => {
        if (a.length !== b.length) return false;
        const setB = new Set(b);
        return a.every((item) => setB.has(item));
      };

      const matchesExact =
        params.sessionType === exact.sessionType &&
        params.requestedDurationMinutes === exact.durationMinutes &&
        cfg.ruleMode === exactCfg.ruleMode &&
        cfg.overlayStatusBar === exactCfg.overlayStatusBar &&
        cfg.disableEmergencyExit === exactCfg.disableEmergencyExit &&
        sameSet(cfg.allowedCategories, exactCfg.allowedCategories) &&
        sameSet(cfg.blockedPackages ?? [], exactCfg.blockedPackages ?? []) &&
        sameSet(cfg.allowedStudyPackages ?? [], exactCfg.allowedStudyPackages ?? []);

      if (!matchesExact) {
        throw Errors.forbidden(
          'PERMISSION_LIMIT_EXCEEDED',
          'Session parameters do not match the exact configuration approved by the device owner.'
        );
      }
    }

    if (!permission.allowedSessionTypes.includes(params.sessionType)) {
      throw Errors.forbidden(
        'PERMISSION_LIMIT_EXCEEDED',
        `Session type ${params.sessionType} is not permitted by this authorization.`
      );
    }

    if (params.requestedDurationMinutes > permission.maximumSessionDuration) {
      throw Errors.forbidden(
        'PERMISSION_LIMIT_EXCEEDED',
        `Requested duration (${params.requestedDurationMinutes}m) exceeds authorized maximum (${permission.maximumSessionDuration}m).`
      );
    }

    if (!isWithinAllowedTimeWindows(params.now, permission.allowedTimeWindows)) {
      throw Errors.forbidden(
        'PERMISSION_TIME_WINDOW_RESTRICTED',
        'Current time falls outside the owner-authorized schedule windows.'
      );
    }

    const limits = permission.blockingConfigLimits;
    const cfg = params.blockingConfiguration;

    if (!limits.allowedRuleModes.includes(cfg.ruleMode)) {
      throw Errors.forbidden(
        'PERMISSION_LIMIT_EXCEEDED',
        `Blocking rule mode ${cfg.ruleMode} is not authorized by the device owner.`
      );
    }

    if (cfg.disableEmergencyExit && !limits.allowDisableEmergencyExit) {
      throw Errors.forbidden(
        'PERMISSION_LIMIT_EXCEEDED',
        'Disabling Emergency Exit is not permitted under this authorization.'
      );
    }

    if (cfg.overlayStatusBar && !limits.allowOverlayStatusBar) {
      throw Errors.forbidden(
        'PERMISSION_LIMIT_EXCEEDED',
        'Status-bar overlay expansion is not permitted under this authorization.'
      );
    }

    for (const requiredCategory of limits.requiredAllowedCategories) {
      if (!cfg.allowedCategories.includes(requiredCategory)) {
        throw Errors.forbidden(
          'PERMISSION_LIMIT_EXCEEDED',
          `Owner authorization requires allowed category ${requiredCategory} to remain enabled.`
        );
      }
    }

    const hasCustomPackages =
      (cfg.blockedPackages !== undefined && cfg.blockedPackages.length > 0) ||
      (cfg.allowedStudyPackages !== undefined && cfg.allowedStudyPackages.length > 0);
    if (hasCustomPackages && !limits.allowCustomPackageLists) {
      throw Errors.forbidden(
        'PERMISSION_LIMIT_EXCEEDED',
        'Custom package lists are not permitted; session must use device owner local app rules.'
      );
    }

    if (limits.dailyMaxSessions !== undefined) {
      const windowStart = new Date(params.now.getTime() - 24 * 60 * 60 * 1000);
      const recentCount = await repos.sessions.countSessionsByAuthorizationSince(
        permission.permissionId,
        windowStart
      );
      if (recentCount >= limits.dailyMaxSessions) {
        throw Errors.forbidden(
          'PERMISSION_LIMIT_EXCEEDED',
          `Daily maximum of ${limits.dailyMaxSessions} session(s) for this authorization has been reached.`
        );
      }
    }

    if (limits.cooldownMinutes !== undefined) {
      const latest = await repos.sessions.findLatestSessionByAuthorization(permission.permissionId);
      if (latest) {
        const cooldownMs = limits.cooldownMinutes * 60 * 1000;
        if (params.now.getTime() - latest.requestedAt.getTime() < cooldownMs) {
          throw Errors.forbidden(
            'PERMISSION_LIMIT_EXCEEDED',
            `Minimum cooldown of ${limits.cooldownMinutes} minutes between sessions has not elapsed.`
          );
        }
      }
    }

    await repos.partnerPermissions.incrementUsedCount(permission.permissionId, params.now);
    return {
      ...permission,
      usedCount: permission.usedCount + 1,
      updatedAt: params.now
    };
  }

  private async hydrateSingle(
    record: PartnerPermissionRecord
  ): Promise<SerializedPartnerPermission> {
    const [users, devices] = await Promise.all([
      this.store.repositories.users.findByIds([record.ownerUserId, record.partnerUserId]),
      this.store.repositories.devices.findByIds([record.targetDeviceId])
    ]);
    return this.formatPermission(record, users, devices, this.clock.now());
  }

  public formatPermission(
    record: PartnerPermissionRecord,
    users: Map<string, UserRecord>,
    devices: Map<string, DeviceRecord>,
    now: Date
  ): SerializedPartnerPermission {
    const ownerRec = users.get(record.ownerUserId);
    const partnerRec = users.get(record.partnerUserId);
    const deviceRec = devices.get(record.targetDeviceId);

    const isCurrentlyActive =
      record.revokedAt === null &&
      now.getTime() >= record.validFrom.getTime() &&
      now.getTime() < record.expiresAt.getTime() &&
      (!record.oneTimeOnly || record.usedCount < 1) &&
      deviceRec?.deviceStatus === 'ACTIVE';

    return {
      permissionId: record.permissionId,
      owner: ownerRec
        ? serializePublicUser(ownerRec)
        : { id: record.ownerUserId, username: 'unknown', displayName: 'Unknown', avatarUrl: null },
      partner: partnerRec
        ? serializePublicUser(partnerRec)
        : {
            id: record.partnerUserId,
            username: 'unknown',
            displayName: 'Unknown',
            avatarUrl: null
          },
      targetDevice: deviceRec
        ? {
            id: deviceRec.id,
            deviceName: deviceRec.deviceName,
            platform: deviceRec.platform,
            deviceStatus: deviceRec.deviceStatus
          }
        : {
            id: record.targetDeviceId,
            deviceName: 'Removed Device',
            platform: 'ANDROID',
            deviceStatus: 'REVOKED'
          },
      proposalId: record.proposalId ?? null,
      approvedRevision: record.approvedRevision ?? null,
      exactBlockingConfiguration: record.exactBlockingConfiguration ?? null,
      maximumSessionDuration: record.maximumSessionDuration,
      allowedTimeWindows: record.allowedTimeWindows,
      allowedSessionTypes: record.allowedSessionTypes,
      blockingConfigLimits: record.blockingConfigLimits,
      oneTimeOnly: record.oneTimeOnly,
      usedCount: record.usedCount,
      version: record.version,
      isCurrentlyActive,
      validFrom: record.validFrom.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
      revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
      revokedByUserId: record.revokedByUserId,
      revokeReason: record.revokeReason,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString()
    };
  }
}
