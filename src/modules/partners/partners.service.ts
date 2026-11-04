import { randomUUID } from 'node:crypto';
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
import type { NotificationService } from '../notifications/notification.service';
import type {
  PermissionsService,
  SerializedPartnerPermission
} from '../permissions/permissions.service';
import type { ProposalsService, SerializedProposal } from '../proposals/proposals.service';
import type {
  SchedulesService,
  SerializedScheduledArrest
} from '../schedules/schedules.service';
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

export interface SerializedApprovalPolicy {
  ownerUserId: string;
  partnerUserId: string;
  requireApprovalBeforeArrest: boolean;
  explicitlyConfigured: boolean;
  notes: string | null;
  activeStandingAuthorizationsCount: number;
  activeStandingAuthorizations: SerializedPartnerPermission[];
  updatedAt: string | null;
}

export interface SerializedPartnerProfile {
  partnership: SerializedPartnership;
  partner: PublicUserProfile;
  relationshipStatus: PartnershipState;
  myDevices: Array<{
    id: string;
    deviceName: string;
    platform: 'ANDROID';
    deviceStatus: 'ACTIVE' | 'INACTIVE' | 'REVOKED';
  }>;
  partnerDevices: Array<{
    id: string;
    deviceName: string;
    platform: 'ANDROID';
    deviceStatus: 'ACTIVE' | 'INACTIVE' | 'REVOKED';
  }>;
  permissionsGrantedToPartner: SerializedPartnerPermission[];
  permissionsReceivedFromPartner: SerializedPartnerPermission[];
  myApprovalPolicyForPartner: SerializedApprovalPolicy;
  partnerApprovalPolicyForMe: SerializedApprovalPolicy;
  pendingProposals: SerializedProposal[];
  activeSchedules: SerializedScheduledArrest[];
}

function canonicalPair(userA: string, userB: string): [string, string] {
  return userA < userB ? [userA, userB] : [userB, userA];
}

export class PartnersService {
  constructor(
    private readonly store: DataStore,
    private readonly notificationService: NotificationService,
    private readonly auditService: AuditService,
    private readonly clock: Clock,
    private readonly permissionsService: PermissionsService,
    private readonly proposalsService: ProposalsService,
    private readonly schedulesService: SchedulesService
  ) {}

  async discoverUserAndCounts(
    viewerUserId: string,
    query: { username?: string; inviteCode?: string }
  ): Promise<{
    found: boolean;
    user: PublicUserProfile | null;
    relationshipState:
      | 'NONE'
      | 'SELF'
      | 'PENDING_INCOMING'
      | 'PENDING_OUTGOING'
      | 'ACCEPTED'
      | 'REJECTED'
      | 'CANCELLED'
      | 'BLOCKED';
    partnershipId: string | null;
    pendingCounts: {
      incomingFriendRequestsCount: number;
      outgoingFriendRequestsCount: number;
      incomingProposalsCount: number;
      outgoingProposalsCount: number;
    };
  }> {
    const now = this.clock.now();
    await this.store.repositories.proposals.expireOverdueProposals(now);

    const [incomingFriends, outgoingFriends, incomingProps, outgoingProps] = await Promise.all([
      this.store.repositories.partnerships.listRequestsForUser(viewerUserId, {
        direction: 'incoming',
        state: 'PENDING',
        limit: 1,
        offset: 0
      }),
      this.store.repositories.partnerships.listRequestsForUser(viewerUserId, {
        direction: 'outgoing',
        state: 'PENDING',
        limit: 1,
        offset: 0
      }),
      this.store.repositories.proposals.listForUser(viewerUserId, {
        role: 'incoming',
        limit: 100,
        offset: 0
      }),
      this.store.repositories.proposals.listForUser(viewerUserId, {
        role: 'outgoing',
        limit: 100,
        offset: 0
      })
    ]);

    const pendingCounts = {
      incomingFriendRequestsCount: incomingFriends.total,
      outgoingFriendRequestsCount: outgoingFriends.total,
      incomingProposalsCount: incomingProps.items.filter(
        (p) => p.status === 'PENDING' || p.status === 'COUNTEROFFERED'
      ).length,
      outgoingProposalsCount: outgoingProps.items.filter(
        (p) => p.status === 'PENDING' || p.status === 'COUNTEROFFERED'
      ).length
    };

    if (!query.username && !query.inviteCode) {
      return {
        found: false,
        user: null,
        relationshipState: 'NONE',
        partnershipId: null,
        pendingCounts
      };
    }

    const targetUser = query.username
      ? await this.store.repositories.users.findByUsername(query.username)
      : query.inviteCode
        ? await this.store.repositories.users.findByInviteCode(query.inviteCode)
        : null;

    if (!targetUser || targetUser.accountStatus !== 'ACTIVE') {
      return {
        found: false,
        user: null,
        relationshipState: 'NONE',
        partnershipId: null,
        pendingCounts
      };
    }

    if (targetUser.id === viewerUserId) {
      return {
        found: true,
        user: serializePublicUser(targetUser),
        relationshipState: 'SELF',
        partnershipId: null,
        pendingCounts
      };
    }

    const existing = await this.store.repositories.partnerships.findByPair(
      viewerUserId,
      targetUser.id
    );

    if (!existing) {
      return {
        found: true,
        user: serializePublicUser(targetUser),
        relationshipState: 'NONE',
        partnershipId: null,
        pendingCounts
      };
    }

    if (existing.state === 'BLOCKED' && existing.blockedByUserId !== viewerUserId) {
      // Do not leak block status to the blocked user beyond unavailable
      return {
        found: false,
        user: null,
        relationshipState: 'NONE',
        partnershipId: null,
        pendingCounts
      };
    }

    const relationshipState =
      existing.state === 'PENDING'
        ? existing.recipientUserId === viewerUserId
          ? 'PENDING_INCOMING'
          : 'PENDING_OUTGOING'
        : existing.state;

    return {
      found: true,
      user: serializePublicUser(targetUser),
      relationshipState,
      partnershipId: existing.id,
      pendingCounts
    };
  }

  async sendInvitation(
    senderUserId: string,
    input: { username?: string; recipientUserId?: string; inviteCode?: string },
    context?: RequestContextMeta
  ): Promise<SerializedPartnership> {
    const targetUser = input.recipientUserId
      ? await this.store.repositories.users.findById(input.recipientUserId)
      : input.username
        ? await this.store.repositories.users.findByUsername(input.username)
        : input.inviteCode
          ? await this.store.repositories.users.findByInviteCode(input.inviteCode)
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

  async getPartnerProfile(
    viewerUserId: string,
    partnershipOrPartnerUserId: string
  ): Promise<SerializedPartnerProfile> {
    const { partnership, partnerUserId } = await this.resolvePartnershipAndPartner(
      viewerUserId,
      partnershipOrPartnerUserId
    );

    const now = this.clock.now();
    await this.store.repositories.proposals.expireOverdueProposals(now);

    const [
      users,
      myDevices,
      partnerDevices,
      allPermsPage,
      myPolicyRec,
      partnerPolicyRec,
      proposalsPage,
      schedulesPage
    ] = await Promise.all([
      this.store.repositories.users.findByIds([viewerUserId, partnerUserId]),
      this.store.repositories.devices.listActiveByUser(viewerUserId),
      this.store.repositories.devices.listActiveByUser(partnerUserId),
      this.store.repositories.partnerPermissions.listForUser(viewerUserId, {
        role: 'all',
        activeOnly: true,
        now,
        limit: 100,
        offset: 0
      }),
      this.store.repositories.approvalPolicies.findByOwnerAndPartner(
        viewerUserId,
        partnerUserId
      ),
      this.store.repositories.approvalPolicies.findByOwnerAndPartner(
        partnerUserId,
        viewerUserId
      ),
      this.store.repositories.proposals.listForUser(viewerUserId, {
        partnerUserId,
        limit: 50,
        offset: 0
      }),
      this.store.repositories.scheduledArrests.listForUser(viewerUserId, {
        partnerUserId,
        limit: 50,
        offset: 0
      })
    ]);

    const pairPerms = allPermsPage.items.filter(
      (p) =>
        (p.ownerUserId === viewerUserId && p.partnerUserId === partnerUserId) ||
        (p.ownerUserId === partnerUserId && p.partnerUserId === viewerUserId)
    );

    const deviceIds = Array.from(
      new Set([
        ...myDevices.map((d) => d.id),
        ...partnerDevices.map((d) => d.id),
        ...pairPerms.map((p) => p.targetDeviceId),
        ...proposalsPage.items.map((p) => p.targetDeviceId),
        ...schedulesPage.items.map((s) => s.targetDeviceId)
      ])
    );
    const devicesMap = await this.store.repositories.devices.findByIds(deviceIds);

    const serializedPerms = pairPerms
      .map((p) => this.permissionsService.formatPermission(p, users, devicesMap, now))
      .filter((p) => p.isCurrentlyActive);

    const permissionsGrantedToPartner = serializedPerms.filter(
      (p) => p.owner.id === viewerUserId
    );
    const permissionsReceivedFromPartner = serializedPerms.filter(
      (p) => p.owner.id === partnerUserId
    );

    const grantedStanding = permissionsGrantedToPartner.filter((p) => !p.oneTimeOnly);
    const receivedStanding = permissionsReceivedFromPartner.filter((p) => !p.oneTimeOnly);

    const myApprovalPolicyForPartner: SerializedApprovalPolicy = {
      ownerUserId: viewerUserId,
      partnerUserId,
      requireApprovalBeforeArrest: myPolicyRec ? myPolicyRec.requireApprovalBeforeArrest : true,
      explicitlyConfigured: myPolicyRec ? myPolicyRec.explicitlyConfigured : false,
      notes: myPolicyRec?.notes ?? null,
      activeStandingAuthorizationsCount: grantedStanding.length,
      activeStandingAuthorizations: grantedStanding,
      updatedAt: myPolicyRec ? myPolicyRec.updatedAt.toISOString() : null
    };

    const partnerApprovalPolicyForMe: SerializedApprovalPolicy = {
      ownerUserId: partnerUserId,
      partnerUserId: viewerUserId,
      requireApprovalBeforeArrest: partnerPolicyRec
        ? partnerPolicyRec.requireApprovalBeforeArrest
        : true,
      explicitlyConfigured: partnerPolicyRec ? partnerPolicyRec.explicitlyConfigured : false,
      notes: partnerPolicyRec?.notes ?? null,
      activeStandingAuthorizationsCount: receivedStanding.length,
      activeStandingAuthorizations: receivedStanding,
      updatedAt: partnerPolicyRec ? partnerPolicyRec.updatedAt.toISOString() : null
    };

    const serializedPartnership = this.formatPartnership(partnership, viewerUserId, users);

    const pendingProposals = proposalsPage.items
      .filter((p) => p.status === 'PENDING' || p.status === 'COUNTEROFFERED')
      .map((p) => this.proposalsService.formatProposal(p, users, devicesMap));

    const activeSchedules = schedulesPage.items
      .filter((s) => s.status === 'SCHEDULED' || s.status === 'ACTIVE')
      .map((s) => this.schedulesService.formatSchedule(s, users, devicesMap));

    return {
      partnership: serializedPartnership,
      partner: serializedPartnership.partner,
      relationshipStatus: partnership.state,
      myDevices: myDevices.map((d) => ({
        id: d.id,
        deviceName: d.deviceName,
        platform: d.platform,
        deviceStatus: d.deviceStatus
      })),
      partnerDevices:
        partnership.state === 'ACCEPTED'
          ? partnerDevices.map((d) => ({
              id: d.id,
              deviceName: d.deviceName,
              platform: d.platform,
              deviceStatus: d.deviceStatus
            }))
          : [],
      permissionsGrantedToPartner,
      permissionsReceivedFromPartner,
      myApprovalPolicyForPartner,
      partnerApprovalPolicyForMe,
      pendingProposals,
      activeSchedules
    };
  }

  async getApprovalPoliciesForPartner(
    viewerUserId: string,
    partnershipOrPartnerUserId: string
  ): Promise<{
    myApprovalPolicyForPartner: SerializedApprovalPolicy;
    partnerApprovalPolicyForMe: SerializedApprovalPolicy;
  }> {
    const profile = await this.getPartnerProfile(viewerUserId, partnershipOrPartnerUserId);
    return {
      myApprovalPolicyForPartner: profile.myApprovalPolicyForPartner,
      partnerApprovalPolicyForMe: profile.partnerApprovalPolicyForMe
    };
  }

  async updateApprovalPolicyForPartner(
    viewerUserId: string,
    partnershipOrPartnerUserId: string,
    input: { requireApprovalBeforeArrest: boolean; notes?: string | null },
    context?: RequestContextMeta
  ): Promise<{
    myApprovalPolicyForPartner: SerializedApprovalPolicy;
    partnerApprovalPolicyForMe: SerializedApprovalPolicy;
  }> {
    const { partnership, partnerUserId } = await this.resolvePartnershipAndPartner(
      viewerUserId,
      partnershipOrPartnerUserId
    );
    if (partnership.state !== 'ACCEPTED') {
      throw Errors.forbidden(
        'PARTNERSHIP_REQUIRED',
        'Approval policies can only be configured for accepted partners.'
      );
    }

    await this.store.withTransaction(async (repos) => {
      const now = this.clock.now();
      const updated = await repos.approvalPolicies.upsert({
        id: randomUUID(),
        ownerUserId: viewerUserId,
        partnerUserId,
        requireApprovalBeforeArrest: input.requireApprovalBeforeArrest,
        explicitlyConfigured: true,
        notes: input.notes ?? null,
        now
      });

      await this.auditService.record(repos.auditLogs, {
        actorUserId: viewerUserId,
        action: 'PARTNER_APPROVAL_POLICY_UPDATED',
        resourceType: 'PARTNER_APPROVAL_POLICY',
        resourceId: updated.id,
        result: 'SUCCESS',
        context,
        metadata: {
          partnerUserId,
          requireApprovalBeforeArrest: updated.requireApprovalBeforeArrest
        }
      });
    });

    return this.getApprovalPoliciesForPartner(viewerUserId, partnership.id);
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

  private async resolvePartnershipAndPartner(
    viewerUserId: string,
    partnershipOrPartnerUserId: string
  ): Promise<{ partnership: PartnershipRecord; partnerUserId: string }> {
    let partnership = await this.store.repositories.partnerships.findById(
      partnershipOrPartnerUserId
    );
    if (partnership) {
      if (
        partnership.senderUserId !== viewerUserId &&
        partnership.recipientUserId !== viewerUserId
      ) {
        throw Errors.notFound('PARTNERSHIP_NOT_FOUND', 'Partnership was not found.');
      }
      const partnerUserId =
        partnership.senderUserId === viewerUserId
          ? partnership.recipientUserId
          : partnership.senderUserId;
      return { partnership, partnerUserId };
    }

    partnership = await this.store.repositories.partnerships.findByPair(
      viewerUserId,
      partnershipOrPartnerUserId
    );
    if (!partnership) {
      throw Errors.notFound('PARTNERSHIP_NOT_FOUND', 'Partnership was not found.');
    }
    return { partnership, partnerUserId: partnershipOrPartnerUserId };
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
