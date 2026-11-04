import type { AuditService, RequestContextMeta } from '../../services/audit.service';
import { Errors } from '../../shared/errors';
import type { Clock } from '../../shared/time';
import type { AuthenticatedUserProfile, PublicUserProfile, UserRecord } from '../../types/domain';
import type { DataStore } from '../../types/repositories';
import { serializeAuthenticatedUser } from '../auth/auth.service';

export function serializePublicUser(user: UserRecord): PublicUserProfile {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl
  };
}

export class UsersService {
  constructor(
    private readonly store: DataStore,
    private readonly auditService: AuditService,
    private readonly clock: Clock
  ) {}

  async getMe(userId: string): Promise<AuthenticatedUserProfile> {
    const user = await this.store.repositories.users.findById(userId);
    if (!user || user.accountStatus === 'DELETED') {
      throw Errors.notFound('NOT_FOUND', 'User profile was not found.');
    }
    return serializeAuthenticatedUser(user);
  }

  async updateMe(
    userId: string,
    updates: { displayName?: string; avatarUrl?: string | null },
    context?: RequestContextMeta
  ): Promise<AuthenticatedUserProfile> {
    return this.store.withTransaction(async (repos) => {
      const now = this.clock.now();
      const updated = await repos.users.updateProfile(userId, {
        ...updates,
        updatedAt: now
      });
      if (!updated) {
        throw Errors.notFound('NOT_FOUND', 'User profile was not found.');
      }

      await this.auditService.record(repos.auditLogs, {
        actorUserId: userId,
        action: 'USER_PROFILE_UPDATED',
        resourceType: 'USER',
        resourceId: userId,
        result: 'SUCCESS',
        context,
        metadata: {
          updatedDisplayName: updates.displayName !== undefined,
          updatedAvatarUrl: updates.avatarUrl !== undefined
        }
      });

      return serializeAuthenticatedUser(updated);
    });
  }
}
