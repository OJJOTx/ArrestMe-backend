import type { AllowedTimeWindowsConfig } from '../shared/time';

export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  displayName: string;
  avatarUrl: string | null;
  accountStatus: AccountStatus;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

export interface PublicUserProfile {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface AuthenticatedUserProfile extends PublicUserProfile {
  email: string;
  accountStatus: AccountStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  deviceId: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  replacedById: string | null;
  createdAt: Date;
}

export type DevicePlatform = 'ANDROID';
export type DeviceStatus = 'ACTIVE' | 'INACTIVE' | 'REVOKED';

export interface DeviceRecord {
  id: string;
  userId: string;
  installationId: string | null;
  deviceName: string;
  platform: DevicePlatform;
  manufacturer: string | null;
  model: string | null;
  appVersion: string;
  androidVersion: string;
  sdkInt: number | null;
  deviceStatus: DeviceStatus;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PushTokenStatus = 'ACTIVE' | 'INVALID' | 'REVOKED';

export interface DevicePushTokenRecord {
  id: string;
  deviceId: string;
  fcmToken: string;
  tokenHash: string;
  tokenStatus: PushTokenStatus;
  invalidatedReason: string | null;
  lastValidatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PartnershipState =
  | 'PENDING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'BLOCKED';

export interface PartnershipRecord {
  id: string;
  senderUserId: string;
  recipientUserId: string;
  userLowId: string;
  userHighId: string;
  state: PartnershipState;
  blockedByUserId: string | null;
  respondedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aligned directly with Android `com.arrestme.benchmark.core.session.SessionModels`:
 * - SessionType: SELF_ARREST (+ PARTNER_ARREST, MUTUAL_ARREST)
 * - SessionState: IDLE, PREPARING, ACTIVE, PAUSED, COMPLETED, EMERGENCY_STOPPED, INTERRUPTED
 * - AllowedCategory: CALLS, STUDY_APPS
 * - BlockingRuleMode: BLOCK_SELECTED, STRICT_ALLOWLIST, WHITELIST_ONLY
 */
export type SessionType = 'SELF_ARREST' | 'PARTNER_ARREST' | 'MUTUAL_ARREST';

export type AndroidEngineState =
  | 'IDLE'
  | 'PREPARING'
  | 'ACTIVE'
  | 'PAUSED'
  | 'COMPLETED'
  | 'EMERGENCY_STOPPED'
  | 'INTERRUPTED';

export type AllowedCategory = 'CALLS' | 'STUDY_APPS';

export type BlockingRuleMode = 'BLOCK_SELECTED' | 'STRICT_ALLOWLIST' | 'WHITELIST_ONLY';

export interface BlockingConfigurationV1 {
  schemaVersion: 1;
  ruleMode: BlockingRuleMode;
  allowedCategories: AllowedCategory[];
  overlayStatusBar: boolean;
  disableEmergencyExit: boolean;
  blockedPackages?: string[];
  allowedStudyPackages?: string[];
}

export interface BlockingConfigLimitsV1 {
  schemaVersion: 1;
  allowedRuleModes: BlockingRuleMode[];
  allowDisableEmergencyExit: boolean;
  allowOverlayStatusBar: boolean;
  requiredAllowedCategories: AllowedCategory[];
  allowCustomPackageLists: boolean;
  dailyMaxSessions?: number;
  cooldownMinutes?: number;
}

export interface PartnerPermissionRecord {
  permissionId: string;
  ownerUserId: string;
  partnerUserId: string;
  targetDeviceId: string;
  maximumSessionDuration: number;
  allowedTimeWindows: AllowedTimeWindowsConfig | null;
  allowedSessionTypes: SessionType[];
  blockingConfigLimits: BlockingConfigLimitsV1;
  oneTimeOnly: boolean;
  usedCount: number;
  version: number;
  validFrom: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  revokeReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CloudSessionStatus =
  | 'REQUESTED'
  | 'DELIVERED'
  | 'ACTIVE'
  | 'PAUSED'
  | 'INTERRUPTED'
  | 'COMPLETED'
  | 'RELEASED_EARLY'
  | 'EMERGENCY_STOPPED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED';

export const NON_TERMINAL_CLOUD_SESSION_STATUSES: readonly CloudSessionStatus[] = [
  'REQUESTED',
  'DELIVERED',
  'ACTIVE',
  'PAUSED',
  'INTERRUPTED'
] as const;

export const TERMINAL_CLOUD_SESSION_STATUSES: readonly CloudSessionStatus[] = [
  'COMPLETED',
  'RELEASED_EARLY',
  'EMERGENCY_STOPPED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED'
] as const;

export interface ArrestSessionRecord {
  sessionId: string;
  localSessionId: string | null;
  ownerUserId: string;
  targetDeviceId: string;
  initiatedByUserId: string;
  authorizationId: string | null;
  idempotencyKey: string | null;
  sessionType: SessionType;
  goal: string;
  blockingConfiguration: BlockingConfigurationV1;
  requestedDuration: number;
  status: CloudSessionStatus;
  localEngineState: AndroidEngineState | null;
  requestedAt: Date;
  acceptedAt: Date | null;
  startedAt: Date | null;
  expectedEndAt: Date | null;
  completedAt: Date | null;
  completionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CommandType =
  | 'START_ARREST'
  | 'REQUEST_RELEASE'
  | 'APPROVE_RELEASE'
  | 'DENY_RELEASE'
  | 'END_SESSION'
  | 'SYNC_SESSION';

export type CommandStatus =
  | 'PENDING'
  | 'DELIVERED'
  | 'ACKNOWLEDGED'
  | 'EXECUTED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'FAILED';

export type PushDeliveryStatus =
  | 'NOT_ATTEMPTED'
  | 'SENT'
  | 'NO_ACTIVE_TOKEN'
  | 'SKIPPED_DISABLED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_PERMANENT';

export interface SessionCommandRecord {
  sequenceNo: number;
  commandId: string;
  sessionId: string;
  targetDeviceId: string;
  issuedByUserId: string;
  commandType: CommandType;
  payload: Record<string, unknown>;
  status: CommandStatus;
  idempotencyKey: string;
  resultMetadata: Record<string, unknown> | null;
  failureReason: string | null;
  pushDeliveryStatus: PushDeliveryStatus;
  pushAttempts: number;
  lastPushAttemptAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
  deliveredAt: Date | null;
  acknowledgedAt: Date | null;
  executedAt: Date | null;
  updatedAt: Date;
}

export interface SessionSyncEventRecord {
  id: number;
  sessionId: string;
  deviceId: string;
  clientEventId: string;
  eventType: string;
  fromEngineState: AndroidEngineState | null;
  toEngineState: AndroidEngineState | null;
  occurredAtClientMs: number;
  metadata: Record<string, unknown> | null;
  recordedAt: Date;
}

export type ReleaseRequestStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'DENIED'
  | 'EXPIRED'
  | 'CANCELLED';

export interface ReleaseRequestRecord {
  id: string;
  sessionId: string;
  requesterUserId: string;
  approverUserId: string;
  reason: string;
  status: ReleaseRequestStatus;
  decisionReason: string | null;
  resolutionCommandId: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  updatedAt: Date;
}

export type AuditResult = 'SUCCESS' | 'DENIED' | 'FAILURE';

export interface AuditLogRecord {
  id: number;
  actorUserId: string | null;
  actorDeviceId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  result: AuditResult;
  ipAddress: string | null;
  requestId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
