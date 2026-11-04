import type {
  AndroidEngineState,
  ArrestProposalRecord,
  ArrestProposalRevisionRecord,
  ArrestProposalStatus,
  ArrestRequestType,
  ArrestSessionRecord,
  AuditLogRecord,
  AuditResult,
  BlockingConfigLimitsV1,
  BlockingConfigurationV1,
  CloudSessionStatus,
  CommandStatus,
  CommandType,
  DeviceAppCatalogRecord,
  DevicePushTokenRecord,
  DeviceRecord,
  DeviceStatus,
  NormalizedProposalConfigurationV1,
  PaginatedResult,
  PartnerApprovalPolicyRecord,
  PartnerPermissionRecord,
  PartnershipRecord,
  PartnershipState,
  PushDeliveryStatus,
  RefreshTokenRecord,
  ReleaseRequestRecord,
  ReleaseRequestStatus,
  ScheduledArrestRecord,
  ScheduledArrestStatus,
  SelectableAppCatalogItem,
  SessionCommandRecord,
  SessionSyncEventRecord,
  SessionType,
  UserRecord
} from './domain';
import type { AllowedTimeWindowsConfig } from '../shared/time';

export interface UsersRepository {
  create(user: UserRecord): Promise<UserRecord>;
  findById(id: string): Promise<UserRecord | null>;
  findByIds(ids: string[]): Promise<Map<string, UserRecord>>;
  findByEmail(normalizedEmail: string): Promise<UserRecord | null>;
  findByUsername(normalizedUsername: string): Promise<UserRecord | null>;
  findByInviteCode(inviteCode: string): Promise<UserRecord | null>;
  updateInviteCode(userId: string, inviteCode: string, updatedAt: Date): Promise<UserRecord | null>;
  updateProfile(
    userId: string,
    updates: { displayName?: string; avatarUrl?: string | null; updatedAt: Date }
  ): Promise<UserRecord | null>;
  updatePasswordHash(userId: string, passwordHash: string, updatedAt: Date): Promise<void>;
  updateLastLogin(userId: string, lastLoginAt: Date): Promise<void>;
}

export interface RefreshTokensRepository {
  create(token: RefreshTokenRecord): Promise<RefreshTokenRecord>;
  findByHashForUpdate(tokenHash: string): Promise<RefreshTokenRecord | null>;
  revokeById(
    id: string,
    params: { revokedAt: Date; revokedReason: string; replacedById?: string | null }
  ): Promise<void>;
  revokeFamily(familyId: string, revokedAt: Date, revokedReason: string): Promise<number>;
  revokeAllForUser(userId: string, revokedAt: Date, revokedReason: string): Promise<number>;
  deleteExpiredBefore(cutoff: Date): Promise<number>;
}

export interface DevicesRepository {
  create(device: DeviceRecord): Promise<DeviceRecord>;
  findById(id: string): Promise<DeviceRecord | null>;
  findByIdForUpdate(id: string): Promise<DeviceRecord | null>;
  findByIds(ids: string[]): Promise<Map<string, DeviceRecord>>;
  findByUserAndInstallation(userId: string, installationId: string): Promise<DeviceRecord | null>;
  listByUser(
    userId: string,
    options: { includeRevoked?: boolean; limit: number; offset: number }
  ): Promise<PaginatedResult<DeviceRecord>>;
  listActiveByUser(userId: string): Promise<DeviceRecord[]>;
  update(
    id: string,
    updates: {
      deviceName?: string;
      manufacturer?: string | null;
      model?: string | null;
      appVersion?: string;
      androidVersion?: string;
      sdkInt?: number | null;
      deviceStatus?: DeviceStatus;
      lastSeenAt?: Date;
      revokedAt?: Date | null;
      updatedAt: Date;
    }
  ): Promise<DeviceRecord | null>;
  touchLastSeen(id: string, seenAt: Date): Promise<void>;
}

export interface PushTokensRepository {
  upsertForDevice(params: {
    id: string;
    deviceId: string;
    fcmToken: string;
    tokenHash: string;
    now: Date;
  }): Promise<DevicePushTokenRecord>;
  listActiveForDevice(deviceId: string): Promise<DevicePushTokenRecord[]>;
  listActiveForUser(userId: string): Promise<DevicePushTokenRecord[]>;
  markTokenInvalid(tokenHash: string, reason: string, now: Date): Promise<void>;
  revokeAllForDevice(deviceId: string, reason: string, now: Date): Promise<number>;
}

export interface PartnershipsRepository {
  findById(id: string): Promise<PartnershipRecord | null>;
  findByIdForUpdate(id: string): Promise<PartnershipRecord | null>;
  findByPairForUpdate(userA: string, userB: string): Promise<PartnershipRecord | null>;
  findByPair(userA: string, userB: string): Promise<PartnershipRecord | null>;
  create(record: PartnershipRecord): Promise<PartnershipRecord>;
  update(
    id: string,
    updates: {
      senderUserId?: string;
      recipientUserId?: string;
      state: PartnershipState;
      blockedByUserId?: string | null;
      respondedAt?: Date | null;
      updatedAt: Date;
    }
  ): Promise<PartnershipRecord>;
  listRequestsForUser(
    userId: string,
    options: {
      direction: 'incoming' | 'outgoing' | 'all';
      state?: PartnershipState;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<PartnershipRecord>>;
  listAcceptedPartnersForUser(
    userId: string,
    options: { limit: number; offset: number }
  ): Promise<PaginatedResult<PartnershipRecord>>;
}

export interface PartnerPermissionsRepository {
  create(record: PartnerPermissionRecord): Promise<PartnerPermissionRecord>;
  findById(permissionId: string): Promise<PartnerPermissionRecord | null>;
  findByIdForUpdate(permissionId: string): Promise<PartnerPermissionRecord | null>;
  listForUser(
    userId: string,
    options: {
      role: 'granted' | 'received' | 'all';
      activeOnly: boolean;
      now: Date;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<PartnerPermissionRecord>>;
  update(
    permissionId: string,
    updates: {
      maximumSessionDuration?: number;
      allowedTimeWindows?: AllowedTimeWindowsConfig | null;
      allowedSessionTypes?: SessionType[];
      blockingConfigLimits?: BlockingConfigLimitsV1;
      oneTimeOnly?: boolean;
      validFrom?: Date;
      expiresAt?: Date;
      version: number;
      updatedAt: Date;
    }
  ): Promise<PartnerPermissionRecord>;
  incrementUsedCount(permissionId: string, now: Date): Promise<void>;
  revokeById(
    permissionId: string,
    params: { revokedByUserId: string; revokeReason: string; now: Date }
  ): Promise<PartnerPermissionRecord | null>;
  revokeBetweenUsers(
    userA: string,
    userB: string,
    params: { revokedByUserId: string; revokeReason: string; now: Date }
  ): Promise<number>;
  revokeAllForDevice(
    deviceId: string,
    params: { revokedByUserId: string; revokeReason: string; now: Date }
  ): Promise<number>;
}

export interface SessionsRepository {
  create(session: ArrestSessionRecord): Promise<ArrestSessionRecord>;
  findById(sessionId: string): Promise<ArrestSessionRecord | null>;
  findByIdForUpdate(sessionId: string): Promise<ArrestSessionRecord | null>;
  findByInitiatorAndIdempotencyKey(
    initiatedByUserId: string,
    idempotencyKey: string
  ): Promise<ArrestSessionRecord | null>;
  findActiveForDeviceForUpdate(targetDeviceId: string): Promise<ArrestSessionRecord | null>;
  listActiveForUser(userId: string): Promise<ArrestSessionRecord[]>;
  listForUser(
    userId: string,
    options: {
      role?: 'owner' | 'initiator' | 'all';
      status?: CloudSessionStatus;
      deviceId?: string;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<ArrestSessionRecord>>;
  countSessionsByAuthorizationSince(authorizationId: string, since: Date): Promise<number>;
  findLatestSessionByAuthorization(authorizationId: string): Promise<ArrestSessionRecord | null>;
  updateStatusAndFields(
    sessionId: string,
    updates: {
      status?: CloudSessionStatus;
      localSessionId?: string | null;
      localEngineState?: AndroidEngineState | null;
      blockingConfiguration?: BlockingConfigurationV1;
      acceptedAt?: Date | null;
      startedAt?: Date | null;
      expectedEndAt?: Date | null;
      completedAt?: Date | null;
      completionReason?: string | null;
      updatedAt: Date;
    }
  ): Promise<ArrestSessionRecord>;
  recordSyncEventIfNew(
    event: Omit<SessionSyncEventRecord, 'id'>
  ): Promise<{ inserted: boolean; record: SessionSyncEventRecord }>;
}

export interface CommandsRepository {
  create(
    command: Omit<SessionCommandRecord, 'sequenceNo'>
  ): Promise<SessionCommandRecord>;
  findById(commandId: string): Promise<SessionCommandRecord | null>;
  findByIdForUpdate(commandId: string): Promise<SessionCommandRecord | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<SessionCommandRecord | null>;
  findLatestBySessionAndType(
    sessionId: string,
    commandType: CommandType
  ): Promise<SessionCommandRecord | null>;
  expireOverdueCommands(now: Date): Promise<{
    expiredCommandIds: string[];
    expiredSessionIds: string[];
  }>;
  expireOverdueForDevice(deviceId: string, now: Date): Promise<number>;
  expirePendingForDeviceRevocation(deviceId: string, reason: string, now: Date): Promise<number>;
  pollActionableForDevice(
    deviceId: string,
    options: {
      afterSequence: number;
      statuses: CommandStatus[];
      limit: number;
      now: Date;
    }
  ): Promise<SessionCommandRecord[]>;
  markDeliveredBatch(commandIds: string[], now: Date): Promise<void>;
  updateCommandStatus(
    commandId: string,
    updates: {
      status: CommandStatus;
      acknowledgedAt?: Date | null;
      executedAt?: Date | null;
      resultMetadata?: Record<string, unknown> | null;
      failureReason?: string | null;
      updatedAt: Date;
    }
  ): Promise<SessionCommandRecord>;
  updatePushDelivery(
    commandId: string,
    updates: {
      pushDeliveryStatus: PushDeliveryStatus;
      incrementAttempts: boolean;
      lastPushAttemptAt: Date;
      updatedAt: Date;
    }
  ): Promise<void>;
  listRetryablePushCommands(now: Date, limit: number): Promise<SessionCommandRecord[]>;
}

export interface ReleaseRequestsRepository {
  create(request: ReleaseRequestRecord): Promise<ReleaseRequestRecord>;
  findById(id: string): Promise<ReleaseRequestRecord | null>;
  findByIdForUpdate(id: string): Promise<ReleaseRequestRecord | null>;
  findPendingBySessionForUpdate(sessionId: string): Promise<ReleaseRequestRecord | null>;
  listForUser(
    userId: string,
    options: {
      role: 'incoming' | 'outgoing' | 'all';
      status?: ReleaseRequestStatus;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<ReleaseRequestRecord>>;
  updateDecision(
    id: string,
    updates: {
      status: ReleaseRequestStatus;
      decisionReason?: string | null;
      resolutionCommandId?: string | null;
      decidedAt: Date;
      updatedAt: Date;
    }
  ): Promise<ReleaseRequestRecord>;
  expirePendingForSession(sessionId: string, now: Date): Promise<number>;
  expirePendingForEndedSessions(now: Date): Promise<number>;
}

export interface AuditLogsRepository {
  append(entry: {
    actorUserId?: string | null;
    actorDeviceId?: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    result: AuditResult;
    ipAddress?: string | null;
    requestId?: string | null;
    metadata?: Record<string, unknown> | null;
    createdAt: Date;
  }): Promise<AuditLogRecord>;
  listByActor(actorUserId: string, limit: number): Promise<AuditLogRecord[]>;
}

export interface ApprovalPoliciesRepository {
  findByOwnerAndPartner(
    ownerUserId: string,
    partnerUserId: string
  ): Promise<PartnerApprovalPolicyRecord | null>;
  findByOwnerAndPartnerForUpdate(
    ownerUserId: string,
    partnerUserId: string
  ): Promise<PartnerApprovalPolicyRecord | null>;
  upsert(params: {
    id: string;
    ownerUserId: string;
    partnerUserId: string;
    requireApprovalBeforeArrest: boolean;
    explicitlyConfigured: boolean;
    notes?: string | null;
    now: Date;
  }): Promise<PartnerApprovalPolicyRecord>;
}

export interface ProposalsRepository {
  createWithInitialRevision(
    proposal: ArrestProposalRecord,
    initialRevision: ArrestProposalRevisionRecord
  ): Promise<{ proposal: ArrestProposalRecord; revision: ArrestProposalRevisionRecord }>;
  findById(proposalId: string): Promise<ArrestProposalRecord | null>;
  findByIdForUpdate(proposalId: string): Promise<ArrestProposalRecord | null>;
  findByProposerAndIdempotencyKey(
    proposerUserId: string,
    idempotencyKey: string
  ): Promise<ArrestProposalRecord | null>;
  listRevisions(proposalId: string): Promise<ArrestProposalRevisionRecord[]>;
  listForUser(
    userId: string,
    options: {
      role?: 'incoming' | 'outgoing' | 'all';
      status?: ArrestProposalStatus;
      partnerUserId?: string;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<ArrestProposalRecord>>;
  addCounterofferRevision(
    proposalId: string,
    updates: {
      proposerUserId: string;
      recipientUserId: string;
      requestType: ArrestRequestType;
      currentRevision: number;
      status: ArrestProposalStatus;
      normalizedConfiguration: NormalizedProposalConfigurationV1;
      reason: string | null;
      expiresAt: Date;
      updatedAt: Date;
    },
    newRevision: ArrestProposalRevisionRecord
  ): Promise<{ proposal: ArrestProposalRecord; revision: ArrestProposalRevisionRecord }>;
  updateStatusAndOutcome(
    proposalId: string,
    updates: {
      status: ArrestProposalStatus;
      approvedRevision?: number | null;
      resultingPermissionId?: string | null;
      resultingSessionId?: string | null;
      resultingScheduleId?: string | null;
      respondedAt?: Date | null;
      updatedAt: Date;
    }
  ): Promise<ArrestProposalRecord>;
  expireOverdueProposals(now: Date): Promise<number>;
  cancelPendingBetweenUsers(userA: string, userB: string, now: Date): Promise<number>;
}

export interface ScheduledArrestsRepository {
  create(record: ScheduledArrestRecord): Promise<ScheduledArrestRecord>;
  findById(scheduleId: string): Promise<ScheduledArrestRecord | null>;
  findByIdForUpdate(scheduleId: string): Promise<ScheduledArrestRecord | null>;
  listForUser(
    userId: string,
    options: {
      role?: 'owner' | 'partner' | 'all';
      status?: ScheduledArrestStatus;
      partnerUserId?: string;
      deviceId?: string;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<ScheduledArrestRecord>>;
  updateStatusAndOccurrence(
    scheduleId: string,
    updates: {
      status?: ScheduledArrestStatus;
      occurrencesCompleted?: number;
      nextOccurrenceAt?: Date | null;
      lastMaterializedSessionId?: string | null;
      lastMaterializedAt?: Date | null;
      updatedAt: Date;
    }
  ): Promise<ScheduledArrestRecord>;
  listDueForDevice(deviceId: string, now: Date): Promise<ScheduledArrestRecord[]>;
  revokeByPermissionId(permissionId: string, now: Date): Promise<number>;
  revokeBetweenUsers(userA: string, userB: string, now: Date): Promise<number>;
}

export interface DeviceAppCatalogsRepository {
  findByDeviceId(deviceId: string): Promise<DeviceAppCatalogRecord | null>;
  upsert(params: {
    deviceId: string;
    ownerUserId: string;
    apps: SelectableAppCatalogItem[];
    now: Date;
  }): Promise<DeviceAppCatalogRecord>;
}

export interface RepositoryBundle {
  users: UsersRepository;
  refreshTokens: RefreshTokensRepository;
  devices: DevicesRepository;
  deviceAppCatalogs: DeviceAppCatalogsRepository;
  pushTokens: PushTokensRepository;
  partnerships: PartnershipsRepository;
  partnerPermissions: PartnerPermissionsRepository;
  approvalPolicies: ApprovalPoliciesRepository;
  proposals: ProposalsRepository;
  scheduledArrests: ScheduledArrestsRepository;
  sessions: SessionsRepository;
  commands: CommandsRepository;
  releaseRequests: ReleaseRequestsRepository;
  auditLogs: AuditLogsRepository;
}

export interface DataStore {
  readonly repositories: RepositoryBundle;
  withTransaction<T>(fn: (repos: RepositoryBundle) => Promise<T>): Promise<T>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
