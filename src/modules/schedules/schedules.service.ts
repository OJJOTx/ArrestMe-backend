import type { AuditService, RequestContextMeta } from '../../services/audit.service';
import { Errors } from '../../shared/errors';
import type { Clock, RecurrenceRuleConfig } from '../../shared/time';
import type {
  BlockingConfigurationV1,
  DeviceRecord,
  PaginatedResult,
  PublicUserProfile,
  ScheduledArrestRecord,
  ScheduledArrestStatus,
  SessionType,
  UserRecord
} from '../../types/domain';
import type { DataStore } from '../../types/repositories';
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
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString()
    };
  }
}
