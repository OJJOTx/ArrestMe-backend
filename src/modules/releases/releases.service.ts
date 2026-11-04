import { randomUUID } from 'node:crypto';
import { serializeCommand, type SerializedSessionCommand } from '../commands/commands.service';
import type { NotificationService } from '../notifications/notification.service';
import { serializePublicUser } from '../users/users.service';
import type { AuditService, RequestContextMeta } from '../../services/audit.service';
import { Errors } from '../../shared/errors';
import type { Clock } from '../../shared/time';
import {
  TERMINAL_CLOUD_SESSION_STATUSES,
  type PaginatedResult,
  type PublicUserProfile,
  type ReleaseRequestRecord,
  type ReleaseRequestStatus,
  type SessionCommandRecord,
  type UserRecord
} from '../../types/domain';
import type { DataStore } from '../../types/repositories';

export interface SerializedReleaseRequest {
  id: string;
  sessionId: string;
  requester: PublicUserProfile;
  approver: PublicUserProfile;
  reason: string;
  status: ReleaseRequestStatus;
  decisionReason: string | null;
  resolutionCommandId: string | null;
  requestedAt: string;
  decidedAt: string | null;
  updatedAt: string;
}

const RELEASE_ELIGIBLE_SESSION_STATUSES = new Set(['ACTIVE', 'PAUSED', 'INTERRUPTED']);

export class ReleasesService {
  constructor(
    private readonly store: DataStore,
    private readonly notificationService: NotificationService,
    private readonly auditService: AuditService,
    private readonly clock: Clock,
    private readonly defaultCommandTtlSeconds: number
  ) {}

  async createReleaseRequest(
    actorUserId: string,
    sessionId: string,
    input: { reason: string },
    context?: RequestContextMeta
  ): Promise<SerializedReleaseRequest> {
    const outcome = await this.store.withTransaction(
      async (
        repos
      ): Promise<
        | { ok: true; record: ReleaseRequestRecord }
        | {
            ok: false;
            reason:
              | 'SESSION_NOT_FOUND'
              | 'FORBIDDEN_NOT_OWNER'
              | 'SELF_ARREST_NO_PARTNER'
              | 'SESSION_EXPIRED'
              | 'SESSION_INVALID_STATE'
              | 'DUPLICATE_PENDING';
          }
      > => {
        const session = await repos.sessions.findByIdForUpdate(sessionId);
        if (!session) {
          return { ok: false, reason: 'SESSION_NOT_FOUND' };
        }
        if (session.ownerUserId !== actorUserId && session.initiatedByUserId !== actorUserId) {
          return { ok: false, reason: 'SESSION_NOT_FOUND' };
        }
        if (session.ownerUserId !== actorUserId) {
          return { ok: false, reason: 'FORBIDDEN_NOT_OWNER' };
        }
        if (session.sessionType === 'SELF_ARREST' || session.initiatedByUserId === actorUserId) {
          return { ok: false, reason: 'SELF_ARREST_NO_PARTNER' };
        }

        const now = this.clock.now();

        if (TERMINAL_CLOUD_SESSION_STATUSES.includes(session.status)) {
          return { ok: false, reason: 'SESSION_EXPIRED' };
        }

        if (session.expectedEndAt && now.getTime() >= session.expectedEndAt.getTime()) {
          await repos.sessions.updateStatusAndFields(session.sessionId, {
            status: 'COMPLETED',
            localEngineState: 'COMPLETED',
            completedAt: now,
            completionReason: 'Session expected end timestamp elapsed',
            updatedAt: now
          });
          await repos.releaseRequests.expirePendingForSession(session.sessionId, now);
          return { ok: false, reason: 'SESSION_EXPIRED' };
        }

        if (!RELEASE_ELIGIBLE_SESSION_STATUSES.has(session.status)) {
          return { ok: false, reason: 'SESSION_INVALID_STATE' };
        }

        const existingPending = await repos.releaseRequests.findPendingBySessionForUpdate(
          sessionId
        );
        if (existingPending) {
          return { ok: false, reason: 'DUPLICATE_PENDING' };
        }

        const created = await repos.releaseRequests.create({
          id: randomUUID(),
          sessionId,
          requesterUserId: session.ownerUserId,
          approverUserId: session.initiatedByUserId,
          reason: input.reason,
          status: 'PENDING',
          decisionReason: null,
          resolutionCommandId: null,
          requestedAt: now,
          decidedAt: null,
          updatedAt: now
        });

        await this.auditService.record(repos.auditLogs, {
          actorUserId,
          actorDeviceId: session.targetDeviceId,
          action: 'RELEASE_REQUEST_CREATED',
          resourceType: 'RELEASE_REQUEST',
          resourceId: created.id,
          result: 'SUCCESS',
          context,
          metadata: {
            sessionId,
            approverUserId: created.approverUserId
          }
        });

        return { ok: true, record: created };
      }
    );

    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'FORBIDDEN_NOT_OWNER':
          throw Errors.forbidden(
            'FORBIDDEN',
            'Only the arrested device owner can submit an early release request.'
          );
        case 'SELF_ARREST_NO_PARTNER':
          throw Errors.badRequest(
            'BAD_REQUEST',
            'Early partner release requests apply only to partner-controlled sessions.'
          );
        case 'SESSION_EXPIRED':
          throw Errors.conflict(
            'SESSION_EXPIRED',
            'Session has already ended or reached its expiration timestamp.'
          );
        case 'SESSION_INVALID_STATE':
          throw Errors.conflict(
            'SESSION_INVALID_STATE',
            'Early release can only be requested while a session is ACTIVE, PAUSED, or INTERRUPTED.'
          );
        case 'DUPLICATE_PENDING':
          throw Errors.conflict(
            'RELEASE_REQUEST_CONFLICT',
            'A pending release request already exists for this session.'
          );
        default:
          throw Errors.notFound('SESSION_NOT_FOUND', 'Arrest session was not found.');
      }
    }

    await this.notificationService.notifyUserEvent(
      outcome.record.approverUserId,
      'RELEASE_REQUESTED',
      outcome.record.id
    );

    return this.hydrateSingle(outcome.record);
  }

  async listReleaseRequests(
    userId: string,
    options: {
      role: 'incoming' | 'outgoing' | 'all';
      status?: ReleaseRequestStatus;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<SerializedReleaseRequest>> {
    await this.store.repositories.releaseRequests.expirePendingForEndedSessions(this.clock.now());
    const page = await this.store.repositories.releaseRequests.listForUser(userId, options);

    const userIds = page.items.flatMap((r) => [r.requesterUserId, r.approverUserId]);
    const users = await this.store.repositories.users.findByIds(userIds);

    return {
      ...page,
      items: page.items.map((item) => this.formatReleaseRequest(item, users))
    };
  }

  async approveReleaseRequest(
    actorUserId: string,
    releaseRequestId: string,
    input: { decisionReason?: string },
    context?: RequestContextMeta
  ): Promise<{ releaseRequest: SerializedReleaseRequest; command: SerializedSessionCommand }> {
    return this.decideReleaseRequest(actorUserId, releaseRequestId, 'APPROVED', input, context);
  }

  async denyReleaseRequest(
    actorUserId: string,
    releaseRequestId: string,
    input: { decisionReason?: string },
    context?: RequestContextMeta
  ): Promise<{ releaseRequest: SerializedReleaseRequest; command: SerializedSessionCommand }> {
    return this.decideReleaseRequest(actorUserId, releaseRequestId, 'DENIED', input, context);
  }

  private async decideReleaseRequest(
    actorUserId: string,
    releaseRequestId: string,
    decision: 'APPROVED' | 'DENIED',
    input: { decisionReason?: string },
    context?: RequestContextMeta
  ): Promise<{ releaseRequest: SerializedReleaseRequest; command: SerializedSessionCommand }> {
    const outcome = await this.store.withTransaction(
      async (
        repos
      ): Promise<
        | { ok: true; record: ReleaseRequestRecord; command: SessionCommandRecord }
        | {
            ok: false;
            reason:
              | 'NOT_FOUND'
              | 'FORBIDDEN'
              | 'ALREADY_DECIDED'
              | 'SESSION_EXPIRED';
          }
      > => {
        const request = await repos.releaseRequests.findByIdForUpdate(releaseRequestId);
        if (!request) {
          return { ok: false, reason: 'NOT_FOUND' };
        }

        if (request.approverUserId !== actorUserId) {
          await this.auditService.record(repos.auditLogs, {
            actorUserId,
            action: `RELEASE_REQUEST_${decision}_UNAUTHORIZED`,
            resourceType: 'RELEASE_REQUEST',
            resourceId: releaseRequestId,
            result: 'DENIED',
            context
          });
          return { ok: false, reason: 'FORBIDDEN' };
        }

        const now = this.clock.now();
        const session = await repos.sessions.findByIdForUpdate(request.sessionId);
        if (!session) {
          return { ok: false, reason: 'NOT_FOUND' };
        }

        // Handle session expiration during an unresolved release request cleanly
        const sessionEndedOrElapsed =
          TERMINAL_CLOUD_SESSION_STATUSES.includes(session.status) ||
          (session.expectedEndAt !== null && now.getTime() >= session.expectedEndAt.getTime());

        if (sessionEndedOrElapsed) {
          if (!TERMINAL_CLOUD_SESSION_STATUSES.includes(session.status)) {
            await repos.sessions.updateStatusAndFields(session.sessionId, {
              status: 'COMPLETED',
              localEngineState: 'COMPLETED',
              completedAt: now,
              completionReason: 'Session expired prior to release request resolution',
              updatedAt: now
            });
          }
          if (request.status === 'PENDING') {
            await repos.releaseRequests.updateDecision(request.id, {
              status: 'EXPIRED',
              decisionReason: 'Session ended or expired before partner decision',
              decidedAt: now,
              updatedAt: now
            });
          }
          return { ok: false, reason: 'SESSION_EXPIRED' };
        }

        if (request.status !== 'PENDING') {
          return { ok: false, reason: 'ALREADY_DECIDED' };
        }

        const commandId = randomUUID();
        const commandType = decision === 'APPROVED' ? 'APPROVE_RELEASE' : 'DENY_RELEASE';

        const command = await repos.commands.create({
          commandId,
          sessionId: session.sessionId,
          targetDeviceId: session.targetDeviceId,
          issuedByUserId: actorUserId,
          commandType,
          payload: {
            schemaVersion: 1,
            sessionId: session.sessionId,
            releaseRequestId: request.id,
            decision,
            decisionReason: input.decisionReason ?? null
          },
          status: 'PENDING',
          idempotencyKey: `release_${decision.toLowerCase()}_${request.id}`,
          resultMetadata: null,
          failureReason: null,
          pushDeliveryStatus: 'NOT_ATTEMPTED',
          pushAttempts: 0,
          lastPushAttemptAt: null,
          createdAt: now,
          expiresAt: new Date(
            Math.min(
              now.getTime() + this.defaultCommandTtlSeconds * 1000,
              session.expectedEndAt
                ? session.expectedEndAt.getTime() + 60_000
                : now.getTime() + this.defaultCommandTtlSeconds * 1000
            )
          ),
          deliveredAt: null,
          acknowledgedAt: null,
          executedAt: null,
          updatedAt: now
        });

        const updatedRequest = await repos.releaseRequests.updateDecision(request.id, {
          status: decision,
          decisionReason: input.decisionReason ?? null,
          resolutionCommandId: command.commandId,
          decidedAt: now,
          updatedAt: now
        });

        await this.auditService.record(repos.auditLogs, {
          actorUserId,
          actorDeviceId: session.targetDeviceId,
          action: `RELEASE_REQUEST_${decision}`,
          resourceType: 'RELEASE_REQUEST',
          resourceId: request.id,
          result: 'SUCCESS',
          context,
          metadata: {
            sessionId: session.sessionId,
            commandId: command.commandId
          }
        });

        return { ok: true, record: updatedRequest, command };
      }
    );

    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'FORBIDDEN':
          throw Errors.forbidden(
            'FORBIDDEN',
            'Only the designated partner authority for this session can approve or deny release.'
          );
        case 'SESSION_EXPIRED':
          throw Errors.conflict(
            'SESSION_EXPIRED',
            'The linked Arrest session has already ended or expired.'
          );
        case 'ALREADY_DECIDED':
          throw Errors.conflict(
            'RELEASE_REQUEST_INVALID_STATE',
            'This release request has already been resolved.'
          );
        default:
          throw Errors.notFound('RELEASE_REQUEST_NOT_FOUND', 'Release request was not found.');
      }
    }

    await this.notificationService.notifyCommandAvailable(outcome.command);
    const refreshedCmd =
      (await this.store.repositories.commands.findById(outcome.command.commandId)) ??
      outcome.command;

    return {
      releaseRequest: await this.hydrateSingle(outcome.record),
      command: serializeCommand(refreshedCmd)
    };
  }

  private async hydrateSingle(record: ReleaseRequestRecord): Promise<SerializedReleaseRequest> {
    const users = await this.store.repositories.users.findByIds([
      record.requesterUserId,
      record.approverUserId
    ]);
    return this.formatReleaseRequest(record, users);
  }

  private formatReleaseRequest(
    record: ReleaseRequestRecord,
    users: Map<string, UserRecord>
  ): SerializedReleaseRequest {
    const reqUser = users.get(record.requesterUserId);
    const appUser = users.get(record.approverUserId);

    return {
      id: record.id,
      sessionId: record.sessionId,
      requester: reqUser
        ? serializePublicUser(reqUser)
        : {
            id: record.requesterUserId,
            username: 'unknown',
            displayName: 'Unknown',
            avatarUrl: null
          },
      approver: appUser
        ? serializePublicUser(appUser)
        : {
            id: record.approverUserId,
            username: 'unknown',
            displayName: 'Unknown',
            avatarUrl: null
          },
      reason: record.reason,
      status: record.status,
      decisionReason: record.decisionReason,
      resolutionCommandId: record.resolutionCommandId,
      requestedAt: record.requestedAt.toISOString(),
      decidedAt: record.decidedAt ? record.decidedAt.toISOString() : null,
      updatedAt: record.updatedAt.toISOString()
    };
  }
}
