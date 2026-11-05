import type { AllowedTimeWindowsConfig, RecurrenceRuleConfig } from '../shared/time';

export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  displayName: string;
  avatarUrl: string | null;
  inviteCode?: string | null;
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
  inviteCode?: string | null;
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

export interface ExactApprovedSessionConfig {
  sessionType: SessionType;
  goal: string;
  durationMinutes: number;
  blockingConfiguration: BlockingConfigurationV1;
}

export interface PartnerPermissionRecord {
  permissionId: string;
  ownerUserId: string;
  partnerUserId: string;
  targetDeviceId: string;
  proposalId?: string | null;
  approvedRevision?: number | null;
  exactBlockingConfiguration?: ExactApprovedSessionConfig | null;
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

export interface PartnerApprovalPolicyRecord {
  id: string;
  ownerUserId: string;
  partnerUserId: string;
  requireApprovalBeforeArrest: boolean;
  explicitlyConfigured: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ArrestRequestType =
  | 'IMMEDIATE'
  | 'SCHEDULED'
  | 'RECURRING'
  | 'STANDING_AUTHORIZATION';

export type ArrestProposalStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'COUNTEROFFERED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface ProposalScheduleSpec {
  localDate: string;
  localStartTime: string;
  localEndTime?: string | null;
  timezone: string;
  scheduledStartUtc: string;
  scheduledEndUtc: string;
}

export interface ProposalStandingAuthorizationSpec {
  validFromUtc: string;
  expiresAtUtc: string;
  maximumSessionDuration: number;
  allowedTimeWindows: AllowedTimeWindowsConfig | null;
  blockingConfigLimits: BlockingConfigLimitsV1;
}

export interface NormalizedProposalConfigurationV1 {
  schemaVersion: 1;
  requestType: ArrestRequestType;
  targetDeviceId: string;
  ownerUserId: string;
  initiatingPartnerUserId: string;
  sessionType: 'PARTNER_ARREST' | 'MUTUAL_ARREST';
  goal: string;
  durationMinutes: number;
  blockingConfiguration: BlockingConfigurationV1;
  requireApprovalBeforeArrest: boolean;
  schedule: ProposalScheduleSpec | null;
  recurrence: RecurrenceRuleConfig | null;
  standingAuthorization: ProposalStandingAuthorizationSpec | null;
}

export interface ArrestProposalRecord {
  proposalId: string;
  partnershipId: string;
  ownerUserId: string;
  partnerUserId: string;
  targetDeviceId: string;
  proposerUserId: string;
  recipientUserId: string;
  requestType: ArrestRequestType;
  currentRevision: number;
  status: ArrestProposalStatus;
  normalizedConfiguration: NormalizedProposalConfigurationV1;
  reason: string | null;
  approvedRevision: number | null;
  resultingPermissionId: string | null;
  resultingSessionId: string | null;
  resultingScheduleId: string | null;
  idempotencyKey: string | null;
  expiresAt: Date;
  respondedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ArrestProposalRevisionRecord {
  id: string;
  proposalId: string;
  revisionNumber: number;
  proposerUserId: string;
  recipientUserId: string;
  normalizedConfiguration: NormalizedProposalConfigurationV1;
  reason: string | null;
  status: ArrestProposalStatus;
  createdAt: Date;
  expiresAt: Date;
}

export type ScheduledArrestStatus =
  | 'SCHEDULED'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REVOKED'
  | 'EXPIRED';

export interface ScheduledArrestRecord {
  scheduleId: string;
  proposalId: string | null;
  permissionId: string | null;
  ownerUserId: string;
  partnerUserId: string;
  targetDeviceId: string;
  scheduleType: 'SCHEDULED' | 'RECURRING';
  sessionType: SessionType;
  goal: string;
  durationMinutes: number;
  blockingConfiguration: BlockingConfigurationV1;
  timezone: string;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  recurrenceRule: RecurrenceRuleConfig | null;
  occurrencesCompleted: number;
  maxOccurrences: number;
  nextOccurrenceAt: Date | null;
  lastMaterializedSessionId?: string | null;
  lastMaterializedAt?: Date | null;
  status: ScheduledArrestStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type RemoteExecutionPhase =
  | 'REQUESTED'
  | 'AUTHORIZED'
  | 'QUEUED'
  | 'DELIVERED'
  | 'EXECUTING'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED';

export interface SelectableAppCatalogItem {
  packageName: string;
  appLabel: string;
  category: string;
  isStudyCandidate: boolean;
}

export interface DeviceAppCatalogRecord {
  deviceId: string;
  ownerUserId: string;
  apps: SelectableAppCatalogItem[];
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
  | 'SYNC_SESSION'
  | 'APPLY_TEMPORARY_APP_ACCESS'
  | 'REVOKE_TEMPORARY_APP_ACCESS'
  | 'UPDATE_SESSION_RULES';

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

export type MessageType = 'TEXT' | 'STRUCTURED_REQUEST' | 'SYSTEM_EVENT';
export type MessageDeliveryStatus = 'SENT' | 'DELIVERED' | 'READ';

export type StructuredRequestType =
  | 'REQUEST_EARLY_RELEASE'
  | 'REQUEST_TEMPORARY_APP_ACCESS'
  | 'REQUEST_ADD_ALLOWED_APP'
  | 'REQUEST_REMOVE_BLOCKED_APP'
  | 'REQUEST_CHANGE_BLOCKING_MODE'
  | 'REQUEST_SESSION_EXTENSION'
  | 'REQUEST_SCHEDULE_CHANGE'
  | 'REQUEST_CUSTOM_ACTION';

export type StructuredRequestStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface ConversationRecord {
  id: string;
  partnershipId: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date | null;
}

export interface ConversationMemberRecord {
  conversationId: string;
  userId: string;
  joinedAt: Date;
  lastReadMessageId: string | null;
  lastReadAt: Date | null;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  senderUserId: string;
  clientMessageId: string;
  messageType: MessageType;
  textContent: string | null;
  structuredPayload: Record<string, unknown> | null;
  status: MessageDeliveryStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface StructuredRequestRecord {
  id: string;
  messageId: string;
  conversationId: string;
  requestType: StructuredRequestType;
  initiatorUserId: string;
  recipientUserId: string;
  sessionId: string | null;
  status: StructuredRequestStatus;
  durationMinutes: number | null;
  targetPackage: string | null;
  parametersJson: Record<string, unknown> | null;
  decisionReason: string | null;
  decidedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TemporaryAppAccessGrantRecord {
  id: string;
  sessionId: string;
  deviceId: string;
  packageName: string;
  grantedDurationMinutes: number;
  grantedByUserId: string;
  startsAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface SessionRuleRevisionRecord {
  id: string;
  sessionId: string;
  revisionNumber: number;
  modifiedByUserId: string;
  ruleChanges: Record<string, unknown>;
  appliedAt: Date;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
