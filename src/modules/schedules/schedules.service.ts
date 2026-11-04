import { randomUUID } from 'node:crypto';
import type { AuditService, RequestContextMeta } from '../../services/audit.service';
import { Errors } from '../../shared/errors';
import {
  computeNextRecurrenceUtc,
  type Clock,
  type RecurrenceRuleConfig
} from '../../shared/time';
import type {
  BlockingConfigurationV1,
  DeviceRecord,
  PaginatedResult,
  PublicUserProfile,
  ScheduledArrestRecord,
  ScheduledArrestStatus,
  SessionCommandRecord,
  SessionType,
  UserRecord
} from '../../types/domain';
import type { DataStore, RepositoryBundle } from '../../types/repositories';
import { serializePublicUser } from '../users/users.service';

export interface SerializedScheduledArrest {
  scheduleId: string;
  proposalId: string | null;
  permissionId: string | null;
  owner: PublicUserProfile;
  partner: PublicUserProfile;
  targetDevice: {
    id: string;
    deviceName: string;
    platform: 'ANDROID';
    deviceStatus: 'ACTIVE' | 'INACTIVE' | 'REVOKED';
  };
  scheduleType: 'SCHEDULED' | 'RECURRING';
  sessionType: SessionType;
  goal: string;
  durationMinutes: number;
  blockingConfiguration: BlockingConfigurationV1;
  timezone: string;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  recurrenceRule: RecurrenceRuleConfig | null;
  occurrencesCompleted: number;
  maxOccurrences: number;
  nextOccurrenceAt: string | null;
  lastMaterializedSessionId?: string | null;
  lastMaterializedAt?: string | null;
  status: ScheduledArrestStatus;
  createdAt: string;
  updatedAt: string;
}

export class SchedulesService {
  constructor(
    private readonly store: DataStore,
    private readonly auditService: AuditService,
    private readonly clock: Clock
  ) {}

  async listSchedules(
    userId: string,
    options: {
      role?: 'owner' | 'partner' | 'all';
      status?: ScheduledArrestStatus;
      partnerUserId?: string;
      deviceId?: string;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<SerializedScheduledArrest>> {
    const page = await this.store.repositories.scheduledArrests.listForUser(userId, options);
    const userIds = page.items.flatMap((s) => [s.ownerUserId, s.partnerUserId]);
    const deviceIds = page.items.map((s) => s.targetDeviceId);
    const [users, devices] = await Promise.all([
      this.store.repositories.users.findByIds(userIds),
      this.store.repositories.devices.findByIds(deviceIds)
    ]);

    return {
      ...page,
      items: page.items.map((item) => this.formatSchedule(item, users, devices))
    };
  }

  async getScheduleById(userId: string, scheduleId: string): Promise<SerializedScheduledArrest> {
    const record = await this.store.repositories.scheduledArrests.findById(scheduleId);
    if (!record || (record.ownerUserId !== userId && record.partnerUserId !== userId)) {
      throw Errors.notFound('SCHEDULE_NOT_FOUND', 'Scheduled arrest was not found.');
    }
    return this.hydrateSingle(record);
  }

  async cancelSchedule(
    actorUserId: string,
    scheduleId: string,
    context?: RequestContextMeta
  ): Promise<SerializedScheduledArrest> {
    const updated = await this.store.withTransaction(async (repos) => {
      const existing = await repos.scheduledArrests.findByIdForUpdate(scheduleId);
      if (
        !existing ||
        (existing.ownerUserId !== actorUserId && existing.partnerUserId !== actorUserId)
      ) {
        throw Errors.notFound('SCHEDULE_NOT_FOUND', 'Scheduled arrest was not found.');
      }

      if (existing.status === 'CANCELLED' || existing.status === 'REVOKED') {
        return existing;
      }

      if (existing.status === 'COMPLETED' || existing.status === 'EXPIRED') {
        throw Errors.conflict(
          'SCHEDULE_INVALID_STATE',
          `Cannot cancel a scheduled arrest in state ${existing.status}.`
        );
      }

      const now = this.clock.now();
      const nextStatus: ScheduledArrestStatus =
        existing.ownerUserId === actorUserId ? 'REVOKED' : 'CANCELLED';

      const result = await repos.scheduledArrests.updateStatusAndOccurrence(scheduleId, {
        status: nextStatus,
        nextOccurrenceAt: null,
        updatedAt: now
      });

      if (existing.permissionId) {
        await repos.partnerPermissions.revokeById(existing.permissionId, {
          revokedByUserId: actorUserId,
          revokeReason: `Scheduled arrest ${scheduleId} was ${nextStatus.toLowerCase()}`,
          now
        });
      }

      await this.auditService.record(repos.auditLogs, {
        actorUserId,
        actorDeviceId: existing.targetDeviceId,
        action: 'SCHEDULED_ARREST_CANCELLED',
        resourceType: 'SCHEDULED_ARREST',
        resourceId: scheduleId,
        result: 'SUCCESS',
        context,
        metadata: { status: nextStatus, permissionId: existing.permissionId }
      });

      return result;
    });

    return this.hydrateSingle(updated);
  }

  /**
   * Explicitly triggers/materializes a due scheduled or recurring Arrest occurrence into an
   * ArrestSession + START_ARREST command after verifying partnership, authorization, and window bounds.
   */
  async triggerDueSchedule(
    actorUserId: string,
    scheduleId: string,
    context?: RequestContextMeta
  ): Promise<{
    schedule: SerializedScheduledArrest;
    sessionId: string;
    commandId: string;
    idempotentReplay: boolean;
  }> {
    const outcome = await this.store.withTransaction(async (repos) => {
      const schedule = await repos.scheduledArrests.findByIdForUpdate(scheduleId);
      if (
        !schedule ||
        (schedule.ownerUserId !== actorUserId && schedule.partnerUserId !== actorUserId)
      ) {
        throw Errors.notFound('SCHEDULE_NOT_FOUND', 'Scheduled arrest was not found.');
      }

      const now = this.clock.now();
      return this.materializeSingleScheduleInTx(repos, schedule, now, context, true);
    });

    return {
      schedule: await this.hydrateSingle(outcome.schedule),
      sessionId: outcome.sessionId,
      commandId: outcome.command.commandId,
      idempotentReplay: outcome.idempotentReplay
    };
  }

  /**
   * Automatically evaluates and materializes any due scheduled occurrences for a target device
   * when that device polls its command queue.
   */
  async materializeDueSchedulesForDeviceInTx(
    repos: RepositoryBundle,
    deviceId: string,
    now: Date,
    context?: RequestContextMeta
  ): Promise<SessionCommandRecord[]> {
    const dueSchedules = await repos.scheduledArrests.listDueForDevice(deviceId, now);
    const createdCommands: SessionCommandRecord[] = [];

    for (const sched of dueSchedules) {
      try {
        const res = await this.materializeSingleScheduleInTx(repos, sched, now, context, false);
        if (!res.idempotentReplay) {
          createdCommands.push(res.command);
        }
      } catch {
        // Non-fatal during background poll: if expired or conflicted, status update is already persisted
      }
    }

    return createdCommands;
  }

  private async materializeSingleScheduleInTx(
    repos: RepositoryBundle,
    schedule: ScheduledArrestRecord,
    now: Date,
    context: RequestContextMeta | undefined,
    strictThrow: boolean
  ): Promise<{
    schedule: ScheduledArrestRecord;
    sessionId: string;
    command: SessionCommandRecord;
    idempotentReplay: boolean;
  }> {
    if (schedule.status === 'REVOKED') {
      throw Errors.forbidden(
        'PERMISSION_REVOKED',
        'Authorization for this scheduled arrest was revoked.'
      );
    }
    if (schedule.status === 'CANCELLED') {
      throw Errors.conflict(
        'SCHEDULE_INVALID_STATE',
        `Scheduled arrest is ${schedule.status} and cannot be started.`
      );
    }
    if (schedule.status === 'COMPLETED' || schedule.status === 'EXPIRED') {
      if (schedule.lastMaterializedSessionId) {
        const prevCmd = await repos.commands.findLatestBySessionAndType(
          schedule.lastMaterializedSessionId,
          'START_ARREST'
        );
        if (prevCmd) {
          return {
            schedule,
            sessionId: schedule.lastMaterializedSessionId,
            command: prevCmd,
            idempotentReplay: true
          };
        }
      }
      throw Errors.conflict(
        'SCHEDULE_INVALID_STATE',
        `Scheduled arrest is already ${schedule.status}.`
      );
    }

    // 1. Verify active partnership
    const partnership = await repos.partnerships.findByPairForUpdate(
      schedule.ownerUserId,
      schedule.partnerUserId
    );
    if (!partnership || partnership.state !== 'ACCEPTED') {
      await repos.scheduledArrests.updateStatusAndOccurrence(schedule.scheduleId, {
        status: 'REVOKED',
        nextOccurrenceAt: null,
        updatedAt: now
      });
      throw Errors.forbidden(
        'PARTNERSHIP_REQUIRED',
        'Active partnership is no longer valid; scheduled arrest has been revoked.'
      );
    }

    // 2. Verify target device is still ACTIVE
    const device = await repos.devices.findByIdForUpdate(schedule.targetDeviceId);
    if (!device || device.deviceStatus !== 'ACTIVE') {
      await repos.scheduledArrests.updateStatusAndOccurrence(schedule.scheduleId, {
        status: 'REVOKED',
        nextOccurrenceAt: null,
        updatedAt: now
      });
      throw Errors.conflict('DEVICE_REVOKED', 'Target device is no longer active.');
    }

    // 3. Verify associated permission was not revoked or expired
    if (schedule.permissionId) {
      const perm = await repos.partnerPermissions.findByIdForUpdate(schedule.permissionId);
      if (!perm || perm.revokedAt !== null) {
        await repos.scheduledArrests.updateStatusAndOccurrence(schedule.scheduleId, {
          status: 'REVOKED',
          nextOccurrenceAt: null,
          updatedAt: now
        });
        throw Errors.forbidden(
          'PERMISSION_REVOKED',
          'Authorization for this scheduled arrest was revoked.'
        );
      }
      if (now.getTime() >= perm.expiresAt.getTime()) {
        await repos.scheduledArrests.updateStatusAndOccurrence(schedule.scheduleId, {
          status: 'EXPIRED',
          nextOccurrenceAt: null,
          updatedAt: now
        });
        throw Errors.forbidden(
          'PERMISSION_EXPIRED',
          'Authorization for this scheduled arrest has expired.'
        );
      }
    }

    const occurrenceStart = schedule.nextOccurrenceAt;
    if (!occurrenceStart) {
      throw Errors.conflict('SCHEDULE_INVALID_STATE', 'Schedule has no upcoming occurrence.');
    }

    // Allow 60 seconds early clock-skew grace on explicit trigger
    const graceMs = 60_000;
    if (now.getTime() + graceMs < occurrenceStart.getTime()) {
      if (strictThrow) {
        throw Errors.conflict(
          'SCHEDULE_NOT_DUE_YET',
          `Scheduled occurrence is not due until ${occurrenceStart.toISOString()}.`
        );
      }
      throw Errors.conflict('SCHEDULE_NOT_DUE_YET', 'Not due yet.');
    }

    const occurrenceEnd = new Date(
      occurrenceStart.getTime() + schedule.durationMinutes * 60_000
    );

    // 4. Never start a session after its scheduled end time has already passed!
    if (now.getTime() >= occurrenceEnd.getTime()) {
      if (schedule.scheduleType === 'RECURRING' && schedule.recurrenceRule) {
        const nextOcc = computeNextRecurrenceUtc(schedule.recurrenceRule, now);
        await repos.scheduledArrests.updateStatusAndOccurrence(schedule.scheduleId, {
          status: nextOcc ? 'SCHEDULED' : 'EXPIRED',
          nextOccurrenceAt: nextOcc,
          updatedAt: now
        });
      } else {
        await repos.scheduledArrests.updateStatusAndOccurrence(schedule.scheduleId, {
          status: 'EXPIRED',
          nextOccurrenceAt: null,
          updatedAt: now
        });
      }
      throw Errors.conflict(
        'SCHEDULE_WINDOW_EXPIRED',
        'Scheduled session window has already passed and cannot start late.'
      );
    }

    // 5. Check for existing active/pending session on the device
    await repos.commands.expireOverdueForDevice(schedule.targetDeviceId, now);
    const existingActive = await repos.sessions.findActiveForDeviceForUpdate(
      schedule.targetDeviceId
    );
    if (existingActive) {
      if (schedule.lastMaterializedSessionId === existingActive.sessionId) {
        const existingCmd = await repos.commands.findLatestBySessionAndType(
          existingActive.sessionId,
          'START_ARREST'
        );
        if (existingCmd) {
          return {
            schedule,
            sessionId: existingActive.sessionId,
            command: existingCmd,
            idempotentReplay: true
          };
        }
      }
      throw Errors.conflict(
        'ACTIVE_SESSION_EXISTS',
        'Target device already has a conflicting active or pending session.',
        { existingSessionId: existingActive.sessionId }
      );
    }

    // Compute remaining duration bounded by occurrenceEnd so a session started mid-window never overruns occurrenceEnd
    const remainingMinutes = Math.max(
      1,
      Math.min(
        schedule.durationMinutes,
        Math.ceil((occurrenceEnd.getTime() - Math.max(now.getTime(), occurrenceStart.getTime())) / 60_000)
      )
    );

    const sessionId = randomUUID();
    const commandId = randomUUID();
    const occurrenceIndex = schedule.occurrencesCompleted + 1;

    await repos.sessions.create({
      sessionId,
      localSessionId: null,
      ownerUserId: schedule.ownerUserId,
      targetDeviceId: schedule.targetDeviceId,
      initiatedByUserId: schedule.partnerUserId,
      authorizationId: schedule.permissionId,
      idempotencyKey: `sched_${schedule.scheduleId}_occ_${occurrenceIndex}`,
      sessionType: schedule.sessionType,
      goal: schedule.goal,
      blockingConfiguration: schedule.blockingConfiguration,
      requestedDuration: remainingMinutes,
      status: 'REQUESTED',
      localEngineState: null,
      requestedAt: now,
      acceptedAt: null,
      startedAt: null,
      expectedEndAt: occurrenceEnd,
      completedAt: null,
      completionReason: null,
      createdAt: now,
      updatedAt: now
    });

    const commandPayload: Record<string, unknown> = {
      schemaVersion: 1,
      sessionId,
      scheduleId: schedule.scheduleId,
      occurrenceIndex,
      sessionType: schedule.sessionType,
      durationMinutes: remainingMinutes,
      goal: schedule.goal,
      ruleMode: schedule.blockingConfiguration.ruleMode,
      allowedCategories: schedule.blockingConfiguration.allowedCategories,
      overlayStatusBar: schedule.blockingConfiguration.overlayStatusBar,
      disableEmergencyExit: schedule.blockingConfiguration.disableEmergencyExit,
      ...(schedule.blockingConfiguration.blockedPackages
        ? { blockedPackages: schedule.blockingConfiguration.blockedPackages }
        : {}),
      ...(schedule.blockingConfiguration.allowedStudyPackages
        ? { allowedStudyPackages: schedule.blockingConfiguration.allowedStudyPackages }
        : {}),
      authorizationId: schedule.permissionId,
      initiatedByUserId: schedule.partnerUserId,
      scheduledStartAtUtc: occurrenceStart.toISOString(),
      scheduledEndAtUtc: occurrenceEnd.toISOString()
    };

    const command = await repos.commands.create({
      commandId,
      sessionId,
      targetDeviceId: schedule.targetDeviceId,
      issuedByUserId: schedule.partnerUserId,
      commandType: 'START_ARREST',
      payload: commandPayload,
      status: 'PENDING',
      idempotencyKey: `start_sched_${schedule.scheduleId}_${occurrenceIndex}`,
      resultMetadata: null,
      failureReason: null,
      pushDeliveryStatus: 'NOT_ATTEMPTED',
      pushAttempts: 0,
      lastPushAttemptAt: null,
      createdAt: now,
      expiresAt: occurrenceEnd,
      deliveredAt: null,
      acknowledgedAt: null,
      executedAt: null,
      updatedAt: now
    });

    if (schedule.permissionId) {
      await repos.partnerPermissions.incrementUsedCount(schedule.permissionId, now);
    }

    let nextOccurrenceAt: Date | null = null;
    let nextStatus: ScheduledArrestStatus = 'COMPLETED';

    if (
      schedule.scheduleType === 'RECURRING' &&
      schedule.recurrenceRule &&
      occurrenceIndex < schedule.maxOccurrences
    ) {
      nextOccurrenceAt = computeNextRecurrenceUtc(schedule.recurrenceRule, occurrenceEnd);
      nextStatus = nextOccurrenceAt ? 'SCHEDULED' : 'COMPLETED';
    }

    const updatedSchedule = await repos.scheduledArrests.updateStatusAndOccurrence(
      schedule.scheduleId,
      {
        status: nextStatus,
        occurrencesCompleted: occurrenceIndex,
        nextOccurrenceAt,
        lastMaterializedSessionId: sessionId,
        lastMaterializedAt: now,
        updatedAt: now
      }
    );

    await this.auditService.record(repos.auditLogs, {
      actorUserId: schedule.partnerUserId,
      actorDeviceId: schedule.targetDeviceId,
      action: 'SCHEDULED_ARREST_MATERIALIZED',
      resourceType: 'SCHEDULED_ARREST',
      resourceId: schedule.scheduleId,
      result: 'SUCCESS',
      context,
      metadata: {
        sessionId,
        commandId,
        occurrenceIndex,
        nextStatus,
        nextOccurrenceAt: nextOccurrenceAt ? nextOccurrenceAt.toISOString() : null
      }
    });

    return {
      schedule: updatedSchedule,
      sessionId,
      command,
      idempotentReplay: false
    };
  }

  public async hydrateSingle(record: ScheduledArrestRecord): Promise<SerializedScheduledArrest> {
    const [users, devices] = await Promise.all([
      this.store.repositories.users.findByIds([record.ownerUserId, record.partnerUserId]),
      this.store.repositories.devices.findByIds([record.targetDeviceId])
    ]);
    return this.formatSchedule(record, users, devices);
  }

  public formatSchedule(
    record: ScheduledArrestRecord,
    users: Map<string, UserRecord>,
    devices: Map<string, DeviceRecord>
  ): SerializedScheduledArrest {
    const ownerRec = users.get(record.ownerUserId);
    const partnerRec = users.get(record.partnerUserId);
    const deviceRec = devices.get(record.targetDeviceId);

    return {
      scheduleId: record.scheduleId,
      proposalId: record.proposalId,
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
      scheduleType: record.scheduleType,
      sessionType: record.sessionType,
      goal: record.goal,
      durationMinutes: record.durationMinutes,
      blockingConfiguration: record.blockingConfiguration,
      timezone: record.timezone,
      scheduledStartAt: record.scheduledStartAt ? record.scheduledStartAt.toISOString() : null,
      scheduledEndAt: record.scheduledEndAt ? record.scheduledEndAt.toISOString() : null,
      recurrenceRule: record.recurrenceRule,
      occurrencesCompleted: record.occurrencesCompleted,
      maxOccurrences: record.maxOccurrences,
      nextOccurrenceAt: record.nextOccurrenceAt ? record.nextOccurrenceAt.toISOString() : null,
      lastMaterializedSessionId: record.lastMaterializedSessionId ?? null,
      lastMaterializedAt: record.lastMaterializedAt
        ? record.lastMaterializedAt.toISOString()
        : null,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString()
    };
  }
}
