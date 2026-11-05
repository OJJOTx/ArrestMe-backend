import { randomUUID } from 'node:crypto';
import type { NotificationService } from '../notifications/notification.service';
import type { PermissionsService } from '../permissions/permissions.service';
import { serializeCommand, type SerializedSessionCommand } from '../commands/commands.service';
import type { AuditService, RequestContextMeta } from '../../services/audit.service';
import { Errors } from '../../shared/errors';
import type { Clock } from '../../shared/time';
import {
  TERMINAL_CLOUD_SESSION_STATUSES,
  type AndroidEngineState,
  type ArrestSessionRecord,
  type BlockingConfigurationV1,
  type CloudSessionStatus,
  type PaginatedResult,
  type PartnerPermissionRecord,
  type RemoteExecutionPhase,
  type SessionCommandRecord,
  type SessionType
} from '../../types/domain';
import type { DataStore } from '../../types/repositories';

export interface SerializedArrestSession {
  sessionId: string;
  localSessionId: string | null;
  ownerUserId: string;
  targetDeviceId: string;
  initiatedByUserId: string;
  authorizationId: string | null;
  sessionType: SessionType;
  goal: string;
  blockingConfiguration: BlockingConfigurationV1;
  requestedDurationMinutes: number;
  status: CloudSessionStatus;
  remoteExecutionPhase: RemoteExecutionPhase;
  localEngineState: AndroidEngineState | null;
  requestedAt: string;
  acceptedAt: string | null;
  startedAt: string | null;
  expectedEndAt: string | null;
  completedAt: string | null;
  completionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedLiveDashboardItem {
  session: SerializedArrestSession;
  owner: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  };
  initiator: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  };
  targetDevice: {
    deviceId: string;
    deviceName: string;
    deviceModel: string | null;
    platform: string;
    deviceStatus: string;
    lastSeenAt: string | null;
  } | null;
  remainingSeconds: number | null;
  pendingReleaseRequestsCount: number;
}

export function computeRemoteExecutionPhase(session: ArrestSessionRecord): RemoteExecutionPhase {
  switch (session.status) {
    case 'REQUESTED':
      return 'QUEUED';
    case 'DELIVERED':
      return session.localEngineState === 'PREPARING' ? 'EXECUTING' : 'DELIVERED';
    case 'ACTIVE':
    case 'PAUSED':
    case 'INTERRUPTED':
      return 'ACTIVE';
    case 'COMPLETED':
    case 'RELEASED_EARLY':
    case 'EMERGENCY_STOPPED':
      return 'COMPLETED';
    case 'REJECTED':
    case 'CANCELLED':
      return 'FAILED';
    case 'EXPIRED':
      return 'EXPIRED';
  }
}

export function serializeSession(session: ArrestSessionRecord): SerializedArrestSession {
  return {
    sessionId: session.sessionId,
    localSessionId: session.localSessionId,
    ownerUserId: session.ownerUserId,
    targetDeviceId: session.targetDeviceId,
    initiatedByUserId: session.initiatedByUserId,
    authorizationId: session.authorizationId,
    sessionType: session.sessionType,
    goal: session.goal,
    blockingConfiguration: session.blockingConfiguration,
    requestedDurationMinutes: session.requestedDuration,
    status: session.status,
    remoteExecutionPhase: computeRemoteExecutionPhase(session),
    localEngineState: session.localEngineState,
    requestedAt: session.requestedAt.toISOString(),
    acceptedAt: session.acceptedAt ? session.acceptedAt.toISOString() : null,
    startedAt: session.startedAt ? session.startedAt.toISOString() : null,
    expectedEndAt: session.expectedEndAt ? session.expectedEndAt.toISOString() : null,
    completedAt: session.completedAt ? session.completedAt.toISOString() : null,
    completionReason: session.completionReason,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString()
  };
}

export class SessionsService {
  constructor(
    private readonly store: DataStore,
    private readonly permissionsService: PermissionsService,
    private readonly notificationService: NotificationService,
    private readonly auditService: AuditService,
    private readonly clock: Clock,
    private readonly defaultCommandTtlSeconds: number,
    private readonly maxSessionDurationMinutes: number
  ) {}

  async createSession(
    initiatorUserId: string,
    input: {
      sessionType: SessionType;
      targetDeviceId: string;
      authorizationId?: string;
      requestedDurationMinutes: number;
      goal: string;
      blockingConfiguration: BlockingConfigurationV1;
      commandTtlSeconds?: number;
      idempotencyKey?: string;
    },
    context?: RequestContextMeta
  ): Promise<{
    session: SerializedArrestSession;
    command: SerializedSessionCommand | null;
    idempotentReplay: boolean;
  }> {
    if (input.requestedDurationMinutes > this.maxSessionDurationMinutes) {
      throw Errors.badRequest(
        'PERMISSION_LIMIT_EXCEEDED',
        `requestedDurationMinutes cannot exceed ${this.maxSessionDurationMinutes}.`
      );
    }

    const normalizedBlockingConfig: BlockingConfigurationV1 = {
      schemaVersion: 1,
      ruleMode: input.blockingConfiguration.ruleMode,
      allowedCategories: Array.from(new Set(input.blockingConfiguration.allowedCategories)),
      overlayStatusBar: input.blockingConfiguration.overlayStatusBar,
      disableEmergencyExit: input.blockingConfiguration.disableEmergencyExit,
      ...(input.blockingConfiguration.blockedPackages
        ? {
            blockedPackages: Array.from(new Set(input.blockingConfiguration.blockedPackages))
          }
        : {}),
      ...(input.blockingConfiguration.allowedStudyPackages
        ? {
            allowedStudyPackages: Array.from(
              new Set(input.blockingConfiguration.allowedStudyPackages)
            )
          }
        : {})
    };

    if (input.idempotencyKey) {
      const existing = await this.store.repositories.sessions.findByInitiatorAndIdempotencyKey(
        initiatorUserId,
        input.idempotencyKey
      );
      if (existing) {
        if (
          existing.targetDeviceId !== input.targetDeviceId ||
          existing.requestedDuration !== input.requestedDurationMinutes ||
          existing.sessionType !== input.sessionType
        ) {
          throw Errors.conflict(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key was already used with different session parameters.'
          );
        }
        const existingCmd = await this.store.repositories.commands.findLatestBySessionAndType(
          existing.sessionId,
          'START_ARREST'
        );
        return {
          session: serializeSession(existing),
          command: existingCmd ? serializeCommand(existingCmd) : null,
          idempotentReplay: true
        };
      }
    }

    const txResult = await this.store.withTransaction(
      async (
        repos
      ): Promise<{
        session: ArrestSessionRecord;
        command: SessionCommandRecord;
        idempotentReplay: boolean;
      }> => {
        if (input.idempotencyKey) {
          const raceExisting = await repos.sessions.findByInitiatorAndIdempotencyKey(
            initiatorUserId,
            input.idempotencyKey
          );
          if (raceExisting) {
            if (
              raceExisting.targetDeviceId !== input.targetDeviceId ||
              raceExisting.requestedDuration !== input.requestedDurationMinutes ||
              raceExisting.sessionType !== input.sessionType
            ) {
              throw Errors.conflict(
                'IDEMPOTENCY_CONFLICT',
                'Idempotency key was already used with different session parameters.'
              );
            }
            const cmd = await repos.commands.findLatestBySessionAndType(
              raceExisting.sessionId,
              'START_ARREST'
            );
            return {
              session: raceExisting,
              command: cmd!,
              idempotentReplay: true
            };
          }
        }

        // Lock target device row first to serialize all concurrent session requests for this device
        const targetDevice = await repos.devices.findByIdForUpdate(input.targetDeviceId);
        if (!targetDevice) {
          throw Errors.notFound('DEVICE_NOT_FOUND', 'Target device was not found.');
        }
        if (targetDevice.deviceStatus === 'REVOKED') {
          throw Errors.conflict('DEVICE_REVOKED', 'Target device has been revoked.');
        }
        if (targetDevice.deviceStatus !== 'ACTIVE') {
          throw Errors.conflict('DEVICE_REVOKED', 'Target device is not currently active.');
        }

        const now = this.clock.now();
        const ownerUserId = targetDevice.userId;

        let commandHardDeadlineMs =
          now.getTime() + (input.commandTtlSeconds ?? this.defaultCommandTtlSeconds) * 1000;
        let verifiedAuthId: string | null = null;
        let consumedPermission: PartnerPermissionRecord | null = null;

        if (input.sessionType === 'SELF_ARREST') {
          if (ownerUserId !== initiatorUserId) {
            throw Errors.forbidden(
              'FORBIDDEN',
              'SELF_ARREST can only target a device owned by the authenticated user.'
            );
          }
        } else {
          // PARTNER_ARREST or MUTUAL_ARREST requires explicit delegated authorization
          if (ownerUserId === initiatorUserId) {
            throw Errors.badRequest(
              'SELF_ACTION_NOT_ALLOWED',
              `Use SELF_ARREST when targeting your own device instead of ${input.sessionType}.`
            );
          }
          if (!input.authorizationId) {
            throw Errors.badRequest(
              'PERMISSION_NOT_FOUND',
              'authorizationId is required to initiate a remote partner session.'
            );
          }

          consumedPermission = await this.permissionsService.validateAndConsumeForSessionInTx(
            repos,
            {
              authorizationId: input.authorizationId,
              initiatorUserId,
              ownerUserId,
              targetDeviceId: targetDevice.id,
              sessionType: input.sessionType,
              requestedDurationMinutes: input.requestedDurationMinutes,
              blockingConfiguration: normalizedBlockingConfig,
              now,
              context
            }
          );

          verifiedAuthId = consumedPermission.permissionId;
          commandHardDeadlineMs = Math.min(commandHardDeadlineMs, consumedPermission.expiresAt.getTime());
        }

        // Clean up any stale unexecuted commands on this device before checking active sessions
        await repos.commands.expireOverdueForDevice(targetDevice.id, now);

        const existingActive = await repos.sessions.findActiveForDeviceForUpdate(targetDevice.id);
        if (existingActive) {
          throw Errors.conflict(
            'ACTIVE_SESSION_EXISTS',
            'Target device already has an active or pending Arrest session.',
            { existingSessionId: existingActive.sessionId, status: existingActive.status }
          );
        }

        const sessionId = randomUUID();
        const commandId = randomUUID();
        const commandExpiresAt = new Date(Math.max(now.getTime() + 5000, commandHardDeadlineMs));

        const createdSession = await repos.sessions.create({
          sessionId,
          localSessionId: null,
          ownerUserId,
          targetDeviceId: targetDevice.id,
          initiatedByUserId: initiatorUserId,
          authorizationId: verifiedAuthId,
          idempotencyKey: input.idempotencyKey ?? null,
          sessionType: input.sessionType,
          goal: input.goal,
          blockingConfiguration: normalizedBlockingConfig,
          requestedDuration: input.requestedDurationMinutes,
          status: 'REQUESTED',
          localEngineState: null,
          requestedAt: now,
          acceptedAt: null,
          startedAt: null,
          expectedEndAt: null,
          completedAt: null,
          completionReason: null,
          createdAt: now,
          updatedAt: now
        });

        // Command payload maps cleanly to Android's `SessionConfig` without exposing secrets
        const commandPayload: Record<string, unknown> = {
          schemaVersion: 1,
          sessionId,
          sessionType: input.sessionType,
          durationMinutes: input.requestedDurationMinutes,
          goal: input.goal,
          ruleMode: normalizedBlockingConfig.ruleMode,
          allowedCategories: normalizedBlockingConfig.allowedCategories,
          overlayStatusBar: normalizedBlockingConfig.overlayStatusBar,
          disableEmergencyExit: normalizedBlockingConfig.disableEmergencyExit,
          ...(normalizedBlockingConfig.blockedPackages
            ? { blockedPackages: normalizedBlockingConfig.blockedPackages }
            : {}),
          ...(normalizedBlockingConfig.allowedStudyPackages
            ? { allowedStudyPackages: normalizedBlockingConfig.allowedStudyPackages }
            : {}),
          authorizationId: verifiedAuthId,
          ...(consumedPermission?.proposalId ? { proposalId: consumedPermission.proposalId } : {}),
          ...(consumedPermission?.approvedRevision
            ? { approvedRevision: consumedPermission.approvedRevision }
            : {}),
          initiatedByUserId: initiatorUserId
        };

        const createdCommand = await repos.commands.create({
          commandId,
          sessionId,
          targetDeviceId: targetDevice.id,
          issuedByUserId: initiatorUserId,
          commandType: 'START_ARREST',
          payload: commandPayload,
          status: 'PENDING',
          idempotencyKey: `start_${sessionId}`,
          resultMetadata: null,
          failureReason: null,
          pushDeliveryStatus: 'NOT_ATTEMPTED',
          pushAttempts: 0,
          lastPushAttemptAt: null,
          createdAt: now,
          expiresAt: commandExpiresAt,
          deliveredAt: null,
          acknowledgedAt: null,
          executedAt: null,
          updatedAt: now
        });

        await this.auditService.record(repos.auditLogs, {
          actorUserId: initiatorUserId,
          actorDeviceId: targetDevice.id,
          action: 'SESSION_REQUESTED',
          resourceType: 'ARREST_SESSION',
          resourceId: sessionId,
          result: 'SUCCESS',
          context,
          metadata: {
            ownerUserId,
            targetDeviceId: targetDevice.id,
            authorizationId: verifiedAuthId,
            sessionType: input.sessionType,
            requestedDurationMinutes: input.requestedDurationMinutes,
            commandId
          }
        });

        return {
          session: createdSession,
          command: createdCommand,
          idempotentReplay: false
        };
      }
    );

    if (!txResult.idempotentReplay) {
      await this.notificationService.notifyCommandAvailable(txResult.command);
    }

    const refreshedCommand =
      (await this.store.repositories.commands.findById(txResult.command.commandId)) ??
      txResult.command;

    return {
      session: serializeSession(txResult.session),
      command: serializeCommand(refreshedCommand),
      idempotentReplay: txResult.idempotentReplay
    };
  }

  async listSessions(
    userId: string,
    options: {
      role?: 'owner' | 'initiator' | 'all';
      status?: CloudSessionStatus;
      deviceId?: string;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<SerializedArrestSession>> {
    const page = await this.store.repositories.sessions.listForUser(userId, options);
    return {
      ...page,
      items: page.items.map(serializeSession)
    };
  }

  async listActiveSessions(userId: string): Promise<SerializedArrestSession[]> {
    const sessions = await this.store.repositories.sessions.listActiveForUser(userId);
    return sessions.map(serializeSession);
  }

  async listLiveDashboardSessions(userId: string): Promise<SerializedLiveDashboardItem[]> {
    const now = this.clock.now();
    const page = await this.store.repositories.sessions.listForUser(userId, {
      role: 'all',
      limit: 25,
      offset: 0
    });

    const sorted = [...page.items].sort((a, b) => {
      const aActive = !TERMINAL_CLOUD_SESSION_STATUSES.includes(a.status);
      const bActive = !TERMINAL_CLOUD_SESSION_STATUSES.includes(b.status);
      if (aActive !== bActive) {
        return aActive ? -1 : 1;
      }
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });

    const pendingReleases = await this.store.repositories.releaseRequests.listForUser(userId, {
      role: 'all',
      status: 'PENDING',
      limit: 100,
      offset: 0
    });

    const items: SerializedLiveDashboardItem[] = [];
    for (const s of sorted) {
      const [owner, initiator, targetDevice] = await Promise.all([
        this.store.repositories.users.findById(s.ownerUserId),
        this.store.repositories.users.findById(s.initiatedByUserId),
        this.store.repositories.devices.findById(s.targetDeviceId)
      ]);
      const sessionPendingReleasesCount = pendingReleases.items.filter(
        (r) => r.sessionId === s.sessionId
      ).length;

      let remainingSeconds: number | null = null;
      if (
        !TERMINAL_CLOUD_SESSION_STATUSES.includes(s.status) &&
        s.expectedEndAt !== null
      ) {
        remainingSeconds = Math.max(
          0,
          Math.floor((s.expectedEndAt.getTime() - now.getTime()) / 1000)
        );
      } else if (s.status === 'REQUESTED' || s.status === 'DELIVERED') {
        remainingSeconds = s.requestedDuration * 60;
      }

      items.push({
        session: serializeSession(s),
        owner: {
          id: owner?.id ?? s.ownerUserId,
          username: owner?.username ?? 'unknown',
          displayName: owner?.displayName ?? 'Unknown User',
          avatarUrl: owner?.avatarUrl ?? null
        },
        initiator: {
          id: initiator?.id ?? s.initiatedByUserId,
          username: initiator?.username ?? 'unknown',
          displayName: initiator?.displayName ?? 'Unknown User',
          avatarUrl: initiator?.avatarUrl ?? null
        },
        targetDevice: targetDevice
          ? {
              deviceId: targetDevice.id,
              deviceName: targetDevice.deviceName,
              deviceModel: targetDevice.model,
              platform: targetDevice.platform,
              deviceStatus: targetDevice.deviceStatus,
              lastSeenAt: targetDevice.lastSeenAt ? targetDevice.lastSeenAt.toISOString() : null
            }
          : null,
        remainingSeconds,
        pendingReleaseRequestsCount: sessionPendingReleasesCount
      });
    }

    return items;
  }

  async getSessionById(userId: string, sessionId: string): Promise<SerializedArrestSession> {
    const session = await this.store.repositories.sessions.findById(sessionId);
    if (
      !session ||
      (session.ownerUserId !== userId && session.initiatedByUserId !== userId)
    ) {
      throw Errors.notFound('SESSION_NOT_FOUND', 'Arrest session was not found.');
    }
    return serializeSession(session);
  }

  async acknowledgeSession(
    actorUserId: string,
    sessionId: string,
    input: {
      deviceId: string;
      outcome: 'ACCEPTED' | 'STARTED' | 'REJECTED';
      localSessionId?: string;
      localEngineState?: AndroidEngineState;
      reason?: string;
    },
    context?: RequestContextMeta
  ): Promise<SerializedArrestSession> {
    const outcome = await this.store.withTransaction(
      async (
        repos
      ): Promise<
        | { ok: true; session: ArrestSessionRecord }
        | {
            ok: false;
            error: 'NOT_FOUND' | 'COMMAND_EXPIRED' | 'PERMISSION_REVOKED' | 'INVALID_STATE';
          }
      > => {
        const session = await repos.sessions.findByIdForUpdate(sessionId);
        if (
          !session ||
          session.ownerUserId !== actorUserId ||
          session.targetDeviceId !== input.deviceId
        ) {
          return { ok: false, error: 'NOT_FOUND' };
        }

        const now = this.clock.now();
        await repos.devices.touchLastSeen(input.deviceId, now);

        // Idempotent handling when already in target state
        if (input.outcome === 'STARTED' && session.status === 'ACTIVE') {
          return { ok: true, session };
        }
        if (input.outcome === 'REJECTED' && session.status === 'REJECTED') {
          return { ok: true, session };
        }

        if (TERMINAL_CLOUD_SESSION_STATUSES.includes(session.status)) {
          if (session.status === 'EXPIRED') {
            return { ok: false, error: 'COMMAND_EXPIRED' };
          }
          return { ok: false, error: 'INVALID_STATE' };
        }

        const startCmd = await repos.commands.findLatestBySessionAndType(
          sessionId,
          'START_ARREST'
        );

        if (
          startCmd &&
          (session.status === 'REQUESTED' || session.status === 'DELIVERED') &&
          now.getTime() >= startCmd.expiresAt.getTime()
        ) {
          await repos.commands.updateCommandStatus(startCmd.commandId, {
            status: 'EXPIRED',
            failureReason: 'START_ARREST command expired before session acknowledgment',
            updatedAt: now
          });
          await repos.sessions.updateStatusAndFields(sessionId, {
            status: 'EXPIRED',
            completedAt: now,
            completionReason: 'START_ARREST command expired before session acknowledgment',
            updatedAt: now
          });
          return { ok: false, error: 'COMMAND_EXPIRED' };
        }

        if (
          input.outcome !== 'REJECTED' &&
          session.authorizationId &&
          (session.status === 'REQUESTED' || session.status === 'DELIVERED')
        ) {
          const perm = await repos.partnerPermissions.findByIdForUpdate(session.authorizationId);
          if (!perm || perm.revokedAt !== null) {
            if (startCmd) {
              await repos.commands.updateCommandStatus(startCmd.commandId, {
                status: 'REJECTED',
                failureReason: 'Partner authorization was revoked prior to start',
                updatedAt: now
              });
            }
            await repos.sessions.updateStatusAndFields(sessionId, {
              status: 'CANCELLED',
              completedAt: now,
              completionReason: 'Partner authorization was revoked prior to start',
              updatedAt: now
            });
            return { ok: false, error: 'PERMISSION_REVOKED' };
          }
        }

        let updated: ArrestSessionRecord;
        if (input.outcome === 'ACCEPTED') {
          updated = await repos.sessions.updateStatusAndFields(sessionId, {
            status: session.status === 'REQUESTED' ? 'DELIVERED' : session.status,
            acceptedAt: session.acceptedAt ?? now,
            localSessionId: input.localSessionId ?? session.localSessionId,
            localEngineState: input.localEngineState ?? 'PREPARING',
            updatedAt: now
          });
          if (startCmd && (startCmd.status === 'PENDING' || startCmd.status === 'DELIVERED')) {
            await repos.commands.updateCommandStatus(startCmd.commandId, {
              status: 'ACKNOWLEDGED',
              acknowledgedAt: now,
              updatedAt: now
            });
          }
        } else if (input.outcome === 'STARTED') {
          const expectedEndAt = new Date(now.getTime() + session.requestedDuration * 60_000);
          updated = await repos.sessions.updateStatusAndFields(sessionId, {
            status: 'ACTIVE',
            acceptedAt: session.acceptedAt ?? now,
            startedAt: session.startedAt ?? now,
            expectedEndAt: session.expectedEndAt ?? expectedEndAt,
            localSessionId: input.localSessionId ?? session.localSessionId,
            localEngineState: input.localEngineState ?? 'ACTIVE',
            updatedAt: now
          });
          if (
            startCmd &&
            (startCmd.status === 'PENDING' ||
              startCmd.status === 'DELIVERED' ||
              startCmd.status === 'ACKNOWLEDGED')
          ) {
            await repos.commands.updateCommandStatus(startCmd.commandId, {
              status: 'EXECUTED',
              acknowledgedAt: startCmd.acknowledgedAt ?? now,
              executedAt: now,
              updatedAt: now
            });
          }
        } else {
          updated = await repos.sessions.updateStatusAndFields(sessionId, {
            status: 'REJECTED',
            localEngineState: input.localEngineState ?? 'IDLE',
            completedAt: now,
            completionReason: input.reason ?? 'Rejected by target Android device',
            updatedAt: now
          });
          if (
            startCmd &&
            (startCmd.status === 'PENDING' ||
              startCmd.status === 'DELIVERED' ||
              startCmd.status === 'ACKNOWLEDGED')
          ) {
            await repos.commands.updateCommandStatus(startCmd.commandId, {
              status: 'REJECTED',
              acknowledgedAt: startCmd.acknowledgedAt ?? now,
              failureReason: input.reason ?? 'Rejected by target Android device',
              updatedAt: now
            });
          }
        }

        await this.auditService.record(repos.auditLogs, {
          actorUserId,
          actorDeviceId: input.deviceId,
          action: `SESSION_ACK_${input.outcome}`,
          resourceType: 'ARREST_SESSION',
          resourceId: sessionId,
          result: 'SUCCESS',
          context,
          metadata: {
            localSessionId: updated.localSessionId,
            status: updated.status
          }
        });

        return { ok: true, session: updated };
      }
    );

    if (!outcome.ok) {
      switch (outcome.error) {
        case 'COMMAND_EXPIRED':
          throw Errors.conflict('COMMAND_EXPIRED', 'Session start command has already expired.');
        case 'PERMISSION_REVOKED':
          throw Errors.forbidden(
            'PERMISSION_REVOKED',
            'Partner authorization was revoked prior to session start.'
          );
        case 'INVALID_STATE':
          throw Errors.conflict(
            'SESSION_INVALID_STATE',
            'Session is already in a terminal state.'
          );
        default:
          throw Errors.notFound('SESSION_NOT_FOUND', 'Arrest session was not found.');
      }
    }

    return serializeSession(outcome.session);
  }

  async recordSessionEvents(
    actorUserId: string,
    sessionId: string,
    input: {
      deviceId: string;
      events: Array<{
        clientEventId: string;
        eventType:
          | 'SESSION_STARTED'
          | 'SESSION_PAUSED'
          | 'SESSION_RESUMED'
          | 'SESSION_INTERRUPTED'
          | 'SESSION_COMPLETED'
          | 'EMERGENCY_STOPPED'
          | 'CLOCK_ANOMALY_DETECTED'
          | 'HEARTBEAT_SYNC';
        fromEngineState?: AndroidEngineState | null;
        toEngineState?: AndroidEngineState | null;
        occurredAtClientMs: number;
        localSessionId?: string;
        accumulatedPausedMs?: number;
        reason?: string;
        metadata?: Record<string, unknown>;
      }>;
    },
    context?: RequestContextMeta
  ): Promise<{
    session: SerializedArrestSession;
    processedCount: number;
    duplicateCount: number;
  }> {
    return this.store.withTransaction(async (repos) => {
      let session = await repos.sessions.findByIdForUpdate(sessionId);
      if (
        !session ||
        session.ownerUserId !== actorUserId ||
        session.targetDeviceId !== input.deviceId
      ) {
        throw Errors.notFound('SESSION_NOT_FOUND', 'Arrest session was not found.');
      }

      const now = this.clock.now();
      await repos.devices.touchLastSeen(input.deviceId, now);

      let processedCount = 0;
      let duplicateCount = 0;

      // Process events in chronological client order
      const sortedEvents = [...input.events].sort(
        (a, b) => a.occurredAtClientMs - b.occurredAtClientMs
      );

      for (const ev of sortedEvents) {
        const dedup = await repos.sessions.recordSyncEventIfNew({
          sessionId,
          deviceId: input.deviceId,
          clientEventId: ev.clientEventId,
          eventType: ev.eventType,
          fromEngineState: ev.fromEngineState ?? null,
          toEngineState: ev.toEngineState ?? null,
          occurredAtClientMs: ev.occurredAtClientMs,
          metadata: ev.metadata ?? null,
          recordedAt: now
        });

        if (!dedup.inserted) {
          duplicateCount++;
          continue;
        }
        processedCount++;

        // Conflict resolution invariant: terminal cloud states are monotonic; late out-of-order
        // non-terminal events after reconnection never reopen an already ended session.
        if (TERMINAL_CLOUD_SESSION_STATUSES.includes(session.status)) {
          continue;
        }

        if (ev.eventType === 'SESSION_STARTED') {
          const baseStart = session.startedAt ?? now;
          const expectedEndAt =
            session.expectedEndAt ??
            new Date(baseStart.getTime() + session.requestedDuration * 60_000);
          session = await repos.sessions.updateStatusAndFields(sessionId, {
            status: 'ACTIVE',
            localSessionId: ev.localSessionId ?? session.localSessionId,
            localEngineState: 'ACTIVE',
            acceptedAt: session.acceptedAt ?? baseStart,
            startedAt: baseStart,
            expectedEndAt,
            updatedAt: now
          });
        } else if (ev.eventType === 'SESSION_PAUSED') {
          session = await repos.sessions.updateStatusAndFields(sessionId, {
            status: 'PAUSED',
            localEngineState: 'PAUSED',
            updatedAt: now
          });
        } else if (ev.eventType === 'SESSION_RESUMED') {
          let nextExpectedEnd = session.expectedEndAt;
          if (session.startedAt && ev.accumulatedPausedMs !== undefined) {
            // Bounded pause shift so clock anomalies or tampered client deltas cannot extend indefinitely
            const boundedPauseMs = Math.min(
              Math.max(0, ev.accumulatedPausedMs),
              session.requestedDuration * 60_000
            );
            nextExpectedEnd = new Date(
              session.startedAt.getTime() + session.requestedDuration * 60_000 + boundedPauseMs
            );
          }
          session = await repos.sessions.updateStatusAndFields(sessionId, {
            status: 'ACTIVE',
            localEngineState: 'ACTIVE',
            expectedEndAt: nextExpectedEnd,
            updatedAt: now
          });
        } else if (ev.eventType === 'SESSION_INTERRUPTED') {
          session = await repos.sessions.updateStatusAndFields(sessionId, {
            status: 'INTERRUPTED',
            localEngineState: 'INTERRUPTED',
            updatedAt: now
          });
          await this.auditService.record(repos.auditLogs, {
            actorUserId,
            actorDeviceId: input.deviceId,
            action: 'SESSION_INTERRUPTED_ON_DEVICE',
            resourceType: 'ARREST_SESSION',
            resourceId: sessionId,
            result: 'SUCCESS',
            context,
            metadata: { reason: ev.reason ?? null }
          });
        } else if (ev.eventType === 'SESSION_COMPLETED') {
          session = await repos.sessions.updateStatusAndFields(sessionId, {
            status: 'COMPLETED',
            localEngineState: 'COMPLETED',
            completedAt: now,
            completionReason: ev.reason ?? 'Completed by local Android Arrest Engine',
            updatedAt: now
          });
          await repos.releaseRequests.expirePendingForSession(sessionId, now);
          await this.auditService.record(repos.auditLogs, {
            actorUserId,
            actorDeviceId: input.deviceId,
            action: 'SESSION_COMPLETED',
            resourceType: 'ARREST_SESSION',
            resourceId: sessionId,
            result: 'SUCCESS',
            context
          });
        } else if (ev.eventType === 'EMERGENCY_STOPPED') {
          session = await repos.sessions.updateStatusAndFields(sessionId, {
            status: 'EMERGENCY_STOPPED',
            localEngineState: 'EMERGENCY_STOPPED',
            completedAt: now,
            completionReason: ev.reason ?? 'Emergency exit triggered on device',
            updatedAt: now
          });
          await repos.releaseRequests.expirePendingForSession(sessionId, now);
          await this.auditService.record(repos.auditLogs, {
            actorUserId,
            actorDeviceId: input.deviceId,
            action: session.blockingConfiguration.disableEmergencyExit
              ? 'SESSION_UNEXPECTED_EMERGENCY_STOP'
              : 'SESSION_EMERGENCY_STOPPED',
            resourceType: 'ARREST_SESSION',
            resourceId: sessionId,
            result: 'SUCCESS',
            context,
            metadata: { reason: ev.reason ?? null }
          });
        } else if (ev.eventType === 'CLOCK_ANOMALY_DETECTED') {
          await this.auditService.record(repos.auditLogs, {
            actorUserId,
            actorDeviceId: input.deviceId,
            action: 'DEVICE_CLOCK_ANOMALY_REPORTED',
            resourceType: 'ARREST_SESSION',
            resourceId: sessionId,
            result: 'SUCCESS',
            context,
            metadata: { reason: ev.reason ?? null }
          });
        } else if (ev.eventType === 'HEARTBEAT_SYNC' && ev.toEngineState) {
          session = await repos.sessions.updateStatusAndFields(sessionId, {
            localEngineState: ev.toEngineState,
            updatedAt: now
          });
        }
      }

      return {
        session: serializeSession(session),
        processedCount,
        duplicateCount
      };
    });
  }

  /**
   * Allows the session initiator (e.g. partner ending a Partner Arrest early, or owner ending a Self Arrest)
   * to queue an explicit `END_SESSION` command. An arrested user cannot call this to bypass their partner!
   */
  async queueRemoteEndSession(
    actorUserId: string,
    sessionId: string,
    input: { reason?: string; idempotencyKey?: string },
    context?: RequestContextMeta
  ): Promise<{ command: SerializedSessionCommand }> {
    const command = await this.store.withTransaction(async (repos) => {
      const session = await repos.sessions.findByIdForUpdate(sessionId);
      if (
        !session ||
        (session.ownerUserId !== actorUserId && session.initiatedByUserId !== actorUserId)
      ) {
        throw Errors.notFound('SESSION_NOT_FOUND', 'Arrest session was not found.');
      }

      if (session.initiatedByUserId !== actorUserId) {
        throw Errors.forbidden(
          'FORBIDDEN',
          'Only the initiating authority may directly end a Partner Arrest session. Submit a release request instead.'
        );
      }

      if (TERMINAL_CLOUD_SESSION_STATUSES.includes(session.status)) {
        throw Errors.conflict(
          'SESSION_ALREADY_ENDED',
          `Session is already in terminal state ${session.status}.`
        );
      }

      const idemKey = input.idempotencyKey ?? `end_${sessionId}`;
      const existingCmd = await repos.commands.findByIdempotencyKey(idemKey);
      if (existingCmd) {
        return existingCmd;
      }

      const now = this.clock.now();
      const created = await repos.commands.create({
        commandId: randomUUID(),
        sessionId,
        targetDeviceId: session.targetDeviceId,
        issuedByUserId: actorUserId,
        commandType: 'END_SESSION',
        payload: {
          schemaVersion: 1,
          sessionId,
          reason: input.reason ?? 'Ended remotely by session initiator'
        },
        status: 'PENDING',
        idempotencyKey: idemKey,
        resultMetadata: null,
        failureReason: null,
        pushDeliveryStatus: 'NOT_ATTEMPTED',
        pushAttempts: 0,
        lastPushAttemptAt: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.defaultCommandTtlSeconds * 1000),
        deliveredAt: null,
        acknowledgedAt: null,
        executedAt: null,
        updatedAt: now
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId,
        actorDeviceId: session.targetDeviceId,
        action: 'SESSION_REMOTE_END_QUEUED',
        resourceType: 'ARREST_SESSION',
        resourceId: sessionId,
        result: 'SUCCESS',
        context,
        metadata: { commandId: created.commandId }
      });

      return created;
    });

    await this.notificationService.notifyCommandAvailable(command);
    const refreshed = (await this.store.repositories.commands.findById(command.commandId)) ?? command;
    return { command: serializeCommand(refreshed) };
  }

  async queueSyncSessionCommand(
    actorUserId: string,
    sessionId: string,
    input: { idempotencyKey?: string },
    context?: RequestContextMeta
  ): Promise<{ command: SerializedSessionCommand }> {
    const command = await this.store.withTransaction(async (repos) => {
      const session = await repos.sessions.findByIdForUpdate(sessionId);
      if (
        !session ||
        (session.ownerUserId !== actorUserId && session.initiatedByUserId !== actorUserId)
      ) {
        throw Errors.notFound('SESSION_NOT_FOUND', 'Arrest session was not found.');
      }

      const now = this.clock.now();
      const idemKey = input.idempotencyKey ?? `sync_${sessionId}_${now.getTime()}`;
      const existing = await repos.commands.findByIdempotencyKey(idemKey);
      if (existing) return existing;

      const created = await repos.commands.create({
        commandId: randomUUID(),
        sessionId,
        targetDeviceId: session.targetDeviceId,
        issuedByUserId: actorUserId,
        commandType: 'SYNC_SESSION',
        payload: {
          schemaVersion: 1,
          sessionId
        },
        status: 'PENDING',
        idempotencyKey: idemKey,
        resultMetadata: null,
        failureReason: null,
        pushDeliveryStatus: 'NOT_ATTEMPTED',
        pushAttempts: 0,
        lastPushAttemptAt: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.defaultCommandTtlSeconds * 1000),
        deliveredAt: null,
        acknowledgedAt: null,
        executedAt: null,
        updatedAt: now
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId,
        actorDeviceId: session.targetDeviceId,
        action: 'SESSION_SYNC_COMMAND_QUEUED',
        resourceType: 'ARREST_SESSION',
        resourceId: sessionId,
        result: 'SUCCESS',
        context,
        metadata: { commandId: created.commandId }
      });

      return created;
    });

    await this.notificationService.notifyCommandAvailable(command);
    const refreshed = (await this.store.repositories.commands.findById(command.commandId)) ?? command;
    return { command: serializeCommand(refreshed) };
  }
}
