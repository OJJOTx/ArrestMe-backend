import type { AuditService, RequestContextMeta } from '../../services/audit.service';
import { Errors } from '../../shared/errors';
import type { Clock } from '../../shared/time';
import {
  TERMINAL_CLOUD_SESSION_STATUSES,
  type CommandStatus,
  type SessionCommandRecord
} from '../../types/domain';
import type { DataStore, RepositoryBundle } from '../../types/repositories';

export interface SerializedSessionCommand {
  sequenceNo: number;
  commandId: string;
  sessionId: string;
  targetDeviceId: string;
  issuedByUserId: string;
  commandType: SessionCommandRecord['commandType'];
  payload: Record<string, unknown>;
  status: CommandStatus;
  idempotencyKey: string;
  resultMetadata: Record<string, unknown> | null;
  failureReason: string | null;
  createdAt: string;
  expiresAt: string;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  executedAt: string | null;
  updatedAt: string;
}

export function serializeCommand(cmd: SessionCommandRecord): SerializedSessionCommand {
  return {
    sequenceNo: cmd.sequenceNo,
    commandId: cmd.commandId,
    sessionId: cmd.sessionId,
    targetDeviceId: cmd.targetDeviceId,
    issuedByUserId: cmd.issuedByUserId,
    commandType: cmd.commandType,
    payload: cmd.payload,
    status: cmd.status,
    idempotencyKey: cmd.idempotencyKey,
    resultMetadata: cmd.resultMetadata,
    failureReason: cmd.failureReason,
    createdAt: cmd.createdAt.toISOString(),
    expiresAt: cmd.expiresAt.toISOString(),
    deliveredAt: cmd.deliveredAt ? cmd.deliveredAt.toISOString() : null,
    acknowledgedAt: cmd.acknowledgedAt ? cmd.acknowledgedAt.toISOString() : null,
    executedAt: cmd.executedAt ? cmd.executedAt.toISOString() : null,
    updatedAt: cmd.updatedAt.toISOString()
  };
}

const TERMINAL_COMMAND_STATUSES: readonly CommandStatus[] = [
  'EXECUTED',
  'REJECTED',
  'EXPIRED',
  'FAILED'
];

export class CommandsService {
  constructor(
    private readonly store: DataStore,
    private readonly auditService: AuditService,
    private readonly clock: Clock
  ) {}

  async pollDeviceCommands(
    actorUserId: string,
    deviceId: string,
    options: {
      afterSequence: number;
      limit: number;
      includeAcknowledged?: boolean;
    }
  ): Promise<{
    items: SerializedSessionCommand[];
    nextCursorSequence: number;
    serverTime: string;
  }> {
    return this.store.withTransaction(async (repos) => {
      const device = await repos.devices.findByIdForUpdate(deviceId);
      if (!device || device.userId !== actorUserId) {
        throw Errors.notFound('DEVICE_NOT_FOUND', 'Target device was not found.');
      }
      if (device.deviceStatus === 'REVOKED') {
        throw Errors.conflict('DEVICE_REVOKED', 'Revoked devices cannot poll commands.');
      }

      const now = this.clock.now();
      await repos.devices.touchLastSeen(deviceId, now);
      await repos.commands.expireOverdueForDevice(deviceId, now);

      const statuses: CommandStatus[] = options.includeAcknowledged
        ? ['PENDING', 'DELIVERED', 'ACKNOWLEDGED']
        : ['PENDING', 'DELIVERED'];

      const commands = await repos.commands.pollActionableForDevice(deviceId, {
        afterSequence: options.afterSequence,
        statuses,
        limit: options.limit,
        now
      });

      const newlyPendingIds = commands
        .filter((c) => c.status === 'PENDING')
        .map((c) => c.commandId);

      if (newlyPendingIds.length > 0) {
        await repos.commands.markDeliveredBatch(newlyPendingIds, now);
      }

      const updatedItems = commands.map((c) =>
        c.status === 'PENDING'
          ? { ...c, status: 'DELIVERED' as const, deliveredAt: c.deliveredAt ?? now, updatedAt: now }
          : c
      );

      const lastSeq = updatedItems.at(-1)?.sequenceNo ?? options.afterSequence;

      return {
        items: updatedItems.map(serializeCommand),
        nextCursorSequence: lastSeq,
        serverTime: now.toISOString()
      };
    });
  }

  async acknowledgeCommand(
    actorUserId: string,
    commandId: string,
    input: {
      deviceId: string;
      status: 'ACKNOWLEDGED' | 'EXECUTED' | 'REJECTED' | 'FAILED';
      localSessionId?: string;
      executedAtClientMs?: number;
      failureReason?: string;
      resultMetadata?: Record<string, unknown>;
    },
    context?: RequestContextMeta
  ): Promise<{ command: SerializedSessionCommand; idempotentReplay: boolean }> {
    const outcome = await this.store.withTransaction(
      async (
        repos
      ): Promise<
        | { ok: true; command: SessionCommandRecord; idempotentReplay: boolean }
        | {
            ok: false;
            reason:
              | 'COMMAND_NOT_FOUND'
              | 'DEVICE_REVOKED'
              | 'COMMAND_EXPIRED'
              | 'PERMISSION_REVOKED'
              | 'PERMISSION_EXPIRED'
              | 'INVALID_TRANSITION';
            details?: string;
          }
      > => {
        const command = await repos.commands.findByIdForUpdate(commandId);
        if (!command || command.targetDeviceId !== input.deviceId) {
          return { ok: false, reason: 'COMMAND_NOT_FOUND' };
        }

        const device = await repos.devices.findByIdForUpdate(command.targetDeviceId);
        if (!device || device.userId !== actorUserId) {
          return { ok: false, reason: 'COMMAND_NOT_FOUND' };
        }
        if (device.deviceStatus === 'REVOKED') {
          return { ok: false, reason: 'DEVICE_REVOKED' };
        }

        const now = this.clock.now();
        await repos.devices.touchLastSeen(device.id, now);

        // Idempotent replay handling
        if (command.status === input.status) {
          return { ok: true, command, idempotentReplay: true };
        }

        if (TERMINAL_COMMAND_STATUSES.includes(command.status)) {
          if (command.status === 'EXPIRED') {
            return { ok: false, reason: 'COMMAND_EXPIRED' };
          }
          return {
            ok: false,
            reason: 'INVALID_TRANSITION',
            details: `Command is already in terminal state ${command.status}.`
          };
        }

        // Enforce strict command TTL: expired commands must NEVER start new sessions or execute
        if (now.getTime() >= command.expiresAt.getTime()) {
          await repos.commands.updateCommandStatus(command.commandId, {
            status: 'EXPIRED',
            failureReason: 'Command expired before acknowledgment',
            updatedAt: now
          });

          if (command.commandType === 'START_ARREST') {
            const session = await repos.sessions.findByIdForUpdate(command.sessionId);
            if (session && (session.status === 'REQUESTED' || session.status === 'DELIVERED')) {
              await repos.sessions.updateStatusAndFields(session.sessionId, {
                status: 'EXPIRED',
                completedAt: now,
                completionReason: 'START_ARREST command expired prior to execution',
                updatedAt: now
              });
            }
          }
          return { ok: false, reason: 'COMMAND_EXPIRED' };
        }

        const session = await repos.sessions.findByIdForUpdate(command.sessionId);
        if (!session) {
          return { ok: false, reason: 'COMMAND_NOT_FOUND' };
        }

        // Re-verify delegated permission was not revoked/expired before starting a remote session
        if (
          command.commandType === 'START_ARREST' &&
          (input.status === 'ACKNOWLEDGED' || input.status === 'EXECUTED') &&
          session.authorizationId &&
          (session.status === 'REQUESTED' || session.status === 'DELIVERED')
        ) {
          const perm = await repos.partnerPermissions.findByIdForUpdate(session.authorizationId);
          if (!perm || perm.revokedAt !== null) {
            await repos.commands.updateCommandStatus(command.commandId, {
              status: 'REJECTED',
              failureReason: 'Partner authorization was revoked prior to device execution',
              updatedAt: now
            });
            await repos.sessions.updateStatusAndFields(session.sessionId, {
              status: 'CANCELLED',
              completedAt: now,
              completionReason: 'Partner authorization was revoked prior to device execution',
              updatedAt: now
            });
            return { ok: false, reason: 'PERMISSION_REVOKED' };
          }
          if (now.getTime() >= perm.expiresAt.getTime()) {
            await repos.commands.updateCommandStatus(command.commandId, {
              status: 'EXPIRED',
              failureReason: 'Partner authorization expired prior to device execution',
              updatedAt: now
            });
            await repos.sessions.updateStatusAndFields(session.sessionId, {
              status: 'EXPIRED',
              completedAt: now,
              completionReason: 'Partner authorization expired prior to device execution',
              updatedAt: now
            });
            return { ok: false, reason: 'PERMISSION_EXPIRED' };
          }
        }

        const updatedCommand = await this.applyCommandTransitionInTx(
          repos,
          command,
          session,
          input,
          now
        );

        await this.auditService.record(repos.auditLogs, {
          actorUserId,
          actorDeviceId: device.id,
          action: `COMMAND_${input.status}`,
          resourceType: 'SESSION_COMMAND',
          resourceId: command.commandId,
          result: 'SUCCESS',
          context,
          metadata: {
            commandType: command.commandType,
            sessionId: command.sessionId,
            localSessionId: input.localSessionId ?? null
          }
        });

        return { ok: true, command: updatedCommand, idempotentReplay: false };
      }
    );

    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'DEVICE_REVOKED':
          throw Errors.conflict('DEVICE_REVOKED', 'Target device has been revoked.');
        case 'COMMAND_EXPIRED':
          throw Errors.conflict(
            'COMMAND_EXPIRED',
            'Command has expired and must not be executed.'
          );
        case 'PERMISSION_REVOKED':
          throw Errors.forbidden(
            'PERMISSION_REVOKED',
            'Partner authorization was revoked before execution.'
          );
        case 'PERMISSION_EXPIRED':
          throw Errors.forbidden(
            'PERMISSION_EXPIRED',
            'Partner authorization expired before execution.'
          );
        case 'INVALID_TRANSITION':
          throw Errors.conflict(
            'COMMAND_INVALID_TRANSITION',
            outcome.details ?? 'Invalid command state transition.'
          );
        default:
          throw Errors.notFound('COMMAND_NOT_FOUND', 'Command was not found.');
      }
    }

    return {
      command: serializeCommand(outcome.command),
      idempotentReplay: outcome.idempotentReplay
    };
  }

  private async applyCommandTransitionInTx(
    repos: RepositoryBundle,
    command: SessionCommandRecord,
    session: Awaited<ReturnType<RepositoryBundle['sessions']['findById']>> & object,
    input: {
      status: 'ACKNOWLEDGED' | 'EXECUTED' | 'REJECTED' | 'FAILED';
      localSessionId?: string;
      failureReason?: string;
      resultMetadata?: Record<string, unknown>;
    },
    now: Date
  ): Promise<SessionCommandRecord> {
    const acknowledgedAt = command.acknowledgedAt ?? now;
    const executedAt = input.status === 'EXECUTED' ? now : null;

    const updatedCommand = await repos.commands.updateCommandStatus(command.commandId, {
      status: input.status,
      acknowledgedAt,
      executedAt,
      resultMetadata: input.resultMetadata ?? command.resultMetadata,
      failureReason: input.failureReason ?? command.failureReason,
      updatedAt: now
    });

    if (command.commandType === 'START_ARREST') {
      if (input.status === 'ACKNOWLEDGED') {
        if (session.status === 'REQUESTED' || session.status === 'DELIVERED') {
          await repos.sessions.updateStatusAndFields(session.sessionId, {
            status: 'DELIVERED',
            acceptedAt: session.acceptedAt ?? now,
            localSessionId: input.localSessionId ?? session.localSessionId,
            localEngineState: 'PREPARING',
            updatedAt: now
          });
        }
      } else if (input.status === 'EXECUTED') {
        if (!TERMINAL_CLOUD_SESSION_STATUSES.includes(session.status)) {
          const expectedEndAt = new Date(now.getTime() + session.requestedDuration * 60_000);
          await repos.sessions.updateStatusAndFields(session.sessionId, {
            status: 'ACTIVE',
            localSessionId: input.localSessionId ?? session.localSessionId,
            localEngineState: 'ACTIVE',
            acceptedAt: session.acceptedAt ?? now,
            startedAt: session.startedAt ?? now,
            expectedEndAt: session.expectedEndAt ?? expectedEndAt,
            updatedAt: now
          });
        }
      } else if (input.status === 'REJECTED' || input.status === 'FAILED') {
        if (session.status === 'REQUESTED' || session.status === 'DELIVERED') {
          await repos.sessions.updateStatusAndFields(session.sessionId, {
            status: 'REJECTED',
            completedAt: now,
            completionReason:
              input.failureReason ?? `Target device reported ${input.status} for START_ARREST`,
            updatedAt: now
          });
        }
      }
    } else if (
      (command.commandType === 'APPROVE_RELEASE' || command.commandType === 'END_SESSION') &&
      input.status === 'EXECUTED'
    ) {
      if (!TERMINAL_CLOUD_SESSION_STATUSES.includes(session.status)) {
        await repos.sessions.updateStatusAndFields(session.sessionId, {
          status: 'RELEASED_EARLY',
          localEngineState: 'COMPLETED',
          completedAt: now,
          completionReason:
            command.commandType === 'APPROVE_RELEASE'
              ? 'Partner-approved early release executed by device'
              : 'Remote END_SESSION command executed by device',
          updatedAt: now
        });
        await repos.releaseRequests.expirePendingForSession(session.sessionId, now);
      }
    }

    return updatedCommand;
  }
}
