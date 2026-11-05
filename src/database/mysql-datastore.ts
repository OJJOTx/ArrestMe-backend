import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../config/database';
import { Errors } from '../shared/errors';
import {
  fromMysqlDateTime,
  toMysqlDateTime,
  type AllowedTimeWindowsConfig,
  type RecurrenceRuleConfig
} from '../shared/time';
import {
  NON_TERMINAL_CLOUD_SESSION_STATUSES,
  TERMINAL_CLOUD_SESSION_STATUSES,
  type AccountStatus,
  type AndroidEngineState,
  type ArrestProposalRecord,
  type ArrestProposalRevisionRecord,
  type ArrestProposalStatus,
  type ArrestRequestType,
  type ArrestSessionRecord,
  type AuditLogRecord,
  type AuditResult,
  type BlockingConfigLimitsV1,
  type BlockingConfigurationV1,
  type CloudSessionStatus,
  type CommandStatus,
  type CommandType,
  type ConversationMemberRecord,
  type ConversationRecord,
  type DeviceAppCatalogRecord,
  type DevicePlatform,
  type DevicePushTokenRecord,
  type DeviceRecord,
  type DeviceStatus,
  type ExactApprovedSessionConfig,
  type MessageDeliveryStatus,
  type MessageRecord,
  type MessageType,
  type NormalizedProposalConfigurationV1,
  type PaginatedResult,
  type PartnerApprovalPolicyRecord,
  type PartnerPermissionRecord,
  type PartnershipRecord,
  type PartnershipState,
  type PushDeliveryStatus,
  type PushTokenStatus,
  type RefreshTokenRecord,
  type ReleaseRequestRecord,
  type ReleaseRequestStatus,
  type ScheduledArrestRecord,
  type ScheduledArrestStatus,
  type SelectableAppCatalogItem,
  type SessionCommandRecord,
  type SessionRuleRevisionRecord,
  type SessionSyncEventRecord,
  type SessionType,
  type StructuredRequestRecord,
  type StructuredRequestStatus,
  type StructuredRequestType,
  type TemporaryAppAccessGrantRecord,
  type UserRecord
} from '../types/domain';
import type {
  ApprovalPoliciesRepository,
  AuditLogsRepository,
  CommandsRepository,
  ConversationsRepository,
  DataStore,
  DeviceAppCatalogsRepository,
  DevicesRepository,
  MessagesRepository,
  PartnerPermissionsRepository,
  PartnershipsRepository,
  ProposalsRepository,
  PushTokensRepository,
  RefreshTokensRepository,
  ReleaseRequestsRepository,
  RepositoryBundle,
  ScheduledArrestsRepository,
  SessionRuleRevisionsRepository,
  SessionsRepository,
  StructuredRequestsRepository,
  TemporaryAppAccessGrantsRepository,
  UsersRepository
} from '../types/repositories';

type SqlParam = string | number | boolean | null;

function parseJsonColumn<T>(value: unknown): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

function isMysqlDuplicateError(err: unknown): err is { code: string; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<string, unknown>).code === 'ER_DUP_ENTRY'
  );
}

function canonicalPair(userA: string, userB: string): [string, string] {
  return userA < userB ? [userA, userB] : [userB, userA];
}

function mapUserRow(row: RowDataPacket): UserRecord {
  return {
    id: String(row.id),
    username: String(row.username),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    displayName: String(row.display_name),
    avatarUrl: row.avatar_url !== null ? String(row.avatar_url) : null,
    inviteCode:
      row.invite_code !== undefined && row.invite_code !== null ? String(row.invite_code) : null,
    accountStatus: row.account_status as AccountStatus,
    createdAt: fromMysqlDateTime(row.created_at)!,
    updatedAt: fromMysqlDateTime(row.updated_at)!,
    lastLoginAt: fromMysqlDateTime(row.last_login_at)
  };
}

function mapRefreshTokenRow(row: RowDataPacket): RefreshTokenRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    familyId: String(row.family_id),
    tokenHash: String(row.token_hash),
    deviceId: row.device_id !== null ? String(row.device_id) : null,
    userAgent: row.user_agent !== null ? String(row.user_agent) : null,
    ipAddress: row.ip_address !== null ? String(row.ip_address) : null,
    expiresAt: fromMysqlDateTime(row.expires_at)!,
    revokedAt: fromMysqlDateTime(row.revoked_at),
    revokedReason: row.revoked_reason !== null ? String(row.revoked_reason) : null,
    replacedById: row.replaced_by_id !== null ? String(row.replaced_by_id) : null,
    createdAt: fromMysqlDateTime(row.created_at)!
  };
}

function mapDeviceRow(row: RowDataPacket): DeviceRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    installationId: row.installation_id !== null ? String(row.installation_id) : null,
    deviceName: String(row.device_name),
    platform: row.platform as DevicePlatform,
    manufacturer: row.manufacturer !== null ? String(row.manufacturer) : null,
    model: row.model !== null ? String(row.model) : null,
    appVersion: String(row.app_version),
    androidVersion: String(row.android_version),
    sdkInt: row.sdk_int !== null ? Number(row.sdk_int) : null,
    deviceStatus: row.device_status as DeviceStatus,
    lastSeenAt: fromMysqlDateTime(row.last_seen_at),
    revokedAt: fromMysqlDateTime(row.revoked_at),
    createdAt: fromMysqlDateTime(row.created_at)!,
    updatedAt: fromMysqlDateTime(row.updated_at)!
  };
}

function mapPushTokenRow(row: RowDataPacket): DevicePushTokenRecord {
  return {
    id: String(row.id),
    deviceId: String(row.device_id),
    fcmToken: String(row.fcm_token),
    tokenHash: String(row.token_hash),
    tokenStatus: row.token_status as PushTokenStatus,
    invalidatedReason: row.invalidated_reason !== null ? String(row.invalidated_reason) : null,
    lastValidatedAt: fromMysqlDateTime(row.last_validated_at),
    createdAt: fromMysqlDateTime(row.created_at)!,
    updatedAt: fromMysqlDateTime(row.updated_at)!
  };
}

function mapPartnershipRow(row: RowDataPacket): PartnershipRecord {
  return {
    id: String(row.id),
    senderUserId: String(row.sender_user_id),
    recipientUserId: String(row.recipient_user_id),
    userLowId: String(row.user_low_id),
    userHighId: String(row.user_high_id),
    state: row.state as PartnershipState,
    blockedByUserId: row.blocked_by_user_id !== null ? String(row.blocked_by_user_id) : null,
    respondedAt: fromMysqlDateTime(row.responded_at),
    createdAt: fromMysqlDateTime(row.created_at)!,
    updatedAt: fromMysqlDateTime(row.updated_at)!
  };
}

function mapPermissionRow(row: RowDataPacket): PartnerPermissionRecord {
  return {
    permissionId: String(row.permission_id),
    ownerUserId: String(row.owner_user_id),
    partnerUserId: String(row.partner_user_id),
    targetDeviceId: String(row.target_device_id),
    proposalId:
      row.proposal_id !== undefined && row.proposal_id !== null ? String(row.proposal_id) : null,
    approvedRevision:
      row.approved_revision !== undefined && row.approved_revision !== null
        ? Number(row.approved_revision)
        : null,
    exactBlockingConfiguration:
      row.exact_blocking_configuration !== undefined && row.exact_blocking_configuration !== null
        ? parseJsonColumn<ExactApprovedSessionConfig>(row.exact_blocking_configuration)
        : null,
    maximumSessionDuration: Number(row.maximum_session_duration),
    allowedTimeWindows:
      row.allowed_time_windows !== null
        ? parseJsonColumn<AllowedTimeWindowsConfig>(row.allowed_time_windows)
        : null,
    allowedSessionTypes: parseJsonColumn<SessionType[]>(row.allowed_session_types),
    blockingConfigLimits: parseJsonColumn<BlockingConfigLimitsV1>(row.blocking_config_limits),
    oneTimeOnly: Boolean(row.one_time_only),
    usedCount: Number(row.used_count),
    version: Number(row.version),
    validFrom: fromMysqlDateTime(row.valid_from)!,
    expiresAt: fromMysqlDateTime(row.expires_at)!,
    revokedAt: fromMysqlDateTime(row.revoked_at),
    revokedByUserId: row.revoked_by_user_id !== null ? String(row.revoked_by_user_id) : null,
    revokeReason: row.revoke_reason !== null ? String(row.revoke_reason) : null,
    createdAt: fromMysqlDateTime(row.created_at)!,
    updatedAt: fromMysqlDateTime(row.updated_at)!
  };
}

function mapSessionRow(row: RowDataPacket): ArrestSessionRecord {
  return {
    sessionId: String(row.session_id),
    localSessionId: row.local_session_id !== null ? String(row.local_session_id) : null,
    ownerUserId: String(row.owner_user_id),
    targetDeviceId: String(row.target_device_id),
    initiatedByUserId: String(row.initiated_by_user_id),
    authorizationId: row.authorization_id !== null ? String(row.authorization_id) : null,
    idempotencyKey: row.idempotency_key !== null ? String(row.idempotency_key) : null,
    sessionType: row.session_type as SessionType,
    goal: String(row.goal),
    blockingConfiguration: parseJsonColumn<BlockingConfigurationV1>(row.blocking_configuration),
    requestedDuration: Number(row.requested_duration),
    status: row.status as CloudSessionStatus,
    localEngineState:
      row.local_engine_state !== null ? (row.local_engine_state as AndroidEngineState) : null,
    requestedAt: fromMysqlDateTime(row.requested_at)!,
    acceptedAt: fromMysqlDateTime(row.accepted_at),
    startedAt: fromMysqlDateTime(row.started_at),
    expectedEndAt: fromMysqlDateTime(row.expected_end_at),
    completedAt: fromMysqlDateTime(row.completed_at),
    completionReason: row.completion_reason !== null ? String(row.completion_reason) : null,
    createdAt: fromMysqlDateTime(row.created_at)!,
    updatedAt: fromMysqlDateTime(row.updated_at)!
  };
}

function mapCommandRow(row: RowDataPacket): SessionCommandRecord {
  return {
    sequenceNo: Number(row.sequence_no),
    commandId: String(row.command_id),
    sessionId: String(row.session_id),
    targetDeviceId: String(row.target_device_id),
    issuedByUserId: String(row.issued_by_user_id),
    commandType: row.command_type as CommandType,
    payload: parseJsonColumn<Record<string, unknown>>(row.payload),
    status: row.status as CommandStatus,
    idempotencyKey: String(row.idempotency_key),
    resultMetadata:
      row.result_metadata !== null
        ? parseJsonColumn<Record<string, unknown>>(row.result_metadata)
        : null,
    failureReason: row.failure_reason !== null ? String(row.failure_reason) : null,
    pushDeliveryStatus: row.push_delivery_status as PushDeliveryStatus,
    pushAttempts: Number(row.push_attempts),
    lastPushAttemptAt: fromMysqlDateTime(row.last_push_attempt_at),
    createdAt: fromMysqlDateTime(row.created_at)!,
    expiresAt: fromMysqlDateTime(row.expires_at)!,
    deliveredAt: fromMysqlDateTime(row.delivered_at),
    acknowledgedAt: fromMysqlDateTime(row.acknowledged_at),
    executedAt: fromMysqlDateTime(row.executed_at),
    updatedAt: fromMysqlDateTime(row.updated_at)!
  };
}

function mapReleaseRequestRow(row: RowDataPacket): ReleaseRequestRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    requesterUserId: String(row.requester_user_id),
    approverUserId: String(row.approver_user_id),
    reason: String(row.reason),
    status: row.status as ReleaseRequestStatus,
    decisionReason: row.decision_reason !== null ? String(row.decision_reason) : null,
    resolutionCommandId:
      row.resolution_command_id !== null ? String(row.resolution_command_id) : null,
    requestedAt: fromMysqlDateTime(row.requested_at)!,
    decidedAt: fromMysqlDateTime(row.decided_at),
    updatedAt: fromMysqlDateTime(row.updated_at)!
  };
}

class MysqlUsersRepository implements UsersRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(user: UserRecord): Promise<UserRecord> {
    try {
      await this.db.execute(
        `INSERT INTO users
          (id, username, email, password_hash, display_name, avatar_url, invite_code, account_status, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          user.username,
          user.email,
          user.passwordHash,
          user.displayName,
          user.avatarUrl,
          user.inviteCode ?? null,
          user.accountStatus,
          toMysqlDateTime(user.createdAt),
          toMysqlDateTime(user.updatedAt),
          user.lastLoginAt ? toMysqlDateTime(user.lastLoginAt) : null
        ]
      );
      return user;
    } catch (err) {
      if (isMysqlDuplicateError(err)) {
        if (err.message.includes('uq_users_email')) {
          throw Errors.conflict('EMAIL_ALREADY_REGISTERED', 'Email address is already registered.');
        }
        if (err.message.includes('uq_users_username')) {
          throw Errors.conflict('USERNAME_ALREADY_TAKEN', 'Username is already taken.');
        }
      }
      throw err;
    }
  }

  async findById(id: string): Promise<UserRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM users WHERE id = ? LIMIT 1',
      [id]
    );
    return rows[0] ? mapUserRow(rows[0]) : null;
  }

  async findByIds(ids: string[]): Promise<Map<string, UserRecord>> {
    const unique = Array.from(new Set(ids));
    const map = new Map<string, UserRecord>();
    if (unique.length === 0) return map;

    const placeholders = unique.map(() => '?').join(', ');
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM users WHERE id IN (${placeholders})`,
      unique
    );
    for (const r of rows) {
      const user = mapUserRow(r);
      map.set(user.id, user);
    }
    return map;
  }

  async findByEmail(normalizedEmail: string): Promise<UserRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM users WHERE email = ? LIMIT 1',
      [normalizedEmail]
    );
    return rows[0] ? mapUserRow(rows[0]) : null;
  }

  async findByUsername(normalizedUsername: string): Promise<UserRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM users WHERE username = ? LIMIT 1',
      [normalizedUsername]
    );
    return rows[0] ? mapUserRow(rows[0]) : null;
  }

  async findByInviteCode(inviteCode: string): Promise<UserRecord | null> {
    const normalized = inviteCode.trim().toUpperCase();
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM users WHERE invite_code = ? LIMIT 1',
      [normalized]
    );
    return rows[0] ? mapUserRow(rows[0]) : null;
  }

  async updateInviteCode(
    userId: string,
    inviteCode: string,
    updatedAt: Date
  ): Promise<UserRecord | null> {
    const normalized = inviteCode.trim().toUpperCase();
    try {
      await this.db.execute('UPDATE users SET invite_code = ?, updated_at = ? WHERE id = ?', [
        normalized,
        toMysqlDateTime(updatedAt),
        userId
      ]);
      return this.findById(userId);
    } catch (err) {
      if (isMysqlDuplicateError(err) && err.message.includes('uq_users_invite_code')) {
        throw Errors.conflict('BAD_REQUEST', 'Invite code is already in use.');
      }
      throw err;
    }
  }

  async updateProfile(
    userId: string,
    updates: { displayName?: string; avatarUrl?: string | null; updatedAt: Date }
  ): Promise<UserRecord | null> {
    const setClauses: string[] = ['updated_at = ?'];
    const params: SqlParam[] = [toMysqlDateTime(updates.updatedAt)];

    if (updates.displayName !== undefined) {
      setClauses.push('display_name = ?');
      params.push(updates.displayName);
    }
    if (updates.avatarUrl !== undefined) {
      setClauses.push('avatar_url = ?');
      params.push(updates.avatarUrl);
    }

    params.push(userId);
    await this.db.execute(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`, params);
    return this.findById(userId);
  }

  async updatePasswordHash(userId: string, passwordHash: string, updatedAt: Date): Promise<void> {
    await this.db.execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
      passwordHash,
      toMysqlDateTime(updatedAt),
      userId
    ]);
  }

  async updateLastLogin(userId: string, lastLoginAt: Date): Promise<void> {
    const ts = toMysqlDateTime(lastLoginAt);
    await this.db.execute('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [
      ts,
      ts,
      userId
    ]);
  }
}

class MysqlRefreshTokensRepository implements RefreshTokensRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(token: RefreshTokenRecord): Promise<RefreshTokenRecord> {
    await this.db.execute(
      `INSERT INTO refresh_tokens
        (id, user_id, family_id, token_hash, device_id, user_agent, ip_address, expires_at, revoked_at, revoked_reason, replaced_by_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        token.id,
        token.userId,
        token.familyId,
        token.tokenHash,
        token.deviceId,
        token.userAgent,
        token.ipAddress,
        toMysqlDateTime(token.expiresAt),
        token.revokedAt ? toMysqlDateTime(token.revokedAt) : null,
        token.revokedReason,
        token.replacedById,
        toMysqlDateTime(token.createdAt)
      ]
    );
    return token;
  }

  async findByHashForUpdate(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM refresh_tokens WHERE token_hash = ? LIMIT 1 FOR UPDATE',
      [tokenHash]
    );
    return rows[0] ? mapRefreshTokenRow(rows[0]) : null;
  }

  async revokeById(
    id: string,
    params: { revokedAt: Date; revokedReason: string; replacedById?: string | null }
  ): Promise<void> {
    await this.db.execute(
      `UPDATE refresh_tokens
       SET revoked_at = ?, revoked_reason = ?, replaced_by_id = COALESCE(?, replaced_by_id)
       WHERE id = ? AND revoked_at IS NULL`,
      [
        toMysqlDateTime(params.revokedAt),
        params.revokedReason,
        params.replacedById ?? null,
        id
      ]
    );
  }

  async revokeFamily(familyId: string, revokedAt: Date, revokedReason: string): Promise<number> {
    const [res] = await this.db.execute<ResultSetHeader>(
      `UPDATE refresh_tokens
       SET revoked_at = ?, revoked_reason = ?
       WHERE family_id = ? AND revoked_at IS NULL`,
      [toMysqlDateTime(revokedAt), revokedReason, familyId]
    );
    return res.affectedRows;
  }

  async revokeAllForUser(userId: string, revokedAt: Date, revokedReason: string): Promise<number> {
    const [res] = await this.db.execute<ResultSetHeader>(
      `UPDATE refresh_tokens
       SET revoked_at = ?, revoked_reason = ?
       WHERE user_id = ? AND revoked_at IS NULL`,
      [toMysqlDateTime(revokedAt), revokedReason, userId]
    );
    return res.affectedRows;
  }

  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    const [res] = await this.db.execute<ResultSetHeader>(
      'DELETE FROM refresh_tokens WHERE expires_at < ?',
      [toMysqlDateTime(cutoff)]
    );
    return res.affectedRows;
  }
}

class MysqlDevicesRepository implements DevicesRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(device: DeviceRecord): Promise<DeviceRecord> {
    await this.db.execute(
      `INSERT INTO devices
        (id, user_id, installation_id, device_name, platform, manufacturer, model, app_version, android_version, sdk_int, device_status, last_seen_at, revoked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        device.id,
        device.userId,
        device.installationId,
        device.deviceName,
        device.platform,
        device.manufacturer,
        device.model,
        device.appVersion,
        device.androidVersion,
        device.sdkInt,
        device.deviceStatus,
        device.lastSeenAt ? toMysqlDateTime(device.lastSeenAt) : null,
        device.revokedAt ? toMysqlDateTime(device.revokedAt) : null,
        toMysqlDateTime(device.createdAt),
        toMysqlDateTime(device.updatedAt)
      ]
    );
    return device;
  }

  async findById(id: string): Promise<DeviceRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM devices WHERE id = ? LIMIT 1',
      [id]
    );
    return rows[0] ? mapDeviceRow(rows[0]) : null;
  }

  async findByIdForUpdate(id: string): Promise<DeviceRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM devices WHERE id = ? LIMIT 1 FOR UPDATE',
      [id]
    );
    return rows[0] ? mapDeviceRow(rows[0]) : null;
  }

  async findByIds(ids: string[]): Promise<Map<string, DeviceRecord>> {
    const unique = Array.from(new Set(ids));
    const map = new Map<string, DeviceRecord>();
    if (unique.length === 0) return map;

    const placeholders = unique.map(() => '?').join(', ');
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM devices WHERE id IN (${placeholders})`,
      unique
    );
    for (const r of rows) {
      const dev = mapDeviceRow(r);
      map.set(dev.id, dev);
    }
    return map;
  }

  async findByUserAndInstallation(
    userId: string,
    installationId: string
  ): Promise<DeviceRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM devices WHERE user_id = ? AND installation_id = ? LIMIT 1 FOR UPDATE',
      [userId, installationId]
    );
    return rows[0] ? mapDeviceRow(rows[0]) : null;
  }

  async listByUser(
    userId: string,
    options: { includeRevoked?: boolean; limit: number; offset: number }
  ): Promise<PaginatedResult<DeviceRecord>> {
    const whereClause = options.includeRevoked
      ? 'user_id = ?'
      : "user_id = ? AND device_status <> 'REVOKED'";

    const [countRows] = await this.db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM devices WHERE ${whereClause}`,
      [userId]
    );
    const total = Number(countRows[0]?.total ?? 0);

    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM devices WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [userId, String(options.limit), String(options.offset)]
    );

    return {
      items: rows.map(mapDeviceRow),
      total,
      limit: options.limit,
      offset: options.offset
    };
  }

  async listActiveByUser(userId: string): Promise<DeviceRecord[]> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      "SELECT * FROM devices WHERE user_id = ? AND device_status = 'ACTIVE' ORDER BY updated_at DESC",
      [userId]
    );
    return rows.map(mapDeviceRow);
  }

  async update(
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
  ): Promise<DeviceRecord | null> {
    const setClauses: string[] = ['updated_at = ?'];
    const params: SqlParam[] = [toMysqlDateTime(updates.updatedAt)];

    if (updates.deviceName !== undefined) {
      setClauses.push('device_name = ?');
      params.push(updates.deviceName);
    }
    if (updates.manufacturer !== undefined) {
      setClauses.push('manufacturer = ?');
      params.push(updates.manufacturer);
    }
    if (updates.model !== undefined) {
      setClauses.push('model = ?');
      params.push(updates.model);
    }
    if (updates.appVersion !== undefined) {
      setClauses.push('app_version = ?');
      params.push(updates.appVersion);
    }
    if (updates.androidVersion !== undefined) {
      setClauses.push('android_version = ?');
      params.push(updates.androidVersion);
    }
    if (updates.sdkInt !== undefined) {
      setClauses.push('sdk_int = ?');
      params.push(updates.sdkInt);
    }
    if (updates.deviceStatus !== undefined) {
      setClauses.push('device_status = ?');
      params.push(updates.deviceStatus);
    }
    if (updates.lastSeenAt !== undefined) {
      setClauses.push('last_seen_at = ?');
      params.push(toMysqlDateTime(updates.lastSeenAt));
    }
    if (updates.revokedAt !== undefined) {
      setClauses.push('revoked_at = ?');
      params.push(updates.revokedAt ? toMysqlDateTime(updates.revokedAt) : null);
    }

    params.push(id);
    await this.db.execute(`UPDATE devices SET ${setClauses.join(', ')} WHERE id = ?`, params);
    return this.findById(id);
  }

  async touchLastSeen(id: string, seenAt: Date): Promise<void> {
    const ts = toMysqlDateTime(seenAt);
    await this.db.execute(
      "UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ? AND device_status <> 'REVOKED'",
      [ts, ts, id]
    );
  }
}

class MysqlPushTokensRepository implements PushTokensRepository {
  constructor(private readonly db: SqlExecutor) {}

  async upsertForDevice(params: {
    id: string;
    deviceId: string;
    fcmToken: string;
    tokenHash: string;
    now: Date;
  }): Promise<DevicePushTokenRecord> {
    const ts = toMysqlDateTime(params.now);

    await this.db.execute(
      `UPDATE device_push_tokens
       SET token_status = 'REVOKED', invalidated_reason = 'ROTATED_ON_DEVICE', updated_at = ?
       WHERE device_id = ? AND token_hash <> ? AND token_status = 'ACTIVE'`,
      [ts, params.deviceId, params.tokenHash]
    );

    await this.db.execute(
      `INSERT INTO device_push_tokens
        (id, device_id, fcm_token, token_hash, token_status, invalidated_reason, last_validated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ACTIVE', NULL, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         device_id = VALUES(device_id),
         fcm_token = VALUES(fcm_token),
         token_status = 'ACTIVE',
         invalidated_reason = NULL,
         last_validated_at = VALUES(last_validated_at),
         updated_at = VALUES(updated_at)`,
      [params.id, params.deviceId, params.fcmToken, params.tokenHash, ts, ts, ts]
    );

    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM device_push_tokens WHERE token_hash = ? LIMIT 1',
      [params.tokenHash]
    );
    return mapPushTokenRow(rows[0]!);
  }

  async listActiveForDevice(deviceId: string): Promise<DevicePushTokenRecord[]> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT pt.* FROM device_push_tokens pt
       INNER JOIN devices d ON d.id = pt.device_id
       WHERE pt.device_id = ? AND pt.token_status = 'ACTIVE' AND d.device_status = 'ACTIVE'`,
      [deviceId]
    );
    return rows.map(mapPushTokenRow);
  }

  async listActiveForUser(userId: string): Promise<DevicePushTokenRecord[]> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT pt.* FROM device_push_tokens pt
       INNER JOIN devices d ON d.id = pt.device_id
       WHERE d.user_id = ? AND d.device_status = 'ACTIVE' AND pt.token_status = 'ACTIVE'`,
      [userId]
    );
    return rows.map(mapPushTokenRow);
  }

  async markTokenInvalid(tokenHash: string, reason: string, now: Date): Promise<void> {
    await this.db.execute(
      `UPDATE device_push_tokens
       SET token_status = 'INVALID', invalidated_reason = ?, updated_at = ?
       WHERE token_hash = ?`,
      [reason.slice(0, 128), toMysqlDateTime(now), tokenHash]
    );
  }

  async revokeAllForDevice(deviceId: string, reason: string, now: Date): Promise<number> {
    const [res] = await this.db.execute<ResultSetHeader>(
      `UPDATE device_push_tokens
       SET token_status = 'REVOKED', invalidated_reason = ?, updated_at = ?
       WHERE device_id = ? AND token_status = 'ACTIVE'`,
      [reason.slice(0, 128), toMysqlDateTime(now), deviceId]
    );
    return res.affectedRows;
  }
}

class MysqlPartnershipsRepository implements PartnershipsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async findById(id: string): Promise<PartnershipRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM partnerships WHERE id = ? LIMIT 1',
      [id]
    );
    return rows[0] ? mapPartnershipRow(rows[0]) : null;
  }

  async findByIdForUpdate(id: string): Promise<PartnershipRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM partnerships WHERE id = ? LIMIT 1 FOR UPDATE',
      [id]
    );
    return rows[0] ? mapPartnershipRow(rows[0]) : null;
  }

  async findByPairForUpdate(userA: string, userB: string): Promise<PartnershipRecord | null> {
    const [low, high] = canonicalPair(userA, userB);
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM partnerships WHERE user_low_id = ? AND user_high_id = ? LIMIT 1 FOR UPDATE',
      [low, high]
    );
    return rows[0] ? mapPartnershipRow(rows[0]) : null;
  }

  async findByPair(userA: string, userB: string): Promise<PartnershipRecord | null> {
    const [low, high] = canonicalPair(userA, userB);
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM partnerships WHERE user_low_id = ? AND user_high_id = ? LIMIT 1',
      [low, high]
    );
    return rows[0] ? mapPartnershipRow(rows[0]) : null;
  }

  async create(record: PartnershipRecord): Promise<PartnershipRecord> {
    try {
      await this.db.execute(
        `INSERT INTO partnerships
          (id, sender_user_id, recipient_user_id, user_low_id, user_high_id, state, blocked_by_user_id, responded_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.senderUserId,
          record.recipientUserId,
          record.userLowId,
          record.userHighId,
          record.state,
          record.blockedByUserId,
          record.respondedAt ? toMysqlDateTime(record.respondedAt) : null,
          toMysqlDateTime(record.createdAt),
          toMysqlDateTime(record.updatedAt)
        ]
      );
      return record;
    } catch (err) {
      if (isMysqlDuplicateError(err)) {
        throw Errors.conflict(
          'PARTNERSHIP_CONFLICT',
          'A partnership record already exists between these users.'
        );
      }
      throw err;
    }
  }

  async update(
    id: string,
    updates: {
      senderUserId?: string;
      recipientUserId?: string;
      state: PartnershipState;
      blockedByUserId?: string | null;
      respondedAt?: Date | null;
      updatedAt: Date;
    }
  ): Promise<PartnershipRecord> {
    const setClauses: string[] = ['state = ?', 'updated_at = ?'];
    const params: SqlParam[] = [updates.state, toMysqlDateTime(updates.updatedAt)];

    if (updates.senderUserId !== undefined) {
      setClauses.push('sender_user_id = ?');
      params.push(updates.senderUserId);
    }
    if (updates.recipientUserId !== undefined) {
      setClauses.push('recipient_user_id = ?');
      params.push(updates.recipientUserId);
    }
    if (updates.blockedByUserId !== undefined) {
      setClauses.push('blocked_by_user_id = ?');
      params.push(updates.blockedByUserId);
    }
    if (updates.respondedAt !== undefined) {
      setClauses.push('responded_at = ?');
      params.push(updates.respondedAt ? toMysqlDateTime(updates.respondedAt) : null);
    }

    params.push(id);
    await this.db.execute(`UPDATE partnerships SET ${setClauses.join(', ')} WHERE id = ?`, params);
    const updated = await this.findById(id);
    if (!updated) {
      throw Errors.notFound('PARTNERSHIP_NOT_FOUND', 'Partnership record was not found.');
    }
    return updated;
  }

  async listRequestsForUser(
    userId: string,
    options: {
      direction: 'incoming' | 'outgoing' | 'all';
      state?: PartnershipState;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<PartnershipRecord>> {
    const conditions: string[] = [];
    const params: SqlParam[] = [];

    if (options.direction === 'incoming') {
      conditions.push('recipient_user_id = ?');
      params.push(userId);
    } else if (options.direction === 'outgoing') {
      conditions.push('sender_user_id = ?');
      params.push(userId);
    } else {
      conditions.push('(sender_user_id = ? OR recipient_user_id = ?)');
      params.push(userId, userId);
    }

    if (options.state) {
      conditions.push('state = ?');
      params.push(options.state);
    } else {
      conditions.push("state = 'PENDING'");
    }

    const whereSql = conditions.join(' AND ');
    const [countRows] = await this.db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM partnerships WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total ?? 0);

    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM partnerships WHERE ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, String(options.limit), String(options.offset)]
    );

    return {
      items: rows.map(mapPartnershipRow),
      total,
      limit: options.limit,
      offset: options.offset
    };
  }

  async listAcceptedPartnersForUser(
    userId: string,
    options: { limit: number; offset: number }
  ): Promise<PaginatedResult<PartnershipRecord>> {
    const whereSql = "(sender_user_id = ? OR recipient_user_id = ?) AND state = 'ACCEPTED'";
    const [countRows] = await this.db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM partnerships WHERE ${whereSql}`,
      [userId, userId]
    );
    const total = Number(countRows[0]?.total ?? 0);

    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM partnerships WHERE ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [userId, userId, String(options.limit), String(options.offset)]
    );

    return {
      items: rows.map(mapPartnershipRow),
      total,
      limit: options.limit,
      offset: options.offset
    };
  }
}

class MysqlPartnerPermissionsRepository implements PartnerPermissionsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(record: PartnerPermissionRecord): Promise<PartnerPermissionRecord> {
    await this.db.execute(
      `INSERT INTO partner_permissions
        (permission_id, owner_user_id, partner_user_id, target_device_id, proposal_id, approved_revision,
         exact_blocking_configuration, maximum_session_duration, allowed_time_windows, allowed_session_types,
         blocking_config_limits, one_time_only, used_count, version, valid_from, expires_at, revoked_at,
         revoked_by_user_id, revoke_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.permissionId,
        record.ownerUserId,
        record.partnerUserId,
        record.targetDeviceId,
        record.proposalId ?? null,
        record.approvedRevision ?? null,
        record.exactBlockingConfiguration
          ? JSON.stringify(record.exactBlockingConfiguration)
          : null,
        record.maximumSessionDuration,
        record.allowedTimeWindows ? JSON.stringify(record.allowedTimeWindows) : null,
        JSON.stringify(record.allowedSessionTypes),
        JSON.stringify(record.blockingConfigLimits),
        record.oneTimeOnly ? 1 : 0,
        record.usedCount,
        record.version,
        toMysqlDateTime(record.validFrom),
        toMysqlDateTime(record.expiresAt),
        record.revokedAt ? toMysqlDateTime(record.revokedAt) : null,
        record.revokedByUserId,
        record.revokeReason,
        toMysqlDateTime(record.createdAt),
        toMysqlDateTime(record.updatedAt)
      ]
    );
    return record;
  }

  async findById(permissionId: string): Promise<PartnerPermissionRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM partner_permissions WHERE permission_id = ? LIMIT 1',
      [permissionId]
    );
    return rows[0] ? mapPermissionRow(rows[0]) : null;
  }

  async findByIdForUpdate(permissionId: string): Promise<PartnerPermissionRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM partner_permissions WHERE permission_id = ? LIMIT 1 FOR UPDATE',
      [permissionId]
    );
    return rows[0] ? mapPermissionRow(rows[0]) : null;
  }

  async listForUser(
    userId: string,
    options: {
      role: 'granted' | 'received' | 'all';
      activeOnly: boolean;
      now: Date;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<PartnerPermissionRecord>> {
    const conditions: string[] = [];
    const params: SqlParam[] = [];

    if (options.role === 'granted') {
      conditions.push('owner_user_id = ?');
      params.push(userId);
    } else if (options.role === 'received') {
      conditions.push('partner_user_id = ?');
      params.push(userId);
    } else {
      conditions.push('(owner_user_id = ? OR partner_user_id = ?)');
      params.push(userId, userId);
    }

    if (options.activeOnly) {
      conditions.push('revoked_at IS NULL AND expires_at > ? AND (one_time_only = 0 OR used_count < 1)');
      params.push(toMysqlDateTime(options.now));
    }

    const whereSql = conditions.join(' AND ');
    const [countRows] = await this.db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM partner_permissions WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total ?? 0);

    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM partner_permissions WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, String(options.limit), String(options.offset)]
    );

    return {
      items: rows.map(mapPermissionRow),
      total,
      limit: options.limit,
      offset: options.offset
    };
  }

  async update(
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
  ): Promise<PartnerPermissionRecord> {
    const setClauses: string[] = ['version = ?', 'updated_at = ?'];
    const params: SqlParam[] = [updates.version, toMysqlDateTime(updates.updatedAt)];

    if (updates.maximumSessionDuration !== undefined) {
      setClauses.push('maximum_session_duration = ?');
      params.push(updates.maximumSessionDuration);
    }
    if (updates.allowedTimeWindows !== undefined) {
      setClauses.push('allowed_time_windows = ?');
      params.push(updates.allowedTimeWindows ? JSON.stringify(updates.allowedTimeWindows) : null);
    }
    if (updates.allowedSessionTypes !== undefined) {
      setClauses.push('allowed_session_types = ?');
      params.push(JSON.stringify(updates.allowedSessionTypes));
    }
    if (updates.blockingConfigLimits !== undefined) {
      setClauses.push('blocking_config_limits = ?');
      params.push(JSON.stringify(updates.blockingConfigLimits));
    }
    if (updates.oneTimeOnly !== undefined) {
      setClauses.push('one_time_only = ?');
      params.push(updates.oneTimeOnly ? 1 : 0);
    }
    if (updates.validFrom !== undefined) {
      setClauses.push('valid_from = ?');
      params.push(toMysqlDateTime(updates.validFrom));
    }
    if (updates.expiresAt !== undefined) {
      setClauses.push('expires_at = ?');
      params.push(toMysqlDateTime(updates.expiresAt));
    }

    params.push(permissionId);
    await this.db.execute(
      `UPDATE partner_permissions SET ${setClauses.join(', ')} WHERE permission_id = ?`,
      params
    );
    const record = await this.findById(permissionId);
    if (!record) {
      throw Errors.notFound('PERMISSION_NOT_FOUND', 'Partner permission was not found.');
    }
    return record;
  }

  async incrementUsedCount(permissionId: string, now: Date): Promise<void> {
    await this.db.execute(
      'UPDATE partner_permissions SET used_count = used_count + 1, updated_at = ? WHERE permission_id = ?',
      [toMysqlDateTime(now), permissionId]
    );
  }

  async revokeById(
    permissionId: string,
    params: { revokedByUserId: string; revokeReason: string; now: Date }
  ): Promise<PartnerPermissionRecord | null> {
    const ts = toMysqlDateTime(params.now);
    await this.db.execute(
      `UPDATE partner_permissions
       SET revoked_at = ?, revoked_by_user_id = ?, revoke_reason = ?, updated_at = ?
       WHERE permission_id = ? AND revoked_at IS NULL`,
      [ts, params.revokedByUserId, params.revokeReason, ts, permissionId]
    );
    await this.db.execute(
      `UPDATE scheduled_arrests
       SET status = 'REVOKED', updated_at = ?
       WHERE permission_id = ? AND status = 'SCHEDULED'`,
      [ts, permissionId]
    );
    return this.findById(permissionId);
  }

  async revokeBetweenUsers(
    userA: string,
    userB: string,
    params: { revokedByUserId: string; revokeReason: string; now: Date }
  ): Promise<number> {
    const ts = toMysqlDateTime(params.now);
    const [res] = await this.db.execute<ResultSetHeader>(
      `UPDATE partner_permissions
       SET revoked_at = ?, revoked_by_user_id = ?, revoke_reason = ?, updated_at = ?
       WHERE revoked_at IS NULL
         AND ((owner_user_id = ? AND partner_user_id = ?) OR (owner_user_id = ? AND partner_user_id = ?))`,
      [
        ts,
        params.revokedByUserId,
        params.revokeReason,
        ts,
        userA,
        userB,
        userB,
        userA
      ]
    );
    await this.db.execute(
      `UPDATE scheduled_arrests
       SET status = 'REVOKED', updated_at = ?
       WHERE status = 'SCHEDULED'
         AND ((owner_user_id = ? AND partner_user_id = ?) OR (owner_user_id = ? AND partner_user_id = ?))`,
      [ts, userA, userB, userB, userA]
    );
    await this.db.execute(
      `UPDATE arrest_proposals
       SET status = 'CANCELLED', responded_at = ?, updated_at = ?
       WHERE status IN ('PENDING', 'COUNTEROFFERED', 'DRAFT')
         AND ((owner_user_id = ? AND partner_user_id = ?) OR (owner_user_id = ? AND partner_user_id = ?))`,
      [ts, ts, userA, userB, userB, userA]
    );
    return res.affectedRows;
  }

  async revokeAllForDevice(
    deviceId: string,
    params: { revokedByUserId: string; revokeReason: string; now: Date }
  ): Promise<number> {
    const ts = toMysqlDateTime(params.now);
    const [res] = await this.db.execute<ResultSetHeader>(
      `UPDATE partner_permissions
       SET revoked_at = ?, revoked_by_user_id = ?, revoke_reason = ?, updated_at = ?
       WHERE target_device_id = ? AND revoked_at IS NULL`,
      [ts, params.revokedByUserId, params.revokeReason, ts, deviceId]
    );
    await this.db.execute(
      `UPDATE scheduled_arrests
       SET status = 'REVOKED', updated_at = ?
       WHERE target_device_id = ? AND status = 'SCHEDULED'`,
      [ts, deviceId]
    );
    return res.affectedRows;
  }
}

function mapApprovalPolicyRow(row: RowDataPacket): PartnerApprovalPolicyRecord {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    partnerUserId: String(row.partner_user_id),
    requireApprovalBeforeArrest: Boolean(row.require_approval_before_arrest),
    explicitlyConfigured: Boolean(row.explicitly_configured),
    notes: row.notes !== null ? String(row.notes) : null,
    createdAt: fromMysqlDateTime(row.created_at)!,
    updatedAt: fromMysqlDateTime(row.updated_at)!
  };
}

function mapProposalRow(row: RowDataPacket): ArrestProposalRecord {
  return {
    proposalId: String(row.proposal_id),
    partnershipId: String(row.partnership_id),
    ownerUserId: String(row.owner_user_id),
    partnerUserId: String(row.partner_user_id),
    targetDeviceId: String(row.target_device_id),
    proposerUserId: String(row.proposer_user_id),
    recipientUserId: String(row.recipient_user_id),
    requestType: row.request_type as ArrestRequestType,
    currentRevision: Number(row.current_revision),
    status: row.status as ArrestProposalStatus,
    normalizedConfiguration: parseJsonColumn<NormalizedProposalConfigurationV1>(
      row.normalized_configuration
    ),
    reason: row.reason !== null ? String(row.reason) : null,
    approvedRevision: row.approved_revision !== null ? Number(row.approved_revision) : null,
    resultingPermissionId:
      row.resulting_permission_id !== null ? String(row.resulting_permission_id) : null,
    resultingSessionId:
      row.resulting_session_id !== null ? String(row.resulting_session_id) : null,
    resultingScheduleId:
      row.resulting_schedule_id !== null ? String(row.resulting_schedule_id) : null,
    idempotencyKey: row.idempotency_key !== null ? String(row.idempotency_key) : null,
    expiresAt: fromMysqlDateTime(row.expires_at)!,
    respondedAt: fromMysqlDateTime(row.responded_at),
    createdAt: fromMysqlDateTime(row.created_at)!,
    updatedAt: fromMysqlDateTime(row.updated_at)!
  };
}

function mapProposalRevisionRow(row: RowDataPacket): ArrestProposalRevisionRecord {
  return {
    id: String(row.id),
    proposalId: String(row.proposal_id),
    revisionNumber: Number(row.revision_number),
    proposerUserId: String(row.proposer_user_id),
    recipientUserId: String(row.recipient_user_id),
    normalizedConfiguration: parseJsonColumn<NormalizedProposalConfigurationV1>(
      row.normalized_configuration
    ),
    reason: row.reason !== null ? String(row.reason) : null,
    status: row.status as ArrestProposalStatus,
    createdAt: fromMysqlDateTime(row.created_at)!,
    expiresAt: fromMysqlDateTime(row.expires_at)!
  };
}

function mapScheduledArrestRow(row: RowDataPacket): ScheduledArrestRecord {
  return {
    scheduleId: String(row.schedule_id),
    proposalId: row.proposal_id !== null ? String(row.proposal_id) : null,
    permissionId: row.permission_id !== null ? String(row.permission_id) : null,
    ownerUserId: String(row.owner_user_id),
    partnerUserId: String(row.partner_user_id),
    targetDeviceId: String(row.target_device_id),
    scheduleType: row.schedule_type as 'SCHEDULED' | 'RECURRING',
    sessionType: row.session_type as SessionType,
    goal: String(row.goal),
    durationMinutes: Number(row.duration_minutes),
    blockingConfiguration: parseJsonColumn<BlockingConfigurationV1>(row.blocking_configuration),
    timezone: String(row.timezone),
    scheduledStartAt: fromMysqlDateTime(row.scheduled_start_at),
    scheduledEndAt: fromMysqlDateTime(row.scheduled_end_at),
    recurrenceRule:
      row.recurrence_rule !== null
        ? parseJsonColumn<RecurrenceRuleConfig>(row.recurrence_rule)
        : null,
    occurrencesCompleted: Number(row.occurrences_completed),
    maxOccurrences: Number(row.max_occurrences),
    nextOccurrenceAt: fromMysqlDateTime(row.next_occurrence_at),
    lastMaterializedSessionId:
      row.last_materialized_session_id !== undefined && row.last_materialized_session_id !== null
        ? String(row.last_materialized_session_id)
        : null,
    lastMaterializedAt:
      row.last_materialized_at !== undefined
        ? fromMysqlDateTime(row.last_materialized_at)
        : null,
    status: row.status as ScheduledArrestStatus,
    createdAt: fromMysqlDateTime(row.created_at)!,
    updatedAt: fromMysqlDateTime(row.updated_at)!
  };
}

class MysqlApprovalPoliciesRepository implements ApprovalPoliciesRepository {
  constructor(private readonly db: SqlExecutor) {}

  async findByOwnerAndPartner(
    ownerUserId: string,
    partnerUserId: string
  ): Promise<PartnerApprovalPolicyRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM partner_approval_policies WHERE owner_user_id = ? AND partner_user_id = ? LIMIT 1',
      [ownerUserId, partnerUserId]
    );
    return rows[0] ? mapApprovalPolicyRow(rows[0]) : null;
  }

  async findByOwnerAndPartnerForUpdate(
    ownerUserId: string,
    partnerUserId: string
  ): Promise<PartnerApprovalPolicyRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM partner_approval_policies WHERE owner_user_id = ? AND partner_user_id = ? LIMIT 1 FOR UPDATE',
      [ownerUserId, partnerUserId]
    );
    return rows[0] ? mapApprovalPolicyRow(rows[0]) : null;
  }

  async upsert(params: {
    id: string;
    ownerUserId: string;
    partnerUserId: string;
    requireApprovalBeforeArrest: boolean;
    explicitlyConfigured: boolean;
    notes?: string | null;
    now: Date;
  }): Promise<PartnerApprovalPolicyRecord> {
    const ts = toMysqlDateTime(params.now);
    await this.db.execute(
      `INSERT INTO partner_approval_policies
        (id, owner_user_id, partner_user_id, require_approval_before_arrest, explicitly_configured, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         require_approval_before_arrest = VALUES(require_approval_before_arrest),
         explicitly_configured = VALUES(explicitly_configured),
         notes = COALESCE(VALUES(notes), notes),
         updated_at = VALUES(updated_at)`,
      [
        params.id,
        params.ownerUserId,
        params.partnerUserId,
        params.requireApprovalBeforeArrest ? 1 : 0,
        params.explicitlyConfigured ? 1 : 0,
        params.notes ?? null,
        ts,
        ts
      ]
    );
    const updated = await this.findByOwnerAndPartner(params.ownerUserId, params.partnerUserId);
    return updated!;
  }
}

class MysqlProposalsRepository implements ProposalsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async createWithInitialRevision(
    proposal: ArrestProposalRecord,
    initialRevision: ArrestProposalRevisionRecord
  ): Promise<{ proposal: ArrestProposalRecord; revision: ArrestProposalRevisionRecord }> {
    try {
      await this.db.execute(
        `INSERT INTO arrest_proposals
          (proposal_id, partnership_id, owner_user_id, partner_user_id, target_device_id,
           proposer_user_id, recipient_user_id, request_type, current_revision, status,
           normalized_configuration, reason, approved_revision, resulting_permission_id,
           resulting_session_id, resulting_schedule_id, idempotency_key, expires_at,
           responded_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          proposal.proposalId,
          proposal.partnershipId,
          proposal.ownerUserId,
          proposal.partnerUserId,
          proposal.targetDeviceId,
          proposal.proposerUserId,
          proposal.recipientUserId,
          proposal.requestType,
          proposal.currentRevision,
          proposal.status,
          JSON.stringify(proposal.normalizedConfiguration),
          proposal.reason,
          proposal.approvedRevision,
          proposal.resultingPermissionId,
          proposal.resultingSessionId,
          proposal.resultingScheduleId,
          proposal.idempotencyKey,
          toMysqlDateTime(proposal.expiresAt),
          proposal.respondedAt ? toMysqlDateTime(proposal.respondedAt) : null,
          toMysqlDateTime(proposal.createdAt),
          toMysqlDateTime(proposal.updatedAt)
        ]
      );

      await this.db.execute(
        `INSERT INTO arrest_proposal_revisions
          (id, proposal_id, revision_number, proposer_user_id, recipient_user_id,
           normalized_configuration, reason, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          initialRevision.id,
          initialRevision.proposalId,
          initialRevision.revisionNumber,
          initialRevision.proposerUserId,
          initialRevision.recipientUserId,
          JSON.stringify(initialRevision.normalizedConfiguration),
          initialRevision.reason,
          initialRevision.status,
          toMysqlDateTime(initialRevision.createdAt),
          toMysqlDateTime(initialRevision.expiresAt)
        ]
      );

      return { proposal, revision: initialRevision };
    } catch (err) {
      if (isMysqlDuplicateError(err) && err.message.includes('uq_proposals_proposer_idem')) {
        throw Errors.conflict(
          'IDEMPOTENCY_CONFLICT',
          'A proposal with this idempotency key already exists.'
        );
      }
      throw err;
    }
  }

  async findById(proposalId: string): Promise<ArrestProposalRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM arrest_proposals WHERE proposal_id = ? LIMIT 1',
      [proposalId]
    );
    return rows[0] ? mapProposalRow(rows[0]) : null;
  }

  async findByIdForUpdate(proposalId: string): Promise<ArrestProposalRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM arrest_proposals WHERE proposal_id = ? LIMIT 1 FOR UPDATE',
      [proposalId]
    );
    return rows[0] ? mapProposalRow(rows[0]) : null;
  }

  async findByProposerAndIdempotencyKey(
    proposerUserId: string,
    idempotencyKey: string
  ): Promise<ArrestProposalRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM arrest_proposals WHERE proposer_user_id = ? AND idempotency_key = ? LIMIT 1',
      [proposerUserId, idempotencyKey]
    );
    return rows[0] ? mapProposalRow(rows[0]) : null;
  }

  async listRevisions(proposalId: string): Promise<ArrestProposalRevisionRecord[]> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM arrest_proposal_revisions WHERE proposal_id = ? ORDER BY revision_number ASC',
      [proposalId]
    );
    return rows.map(mapProposalRevisionRow);
  }

  async listForUser(
    userId: string,
    options: {
      role?: 'incoming' | 'outgoing' | 'all';
      status?: ArrestProposalStatus;
      partnerUserId?: string;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<ArrestProposalRecord>> {
    const conditions: string[] = [];
    const params: SqlParam[] = [];

    if (options.role === 'incoming') {
      conditions.push('recipient_user_id = ?');
      params.push(userId);
    } else if (options.role === 'outgoing') {
      conditions.push('proposer_user_id = ?');
      params.push(userId);
    } else {
      conditions.push('(owner_user_id = ? OR partner_user_id = ?)');
      params.push(userId, userId);
    }

    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options.partnerUserId) {
      conditions.push(
        '((owner_user_id = ? AND partner_user_id = ?) OR (owner_user_id = ? AND partner_user_id = ?))'
      );
      params.push(userId, options.partnerUserId, options.partnerUserId, userId);
    }

    const whereSql = conditions.join(' AND ');
    const [countRows] = await this.db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM arrest_proposals WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total ?? 0);

    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM arrest_proposals WHERE ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, String(options.limit), String(options.offset)]
    );

    return {
      items: rows.map(mapProposalRow),
      total,
      limit: options.limit,
      offset: options.offset
    };
  }

  async addCounterofferRevision(
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
  ): Promise<{ proposal: ArrestProposalRecord; revision: ArrestProposalRevisionRecord }> {
    await this.db.execute(
      `UPDATE arrest_proposals
       SET proposer_user_id = ?, recipient_user_id = ?, request_type = ?, current_revision = ?,
           status = ?, normalized_configuration = ?, reason = ?, expires_at = ?, updated_at = ?
       WHERE proposal_id = ?`,
      [
        updates.proposerUserId,
        updates.recipientUserId,
        updates.requestType,
        updates.currentRevision,
        updates.status,
        JSON.stringify(updates.normalizedConfiguration),
        updates.reason,
        toMysqlDateTime(updates.expiresAt),
        toMysqlDateTime(updates.updatedAt),
        proposalId
      ]
    );

    await this.db.execute(
      `INSERT INTO arrest_proposal_revisions
        (id, proposal_id, revision_number, proposer_user_id, recipient_user_id,
         normalized_configuration, reason, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newRevision.id,
        newRevision.proposalId,
        newRevision.revisionNumber,
        newRevision.proposerUserId,
        newRevision.recipientUserId,
        JSON.stringify(newRevision.normalizedConfiguration),
        newRevision.reason,
        newRevision.status,
        toMysqlDateTime(newRevision.createdAt),
        toMysqlDateTime(newRevision.expiresAt)
      ]
    );

    const updated = await this.findById(proposalId);
    if (!updated) {
      throw Errors.notFound('PROPOSAL_NOT_FOUND', 'Proposal was not found.');
    }
    return { proposal: updated, revision: newRevision };
  }

  async updateStatusAndOutcome(
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
  ): Promise<ArrestProposalRecord> {
    const setClauses: string[] = ['status = ?', 'updated_at = ?'];
    const params: SqlParam[] = [updates.status, toMysqlDateTime(updates.updatedAt)];

    if (updates.approvedRevision !== undefined) {
      setClauses.push('approved_revision = ?');
      params.push(updates.approvedRevision);
    }
    if (updates.resultingPermissionId !== undefined) {
      setClauses.push('resulting_permission_id = ?');
      params.push(updates.resultingPermissionId);
    }
    if (updates.resultingSessionId !== undefined) {
      setClauses.push('resulting_session_id = ?');
      params.push(updates.resultingSessionId);
    }
    if (updates.resultingScheduleId !== undefined) {
      setClauses.push('resulting_schedule_id = ?');
      params.push(updates.resultingScheduleId);
    }
    if (updates.respondedAt !== undefined) {
      setClauses.push('responded_at = ?');
      params.push(updates.respondedAt ? toMysqlDateTime(updates.respondedAt) : null);
    }

    params.push(proposalId);
    await this.db.execute(
      `UPDATE arrest_proposals SET ${setClauses.join(', ')} WHERE proposal_id = ?`,
      params
    );

    const updated = await this.findById(proposalId);
    if (!updated) {
      throw Errors.notFound('PROPOSAL_NOT_FOUND', 'Proposal was not found.');
    }

    await this.db.execute(
      'UPDATE arrest_proposal_revisions SET status = ? WHERE proposal_id = ? AND revision_number = ?',
      [updates.status, proposalId, updated.currentRevision]
    );

    return updated;
  }

  async expireOverdueProposals(now: Date): Promise<number> {
    const ts = toMysqlDateTime(now);
    const [res] = await this.db.execute<ResultSetHeader>(
      `UPDATE arrest_proposals
       SET status = 'EXPIRED', responded_at = ?, updated_at = ?
       WHERE status IN ('PENDING', 'COUNTEROFFERED') AND expires_at <= ?`,
      [ts, ts, ts]
    );
    return res.affectedRows;
  }

  async cancelPendingBetweenUsers(userA: string, userB: string, now: Date): Promise<number> {
    const ts = toMysqlDateTime(now);
    const [res] = await this.db.execute<ResultSetHeader>(
      `UPDATE arrest_proposals
       SET status = 'CANCELLED', responded_at = ?, updated_at = ?
       WHERE status IN ('PENDING', 'COUNTEROFFERED', 'DRAFT')
         AND ((owner_user_id = ? AND partner_user_id = ?) OR (owner_user_id = ? AND partner_user_id = ?))`,
      [ts, ts, userA, userB, userB, userA]
    );
    return res.affectedRows;
  }
}

class MysqlScheduledArrestsRepository implements ScheduledArrestsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(record: ScheduledArrestRecord): Promise<ScheduledArrestRecord> {
    await this.db.execute(
      `INSERT INTO scheduled_arrests
        (schedule_id, proposal_id, permission_id, owner_user_id, partner_user_id, target_device_id,
         schedule_type, session_type, goal, duration_minutes, blocking_configuration, timezone,
         scheduled_start_at, scheduled_end_at, recurrence_rule, occurrences_completed, max_occurrences,
         next_occurrence_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.scheduleId,
        record.proposalId,
        record.permissionId,
        record.ownerUserId,
        record.partnerUserId,
        record.targetDeviceId,
        record.scheduleType,
        record.sessionType,
        record.goal,
        record.durationMinutes,
        JSON.stringify(record.blockingConfiguration),
        record.timezone,
        record.scheduledStartAt ? toMysqlDateTime(record.scheduledStartAt) : null,
        record.scheduledEndAt ? toMysqlDateTime(record.scheduledEndAt) : null,
        record.recurrenceRule ? JSON.stringify(record.recurrenceRule) : null,
        record.occurrencesCompleted,
        record.maxOccurrences,
        record.nextOccurrenceAt ? toMysqlDateTime(record.nextOccurrenceAt) : null,
        record.status,
        toMysqlDateTime(record.createdAt),
        toMysqlDateTime(record.updatedAt)
      ]
    );
    return record;
  }

  async findById(scheduleId: string): Promise<ScheduledArrestRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM scheduled_arrests WHERE schedule_id = ? LIMIT 1',
      [scheduleId]
    );
    return rows[0] ? mapScheduledArrestRow(rows[0]) : null;
  }

  async findByIdForUpdate(scheduleId: string): Promise<ScheduledArrestRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM scheduled_arrests WHERE schedule_id = ? LIMIT 1 FOR UPDATE',
      [scheduleId]
    );
    return rows[0] ? mapScheduledArrestRow(rows[0]) : null;
  }

  async listForUser(
    userId: string,
    options: {
      role?: 'owner' | 'partner' | 'all';
      status?: ScheduledArrestStatus;
      partnerUserId?: string;
      deviceId?: string;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<ScheduledArrestRecord>> {
    const conditions: string[] = [];
    const params: SqlParam[] = [];

    if (options.role === 'owner') {
      conditions.push('owner_user_id = ?');
      params.push(userId);
    } else if (options.role === 'partner') {
      conditions.push('partner_user_id = ?');
      params.push(userId);
    } else {
      conditions.push('(owner_user_id = ? OR partner_user_id = ?)');
      params.push(userId, userId);
    }

    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options.partnerUserId) {
      conditions.push(
        '((owner_user_id = ? AND partner_user_id = ?) OR (owner_user_id = ? AND partner_user_id = ?))'
      );
      params.push(userId, options.partnerUserId, options.partnerUserId, userId);
    }
    if (options.deviceId) {
      conditions.push('target_device_id = ?');
      params.push(options.deviceId);
    }

    const whereSql = conditions.join(' AND ');
    const [countRows] = await this.db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM scheduled_arrests WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total ?? 0);

    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM scheduled_arrests WHERE ${whereSql} ORDER BY COALESCE(next_occurrence_at, created_at) ASC LIMIT ? OFFSET ?`,
      [...params, String(options.limit), String(options.offset)]
    );

    return {
      items: rows.map(mapScheduledArrestRow),
      total,
      limit: options.limit,
      offset: options.offset
    };
  }

  async updateStatusAndOccurrence(
    scheduleId: string,
    updates: {
      status?: ScheduledArrestStatus;
      occurrencesCompleted?: number;
      nextOccurrenceAt?: Date | null;
      lastMaterializedSessionId?: string | null;
      lastMaterializedAt?: Date | null;
      updatedAt: Date;
    }
  ): Promise<ScheduledArrestRecord> {
    const setClauses: string[] = ['updated_at = ?'];
    const params: SqlParam[] = [toMysqlDateTime(updates.updatedAt)];

    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      params.push(updates.status);
    }
    if (updates.occurrencesCompleted !== undefined) {
      setClauses.push('occurrences_completed = ?');
      params.push(updates.occurrencesCompleted);
    }
    if (updates.nextOccurrenceAt !== undefined) {
      setClauses.push('next_occurrence_at = ?');
      params.push(updates.nextOccurrenceAt ? toMysqlDateTime(updates.nextOccurrenceAt) : null);
    }
    if (updates.lastMaterializedSessionId !== undefined) {
      setClauses.push('last_materialized_session_id = ?');
      params.push(updates.lastMaterializedSessionId);
    }
    if (updates.lastMaterializedAt !== undefined) {
      setClauses.push('last_materialized_at = ?');
      params.push(
        updates.lastMaterializedAt ? toMysqlDateTime(updates.lastMaterializedAt) : null
      );
    }

    params.push(scheduleId);
    await this.db.execute(
      `UPDATE scheduled_arrests SET ${setClauses.join(', ')} WHERE schedule_id = ?`,
      params
    );
    const updated = await this.findById(scheduleId);
    if (!updated) {
      throw Errors.notFound('SCHEDULE_NOT_FOUND', 'Scheduled arrest was not found.');
    }
    return updated;
  }

  async listDueForDevice(deviceId: string, now: Date): Promise<ScheduledArrestRecord[]> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM scheduled_arrests
       WHERE target_device_id = ?
         AND status = 'SCHEDULED'
         AND next_occurrence_at IS NOT NULL
         AND next_occurrence_at <= ?
       ORDER BY next_occurrence_at ASC`,
      [deviceId, toMysqlDateTime(now)]
    );
    return rows.map(mapScheduledArrestRow);
  }

  async revokeByPermissionId(permissionId: string, now: Date): Promise<number> {
    const ts = toMysqlDateTime(now);
    const [res] = await this.db.execute<ResultSetHeader>(
      `UPDATE scheduled_arrests
       SET status = 'REVOKED', updated_at = ?
       WHERE permission_id = ? AND status = 'SCHEDULED'`,
      [ts, permissionId]
    );
    return res.affectedRows;
  }

  async revokeBetweenUsers(userA: string, userB: string, now: Date): Promise<number> {
    const ts = toMysqlDateTime(now);
    const [res] = await this.db.execute<ResultSetHeader>(
      `UPDATE scheduled_arrests
       SET status = 'REVOKED', updated_at = ?
       WHERE status = 'SCHEDULED'
         AND ((owner_user_id = ? AND partner_user_id = ?) OR (owner_user_id = ? AND partner_user_id = ?))`,
      [ts, userA, userB, userB, userA]
    );
    return res.affectedRows;
  }
}

class MysqlSessionsRepository implements SessionsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(session: ArrestSessionRecord): Promise<ArrestSessionRecord> {
    try {
      await this.db.execute(
        `INSERT INTO arrest_sessions
          (session_id, local_session_id, owner_user_id, target_device_id, initiated_by_user_id,
           authorization_id, idempotency_key, session_type, goal, blocking_configuration,
           requested_duration, status, local_engine_state, requested_at, accepted_at, started_at,
           expected_end_at, completed_at, completion_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.sessionId,
          session.localSessionId,
          session.ownerUserId,
          session.targetDeviceId,
          session.initiatedByUserId,
          session.authorizationId,
          session.idempotencyKey,
          session.sessionType,
          session.goal,
          JSON.stringify(session.blockingConfiguration),
          session.requestedDuration,
          session.status,
          session.localEngineState,
          toMysqlDateTime(session.requestedAt),
          session.acceptedAt ? toMysqlDateTime(session.acceptedAt) : null,
          session.startedAt ? toMysqlDateTime(session.startedAt) : null,
          session.expectedEndAt ? toMysqlDateTime(session.expectedEndAt) : null,
          session.completedAt ? toMysqlDateTime(session.completedAt) : null,
          session.completionReason,
          toMysqlDateTime(session.createdAt),
          toMysqlDateTime(session.updatedAt)
        ]
      );
      return session;
    } catch (err) {
      if (isMysqlDuplicateError(err) && err.message.includes('uq_sessions_initiator_idem')) {
        throw Errors.conflict(
          'IDEMPOTENCY_CONFLICT',
          'A session request with this idempotency key already exists.'
        );
      }
      throw err;
    }
  }

  async findById(sessionId: string): Promise<ArrestSessionRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM arrest_sessions WHERE session_id = ? LIMIT 1',
      [sessionId]
    );
    return rows[0] ? mapSessionRow(rows[0]) : null;
  }

  async findByIdForUpdate(sessionId: string): Promise<ArrestSessionRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM arrest_sessions WHERE session_id = ? LIMIT 1 FOR UPDATE',
      [sessionId]
    );
    return rows[0] ? mapSessionRow(rows[0]) : null;
  }

  async findByInitiatorAndIdempotencyKey(
    initiatedByUserId: string,
    idempotencyKey: string
  ): Promise<ArrestSessionRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM arrest_sessions WHERE initiated_by_user_id = ? AND idempotency_key = ? LIMIT 1',
      [initiatedByUserId, idempotencyKey]
    );
    return rows[0] ? mapSessionRow(rows[0]) : null;
  }

  async findActiveForDeviceForUpdate(targetDeviceId: string): Promise<ArrestSessionRecord | null> {
    const placeholders = NON_TERMINAL_CLOUD_SESSION_STATUSES.map(() => '?').join(', ');
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM arrest_sessions
       WHERE target_device_id = ? AND status IN (${placeholders})
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [targetDeviceId, ...NON_TERMINAL_CLOUD_SESSION_STATUSES]
    );
    return rows[0] ? mapSessionRow(rows[0]) : null;
  }

  async listActiveForUser(userId: string): Promise<ArrestSessionRecord[]> {
    const placeholders = NON_TERMINAL_CLOUD_SESSION_STATUSES.map(() => '?').join(', ');
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM arrest_sessions
       WHERE (owner_user_id = ? OR initiated_by_user_id = ?) AND status IN (${placeholders})
       ORDER BY created_at DESC`,
      [userId, userId, ...NON_TERMINAL_CLOUD_SESSION_STATUSES]
    );
    return rows.map(mapSessionRow);
  }

  async listForUser(
    userId: string,
    options: {
      role?: 'owner' | 'initiator' | 'all';
      status?: CloudSessionStatus;
      deviceId?: string;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<ArrestSessionRecord>> {
    const conditions: string[] = [];
    const params: SqlParam[] = [];

    if (options.role === 'owner') {
      conditions.push('owner_user_id = ?');
      params.push(userId);
    } else if (options.role === 'initiator') {
      conditions.push('initiated_by_user_id = ?');
      params.push(userId);
    } else {
      conditions.push('(owner_user_id = ? OR initiated_by_user_id = ?)');
      params.push(userId, userId);
    }

    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options.deviceId) {
      conditions.push('target_device_id = ?');
      params.push(options.deviceId);
    }

    const whereSql = conditions.join(' AND ');
    const [countRows] = await this.db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM arrest_sessions WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total ?? 0);

    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM arrest_sessions WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, String(options.limit), String(options.offset)]
    );

    return {
      items: rows.map(mapSessionRow),
      total,
      limit: options.limit,
      offset: options.offset
    };
  }

  async countSessionsByAuthorizationSince(authorizationId: string, since: Date): Promise<number> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM arrest_sessions
       WHERE authorization_id = ? AND requested_at >= ? AND status NOT IN ('REJECTED', 'EXPIRED', 'CANCELLED')`,
      [authorizationId, toMysqlDateTime(since)]
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async findLatestSessionByAuthorization(
    authorizationId: string
  ): Promise<ArrestSessionRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM arrest_sessions
       WHERE authorization_id = ? AND status NOT IN ('REJECTED', 'EXPIRED', 'CANCELLED')
       ORDER BY requested_at DESC LIMIT 1`,
      [authorizationId]
    );
    return rows[0] ? mapSessionRow(rows[0]) : null;
  }

  async updateStatusAndFields(
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
  ): Promise<ArrestSessionRecord> {
    const setClauses: string[] = ['updated_at = ?'];
    const params: SqlParam[] = [toMysqlDateTime(updates.updatedAt)];

    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      params.push(updates.status);
    }
    if (updates.localSessionId !== undefined) {
      setClauses.push('local_session_id = ?');
      params.push(updates.localSessionId);
    }
    if (updates.localEngineState !== undefined) {
      setClauses.push('local_engine_state = ?');
      params.push(updates.localEngineState);
    }
    if (updates.blockingConfiguration !== undefined) {
      setClauses.push('blocking_configuration = ?');
      params.push(JSON.stringify(updates.blockingConfiguration));
    }
    if (updates.acceptedAt !== undefined) {
      setClauses.push('accepted_at = ?');
      params.push(updates.acceptedAt ? toMysqlDateTime(updates.acceptedAt) : null);
    }
    if (updates.startedAt !== undefined) {
      setClauses.push('started_at = ?');
      params.push(updates.startedAt ? toMysqlDateTime(updates.startedAt) : null);
    }
    if (updates.expectedEndAt !== undefined) {
      setClauses.push('expected_end_at = ?');
      params.push(updates.expectedEndAt ? toMysqlDateTime(updates.expectedEndAt) : null);
    }
    if (updates.completedAt !== undefined) {
      setClauses.push('completed_at = ?');
      params.push(updates.completedAt ? toMysqlDateTime(updates.completedAt) : null);
    }
    if (updates.completionReason !== undefined) {
      setClauses.push('completion_reason = ?');
      params.push(updates.completionReason);
    }

    params.push(sessionId);
    await this.db.execute(
      `UPDATE arrest_sessions SET ${setClauses.join(', ')} WHERE session_id = ?`,
      params
    );
    const updated = await this.findById(sessionId);
    if (!updated) {
      throw Errors.notFound('SESSION_NOT_FOUND', 'Arrest session was not found.');
    }
    return updated;
  }

  async recordSyncEventIfNew(
    event: Omit<SessionSyncEventRecord, 'id'>
  ): Promise<{ inserted: boolean; record: SessionSyncEventRecord }> {
    try {
      const [res] = await this.db.execute<ResultSetHeader>(
        `INSERT INTO session_sync_events
          (session_id, device_id, client_event_id, event_type, from_engine_state, to_engine_state, occurred_at_client_ms, metadata, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.sessionId,
          event.deviceId,
          event.clientEventId,
          event.eventType,
          event.fromEngineState,
          event.toEngineState,
          event.occurredAtClientMs,
          event.metadata ? JSON.stringify(event.metadata) : null,
          toMysqlDateTime(event.recordedAt)
        ]
      );
      return {
        inserted: true,
        record: { ...event, id: res.insertId }
      };
    } catch (err) {
      if (isMysqlDuplicateError(err)) {
        const [rows] = await this.db.execute<RowDataPacket[]>(
          'SELECT * FROM session_sync_events WHERE session_id = ? AND client_event_id = ? LIMIT 1',
          [event.sessionId, event.clientEventId]
        );
        const existing = rows[0]!;
        return {
          inserted: false,
          record: {
            id: Number(existing.id),
            sessionId: String(existing.session_id),
            deviceId: String(existing.device_id),
            clientEventId: String(existing.client_event_id),
            eventType: String(existing.event_type),
            fromEngineState:
              existing.from_engine_state !== null
                ? (existing.from_engine_state as AndroidEngineState)
                : null,
            toEngineState:
              existing.to_engine_state !== null
                ? (existing.to_engine_state as AndroidEngineState)
                : null,
            occurredAtClientMs: Number(existing.occurred_at_client_ms),
            metadata:
              existing.metadata !== null
                ? parseJsonColumn<Record<string, unknown>>(existing.metadata)
                : null,
            recordedAt: fromMysqlDateTime(existing.recorded_at)!
          }
        };
      }
      throw err;
    }
  }
}

class MysqlCommandsRepository implements CommandsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(command: Omit<SessionCommandRecord, 'sequenceNo'>): Promise<SessionCommandRecord> {
    const [res] = await this.db.execute<ResultSetHeader>(
      `INSERT INTO session_commands
        (command_id, session_id, target_device_id, issued_by_user_id, command_type, payload, status,
         idempotency_key, result_metadata, failure_reason, push_delivery_status, push_attempts,
         last_push_attempt_at, created_at, expires_at, delivered_at, acknowledged_at, executed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        command.commandId,
        command.sessionId,
        command.targetDeviceId,
        command.issuedByUserId,
        command.commandType,
        JSON.stringify(command.payload),
        command.status,
        command.idempotencyKey,
        command.resultMetadata ? JSON.stringify(command.resultMetadata) : null,
        command.failureReason,
        command.pushDeliveryStatus,
        command.pushAttempts,
        command.lastPushAttemptAt ? toMysqlDateTime(command.lastPushAttemptAt) : null,
        toMysqlDateTime(command.createdAt),
        toMysqlDateTime(command.expiresAt),
        command.deliveredAt ? toMysqlDateTime(command.deliveredAt) : null,
        command.acknowledgedAt ? toMysqlDateTime(command.acknowledgedAt) : null,
        command.executedAt ? toMysqlDateTime(command.executedAt) : null,
        toMysqlDateTime(command.updatedAt)
      ]
    );
    return {
      ...command,
      sequenceNo: res.insertId
    };
  }

  async findById(commandId: string): Promise<SessionCommandRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM session_commands WHERE command_id = ? LIMIT 1',
      [commandId]
    );
    return rows[0] ? mapCommandRow(rows[0]) : null;
  }

  async findByIdForUpdate(commandId: string): Promise<SessionCommandRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM session_commands WHERE command_id = ? LIMIT 1 FOR UPDATE',
      [commandId]
    );
    return rows[0] ? mapCommandRow(rows[0]) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<SessionCommandRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM session_commands WHERE idempotency_key = ? LIMIT 1',
      [idempotencyKey]
    );
    return rows[0] ? mapCommandRow(rows[0]) : null;
  }

  async findLatestBySessionAndType(
    sessionId: string,
    commandType: CommandType
  ): Promise<SessionCommandRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM session_commands WHERE session_id = ? AND command_type = ? ORDER BY sequence_no DESC LIMIT 1',
      [sessionId, commandType]
    );
    return rows[0] ? mapCommandRow(rows[0]) : null;
  }

  async expireOverdueCommands(now: Date): Promise<{
    expiredCommandIds: string[];
    expiredSessionIds: string[];
  }> {
    const ts = toMysqlDateTime(now);
    const [overdueRows] = await this.db.execute<RowDataPacket[]>(
      `SELECT command_id, session_id, command_type
       FROM session_commands
       WHERE status IN ('PENDING', 'DELIVERED', 'ACKNOWLEDGED') AND expires_at <= ?
       FOR UPDATE`,
      [ts]
    );

    if (overdueRows.length === 0) {
      return { expiredCommandIds: [], expiredSessionIds: [] };
    }

    const expiredCommandIds = overdueRows.map((r) => String(r.command_id));
    const cmdPlaceholders = expiredCommandIds.map(() => '?').join(', ');
    await this.db.execute(
      `UPDATE session_commands
       SET status = 'EXPIRED', failure_reason = 'Command TTL elapsed before device execution', updated_at = ?
       WHERE command_id IN (${cmdPlaceholders})`,
      [ts, ...expiredCommandIds]
    );

    const startArrestSessionIds = Array.from(
      new Set(
        overdueRows
          .filter((r) => r.command_type === 'START_ARREST')
          .map((r) => String(r.session_id))
      )
    );

    const expiredSessionIds: string[] = [];
    if (startArrestSessionIds.length > 0) {
      const sessPlaceholders = startArrestSessionIds.map(() => '?').join(', ');
      const [unstartedRows] = await this.db.execute<RowDataPacket[]>(
        `SELECT session_id FROM arrest_sessions
         WHERE session_id IN (${sessPlaceholders}) AND status IN ('REQUESTED', 'DELIVERED')
         FOR UPDATE`,
        startArrestSessionIds
      );
      for (const s of unstartedRows) {
        expiredSessionIds.push(String(s.session_id));
      }
      if (expiredSessionIds.length > 0) {
        const expPlaceholders = expiredSessionIds.map(() => '?').join(', ');
        await this.db.execute(
          `UPDATE arrest_sessions
           SET status = 'EXPIRED', completed_at = ?, completion_reason = 'START_ARREST command expired prior to device execution', updated_at = ?
           WHERE session_id IN (${expPlaceholders})`,
          [ts, ts, ...expiredSessionIds]
        );
      }
    }

    return { expiredCommandIds, expiredSessionIds };
  }

  async expireOverdueForDevice(deviceId: string, now: Date): Promise<number> {
    const ts = toMysqlDateTime(now);
    const [overdueRows] = await this.db.execute<RowDataPacket[]>(
      `SELECT command_id, session_id, command_type
       FROM session_commands
       WHERE target_device_id = ? AND status IN ('PENDING', 'DELIVERED', 'ACKNOWLEDGED') AND expires_at <= ?
       FOR UPDATE`,
      [deviceId, ts]
    );
    if (overdueRows.length === 0) return 0;

    const commandIds = overdueRows.map((r) => String(r.command_id));
    const placeholders = commandIds.map(() => '?').join(', ');
    await this.db.execute(
      `UPDATE session_commands
       SET status = 'EXPIRED', failure_reason = 'Command TTL elapsed before device execution', updated_at = ?
       WHERE command_id IN (${placeholders})`,
      [ts, ...commandIds]
    );

    const startArrestSessions = Array.from(
      new Set(
        overdueRows
          .filter((r) => r.command_type === 'START_ARREST')
          .map((r) => String(r.session_id))
      )
    );
    if (startArrestSessions.length > 0) {
      const sessPlaceholders = startArrestSessions.map(() => '?').join(', ');
      await this.db.execute(
        `UPDATE arrest_sessions
         SET status = 'EXPIRED', completed_at = ?, completion_reason = 'START_ARREST command expired prior to device execution', updated_at = ?
         WHERE session_id IN (${sessPlaceholders}) AND status IN ('REQUESTED', 'DELIVERED')`,
        [ts, ts, ...startArrestSessions]
      );
    }

    return commandIds.length;
  }

  async expirePendingForDeviceRevocation(
    deviceId: string,
    reason: string,
    now: Date
  ): Promise<number> {
    const ts = toMysqlDateTime(now);
    const [res] = await this.db.execute<ResultSetHeader>(
      `UPDATE session_commands
       SET status = 'EXPIRED', failure_reason = ?, updated_at = ?
       WHERE target_device_id = ? AND status IN ('PENDING', 'DELIVERED', 'ACKNOWLEDGED')`,
      [reason.slice(0, 255), ts, deviceId]
    );
    await this.db.execute(
      `UPDATE arrest_sessions
       SET status = 'CANCELLED', completed_at = ?, completion_reason = ?, updated_at = ?
       WHERE target_device_id = ? AND status IN ('REQUESTED', 'DELIVERED')`,
      [ts, reason.slice(0, 255), ts, deviceId]
    );
    return res.affectedRows;
  }

  async pollActionableForDevice(
    deviceId: string,
    options: {
      afterSequence: number;
      statuses: CommandStatus[];
      limit: number;
      now: Date;
    }
  ): Promise<SessionCommandRecord[]> {
    if (options.statuses.length === 0) return [];
    const statusPlaceholders = options.statuses.map(() => '?').join(', ');
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM session_commands
       WHERE target_device_id = ?
         AND sequence_no > ?
         AND status IN (${statusPlaceholders})
         AND expires_at > ?
       ORDER BY sequence_no ASC
       LIMIT ?`,
      [
        deviceId,
        options.afterSequence,
        ...options.statuses,
        toMysqlDateTime(options.now),
        String(options.limit)
      ]
    );
    return rows.map(mapCommandRow);
  }

  async markDeliveredBatch(commandIds: string[], now: Date): Promise<void> {
    if (commandIds.length === 0) return;
    const ts = toMysqlDateTime(now);
    const placeholders = commandIds.map(() => '?').join(', ');
    await this.db.execute(
      `UPDATE session_commands
       SET status = 'DELIVERED', delivered_at = COALESCE(delivered_at, ?), updated_at = ?
       WHERE command_id IN (${placeholders}) AND status = 'PENDING'`,
      [ts, ts, ...commandIds]
    );

    await this.db.execute(
      `UPDATE arrest_sessions s
       INNER JOIN session_commands c ON c.session_id = s.session_id
       SET s.status = 'DELIVERED', s.updated_at = ?
       WHERE c.command_id IN (${placeholders})
         AND c.command_type = 'START_ARREST'
         AND s.status = 'REQUESTED'`,
      [ts, ...commandIds]
    );
  }

  async updateCommandStatus(
    commandId: string,
    updates: {
      status: CommandStatus;
      acknowledgedAt?: Date | null;
      executedAt?: Date | null;
      resultMetadata?: Record<string, unknown> | null;
      failureReason?: string | null;
      updatedAt: Date;
    }
  ): Promise<SessionCommandRecord> {
    const setClauses: string[] = ['status = ?', 'updated_at = ?'];
    const params: SqlParam[] = [updates.status, toMysqlDateTime(updates.updatedAt)];

    if (updates.acknowledgedAt !== undefined) {
      setClauses.push('acknowledged_at = ?');
      params.push(updates.acknowledgedAt ? toMysqlDateTime(updates.acknowledgedAt) : null);
    }
    if (updates.executedAt !== undefined) {
      setClauses.push('executed_at = ?');
      params.push(updates.executedAt ? toMysqlDateTime(updates.executedAt) : null);
    }
    if (updates.resultMetadata !== undefined) {
      setClauses.push('result_metadata = ?');
      params.push(updates.resultMetadata ? JSON.stringify(updates.resultMetadata) : null);
    }
    if (updates.failureReason !== undefined) {
      setClauses.push('failure_reason = ?');
      params.push(updates.failureReason);
    }

    params.push(commandId);
    await this.db.execute(
      `UPDATE session_commands SET ${setClauses.join(', ')} WHERE command_id = ?`,
      params
    );
    const updated = await this.findById(commandId);
    if (!updated) {
      throw Errors.notFound('COMMAND_NOT_FOUND', 'Command was not found.');
    }
    return updated;
  }

  async updatePushDelivery(
    commandId: string,
    updates: {
      pushDeliveryStatus: PushDeliveryStatus;
      incrementAttempts: boolean;
      lastPushAttemptAt: Date;
      updatedAt: Date;
    }
  ): Promise<void> {
    const attemptsExpr = updates.incrementAttempts ? 'push_attempts + 1' : 'push_attempts';
    await this.db.execute(
      `UPDATE session_commands
       SET push_delivery_status = ?, push_attempts = ${attemptsExpr}, last_push_attempt_at = ?, updated_at = ?
       WHERE command_id = ?`,
      [
        updates.pushDeliveryStatus,
        toMysqlDateTime(updates.lastPushAttemptAt),
        toMysqlDateTime(updates.updatedAt),
        commandId
      ]
    );
  }

  async listRetryablePushCommands(now: Date, limit: number): Promise<SessionCommandRecord[]> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM session_commands
       WHERE push_delivery_status = 'FAILED_RETRYABLE'
         AND status = 'PENDING'
         AND expires_at > ?
         AND push_attempts < 5
       ORDER BY sequence_no ASC
       LIMIT ?`,
      [toMysqlDateTime(now), String(limit)]
    );
    return rows.map(mapCommandRow);
  }
}

class MysqlReleaseRequestsRepository implements ReleaseRequestsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(request: ReleaseRequestRecord): Promise<ReleaseRequestRecord> {
    await this.db.execute(
      `INSERT INTO release_requests
        (id, session_id, requester_user_id, approver_user_id, reason, status, decision_reason, resolution_command_id, requested_at, decided_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        request.id,
        request.sessionId,
        request.requesterUserId,
        request.approverUserId,
        request.reason,
        request.status,
        request.decisionReason,
        request.resolutionCommandId,
        toMysqlDateTime(request.requestedAt),
        request.decidedAt ? toMysqlDateTime(request.decidedAt) : null,
        toMysqlDateTime(request.updatedAt)
      ]
    );
    return request;
  }

  async findById(id: string): Promise<ReleaseRequestRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM release_requests WHERE id = ? LIMIT 1',
      [id]
    );
    return rows[0] ? mapReleaseRequestRow(rows[0]) : null;
  }

  async findByIdForUpdate(id: string): Promise<ReleaseRequestRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM release_requests WHERE id = ? LIMIT 1 FOR UPDATE',
      [id]
    );
    return rows[0] ? mapReleaseRequestRow(rows[0]) : null;
  }

  async findPendingBySessionForUpdate(sessionId: string): Promise<ReleaseRequestRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      "SELECT * FROM release_requests WHERE session_id = ? AND status = 'PENDING' LIMIT 1 FOR UPDATE",
      [sessionId]
    );
    return rows[0] ? mapReleaseRequestRow(rows[0]) : null;
  }

  async listForUser(
    userId: string,
    options: {
      role: 'incoming' | 'outgoing' | 'all';
      status?: ReleaseRequestStatus;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<ReleaseRequestRecord>> {
    const conditions: string[] = [];
    const params: SqlParam[] = [];

    if (options.role === 'incoming') {
      conditions.push('approver_user_id = ?');
      params.push(userId);
    } else if (options.role === 'outgoing') {
      conditions.push('requester_user_id = ?');
      params.push(userId);
    } else {
      conditions.push('(approver_user_id = ? OR requester_user_id = ?)');
      params.push(userId, userId);
    }

    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }

    const whereSql = conditions.join(' AND ');
    const [countRows] = await this.db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM release_requests WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total ?? 0);

    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM release_requests WHERE ${whereSql} ORDER BY requested_at DESC LIMIT ? OFFSET ?`,
      [...params, String(options.limit), String(options.offset)]
    );

    return {
      items: rows.map(mapReleaseRequestRow),
      total,
      limit: options.limit,
      offset: options.offset
    };
  }

  async updateDecision(
    id: string,
    updates: {
      status: ReleaseRequestStatus;
      decisionReason?: string | null;
      resolutionCommandId?: string | null;
      decidedAt: Date;
      updatedAt: Date;
    }
  ): Promise<ReleaseRequestRecord> {
    await this.db.execute(
      `UPDATE release_requests
       SET status = ?, decision_reason = ?, resolution_command_id = ?, decided_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        updates.status,
        updates.decisionReason ?? null,
        updates.resolutionCommandId ?? null,
        toMysqlDateTime(updates.decidedAt),
        toMysqlDateTime(updates.updatedAt),
        id
      ]
    );
    const updated = await this.findById(id);
    if (!updated) {
      throw Errors.notFound('RELEASE_REQUEST_NOT_FOUND', 'Release request was not found.');
    }
    return updated;
  }

  async expirePendingForSession(sessionId: string, now: Date): Promise<number> {
    const ts = toMysqlDateTime(now);
    const [res] = await this.db.execute<ResultSetHeader>(
      `UPDATE release_requests
       SET status = 'EXPIRED', decision_reason = 'Session ended before release request was resolved', decided_at = ?, updated_at = ?
       WHERE session_id = ? AND status = 'PENDING'`,
      [ts, ts, sessionId]
    );
    return res.affectedRows;
  }

  async expirePendingForEndedSessions(now: Date): Promise<number> {
    const ts = toMysqlDateTime(now);
    const terminalPlaceholders = TERMINAL_CLOUD_SESSION_STATUSES.map(() => '?').join(', ');
    const [res] = await this.db.execute<ResultSetHeader>(
      `UPDATE release_requests rr
       INNER JOIN arrest_sessions s ON s.session_id = rr.session_id
       SET rr.status = 'EXPIRED',
           rr.decision_reason = 'Linked session ended or expired before decision',
           rr.decided_at = ?,
           rr.updated_at = ?
       WHERE rr.status = 'PENDING'
         AND (s.status IN (${terminalPlaceholders}) OR (s.expected_end_at IS NOT NULL AND s.expected_end_at <= ?))`,
      [ts, ts, ...TERMINAL_CLOUD_SESSION_STATUSES, ts]
    );
    return res.affectedRows;
  }
}

class MysqlAuditLogsRepository implements AuditLogsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async append(entry: {
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
  }): Promise<AuditLogRecord> {
    const [res] = await this.db.execute<ResultSetHeader>(
      `INSERT INTO audit_logs
        (actor_user_id, actor_device_id, action, resource_type, resource_id, result, ip_address, request_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.actorUserId ?? null,
        entry.actorDeviceId ?? null,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        entry.result,
        entry.ipAddress ?? null,
        entry.requestId ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        toMysqlDateTime(entry.createdAt)
      ]
    );
    return {
      id: res.insertId,
      actorUserId: entry.actorUserId ?? null,
      actorDeviceId: entry.actorDeviceId ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      result: entry.result,
      ipAddress: entry.ipAddress ?? null,
      requestId: entry.requestId ?? null,
      metadata: entry.metadata ?? null,
      createdAt: entry.createdAt
    };
  }

  async listByActor(actorUserId: string, limit: number): Promise<AuditLogRecord[]> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM audit_logs WHERE actor_user_id = ? ORDER BY id DESC LIMIT ?',
      [actorUserId, String(limit)]
    );
    return rows.map((row) => ({
      id: Number(row.id),
      actorUserId: row.actor_user_id !== null ? String(row.actor_user_id) : null,
      actorDeviceId: row.actor_device_id !== null ? String(row.actor_device_id) : null,
      action: String(row.action),
      resourceType: String(row.resource_type),
      resourceId: String(row.resource_id),
      result: row.result as AuditResult,
      ipAddress: row.ip_address !== null ? String(row.ip_address) : null,
      requestId: row.request_id !== null ? String(row.request_id) : null,
      metadata:
        row.metadata !== null ? parseJsonColumn<Record<string, unknown>>(row.metadata) : null,
      createdAt: fromMysqlDateTime(row.created_at)!
    }));
  }
}

class MysqlDeviceAppCatalogsRepository implements DeviceAppCatalogsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async findByDeviceId(deviceId: string): Promise<DeviceAppCatalogRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM device_app_catalogs WHERE device_id = ? LIMIT 1',
      [deviceId]
    );
    if (!rows[0]) return null;
    const row = rows[0];
    return {
      deviceId: String(row.device_id),
      ownerUserId: String(row.owner_user_id),
      apps: parseJsonColumn<SelectableAppCatalogItem[]>(row.apps_json),
      updatedAt: fromMysqlDateTime(row.updated_at)!
    };
  }

  async upsert(params: {
    deviceId: string;
    ownerUserId: string;
    apps: SelectableAppCatalogItem[];
    now: Date;
  }): Promise<DeviceAppCatalogRecord> {
    const ts = toMysqlDateTime(params.now);
    const appsJson = JSON.stringify(params.apps);
    await this.db.execute(
      `INSERT INTO device_app_catalogs (device_id, owner_user_id, apps_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         owner_user_id = VALUES(owner_user_id),
         apps_json = VALUES(apps_json),
         updated_at = VALUES(updated_at)`,
      [params.deviceId, params.ownerUserId, appsJson, ts]
    );
    return {
      deviceId: params.deviceId,
      ownerUserId: params.ownerUserId,
      apps: params.apps,
      updatedAt: params.now
    };
  }
}

function mapConversationRow(row: RowDataPacket): ConversationRecord {
  return {
    id: row.id,
    partnershipId: row.partnership_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at) : null
  };
}

function mapConversationMemberRow(row: RowDataPacket): ConversationMemberRecord {
  return {
    conversationId: row.conversation_id,
    userId: row.user_id,
    joinedAt: new Date(row.joined_at),
    lastReadMessageId: row.last_read_message_id ?? null,
    lastReadAt: row.last_read_at ? new Date(row.last_read_at) : null
  };
}

function mapMessageRow(row: RowDataPacket): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderUserId: row.sender_user_id,
    clientMessageId: row.client_message_id,
    messageType: row.message_type as MessageType,
    textContent: row.text_content ?? null,
    structuredPayload: row.structured_payload
      ? typeof row.structured_payload === 'string'
        ? JSON.parse(row.structured_payload)
        : row.structured_payload
      : null,
    status: row.status as MessageDeliveryStatus,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function mapStructuredRequestRow(row: RowDataPacket): StructuredRequestRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    conversationId: row.conversation_id,
    requestType: row.request_type as StructuredRequestType,
    initiatorUserId: row.initiator_user_id,
    recipientUserId: row.recipient_user_id,
    sessionId: row.session_id ?? null,
    status: row.status as StructuredRequestStatus,
    durationMinutes: row.duration_minutes ?? null,
    targetPackage: row.target_package ?? null,
    parametersJson: row.parameters_json
      ? typeof row.parameters_json === 'string'
        ? JSON.parse(row.parameters_json)
        : row.parameters_json
      : null,
    decisionReason: row.decision_reason ?? null,
    decidedAt: row.decided_at ? new Date(row.decided_at) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function mapTemporaryAppAccessGrantRow(row: RowDataPacket): TemporaryAppAccessGrantRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    deviceId: row.device_id,
    packageName: row.package_name,
    grantedDurationMinutes: row.granted_duration_minutes,
    grantedByUserId: row.granted_by_user_id,
    startsAt: new Date(row.starts_at),
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    createdAt: new Date(row.created_at)
  };
}

function mapSessionRuleRevisionRow(row: RowDataPacket): SessionRuleRevisionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    revisionNumber: row.revision_number,
    modifiedByUserId: row.modified_by_user_id,
    ruleChanges: typeof row.rule_changes === 'string'
      ? JSON.parse(row.rule_changes)
      : row.rule_changes,
    appliedAt: new Date(row.applied_at)
  };
}

class MysqlConversationsRepository implements ConversationsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(conversation: ConversationRecord, memberUserIds: string[]): Promise<ConversationRecord> {
    await this.db.execute(
      `INSERT INTO conversations (id, partnership_id, created_at, updated_at, last_message_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        conversation.id,
        conversation.partnershipId,
        toMysqlDateTime(conversation.createdAt),
        toMysqlDateTime(conversation.updatedAt),
        conversation.lastMessageAt ? toMysqlDateTime(conversation.lastMessageAt) : null
      ]
    );
    for (const userId of memberUserIds) {
      await this.db.execute(
        `INSERT INTO conversation_members (conversation_id, user_id, joined_at)
         VALUES (?, ?, ?)`,
        [conversation.id, userId, toMysqlDateTime(conversation.createdAt)]
      );
    }
    return conversation;
  }

  async findById(id: string): Promise<ConversationRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM conversations WHERE id = ? LIMIT 1',
      [id]
    );
    return rows[0] ? mapConversationRow(rows[0]) : null;
  }

  async findByPartnershipId(partnershipId: string): Promise<ConversationRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM conversations WHERE partnership_id = ? LIMIT 1',
      [partnershipId]
    );
    return rows[0] ? mapConversationRow(rows[0]) : null;
  }

  async listByUser(
    userId: string,
    options: { limit: number; offset: number }
  ): Promise<PaginatedResult<ConversationRecord>> {
    const [countRows] = await this.db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) as total FROM conversations c
       INNER JOIN conversation_members cm ON c.id = cm.conversation_id
       WHERE cm.user_id = ?`,
      [userId]
    );
    const total = Number(countRows[0]?.total ?? 0);

    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT c.* FROM conversations c
       INNER JOIN conversation_members cm ON c.id = cm.conversation_id
       WHERE cm.user_id = ?
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
       LIMIT ? OFFSET ?`,
      [userId, String(options.limit), String(options.offset)]
    );
    return {
      items: rows.map(mapConversationRow),
      total,
      limit: options.limit,
      offset: options.offset
    };
  }

  async findMember(conversationId: string, userId: string): Promise<ConversationMemberRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1',
      [conversationId, userId]
    );
    return rows[0] ? mapConversationMemberRow(rows[0]) : null;
  }

  async listMembers(conversationId: string): Promise<ConversationMemberRecord[]> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM conversation_members WHERE conversation_id = ? ORDER BY joined_at ASC',
      [conversationId]
    );
    return rows.map(mapConversationMemberRow);
  }

  async updateLastMessageAt(id: string, lastMessageAt: Date, updatedAt: Date): Promise<void> {
    await this.db.execute(
      'UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?',
      [toMysqlDateTime(lastMessageAt), toMysqlDateTime(updatedAt), id]
    );
  }

  async updateLastRead(
    conversationId: string,
    userId: string,
    params: { lastReadMessageId: string; lastReadAt: Date }
  ): Promise<void> {
    await this.db.execute(
      `UPDATE conversation_members
       SET last_read_message_id = ?, last_read_at = ?
       WHERE conversation_id = ? AND user_id = ?`,
      [params.lastReadMessageId, toMysqlDateTime(params.lastReadAt), conversationId, userId]
    );
  }
}

class MysqlMessagesRepository implements MessagesRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(message: MessageRecord): Promise<MessageRecord> {
    await this.db.execute(
      `INSERT INTO messages
        (id, conversation_id, sender_user_id, client_message_id, message_type, text_content, structured_payload, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        message.id,
        message.conversationId,
        message.senderUserId,
        message.clientMessageId,
        message.messageType,
        message.textContent,
        message.structuredPayload ? JSON.stringify(message.structuredPayload) : null,
        message.status,
        toMysqlDateTime(message.createdAt),
        toMysqlDateTime(message.updatedAt)
      ]
    );
    return message;
  }

  async findById(id: string): Promise<MessageRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM messages WHERE id = ? LIMIT 1',
      [id]
    );
    return rows[0] ? mapMessageRow(rows[0]) : null;
  }

  async findByClientMessageId(conversationId: string, clientMessageId: string): Promise<MessageRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM messages WHERE conversation_id = ? AND client_message_id = ? LIMIT 1',
      [conversationId, clientMessageId]
    );
    return rows[0] ? mapMessageRow(rows[0]) : null;
  }

  async listByConversation(
    conversationId: string,
    options: {
      beforeDate?: Date;
      afterDate?: Date;
      limit: number;
      offset: number;
    }
  ): Promise<PaginatedResult<MessageRecord>> {
    const conditions = ['conversation_id = ?'];
    const params: SqlParam[] = [conversationId];

    if (options.beforeDate) {
      conditions.push('created_at < ?');
      params.push(toMysqlDateTime(options.beforeDate));
    }
    if (options.afterDate) {
      conditions.push('created_at > ?');
      params.push(toMysqlDateTime(options.afterDate));
    }

    const whereClause = conditions.join(' AND ');
    const [countRows] = await this.db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) as total FROM messages WHERE ${whereClause}`,
      params
    );
    const total = Number(countRows[0]?.total ?? 0);

    params.push(String(options.limit), String(options.offset));
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM messages WHERE ${whereClause} ORDER BY created_at ASC LIMIT ? OFFSET ?`,
      params
    );
    return {
      items: rows.map(mapMessageRow),
      total,
      limit: options.limit,
      offset: options.offset
    };
  }

  async countUnreadForUser(conversationId: string, lastReadAt: Date | null, userId: string): Promise<number> {
    if (!lastReadAt) {
      const [rows] = await this.db.execute<RowDataPacket[]>(
        'SELECT COUNT(*) as total FROM messages WHERE conversation_id = ? AND sender_user_id != ?',
        [conversationId, userId]
      );
      return Number(rows[0]?.total ?? 0);
    }
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT COUNT(*) as total FROM messages WHERE conversation_id = ? AND sender_user_id != ? AND created_at > ?',
      [conversationId, userId, toMysqlDateTime(lastReadAt)]
    );
    return Number(rows[0]?.total ?? 0);
  }

  async updateStatus(id: string, status: MessageDeliveryStatus, updatedAt: Date): Promise<void> {
    await this.db.execute(
      'UPDATE messages SET status = ?, updated_at = ? WHERE id = ?',
      [status, toMysqlDateTime(updatedAt), id]
    );
  }
}

class MysqlStructuredRequestsRepository implements StructuredRequestsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(request: StructuredRequestRecord): Promise<StructuredRequestRecord> {
    await this.db.execute(
      `INSERT INTO structured_requests
        (id, message_id, conversation_id, request_type, initiator_user_id, recipient_user_id, session_id, status, duration_minutes, target_package, parameters_json, decision_reason, decided_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        request.id,
        request.messageId,
        request.conversationId,
        request.requestType,
        request.initiatorUserId,
        request.recipientUserId,
        request.sessionId,
        request.status,
        request.durationMinutes,
        request.targetPackage,
        request.parametersJson ? JSON.stringify(request.parametersJson) : null,
        request.decisionReason,
        request.decidedAt ? toMysqlDateTime(request.decidedAt) : null,
        request.expiresAt ? toMysqlDateTime(request.expiresAt) : null,
        toMysqlDateTime(request.createdAt),
        toMysqlDateTime(request.updatedAt)
      ]
    );
    return request;
  }

  async findById(id: string): Promise<StructuredRequestRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM structured_requests WHERE id = ? LIMIT 1',
      [id]
    );
    return rows[0] ? mapStructuredRequestRow(rows[0]) : null;
  }

  async findByMessageId(messageId: string): Promise<StructuredRequestRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM structured_requests WHERE message_id = ? LIMIT 1',
      [messageId]
    );
    return rows[0] ? mapStructuredRequestRow(rows[0]) : null;
  }

  async findPendingBySessionAndType(
    sessionId: string,
    requestType: StructuredRequestType
  ): Promise<StructuredRequestRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM structured_requests
       WHERE session_id = ? AND request_type = ? AND status = 'PENDING'
       LIMIT 1`,
      [sessionId, requestType]
    );
    return rows[0] ? mapStructuredRequestRow(rows[0]) : null;
  }

  async updateDecision(
    id: string,
    params: {
      status: StructuredRequestStatus;
      decisionReason: string | null;
      decidedAt: Date;
      updatedAt: Date;
    }
  ): Promise<StructuredRequestRecord> {
    await this.db.execute(
      `UPDATE structured_requests
       SET status = ?, decision_reason = ?, decided_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        params.status,
        params.decisionReason,
        toMysqlDateTime(params.decidedAt),
        toMysqlDateTime(params.updatedAt),
        id
      ]
    );
    const updated = await this.findById(id);
    if (!updated) {
      throw Errors.notFound('REQUEST_NOT_FOUND', 'Structured request was not found.');
    }
    return updated;
  }
}

class MysqlTemporaryAppAccessGrantsRepository implements TemporaryAppAccessGrantsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(grant: TemporaryAppAccessGrantRecord): Promise<TemporaryAppAccessGrantRecord> {
    await this.db.execute(
      `INSERT INTO temporary_app_access_grants
        (id, session_id, device_id, package_name, granted_duration_minutes, granted_by_user_id, starts_at, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        grant.id,
        grant.sessionId,
        grant.deviceId,
        grant.packageName,
        grant.grantedDurationMinutes,
        grant.grantedByUserId,
        toMysqlDateTime(grant.startsAt),
        toMysqlDateTime(grant.expiresAt),
        grant.revokedAt ? toMysqlDateTime(grant.revokedAt) : null,
        toMysqlDateTime(grant.createdAt)
      ]
    );
    return grant;
  }

  async findById(id: string): Promise<TemporaryAppAccessGrantRecord | null> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM temporary_app_access_grants WHERE id = ? LIMIT 1',
      [id]
    );
    return rows[0] ? mapTemporaryAppAccessGrantRow(rows[0]) : null;
  }

  async listActiveBySession(sessionId: string, now: Date): Promise<TemporaryAppAccessGrantRecord[]> {
    const ts = toMysqlDateTime(now);
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT * FROM temporary_app_access_grants
       WHERE session_id = ? AND revoked_at IS NULL AND starts_at <= ? AND expires_at > ?
       ORDER BY expires_at ASC`,
      [sessionId, ts, ts]
    );
    return rows.map(mapTemporaryAppAccessGrantRow);
  }

  async revoke(id: string, revokedAt: Date): Promise<void> {
    await this.db.execute(
      'UPDATE temporary_app_access_grants SET revoked_at = ? WHERE id = ?',
      [toMysqlDateTime(revokedAt), id]
    );
  }
}

class MysqlSessionRuleRevisionsRepository implements SessionRuleRevisionsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(revision: SessionRuleRevisionRecord): Promise<SessionRuleRevisionRecord> {
    await this.db.execute(
      `INSERT INTO session_rule_revisions
        (id, session_id, revision_number, modified_by_user_id, rule_changes, applied_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        revision.id,
        revision.sessionId,
        revision.revisionNumber,
        revision.modifiedByUserId,
        JSON.stringify(revision.ruleChanges),
        toMysqlDateTime(revision.appliedAt)
      ]
    );
    return revision;
  }

  async listBySession(sessionId: string): Promise<SessionRuleRevisionRecord[]> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM session_rule_revisions WHERE session_id = ? ORDER BY revision_number ASC',
      [sessionId]
    );
    return rows.map(mapSessionRuleRevisionRow);
  }

  async getLatestRevisionNumber(sessionId: string): Promise<number> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT MAX(revision_number) as max_rev FROM session_rule_revisions WHERE session_id = ?',
      [sessionId]
    );
    return Number(rows[0]?.max_rev ?? 0);
  }
}

function createBundle(executor: SqlExecutor): RepositoryBundle {
  return {
    users: new MysqlUsersRepository(executor),
    refreshTokens: new MysqlRefreshTokensRepository(executor),
    devices: new MysqlDevicesRepository(executor),
    deviceAppCatalogs: new MysqlDeviceAppCatalogsRepository(executor),
    pushTokens: new MysqlPushTokensRepository(executor),
    partnerships: new MysqlPartnershipsRepository(executor),
    partnerPermissions: new MysqlPartnerPermissionsRepository(executor),
    approvalPolicies: new MysqlApprovalPoliciesRepository(executor),
    proposals: new MysqlProposalsRepository(executor),
    scheduledArrests: new MysqlScheduledArrestsRepository(executor),
    sessions: new MysqlSessionsRepository(executor),
    commands: new MysqlCommandsRepository(executor),
    releaseRequests: new MysqlReleaseRequestsRepository(executor),
    auditLogs: new MysqlAuditLogsRepository(executor),
    conversations: new MysqlConversationsRepository(executor),
    messages: new MysqlMessagesRepository(executor),
    structuredRequests: new MysqlStructuredRequestsRepository(executor),
    temporaryAppAccessGrants: new MysqlTemporaryAppAccessGrantsRepository(executor),
    sessionRuleRevisions: new MysqlSessionRuleRevisionsRepository(executor)
  };
}

export class MysqlDataStore implements DataStore {
  public readonly repositories: RepositoryBundle;

  constructor(private readonly pool: Pool) {
    this.repositories = createBundle(pool);
  }

  async withTransaction<T>(fn: (repos: RepositoryBundle) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const txRepos = createBundle(conn);
      const result = await fn(txRepos);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
