import { randomUUID } from 'node:crypto';
import type { AuditService, RequestContextMeta } from '../../services/audit.service';
import { Errors } from '../../shared/errors';
import {
  computeNextRecurrenceUtc,
  resolveLocalDateTimeToUtc,
  type AllowedTimeWindowsConfig,
  type Clock,
  type RecurrenceRuleConfig
} from '../../shared/time';
import type {
  ArrestProposalRecord,
  ArrestProposalRevisionRecord,
  ArrestProposalStatus,
  ArrestRequestType,
  ArrestSessionRecord,
  BlockingConfigLimitsV1,
  BlockingConfigurationV1,
  DeviceRecord,
  ExactApprovedSessionConfig,
  NormalizedProposalConfigurationV1,
  PaginatedResult,
  PartnerPermissionRecord,
  PublicUserProfile,
  ScheduledArrestRecord,
  SessionCommandRecord,
  UserRecord
} from '../../types/domain';
import type { DataStore } from '../../types/repositories';
import type { NotificationService } from '../notifications/notification.service';
import type {
  PermissionsService,
  SerializedPartnerPermission
} from '../permissions/permissions.service';
import type {
  SchedulesService,
  SerializedScheduledArrest
} from '../schedules/schedules.service';
import { serializeSession, type SerializedArrestSession } from '../sessions/sessions.service';
import { serializePublicUser } from '../users/users.service';

export interface SerializedProposalRevision {
  id: string;
  proposalId: string;
  revisionNumber: number;
  proposer: PublicUserProfile;
  recipient: PublicUserProfile;
  normalizedConfiguration: NormalizedProposalConfigurationV1;
  reason: string | null;
  status: ArrestProposalStatus;
  createdAt: string;
  expiresAt: string;
}

export interface SerializedProposal {
  proposalId: string;
  partnershipId: string;
  owner: PublicUserProfile;
  partner: PublicUserProfile;
  targetDevice: {
    id: string;
    deviceName: string;
    platform: 'ANDROID';
    deviceStatus: 'ACTIVE' | 'INACTIVE' | 'REVOKED';
  };
  proposer: PublicUserProfile;
  recipient: PublicUserProfile;
  requestType: ArrestRequestType;
  currentRevision: number;
  status: ArrestProposalStatus;
  normalizedConfiguration: NormalizedProposalConfigurationV1;
  reason: string | null;
  approvedRevision: number | null;
  resultingPermissionId: string | null;
  resultingSessionId: string | null;
  resultingScheduleId: string | null;
  expiresAt: string;
  respondedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revisions?: SerializedProposalRevision[];
}

export class ProposalsService {
  constructor(
    private readonly store: DataStore,
    private readonly permissionsService: PermissionsService,
    private readonly schedulesService: SchedulesService,
    private readonly notificationService: NotificationService,
    private readonly auditService: AuditService,
    private readonly clock: Clock,
    private readonly defaultCommandTtlSeconds: number,
    private readonly maxSessionDurationMinutes: number
  ) {}

  async createProposal(
    actorUserId: string,
    input: {
      targetDeviceId: string;
      partnerUserId?: string;
      requestType: ArrestRequestType;
      sessionType: 'PARTNER_ARREST' | 'MUTUAL_ARREST';
      goal: string;
      durationMinutes: number;
      blockingConfiguration: BlockingConfigurationV1;
      requireApprovalBeforeArrest?: boolean;
      schedule?: {
        localDate: string;
        localStartTime: string;
        localEndTime?: string | null;
        timezone: string;
      } | null;
      recurrence?: RecurrenceRuleConfig | null;
      standingAuthorization?: {
        validFromUtc?: string;
        expiresAtUtc: string;
        maximumSessionDuration: number;
        allowedTimeWindows?: AllowedTimeWindowsConfig | null;
        blockingConfigLimits?: BlockingConfigLimitsV1;
      } | null;
      reason?: string | null;
      ttlMinutes?: number;
      idempotencyKey?: string;
    },
    context?: RequestContextMeta
  ): Promise<SerializedProposal> {
    if (input.idempotencyKey) {
      const existing = await this.store.repositories.proposals.findByProposerAndIdempotencyKey(
        actorUserId,
        input.idempotencyKey
      );
      if (existing) {
        return this.hydrateProposal(existing, true);
      }
    }

    const created = await this.store.withTransaction(async (repos) => {
      if (input.idempotencyKey) {
        const raceExisting = await repos.proposals.findByProposerAndIdempotencyKey(
          actorUserId,
          input.idempotencyKey
        );
        if (raceExisting) {
          return raceExisting;
        }
      }

      const targetDevice = await repos.devices.findByIdForUpdate(input.targetDeviceId);
      if (!targetDevice) {
        throw Errors.notFound('DEVICE_NOT_FOUND', 'Target device was not found.');
      }
      if (targetDevice.deviceStatus !== 'ACTIVE') {
        throw Errors.conflict('DEVICE_REVOKED', 'Target device is not active.');
      }

      const ownerUserId = targetDevice.userId;
      let partnerUserId: string;

      if (actorUserId === ownerUserId) {
        if (!input.partnerUserId || input.partnerUserId === ownerUserId) {
          throw Errors.badRequest(
            'BAD_REQUEST',
            'partnerUserId is required when proposing an Arrest on your own device.'
          );
        }
        partnerUserId = input.partnerUserId;
      } else {
        if (input.partnerUserId && input.partnerUserId !== actorUserId && input.partnerUserId !== ownerUserId) {
          throw Errors.forbidden(
            'PERMISSION_SCOPE_MISMATCH',
            'You can only create a proposal involving yourself and your accepted partner.'
          );
        }
        partnerUserId = actorUserId;
      }

      const partnership = await repos.partnerships.findByPairForUpdate(ownerUserId, partnerUserId);
      if (!partnership || partnership.state !== 'ACCEPTED') {
        throw Errors.forbidden(
          'PARTNERSHIP_REQUIRED',
          'An accepted partnership is required to create an Arrest proposal.'
        );
      }

      const now = this.clock.now();
      const normalizedConfig = this.buildAndValidateNormalizedConfig({
        requestType: input.requestType,
        targetDeviceId: targetDevice.id,
        ownerUserId,
        initiatingPartnerUserId: partnerUserId,
        sessionType: input.sessionType,
        goal: input.goal,
        durationMinutes: input.durationMinutes,
        blockingConfiguration: input.blockingConfiguration,
        requireApprovalBeforeArrest:
          input.requireApprovalBeforeArrest ??
          (input.requestType === 'STANDING_AUTHORIZATION' ? false : true),
        schedule: input.schedule ?? null,
        recurrence: input.recurrence ?? null,
        standingAuthorization: input.standingAuthorization ?? null,
        now
      });

      const recipientUserId = actorUserId === ownerUserId ? partnerUserId : ownerUserId;
      const proposalId = randomUUID();
      const ttlMs = (input.ttlMinutes ?? 1440) * 60_000;
      const expiresAt = new Date(now.getTime() + ttlMs);

      const proposalRecord: ArrestProposalRecord = {
        proposalId,
        partnershipId: partnership.id,
        ownerUserId,
        partnerUserId,
        targetDeviceId: targetDevice.id,
        proposerUserId: actorUserId,
        recipientUserId,
        requestType: input.requestType,
        currentRevision: 1,
        status: 'PENDING',
        normalizedConfiguration: normalizedConfig,
        reason: input.reason ?? null,
        approvedRevision: null,
        resultingPermissionId: null,
        resultingSessionId: null,
        resultingScheduleId: null,
        idempotencyKey: input.idempotencyKey ?? null,
        expiresAt,
        respondedAt: null,
        createdAt: now,
        updatedAt: now
      };

      const initialRevision: ArrestProposalRevisionRecord = {
        id: randomUUID(),
        proposalId,
        revisionNumber: 1,
        proposerUserId: actorUserId,
        recipientUserId,
        normalizedConfiguration: normalizedConfig,
        reason: input.reason ?? null,
        status: 'PENDING',
        createdAt: now,
        expiresAt
      };

      await repos.proposals.createWithInitialRevision(proposalRecord, initialRevision);

      await this.auditService.record(repos.auditLogs, {
        actorUserId,
        actorDeviceId: targetDevice.id,
        action: 'ARREST_PROPOSAL_CREATED',
        resourceType: 'ARREST_PROPOSAL',
        resourceId: proposalId,
        result: 'SUCCESS',
        context,
        metadata: {
          ownerUserId,
          partnerUserId,
          requestType: input.requestType,
          revisionNumber: 1
        }
      });

      return proposalRecord;
    });

    await this.notificationService.notifyUserEvent(
      created.recipientUserId,
      'PROPOSAL_CREATED',
      created.proposalId
    );

    return this.hydrateProposal(created, true);
  }

  async listProposals(
    userId: string,
    options: {
      role?: 'incoming' | 'outgoing' | 'all';
      status?: ArrestProposalStatus;
      partnerUserId?: string;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<SerializedProposal>> {
    const now = this.clock.now();
    await this.store.repositories.proposals.expireOverdueProposals(now);

    const page = await this.store.repositories.proposals.listForUser(userId, options);
    const userIds = page.items.flatMap((p) => [
      p.ownerUserId,
      p.partnerUserId,
      p.proposerUserId,
      p.recipientUserId
    ]);
    const deviceIds = page.items.map((p) => p.targetDeviceId);

    const [users, devices] = await Promise.all([
      this.store.repositories.users.findByIds(userIds),
      this.store.repositories.devices.findByIds(deviceIds)
    ]);

    return {
      ...page,
      items: page.items.map((item) => this.formatProposal(item, users, devices))
    };
  }

  async getProposalById(userId: string, proposalId: string): Promise<SerializedProposal> {
    const now = this.clock.now();
    await this.store.repositories.proposals.expireOverdueProposals(now);

    const proposal = await this.store.repositories.proposals.findById(proposalId);
    if (!proposal || (proposal.ownerUserId !== userId && proposal.partnerUserId !== userId)) {
      throw Errors.notFound('PROPOSAL_NOT_FOUND', 'Arrest proposal was not found.');
    }
    return this.hydrateProposal(proposal, true);
  }

  async counterofferProposal(
    actorUserId: string,
    proposalId: string,
    input: {
      expectedRevisionNumber: number;
      requestType?: ArrestRequestType;
      sessionType?: 'PARTNER_ARREST' | 'MUTUAL_ARREST';
      goal?: string;
      durationMinutes?: number;
      blockingConfiguration?: BlockingConfigurationV1;
      requireApprovalBeforeArrest?: boolean;
      schedule?: {
        localDate: string;
        localStartTime: string;
        localEndTime?: string | null;
        timezone: string;
      } | null;
      recurrence?: RecurrenceRuleConfig | null;
      standingAuthorization?: {
        validFromUtc?: string;
        expiresAtUtc: string;
        maximumSessionDuration: number;
        allowedTimeWindows?: AllowedTimeWindowsConfig | null;
        blockingConfigLimits?: BlockingConfigLimitsV1;
      } | null;
      reason?: string | null;
      ttlMinutes?: number;
    },
    context?: RequestContextMeta
  ): Promise<SerializedProposal> {
    const outcome = await this.store.withTransaction(
      async (
        repos
      ): Promise<
        | { ok: true; proposal: ArrestProposalRecord }
        | {
            ok: false;
            error:
              | 'NOT_FOUND'
              | 'EXPIRED'
              | 'INVALID_STATE'
              | 'STALE_REVISION'
              | 'PARTNERSHIP_INACTIVE';
            currentRevision?: number;
            status?: ArrestProposalStatus;
          }
      > => {
        const existing = await repos.proposals.findByIdForUpdate(proposalId);
        if (
          !existing ||
          (existing.ownerUserId !== actorUserId && existing.partnerUserId !== actorUserId)
        ) {
          return { ok: false, error: 'NOT_FOUND' };
        }

        const now = this.clock.now();
        if (
          (existing.status === 'PENDING' || existing.status === 'COUNTEROFFERED') &&
          existing.expiresAt.getTime() <= now.getTime()
        ) {
          await repos.proposals.updateStatusAndOutcome(proposalId, {
            status: 'EXPIRED',
            respondedAt: now,
            updatedAt: now
          });
          return { ok: false, error: 'EXPIRED' };
        }

        if (existing.status !== 'PENDING' && existing.status !== 'COUNTEROFFERED') {
          return { ok: false, error: 'INVALID_STATE', status: existing.status };
        }

        if (existing.currentRevision !== input.expectedRevisionNumber) {
          return {
            ok: false,
            error: 'STALE_REVISION',
            currentRevision: existing.currentRevision
          };
        }

        const partnership = await repos.partnerships.findByPairForUpdate(
          existing.ownerUserId,
          existing.partnerUserId
        );
        if (!partnership || partnership.state !== 'ACCEPTED') {
          return { ok: false, error: 'PARTNERSHIP_INACTIVE' };
        }

        const prevNorm = existing.normalizedConfiguration;
        const nextRequestType = input.requestType ?? existing.requestType;
        const nextDuration = input.durationMinutes ?? prevNorm.durationMinutes;

        const nextScheduleInput =
          input.schedule !== undefined
            ? input.schedule
            : prevNorm.schedule
              ? {
                  localDate: prevNorm.schedule.localDate,
                  localStartTime: prevNorm.schedule.localStartTime,
                  localEndTime: prevNorm.schedule.localEndTime,
                  timezone: prevNorm.schedule.timezone
                }
              : null;

        const nextRecurrenceInput =
          input.recurrence !== undefined ? input.recurrence : prevNorm.recurrence;

        const nextStandingInput =
          input.standingAuthorization !== undefined
            ? input.standingAuthorization
            : prevNorm.standingAuthorization;

        const normalizedConfig = this.buildAndValidateNormalizedConfig({
          requestType: nextRequestType,
          targetDeviceId: existing.targetDeviceId,
          ownerUserId: existing.ownerUserId,
          initiatingPartnerUserId: existing.partnerUserId,
          sessionType: input.sessionType ?? prevNorm.sessionType,
          goal: input.goal ?? prevNorm.goal,
          durationMinutes: nextDuration,
          blockingConfiguration: input.blockingConfiguration ?? prevNorm.blockingConfiguration,
          requireApprovalBeforeArrest:
            input.requireApprovalBeforeArrest ?? prevNorm.requireApprovalBeforeArrest,
          schedule: nextScheduleInput,
          recurrence: nextRecurrenceInput,
          standingAuthorization: nextStandingInput,
          now
        });

        const nextRevisionNumber = existing.currentRevision + 1;
        const recipientUserId =
          actorUserId === existing.ownerUserId ? existing.partnerUserId : existing.ownerUserId;
        const ttlMs = (input.ttlMinutes ?? 1440) * 60_000;
        const expiresAt = new Date(now.getTime() + ttlMs);

        const revisionRecord: ArrestProposalRevisionRecord = {
          id: randomUUID(),
          proposalId,
          revisionNumber: nextRevisionNumber,
          proposerUserId: actorUserId,
          recipientUserId,
          normalizedConfiguration: normalizedConfig,
          reason: input.reason ?? null,
          status: 'COUNTEROFFERED',
          createdAt: now,
          expiresAt
        };

        const { proposal: updatedProposal } = await repos.proposals.addCounterofferRevision(
          proposalId,
          {
            proposerUserId: actorUserId,
            recipientUserId,
            requestType: nextRequestType,
            currentRevision: nextRevisionNumber,
            status: 'COUNTEROFFERED',
            normalizedConfiguration: normalizedConfig,
            reason: input.reason ?? null,
            expiresAt,
            updatedAt: now
          },
          revisionRecord
        );

        await this.auditService.record(repos.auditLogs, {
          actorUserId,
          actorDeviceId: existing.targetDeviceId,
          action: 'ARREST_PROPOSAL_COUNTEROFFERED',
          resourceType: 'ARREST_PROPOSAL',
          resourceId: proposalId,
          result: 'SUCCESS',
          context,
          metadata: {
            revisionNumber: nextRevisionNumber,
            recipientUserId
          }
        });

        return { ok: true, proposal: updatedProposal };
      }
    );

    if (!outcome.ok) {
      switch (outcome.error) {
        case 'EXPIRED':
          throw Errors.conflict('PROPOSAL_EXPIRED', 'Proposal has already expired.');
        case 'INVALID_STATE':
          throw Errors.conflict(
            'PROPOSAL_INVALID_STATE',
            `Cannot counteroffer a proposal in state ${outcome.status}.`
          );
        case 'STALE_REVISION':
          throw Errors.conflict(
            'STALE_PROPOSAL_REVISION',
            `Proposal revision is stale. Expected revision ${outcome.currentRevision}.`,
            { currentRevision: outcome.currentRevision }
          );
        case 'PARTNERSHIP_INACTIVE':
          throw Errors.forbidden(
            'PARTNERSHIP_REQUIRED',
            'Partnership is no longer active.'
          );
        default:
          throw Errors.notFound('PROPOSAL_NOT_FOUND', 'Arrest proposal was not found.');
      }
    }

    await this.notificationService.notifyUserEvent(
      outcome.proposal.recipientUserId,
      'PROPOSAL_COUNTEROFFERED',
      outcome.proposal.proposalId
    );

    return this.hydrateProposal(outcome.proposal, true);
  }

  async acceptProposal(
    actorUserId: string,
    proposalId: string,
    input: { expectedRevisionNumber: number; startImmediateSession?: boolean },
    context?: RequestContextMeta
  ): Promise<{
    proposal: SerializedProposal;
    permission: SerializedPartnerPermission | null;
    session: SerializedArrestSession | null;
    schedule: SerializedScheduledArrest | null;
  }> {
    const outcome = await this.store.withTransaction(
      async (
        repos
      ): Promise<
        | {
            ok: true;
            proposal: ArrestProposalRecord;
            permission: PartnerPermissionRecord;
            session: ArrestSessionRecord | null;
            command: SessionCommandRecord | null;
            schedule: ScheduledArrestRecord | null;
          }
        | {
            ok: false;
            error:
              | 'NOT_FOUND'
              | 'EXPIRED'
              | 'INVALID_STATE'
              | 'STALE_REVISION'
              | 'FORBIDDEN_NOT_RECIPIENT'
              | 'PARTNERSHIP_INACTIVE'
              | 'DEVICE_INACTIVE';
            currentRevision?: number;
            status?: ArrestProposalStatus;
          }
      > => {
        const existing = await repos.proposals.findByIdForUpdate(proposalId);
        if (
          !existing ||
          (existing.ownerUserId !== actorUserId && existing.partnerUserId !== actorUserId)
        ) {
          return { ok: false, error: 'NOT_FOUND' };
        }

        const now = this.clock.now();
        if (
          (existing.status === 'PENDING' || existing.status === 'COUNTEROFFERED') &&
          existing.expiresAt.getTime() <= now.getTime()
        ) {
          await repos.proposals.updateStatusAndOutcome(proposalId, {
            status: 'EXPIRED',
            respondedAt: now,
            updatedAt: now
          });
          return { ok: false, error: 'EXPIRED' };
        }

        if (existing.status !== 'PENDING' && existing.status !== 'COUNTEROFFERED') {
          return { ok: false, error: 'INVALID_STATE', status: existing.status };
        }

        if (existing.currentRevision !== input.expectedRevisionNumber) {
          return {
            ok: false,
            error: 'STALE_REVISION',
            currentRevision: existing.currentRevision
          };
        }

        if (existing.recipientUserId !== actorUserId) {
          return { ok: false, error: 'FORBIDDEN_NOT_RECIPIENT' };
        }

        const partnership = await repos.partnerships.findByPairForUpdate(
          existing.ownerUserId,
          existing.partnerUserId
        );
        if (!partnership || partnership.state !== 'ACCEPTED') {
          return { ok: false, error: 'PARTNERSHIP_INACTIVE' };
        }

        const targetDevice = await repos.devices.findByIdForUpdate(existing.targetDeviceId);
        if (!targetDevice || targetDevice.deviceStatus !== 'ACTIVE') {
          return { ok: false, error: 'DEVICE_INACTIVE' };
        }

        const norm = existing.normalizedConfiguration;
        const cfg = norm.blockingConfiguration;
        const exactConfig: ExactApprovedSessionConfig = {
          sessionType: norm.sessionType,
          goal: norm.goal,
          durationMinutes: norm.durationMinutes,
          blockingConfiguration: cfg
        };

        const exactLimits: BlockingConfigLimitsV1 = {
          schemaVersion: 1,
          allowedRuleModes: [cfg.ruleMode],
          allowDisableEmergencyExit: cfg.disableEmergencyExit,
          allowOverlayStatusBar: cfg.overlayStatusBar,
          requiredAllowedCategories: cfg.allowedCategories,
          allowCustomPackageLists: Boolean(
            (cfg.blockedPackages && cfg.blockedPackages.length > 0) ||
              (cfg.allowedStudyPackages && cfg.allowedStudyPackages.length > 0)
          )
        };

        const permissionId = randomUUID();
        let createdPermission: PartnerPermissionRecord;
        let createdSession: ArrestSessionRecord | null = null;
        let createdCommand: SessionCommandRecord | null = null;
        let createdSchedule: ScheduledArrestRecord | null = null;

        if (existing.requestType === 'STANDING_AUTHORIZATION') {
          const standing = norm.standingAuthorization!;
          const validFrom = new Date(standing.validFromUtc);
          const expiresAt = new Date(standing.expiresAtUtc);
          if (expiresAt.getTime() <= now.getTime()) {
            return { ok: false, error: 'EXPIRED' };
          }

          createdPermission = await repos.partnerPermissions.create({
            permissionId,
            ownerUserId: existing.ownerUserId,
            partnerUserId: existing.partnerUserId,
            targetDeviceId: existing.targetDeviceId,
            proposalId: existing.proposalId,
            approvedRevision: existing.currentRevision,
            exactBlockingConfiguration: null,
            maximumSessionDuration: standing.maximumSessionDuration,
            allowedTimeWindows: standing.allowedTimeWindows,
            allowedSessionTypes: [norm.sessionType],
            blockingConfigLimits: standing.blockingConfigLimits,
            oneTimeOnly: false,
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

          await repos.approvalPolicies.upsert({
            id: randomUUID(),
            ownerUserId: existing.ownerUserId,
            partnerUserId: existing.partnerUserId,
            requireApprovalBeforeArrest: norm.requireApprovalBeforeArrest,
            explicitlyConfigured: true,
            notes: `Updated via Standing Authorization proposal ${existing.proposalId}`,
            now
          });
        } else if (existing.requestType === 'SCHEDULED') {
          const schedSpec = norm.schedule!;
          const scheduledStartAt = new Date(schedSpec.scheduledStartUtc);
          const scheduledEndAt = new Date(schedSpec.scheduledEndUtc);
          const validFrom = new Date(
            Math.min(now.getTime(), scheduledStartAt.getTime() - 15 * 60_000)
          );
          const expiresAt = new Date(scheduledEndAt.getTime() + 2 * 3600_000);

          createdPermission = await repos.partnerPermissions.create({
            permissionId,
            ownerUserId: existing.ownerUserId,
            partnerUserId: existing.partnerUserId,
            targetDeviceId: existing.targetDeviceId,
            proposalId: existing.proposalId,
            approvedRevision: existing.currentRevision,
            exactBlockingConfiguration: exactConfig,
            maximumSessionDuration: norm.durationMinutes,
            allowedTimeWindows: null,
            allowedSessionTypes: [norm.sessionType],
            blockingConfigLimits: exactLimits,
            oneTimeOnly: true,
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

          createdSchedule = await repos.scheduledArrests.create({
            scheduleId: randomUUID(),
            proposalId: existing.proposalId,
            permissionId,
            ownerUserId: existing.ownerUserId,
            partnerUserId: existing.partnerUserId,
            targetDeviceId: existing.targetDeviceId,
            scheduleType: 'SCHEDULED',
            sessionType: norm.sessionType,
            goal: norm.goal,
            durationMinutes: norm.durationMinutes,
            blockingConfiguration: cfg,
            timezone: schedSpec.timezone,
            scheduledStartAt,
            scheduledEndAt,
            recurrenceRule: null,
            occurrencesCompleted: 0,
            maxOccurrences: 1,
            nextOccurrenceAt: scheduledStartAt,
            status: 'SCHEDULED',
            createdAt: now,
            updatedAt: now
          });
        } else if (existing.requestType === 'RECURRING') {
          const recRule = norm.recurrence!;
          const nextOccurrenceAt = computeNextRecurrenceUtc(recRule, now, 0);
          if (!nextOccurrenceAt) {
            return { ok: false, error: 'EXPIRED' };
          }
          const endBoundUtc = resolveLocalDateTimeToUtc(
            recRule.endDate,
            '23:59',
            recRule.timezone
          );
          const expiresAt = new Date(endBoundUtc.getTime() + 24 * 3600_000);

          createdPermission = await repos.partnerPermissions.create({
            permissionId,
            ownerUserId: existing.ownerUserId,
            partnerUserId: existing.partnerUserId,
            targetDeviceId: existing.targetDeviceId,
            proposalId: existing.proposalId,
            approvedRevision: existing.currentRevision,
            exactBlockingConfiguration: exactConfig,
            maximumSessionDuration: norm.durationMinutes,
            allowedTimeWindows: null,
            allowedSessionTypes: [norm.sessionType],
            blockingConfigLimits: exactLimits,
            oneTimeOnly: false,
            usedCount: 0,
            version: 1,
            validFrom: now,
            expiresAt,
            revokedAt: null,
            revokedByUserId: null,
            revokeReason: null,
            createdAt: now,
            updatedAt: now
          });

          createdSchedule = await repos.scheduledArrests.create({
            scheduleId: randomUUID(),
            proposalId: existing.proposalId,
            permissionId,
            ownerUserId: existing.ownerUserId,
            partnerUserId: existing.partnerUserId,
            targetDeviceId: existing.targetDeviceId,
            scheduleType: 'RECURRING',
            sessionType: norm.sessionType,
            goal: norm.goal,
            durationMinutes: norm.durationMinutes,
            blockingConfiguration: cfg,
            timezone: recRule.timezone,
            scheduledStartAt: null,
            scheduledEndAt: null,
            recurrenceRule: recRule,
            occurrencesCompleted: 0,
            maxOccurrences: recRule.maxOccurrences,
            nextOccurrenceAt,
            status: 'SCHEDULED',
            createdAt: now,
            updatedAt: now
          });
        } else {
          // IMMEDIATE
          const expiresAt = new Date(now.getTime() + 24 * 3600_000);
          const shouldAutoStart = input.startImmediateSession ?? true;
          await repos.commands.expireOverdueForDevice(existing.targetDeviceId, now);
          const existingActive = await repos.sessions.findActiveForDeviceForUpdate(
            existing.targetDeviceId
          );

          const startNow = shouldAutoStart && !existingActive;

          createdPermission = await repos.partnerPermissions.create({
            permissionId,
            ownerUserId: existing.ownerUserId,
            partnerUserId: existing.partnerUserId,
            targetDeviceId: existing.targetDeviceId,
            proposalId: existing.proposalId,
            approvedRevision: existing.currentRevision,
            exactBlockingConfiguration: exactConfig,
            maximumSessionDuration: norm.durationMinutes,
            allowedTimeWindows: null,
            allowedSessionTypes: [norm.sessionType],
            blockingConfigLimits: exactLimits,
            oneTimeOnly: true,
            usedCount: startNow ? 1 : 0,
            version: 1,
            validFrom: now,
            expiresAt,
            revokedAt: null,
            revokedByUserId: null,
            revokeReason: null,
            createdAt: now,
            updatedAt: now
          });

          if (startNow) {
            const sessionId = randomUUID();
            const commandId = randomUUID();
            const commandExpiresAt = new Date(
              Math.min(
                expiresAt.getTime(),
                now.getTime() + this.defaultCommandTtlSeconds * 1000
              )
            );

            createdSession = await repos.sessions.create({
              sessionId,
              localSessionId: null,
              ownerUserId: existing.ownerUserId,
              targetDeviceId: existing.targetDeviceId,
              initiatedByUserId: existing.partnerUserId,
              authorizationId: permissionId,
              idempotencyKey: `proposal_${existing.proposalId}_r${existing.currentRevision}`,
              sessionType: norm.sessionType,
              goal: norm.goal,
              blockingConfiguration: cfg,
              requestedDuration: norm.durationMinutes,
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

            createdCommand = await repos.commands.create({
              commandId,
              sessionId,
              targetDeviceId: existing.targetDeviceId,
              issuedByUserId: existing.partnerUserId,
              commandType: 'START_ARREST',
              payload: {
                schemaVersion: 1,
                sessionId,
                sessionType: norm.sessionType,
                durationMinutes: norm.durationMinutes,
                goal: norm.goal,
                ruleMode: cfg.ruleMode,
                allowedCategories: cfg.allowedCategories,
                overlayStatusBar: cfg.overlayStatusBar,
                disableEmergencyExit: cfg.disableEmergencyExit,
                ...(cfg.blockedPackages ? { blockedPackages: cfg.blockedPackages } : {}),
                ...(cfg.allowedStudyPackages
                  ? { allowedStudyPackages: cfg.allowedStudyPackages }
                  : {}),
                authorizationId: permissionId,
                proposalId: existing.proposalId,
                approvedRevision: existing.currentRevision,
                initiatedByUserId: existing.partnerUserId
              },
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
          }
        }

        const updatedProposal = await repos.proposals.updateStatusAndOutcome(proposalId, {
          status: 'APPROVED',
          approvedRevision: existing.currentRevision,
          resultingPermissionId: createdPermission.permissionId,
          resultingSessionId: createdSession?.sessionId ?? null,
          resultingScheduleId: createdSchedule?.scheduleId ?? null,
          respondedAt: now,
          updatedAt: now
        });

        await this.auditService.record(repos.auditLogs, {
          actorUserId,
          actorDeviceId: existing.targetDeviceId,
          action: 'ARREST_PROPOSAL_APPROVED',
          resourceType: 'ARREST_PROPOSAL',
          resourceId: proposalId,
          result: 'SUCCESS',
          context,
          metadata: {
            approvedRevision: existing.currentRevision,
            requestType: existing.requestType,
            resultingPermissionId: createdPermission.permissionId,
            resultingSessionId: createdSession?.sessionId ?? null,
            resultingScheduleId: createdSchedule?.scheduleId ?? null
          }
        });

        return {
          ok: true,
          proposal: updatedProposal,
          permission: createdPermission,
          session: createdSession,
          command: createdCommand,
          schedule: createdSchedule
        };
      }
    );

    if (!outcome.ok) {
      switch (outcome.error) {
        case 'EXPIRED':
          throw Errors.conflict('PROPOSAL_EXPIRED', 'Proposal has already expired.');
        case 'INVALID_STATE':
          throw Errors.conflict(
            'PROPOSAL_INVALID_STATE',
            `Cannot accept a proposal in state ${outcome.status}.`
          );
        case 'STALE_REVISION':
          throw Errors.conflict(
            'STALE_PROPOSAL_REVISION',
            `Proposal revision is stale. Expected revision ${outcome.currentRevision}.`,
            { currentRevision: outcome.currentRevision }
          );
        case 'FORBIDDEN_NOT_RECIPIENT':
          throw Errors.forbidden(
            'FORBIDDEN',
            'Only the recipient of the current proposal revision may accept it.'
          );
        case 'PARTNERSHIP_INACTIVE':
          throw Errors.forbidden('PARTNERSHIP_REQUIRED', 'Partnership is no longer active.');
        case 'DEVICE_INACTIVE':
          throw Errors.conflict('DEVICE_REVOKED', 'Target device is no longer active.');
        default:
          throw Errors.notFound('PROPOSAL_NOT_FOUND', 'Arrest proposal was not found.');
      }
    }

    if (outcome.command) {
      await this.notificationService.notifyCommandAvailable(outcome.command);
    }
    await this.notificationService.notifyUserEvent(
      outcome.proposal.proposerUserId,
      'PROPOSAL_ACCEPTED',
      outcome.proposal.proposalId
    );

    const [serializedProposal, serializedPermission, serializedSchedule] = await Promise.all([
      this.hydrateProposal(outcome.proposal, true),
      this.permissionsService.getPermissionById(
        actorUserId,
        outcome.permission.permissionId
      ),
      outcome.schedule
        ? this.schedulesService.hydrateSingle(outcome.schedule)
        : Promise.resolve(null)
    ]);

    return {
      proposal: serializedProposal,
      permission: serializedPermission,
      session: outcome.session ? serializeSession(outcome.session) : null,
      schedule: serializedSchedule
    };
  }

  async rejectProposal(
    actorUserId: string,
    proposalId: string,
    input: { expectedRevisionNumber?: number; reason?: string },
    context?: RequestContextMeta
  ): Promise<SerializedProposal> {
    const updated = await this.store.withTransaction(async (repos) => {
      const existing = await repos.proposals.findByIdForUpdate(proposalId);
      if (
        !existing ||
        (existing.ownerUserId !== actorUserId && existing.partnerUserId !== actorUserId)
      ) {
        throw Errors.notFound('PROPOSAL_NOT_FOUND', 'Arrest proposal was not found.');
      }

      if (existing.recipientUserId !== actorUserId) {
        throw Errors.forbidden(
          'FORBIDDEN',
          'Only the recipient of the current proposal revision can reject it.'
        );
      }

      if (existing.status !== 'PENDING' && existing.status !== 'COUNTEROFFERED') {
        throw Errors.conflict(
          'PROPOSAL_INVALID_STATE',
          `Cannot reject a proposal in state ${existing.status}.`
        );
      }

      if (
        input.expectedRevisionNumber !== undefined &&
        input.expectedRevisionNumber !== existing.currentRevision
      ) {
        throw Errors.conflict(
          'STALE_PROPOSAL_REVISION',
          `Proposal revision is stale. Expected revision ${existing.currentRevision}.`,
          { currentRevision: existing.currentRevision }
        );
      }

      const now = this.clock.now();
      const result = await repos.proposals.updateStatusAndOutcome(proposalId, {
        status: 'REJECTED',
        respondedAt: now,
        updatedAt: now
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId,
        actorDeviceId: existing.targetDeviceId,
        action: 'ARREST_PROPOSAL_REJECTED',
        resourceType: 'ARREST_PROPOSAL',
        resourceId: proposalId,
        result: 'SUCCESS',
        context,
        metadata: { revisionNumber: existing.currentRevision, reason: input.reason ?? null }
      });

      return result;
    });

    await this.notificationService.notifyUserEvent(
      updated.proposerUserId,
      'PROPOSAL_REJECTED',
      updated.proposalId
    );

    return this.hydrateProposal(updated, true);
  }

  async cancelProposal(
    actorUserId: string,
    proposalId: string,
    input: { expectedRevisionNumber?: number; reason?: string },
    context?: RequestContextMeta
  ): Promise<SerializedProposal> {
    const updated = await this.store.withTransaction(async (repos) => {
      const existing = await repos.proposals.findByIdForUpdate(proposalId);
      if (
        !existing ||
        (existing.ownerUserId !== actorUserId && existing.partnerUserId !== actorUserId)
      ) {
        throw Errors.notFound('PROPOSAL_NOT_FOUND', 'Arrest proposal was not found.');
      }

      if (
        existing.status !== 'PENDING' &&
        existing.status !== 'COUNTEROFFERED' &&
        existing.status !== 'DRAFT'
      ) {
        throw Errors.conflict(
          'PROPOSAL_INVALID_STATE',
          `Cannot cancel a proposal in state ${existing.status}.`
        );
      }

      if (
        input.expectedRevisionNumber !== undefined &&
        input.expectedRevisionNumber !== existing.currentRevision
      ) {
        throw Errors.conflict(
          'STALE_PROPOSAL_REVISION',
          `Proposal revision is stale. Expected revision ${existing.currentRevision}.`,
          { currentRevision: existing.currentRevision }
        );
      }

      const now = this.clock.now();
      const result = await repos.proposals.updateStatusAndOutcome(proposalId, {
        status: 'CANCELLED',
        respondedAt: now,
        updatedAt: now
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId,
        actorDeviceId: existing.targetDeviceId,
        action: 'ARREST_PROPOSAL_CANCELLED',
        resourceType: 'ARREST_PROPOSAL',
        resourceId: proposalId,
        result: 'SUCCESS',
        context,
        metadata: { revisionNumber: existing.currentRevision, reason: input.reason ?? null }
      });

      return result;
    });

    return this.hydrateProposal(updated, true);
  }

  private buildAndValidateNormalizedConfig(params: {
    requestType: ArrestRequestType;
    targetDeviceId: string;
    ownerUserId: string;
    initiatingPartnerUserId: string;
    sessionType: 'PARTNER_ARREST' | 'MUTUAL_ARREST';
    goal: string;
    durationMinutes: number;
    blockingConfiguration: BlockingConfigurationV1;
    requireApprovalBeforeArrest: boolean;
    schedule: {
      localDate: string;
      localStartTime: string;
      localEndTime?: string | null;
      timezone: string;
    } | null;
    recurrence: RecurrenceRuleConfig | null;
    standingAuthorization: {
      validFromUtc?: string;
      expiresAtUtc: string;
      maximumSessionDuration: number;
      allowedTimeWindows?: AllowedTimeWindowsConfig | null;
      blockingConfigLimits?: BlockingConfigLimitsV1;
    } | null;
    now: Date;
  }): NormalizedProposalConfigurationV1 {
    if (params.durationMinutes > this.maxSessionDurationMinutes) {
      throw Errors.badRequest(
        'PERMISSION_LIMIT_EXCEEDED',
        `durationMinutes cannot exceed ${this.maxSessionDurationMinutes} minutes.`
      );
    }

    const normalizedBlocking: BlockingConfigurationV1 = {
      schemaVersion: 1,
      ruleMode: params.blockingConfiguration.ruleMode,
      allowedCategories: Array.from(new Set(params.blockingConfiguration.allowedCategories)),
      overlayStatusBar: params.blockingConfiguration.overlayStatusBar,
      disableEmergencyExit: params.blockingConfiguration.disableEmergencyExit,
      ...(params.blockingConfiguration.blockedPackages
        ? {
            blockedPackages: Array.from(new Set(params.blockingConfiguration.blockedPackages))
          }
        : {}),
      ...(params.blockingConfiguration.allowedStudyPackages
        ? {
            allowedStudyPackages: Array.from(
              new Set(params.blockingConfiguration.allowedStudyPackages)
            )
          }
        : {})
    };

    if (params.requestType === 'SCHEDULED') {
      if (!params.schedule) {
        throw Errors.badRequest(
          'INVALID_SCHEDULE_TIME',
          'schedule is required when requestType is SCHEDULED.'
        );
      }
      const startUtc = resolveLocalDateTimeToUtc(
        params.schedule.localDate,
        params.schedule.localStartTime,
        params.schedule.timezone
      );
      if (startUtc.getTime() <= params.now.getTime()) {
        throw Errors.badRequest(
          'INVALID_SCHEDULE_TIME',
          'Scheduled start time must be in the future.'
        );
      }
      const endUtc = new Date(startUtc.getTime() + params.durationMinutes * 60_000);

      return {
        schemaVersion: 1,
        requestType: 'SCHEDULED',
        targetDeviceId: params.targetDeviceId,
        ownerUserId: params.ownerUserId,
        initiatingPartnerUserId: params.initiatingPartnerUserId,
        sessionType: params.sessionType,
        goal: params.goal,
        durationMinutes: params.durationMinutes,
        blockingConfiguration: normalizedBlocking,
        requireApprovalBeforeArrest: params.requireApprovalBeforeArrest,
        schedule: {
          localDate: params.schedule.localDate,
          localStartTime: params.schedule.localStartTime,
          localEndTime: params.schedule.localEndTime ?? null,
          timezone: params.schedule.timezone,
          scheduledStartUtc: startUtc.toISOString(),
          scheduledEndUtc: endUtc.toISOString()
        },
        recurrence: null,
        standingAuthorization: null
      };
    }

    if (params.requestType === 'RECURRING') {
      if (!params.recurrence) {
        throw Errors.badRequest(
          'INVALID_SCHEDULE_TIME',
          'recurrence is required when requestType is RECURRING.'
        );
      }
      if (params.recurrence.durationMinutes > this.maxSessionDurationMinutes) {
        throw Errors.badRequest(
          'PERMISSION_LIMIT_EXCEEDED',
          `recurrence.durationMinutes cannot exceed ${this.maxSessionDurationMinutes} minutes.`
        );
      }
      const nextOccurrence = computeNextRecurrenceUtc(params.recurrence, params.now, 0);
      if (!nextOccurrence) {
        throw Errors.badRequest(
          'INVALID_SCHEDULE_TIME',
          'Recurring schedule has no future occurrences before endDate.'
        );
      }

      return {
        schemaVersion: 1,
        requestType: 'RECURRING',
        targetDeviceId: params.targetDeviceId,
        ownerUserId: params.ownerUserId,
        initiatingPartnerUserId: params.initiatingPartnerUserId,
        sessionType: params.sessionType,
        goal: params.goal,
        durationMinutes: params.recurrence.durationMinutes,
        blockingConfiguration: normalizedBlocking,
        requireApprovalBeforeArrest: params.requireApprovalBeforeArrest,
        schedule: null,
        recurrence: {
          daysOfWeek: Array.from(new Set(params.recurrence.daysOfWeek)).sort((a, b) => a - b),
          localStartTime: params.recurrence.localStartTime,
          localEndTime: params.recurrence.localEndTime ?? null,
          durationMinutes: params.recurrence.durationMinutes,
          timezone: params.recurrence.timezone,
          endDate: params.recurrence.endDate,
          maxOccurrences: params.recurrence.maxOccurrences
        },
        standingAuthorization: null
      };
    }

    if (params.requestType === 'STANDING_AUTHORIZATION') {
      if (!params.standingAuthorization) {
        throw Errors.badRequest(
          'BAD_REQUEST',
          'standingAuthorization limits and expiration are required when requestType is STANDING_AUTHORIZATION.'
        );
      }
      if (params.standingAuthorization.maximumSessionDuration > this.maxSessionDurationMinutes) {
        throw Errors.badRequest(
          'PERMISSION_LIMIT_EXCEEDED',
          `maximumSessionDuration cannot exceed ${this.maxSessionDurationMinutes} minutes.`
        );
      }
      const validFrom = params.standingAuthorization.validFromUtc
        ? new Date(params.standingAuthorization.validFromUtc)
        : params.now;
      const expiresAt = new Date(params.standingAuthorization.expiresAtUtc);
      if (
        Number.isNaN(expiresAt.getTime()) ||
        expiresAt.getTime() <= validFrom.getTime() ||
        expiresAt.getTime() <= params.now.getTime()
      ) {
        throw Errors.badRequest(
          'BAD_REQUEST',
          'standingAuthorization.expiresAtUtc must be a valid future timestamp after validFromUtc.'
        );
      }

      const limits: BlockingConfigLimitsV1 = {
        schemaVersion: 1,
        allowedRuleModes: params.standingAuthorization.blockingConfigLimits?.allowedRuleModes ?? [
          normalizedBlocking.ruleMode
        ],
        allowDisableEmergencyExit:
          params.standingAuthorization.blockingConfigLimits?.allowDisableEmergencyExit ??
          normalizedBlocking.disableEmergencyExit,
        allowOverlayStatusBar:
          params.standingAuthorization.blockingConfigLimits?.allowOverlayStatusBar ??
          normalizedBlocking.overlayStatusBar,
        requiredAllowedCategories:
          params.standingAuthorization.blockingConfigLimits?.requiredAllowedCategories ??
          normalizedBlocking.allowedCategories,
        allowCustomPackageLists:
          params.standingAuthorization.blockingConfigLimits?.allowCustomPackageLists ?? true,
        ...(params.standingAuthorization.blockingConfigLimits?.dailyMaxSessions !== undefined
          ? {
              dailyMaxSessions:
                params.standingAuthorization.blockingConfigLimits.dailyMaxSessions
            }
          : {}),
        ...(params.standingAuthorization.blockingConfigLimits?.cooldownMinutes !== undefined
          ? {
              cooldownMinutes:
                params.standingAuthorization.blockingConfigLimits.cooldownMinutes
            }
          : {})
      };

      return {
        schemaVersion: 1,
        requestType: 'STANDING_AUTHORIZATION',
        targetDeviceId: params.targetDeviceId,
        ownerUserId: params.ownerUserId,
        initiatingPartnerUserId: params.initiatingPartnerUserId,
        sessionType: params.sessionType,
        goal: params.goal,
        durationMinutes: params.standingAuthorization.maximumSessionDuration,
        blockingConfiguration: normalizedBlocking,
        requireApprovalBeforeArrest: false,
        schedule: null,
        recurrence: null,
        standingAuthorization: {
          validFromUtc: validFrom.toISOString(),
          expiresAtUtc: expiresAt.toISOString(),
          maximumSessionDuration: params.standingAuthorization.maximumSessionDuration,
          allowedTimeWindows: params.standingAuthorization.allowedTimeWindows ?? null,
          blockingConfigLimits: limits
        }
      };
    }

    // IMMEDIATE
    return {
      schemaVersion: 1,
      requestType: 'IMMEDIATE',
      targetDeviceId: params.targetDeviceId,
      ownerUserId: params.ownerUserId,
      initiatingPartnerUserId: params.initiatingPartnerUserId,
      sessionType: params.sessionType,
      goal: params.goal,
      durationMinutes: params.durationMinutes,
      blockingConfiguration: normalizedBlocking,
      requireApprovalBeforeArrest: params.requireApprovalBeforeArrest,
      schedule: null,
      recurrence: null,
      standingAuthorization: null
    };
  }

  public async hydrateProposal(
    record: ArrestProposalRecord,
    includeRevisions = false
  ): Promise<SerializedProposal> {
    const [users, devices, revisions] = await Promise.all([
      this.store.repositories.users.findByIds([
        record.ownerUserId,
        record.partnerUserId,
        record.proposerUserId,
        record.recipientUserId
      ]),
      this.store.repositories.devices.findByIds([record.targetDeviceId]),
      includeRevisions
        ? this.store.repositories.proposals.listRevisions(record.proposalId)
        : Promise.resolve(undefined)
    ]);

    return this.formatProposal(record, users, devices, revisions);
  }

  public formatProposal(
    record: ArrestProposalRecord,
    users: Map<string, UserRecord>,
    devices: Map<string, DeviceRecord>,
    revisions?: ArrestProposalRevisionRecord[]
  ): SerializedProposal {
    const toPub = (id: string): PublicUserProfile => {
      const u = users.get(id);
      return u
        ? serializePublicUser(u)
        : { id, username: 'unknown', displayName: 'Unknown', avatarUrl: null };
    };

    const deviceRec = devices.get(record.targetDeviceId);

    return {
      proposalId: record.proposalId,
      partnershipId: record.partnershipId,
      owner: toPub(record.ownerUserId),
      partner: toPub(record.partnerUserId),
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
      proposer: toPub(record.proposerUserId),
      recipient: toPub(record.recipientUserId),
      requestType: record.requestType,
      currentRevision: record.currentRevision,
      status: record.status,
      normalizedConfiguration: record.normalizedConfiguration,
      reason: record.reason,
      approvedRevision: record.approvedRevision,
      resultingPermissionId: record.resultingPermissionId,
      resultingSessionId: record.resultingSessionId,
      resultingScheduleId: record.resultingScheduleId,
      expiresAt: record.expiresAt.toISOString(),
      respondedAt: record.respondedAt ? record.respondedAt.toISOString() : null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      ...(revisions
        ? {
            revisions: revisions.map((r) => ({
              id: r.id,
              proposalId: r.proposalId,
              revisionNumber: r.revisionNumber,
              proposer: toPub(r.proposerUserId),
              recipient: toPub(r.recipientUserId),
              normalizedConfiguration: r.normalizedConfiguration,
              reason: r.reason,
              status: r.status,
              createdAt: r.createdAt.toISOString(),
              expiresAt: r.expiresAt.toISOString()
            }))
          }
        : {})
    };
  }
}
