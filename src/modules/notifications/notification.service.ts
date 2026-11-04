import type { FastifyBaseLogger } from 'fastify';
import type { FcmTransport } from '../../config/firebase';
import type { Clock } from '../../shared/time';
import type { PushDeliveryStatus, SessionCommandRecord } from '../../types/domain';
import type { DataStore } from '../../types/repositories';

export interface NotificationServiceOptions {
  retryDelayMs?: number;
}

export class NotificationService {
  private readonly retryDelayMs: number;

  constructor(
    private readonly store: DataStore,
    private readonly fcm: FcmTransport,
    private readonly clock: Clock,
    private readonly logger?: FastifyBaseLogger,
    options: NotificationServiceOptions = {}
  ) {
    this.retryDelayMs = options.retryDelayMs ?? 150;
  }

  /**
   * Sends a minimal wakeup data message for a committed command.
   * Never throws: any FCM failure is safely recorded on the command record so
   * committed MySQL state is never corrupted.
   */
  async notifyCommandAvailable(command: SessionCommandRecord): Promise<PushDeliveryStatus> {
    const now = this.clock.now();

    if (!this.fcm.isEnabled) {
      await this.safeRecordCommandPush(command.commandId, 'SKIPPED_DISABLED', false, now);
      return 'SKIPPED_DISABLED';
    }

    let activeTokens;
    try {
      activeTokens = await this.store.repositories.pushTokens.listActiveForDevice(
        command.targetDeviceId
      );
    } catch (err) {
      this.logger?.warn({ err, commandId: command.commandId }, 'Failed reading push tokens');
      return 'FAILED_RETRYABLE';
    }

    if (activeTokens.length === 0) {
      await this.safeRecordCommandPush(command.commandId, 'NO_ACTIVE_TOKEN', false, now);
      return 'NO_ACTIVE_TOKEN';
    }

    const remainingTtlSec = Math.max(
      30,
      Math.floor((command.expiresAt.getTime() - now.getTime()) / 1000)
    );

    const dataPayload: Record<string, string> = {
      type: 'COMMAND_AVAILABLE',
      commandId: command.commandId,
      targetDeviceId: command.targetDeviceId,
      sequenceNo: String(command.sequenceNo),
      commandType: command.commandType
    };

    let anySent = false;
    let anyRetryable = false;

    for (const tokenRec of activeTokens) {
      let outcome = await this.fcm.sendDataMessage({
        token: tokenRec.fcmToken,
        data: dataPayload,
        ttlSeconds: remainingTtlSec,
        collapseKey: `cmd_${command.targetDeviceId}`
      });

      if (outcome.status === 'RETRYABLE_FAILURE' && this.retryDelayMs >= 0) {
        if (this.retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        }
        outcome = await this.fcm.sendDataMessage({
          token: tokenRec.fcmToken,
          data: dataPayload,
          ttlSeconds: remainingTtlSec,
          collapseKey: `cmd_${command.targetDeviceId}`
        });
      }

      if (outcome.status === 'SENT') {
        anySent = true;
      } else if (outcome.status === 'INVALID_TOKEN') {
        try {
          await this.store.repositories.pushTokens.markTokenInvalid(
            tokenRec.tokenHash,
            outcome.errorCode,
            this.clock.now()
          );
        } catch (err) {
          this.logger?.warn({ err }, 'Failed marking invalid FCM token');
        }
      } else if (outcome.status === 'RETRYABLE_FAILURE') {
        anyRetryable = true;
        this.logger?.warn(
          { commandId: command.commandId, errorCode: outcome.errorCode },
          'Transient FCM failure; device can still poll command queue'
        );
      } else if (outcome.status === 'PERMANENT_FAILURE') {
        this.logger?.error(
          { commandId: command.commandId, errorCode: outcome.errorCode },
          'Permanent FCM send error'
        );
      }
    }

    const finalStatus: PushDeliveryStatus = anySent
      ? 'SENT'
      : anyRetryable
        ? 'FAILED_RETRYABLE'
        : 'FAILED_PERMANENT';

    await this.safeRecordCommandPush(command.commandId, finalStatus, true, this.clock.now());
    return finalStatus;
  }

  /**
   * Sends a minimal wakeup hint to all active devices of a user (e.g. partner invitation
   * or early release request). Never throws and never includes sensitive content.
   */
  async notifyUserEvent(
    userId: string,
    eventType: 'PARTNERSHIP_INVITATION' | 'PARTNERSHIP_ACCEPTED' | 'RELEASE_REQUESTED',
    resourceId: string
  ): Promise<void> {
    if (!this.fcm.isEnabled) return;

    try {
      const tokens = await this.store.repositories.pushTokens.listActiveForUser(userId);
      for (const tokenRec of tokens) {
        const outcome = await this.fcm.sendDataMessage({
          token: tokenRec.fcmToken,
          data: {
            type: eventType,
            resourceId
          },
          ttlSeconds: 3600
        });

        if (outcome.status === 'INVALID_TOKEN') {
          await this.store.repositories.pushTokens.markTokenInvalid(
            tokenRec.tokenHash,
            outcome.errorCode,
            this.clock.now()
          );
        }
      }
    } catch (err) {
      this.logger?.warn({ err, eventType, resourceId }, 'Non-fatal user event push failure');
    }
  }

  async retryPendingCommandPushes(limit = 25): Promise<number> {
    if (!this.fcm.isEnabled) return 0;
    const retryable = await this.store.repositories.commands.listRetryablePushCommands(
      this.clock.now(),
      limit
    );
    let sentCount = 0;
    for (const cmd of retryable) {
      const status = await this.notifyCommandAvailable(cmd);
      if (status === 'SENT') sentCount++;
    }
    return sentCount;
  }

  private async safeRecordCommandPush(
    commandId: string,
    status: PushDeliveryStatus,
    incrementAttempts: boolean,
    now: Date
  ): Promise<void> {
    try {
      await this.store.repositories.commands.updatePushDelivery(commandId, {
        pushDeliveryStatus: status,
        incrementAttempts,
        lastPushAttemptAt: now,
        updatedAt: now
      });
    } catch (err) {
      this.logger?.warn({ err, commandId }, 'Failed updating command push delivery status');
    }
  }
}
