import { randomUUID } from 'node:crypto';
import type { NotificationService } from '../notifications/notification.service';
import type { AuditService, RequestContextMeta } from '../../services/audit.service';
import { Errors } from '../../shared/errors';
import type { Clock } from '../../shared/time';
import type {
  PaginatedResult,
  PartnershipRecord,
  PartnershipState,
  PublicUserProfile,
  UserRecord
} from '../../types/domain';
import type { DataStore, RepositoryBundle } from '../../types/repositories';
import { serializePublicUser } from '../users/users.service';

export interface SerializedPartnership {
  id: string;
  state: PartnershipState;
  sender: PublicUserProfile;
  recipient: PublicUserProfile;
  partner: PublicUserProfile;
  respondedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function canonicalPair(userA: string, userB: string): [string, string] {
  return userA < userB ? [userA, userB] : [userB, userA];
}

export class PartnersService {
  constructor(
    private readonly store: DataStore,
    private readonly notificationService: NotificationService,
    private readonly auditService: AuditService,
    private readonly clock: Clock
  ) {}

  async sendInvitation(
    senderUserId: string,
    input: { username?: string; recipientUserId?: string },
    context?: RequestContextMeta
  ): Promise<SerializedPartnership> {
    const targetUser = input.recipientUserId
      ? await this.store.repositories.users.findById(input.recipientUserId)
      : input.username
        ? await this.store.repositories.users.findByUsername(input.username)
        : null;

    if (!targetUser || targetUser.accountStatus !== 'ACTIVE') {
      throw Errors.notFound('NOT_FOUND', 'Target user was not found.');
    }

    if (targetUser.id === senderUserId) {
      throw Errors.badRequest(
        'SELF_ACTION_NOT_ALLOWED',
        'You cannot send a partnership request to yourself.'
      );
    }

    const senderUser = await this.store.repositories.users.findById(senderUserId);
    if (!senderUser) {
      throw Errors.unauthorized('UNAUTHORIZED', 'Authenticated user not found.');
    }

    const partnership = await this.store.withTransaction(async (repos) => {
      const existing = await repos.partnerships.findByPairForUpdate(senderUserId, targetUser.id);
      const now = this.clock.now();

      if (existing) {
        if (existing.state === 'BLOCKED') {
          if (existing.blockedByUserId === senderUserId) {
            throw Errors.conflict(
              'PARTNERSHIP_BLOCKED',
              'You have blocked this user. Remove the block before sending a request.'
            );
          }
          throw Errors.forbidden(
            'PARTNERSHIP_BLOCKED',
            'Unable to send a partnership request to this user.'
          );
        }
        if (existing.state === 'PENDING') {
          throw Errors.conflict(
            'PARTNERSHIP_CONFLICT',
            'A pending partnership request already exists between these users.'
          );
        }
        if (existing.state === 'ACCEPTED') {
          throw Errors.conflict('PARTNERSHIP_CONFLICT', 'Users are already accepted partners.');
        }

        // Re-initiate cleanly after prior REJECTED or CANCELLED state
        const reopened = await repos.partnerships.update(existing.id, {
          senderUserId,
          recipientUserId: targetUser.id,
          state: 'PENDING',
          blockedByUserId: null,
          respondedAt: null,
          updatedAt: now
        });

        await this.auditService.record(repos.auditLogs, {
          actorUserId: senderUserId,
          action: 'PARTNERSHIP_REQUEST_SENT',
          resourceType: 'PARTNERSHIP',
          resourceId: reopened.id,
          result: 'SUCCESS',
          context,
          metadata: { recipientUserId: targetUser.id, reopened: true }
        });

        return reopened;
      }

      const [userLowId, userHighId] = canonicalPair(senderUserId, targetUser.id);
      const created = await repos.partnerships.create({
        id: randomUUID(),
        senderUserId,
        recipientUserId: targetUser.id,
        userLowId,
        userHighId,
        state: 'PENDING',
        blockedByUserId: null,
        respondedAt: null,
        createdAt: now,
        updatedAt: now
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId: senderUserId,
        action: 'PARTNERSHIP_REQUEST_SENT',
        resourceType: 'PARTNERSHIP',
        resourceId: created.id,
        result: 'SUCCESS',
        context,
        metadata: { recipientUserId: targetUser.id }
      });

      return created;
    });

    await this.notificationService.notifyUserEvent(
      targetUser.id,
      'PARTNERSHIP_INVITATION',
      partnership.id
    );

    const userMap = new Map<string, UserRecord>([
      [senderUser.id, senderUser],
      [targetUser.id, targetUser]
    ]);
    return this.formatPartnership(partnership, senderUserId, userMap);
  }

  async listRequests(
    userId: string,
    options: {
      direction: 'incoming' | 'outgoing' | 'all';
      state?: PartnershipState;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<SerializedPartnership>> {
    const page = await this.store.repositories.partnerships.listRequestsForUser(userId, options);
    return this.hydratePartnershipPage(page, userId);
  }

  async acceptRequest(
    userId: string,
    partnershipId: string,
    context?: RequestContextMeta
  ): Promise<SerializedPartnership> {
    const updated = await this.store.withTransaction(async (repos) => {
      const record = await repos.partnerships.findByIdForUpdate(partnershipId);
      if (!record || (record.senderUserId !== userId && record.recipientUserId !== userId)) {
        throw Errors.notFound('PARTNERSHIP_NOT_FOUND', 'Partnership request was not found.');
      }
      if (record.recipientUserId !== userId) {
        throw Errors.forbidden(
          'FORBIDDEN',
          'Only the invitation recipient can accept a partnership request.'
        );
      }
      if (record.state !== 'PENDING') {
        throw Errors.conflict(
          'PARTNERSHIP_CONFLICT',
          `Cannot accept a partnership in state ${record.state}.`
        );
      }

      const now = this.clock.now();
      const accepted = await repos.partnerships.update(record.id, {
        state: 'ACCEPTED',
        respondedAt: now,
        updatedAt: now
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId: userId,
        action: 'PARTNERSHIP_ACCEPTED',
        resourceType: 'PARTNERSHIP',
        resourceId: accepted.id,
        result: 'SUCCESS',
        context,
        metadata: { senderUserId: accepted.senderUserId }
      });

      return accepted;
    });

    await this.notificationService.notifyUserEvent(
      updated.senderUserId,
      'PARTNERSHIP_ACCEPTED',
      updated.id
    );

    const users = await this.store.repositories.users.findByIds([
      updated.senderUserId,
      updated.recipientUserId
    ]);
    return this.formatPartnership(updated, userId, users);
  }

  async rejectRequest(
    userId: string,
    partnershipId: string,
    context?: RequestContextMeta
  ): Promise<SerializedPartnership> {
    const updated = await this.store.withTransaction(async (repos) => {
      const record = await repos.partnerships.findByIdForUpdate(partnershipId);
      if (!record || (record.senderUserId !== userId && record.recipientUserId !== userId)) {
        throw Errors.notFound('PARTNERSHIP_NOT_FOUND', 'Partnership request was not found.');
      }
      if (record.recipientUserId !== userId) {
        throw Errors.forbidden(
          'FORBIDDEN',
          'Only the invitation recipient can reject a partnership request.'
        );
      }
      if (record.state !== 'PENDING') {
        throw Errors.conflict(
          'PARTNERSHIP_CONFLICT',
          `Cannot reject a partnership in state ${record.state}.`
        );
      }

      const now = this.clock.now();
      const rejected = await repos.partnerships.update(record.id, {
        state: 'REJECTED',
        respondedAt: now,
        updatedAt: now
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId: userId,
        action: 'PARTNERSHIP_REJECTED',
        resourceType: 'PARTNERSHIP',
        resourceId: rejected.id,
        result: 'SUCCESS',
        context
      });

      return rejected;
    });

    const users = await this.store.repositories.users.findByIds([
      updated.senderUserId,
      updated.recipientUserId
    ]);
    return this.formatPartnership(updated, userId, users);
  }

  async listPartners(
    userId: string,
    options: { limit: number; offset: number }
  ): Promise<PaginatedResult<SerializedPartnership>> {
    const page = await this.store.repositories.partnerships.listAcceptedPartnersForUser(
      userId,
      options
    );
    return this.hydratePartnershipPage(page, userId);
  }

  async removeOrCancelPartnership(
    userId: string,
    partnershipId: string,
    context?: RequestContextMeta
  ): Promise<SerializedPartnership> {
    const updated = await this.store.withTransaction(async (repos) => {
      const record = await repos.partnerships.findByIdForUpdate(partnershipId);
      if (!record || (record.senderUserId !== userId && record.recipientUserId !== userId)) {
        throw Errors.notFound('PARTNERSHIP_NOT_FOUND', 'Partnership was not found.');
      }

      if (record.state === 'BLOCKED' && record.blockedByUserId !== userId) {
        throw Errors.forbidden('FORBIDDEN', 'You cannot remove a block created by another user.');
      }

      const now = this.clock.now();
      const otherUserId =
        record.senderUserId === userId ? record.recipientUserId : record.senderUserId;

      const cancelled = await repos.partnerships.update(record.id, {
        state: 'CANCELLED',
        blockedByUserId: null,
        respondedAt: now,
        updatedAt: now
      });

      const revokedPerms = await repos.partnerPermissions.revokeBetweenUsers(userId, otherUserId, {
        revokedByUserId: userId,
        revokeReason: 'Partnership was removed',
        now
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId: userId,
        action: 'PARTNERSHIP_REMOVED',
        resourceType: 'PARTNERSHIP',
        resourceId: cancelled.id,
        result: 'SUCCESS',
        context,
        metadata: { otherUserId, revokedPermissionsCount: revokedPerms }
      });

      return cancelled;
    });

    const users = await this.store.repositories.users.findByIds([
      updated.senderUserId,
      updated.recipientUserId
    ]);
    return this.formatPartnership(updated, userId, users);
  }

  /**
   * Supports blocking either by `partnershipId` OR by `targetUserId` directly.
   * Immediately revokes all delegated permissions in both directions.
   */
  async blockPartnerOrUser(
    userId: string,
    partnershipOrTargetUserId: string,
    context?: RequestContextMeta
  ): Promise<SerializedPartnership> {
    const blocked = await this.store.withTransaction(async (repos: RepositoryBundle) => {
      const now = this.clock.now();
      let existing = await repos.partnerships.findByIdForUpdate(partnershipOrTargetUserId);
      let otherUserId: string;

      if (existing) {
        if (existing.senderUserId !== userId && existing.recipientUserId !== userId) {
          throw Errors.notFound('PARTNERSHIP_NOT_FOUND', 'Partnership was not found.');
        }
        otherUserId =
          existing.senderUserId === userId ? existing.recipientUserId : existing.senderUserId;
      } else {
        if (partnershipOrTargetUserId === userId) {
          throw Errors.badRequest('SELF_ACTION_NOT_ALLOWED', 'You cannot block yourself.');
        }
        const targetUser = await repos.users.findById(partnershipOrTargetUserId);
        if (!targetUser || targetUser.accountStatus === 'DELETED') {
          throw Errors.notFound('PARTNERSHIP_NOT_FOUND', 'Partnership or user was not found.');
        }
        otherUserId = targetUser.id;
        existing = await repos.partnerships.findByPairForUpdate(userId, otherUserId);
      }

      let resultRecord: PartnershipRecord;
      if (existing) {
        resultRecord = await repos.partnerships.update(existing.id, {
          state: 'BLOCKED',
          blockedByUserId: userId,
          respondedAt: now,
          updatedAt: now
        });
      } else {
        const [userLowId, userHighId] = canonicalPair(userId, otherUserId);
        resultRecord = await repos.partnerships.create({
          id: randomUUID(),
          senderUserId: userId,
          recipientUserId: otherUserId,
          userLowId,
          userHighId,
          state: 'BLOCKED',
          blockedByUserId: userId,
          respondedAt: now,
          createdAt: now,
          updatedAt: now
        });
      }

      const revokedPerms = await repos.partnerPermissions.revokeBetweenUsers(userId, otherUserId, {
        revokedByUserId: userId,
        revokeReason: 'Partnership blocked',
        now
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId: userId,
        action: 'PARTNERSHIP_BLOCKED',
        resourceType: 'PARTNERSHIP',
        resourceId: resultRecord.id,
        result: 'SUCCESS',
        context,
        metadata: { blockedUserId: otherUserId, revokedPermissionsCount: revokedPerms }
      });

      return resultRecord;
    });

    const users = await this.store.repositories.users.findByIds([
      blocked.senderUserId,
      blocked.recipientUserId
    ]);
    return this.formatPartnership(blocked, userId, users);
  }

  private async hydratePartnershipPage(
    page: PaginatedResult<PartnershipRecord>,
    viewerUserId: string
  ): Promise<PaginatedResult<SerializedPartnership>> {
    const userIds = page.items.flatMap((p) => [p.senderUserId, p.recipientUserId]);
    const users = await this.store.repositories.users.findByIds(userIds);
    return {
      ...page,
      items: page.items.map((p) => this.formatPartnership(p, viewerUserId, users))
    };
  }

  private formatPartnership(
    record: PartnershipRecord,
    viewerUserId: string,
    users: Map<string, UserRecord>
  ): SerializedPartnership {
    const senderRecord = users.get(record.senderUserId);
    const recipientRecord = users.get(record.recipientUserId);

    const sender: PublicUserProfile = senderRecord
      ? serializePublicUser(senderRecord)
      : { id: record.senderUserId, username: 'unknown', displayName: 'Unknown', avatarUrl: null };
    const recipient: PublicUserProfile = recipientRecord
      ? serializePublicUser(recipientRecord)
      : {
          id: record.recipientUserId,
          username: 'unknown',
          displayName: 'Unknown',
          avatarUrl: null
        };
    const partner = record.senderUserId === viewerUserId ? recipient : sender;

    return {
      id: record.id,
      state: record.state,
      sender,
      recipient,
      partner,
      respondedAt: record.respondedAt ? record.respondedAt.toISOString() : null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString()
    };
  }
}
