import type { NotificationService } from '../modules/notifications/notification.service';
import type { Clock } from '../shared/time';
import type { DataStore } from '../types/repositories';
import type { AuditService, RequestContextMeta } from './audit.service';

export interface MaintenanceSummary {
  ranAt: string;
  expiredCommandsCount: number;
  expiredSessionsCount: number;
  expiredReleaseRequestsCount: number;
  purgedRefreshTokensCount: number;
  retriedPushNotificationsSent: number;
}

export class MaintenanceService {
  constructor(
    private readonly store: DataStore,
    private readonly notificationService: NotificationService,
    private readonly auditService: AuditService,
    private readonly clock: Clock
  ) {}

  async runMaintenanceCycle(context?: RequestContextMeta): Promise<MaintenanceSummary> {
    const now = this.clock.now();
    const refreshPurgeCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const dbSummary = await this.store.withTransaction(async (repos) => {
      const expiredCmds = await repos.commands.expireOverdueCommands(now);
      const expiredReleases = await repos.releaseRequests.expirePendingForEndedSessions(now);
      await repos.proposals.expireOverdueProposals(now);
      const purgedTokens = await repos.refreshTokens.deleteExpiredBefore(refreshPurgeCutoff);

      await this.auditService.record(repos.auditLogs, {
        actorUserId: null,
        action: 'SYSTEM_MAINTENANCE_EXECUTED',
        resourceType: 'SYSTEM',
        resourceId: 'maintenance',
        result: 'SUCCESS',
        context,
        metadata: {
          expiredCommandsCount: expiredCmds.expiredCommandIds.length,
          expiredSessionsCount: expiredCmds.expiredSessionIds.length,
          expiredReleaseRequestsCount: expiredReleases,
          purgedRefreshTokensCount: purgedTokens
        }
      });

      return {
        expiredCommandsCount: expiredCmds.expiredCommandIds.length,
        expiredSessionsCount: expiredCmds.expiredSessionIds.length,
        expiredReleaseRequestsCount: expiredReleases,
        purgedRefreshTokensCount: purgedTokens
      };
    });

    const retriedPushNotificationsSent =
      await this.notificationService.retryPendingCommandPushes(25);

    return {
      ranAt: now.toISOString(),
      ...dbSummary,
      retriedPushNotificationsSent
    };
  }
}
