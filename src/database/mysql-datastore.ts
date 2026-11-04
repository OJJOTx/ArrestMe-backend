import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../config/database';
import { Errors } from '../shared/errors';
import {
  fromMysqlDateTime,
  toMysqlDateTime,
  type AllowedTimeWindowsConfig
} from '../shared/time';
import {
  NON_TERMINAL_CLOUD_SESSION_STATUSES,
  TERMINAL_CLOUD_SESSION_STATUSES,
  type AccountStatus,
  type AndroidEngineState,
  type ArrestSessionRecord,
  type AuditLogRecord,
  type AuditResult,
  type BlockingConfigLimitsV1,
  type BlockingConfigurationV1,
  type CloudSessionStatus,
  type CommandStatus,
  type CommandType,
  type DevicePlatform,
  type DevicePushTokenRecord,
  type DeviceRecord,
  type DeviceStatus,
  type PaginatedResult,
  type PartnerPermissionRecord,
  type PartnershipRecord,
  type PartnershipState,
  type PushDeliveryStatus,
  type PushTokenStatus,
  type RefreshTokenRecord,
  type ReleaseRequestRecord,
  type ReleaseRequestStatus,
  type SessionCommandRecord,
  type SessionSyncEventRecord,
  type SessionType,
  type UserRecord
} from '../types/domain';
import type {
  AuditLogsRepository,
  CommandsRepository,
  DataStore,
  DevicesRepository,
  PartnerPermissionsRepository,
  PartnershipsRepository,
  PushTokensRepository,
  RefreshTokensRepository,
  ReleaseRequestsRepository,
  RepositoryBundle,
  SessionsRepository,
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
          (id, username, email, password_hash, display_name, avatar_url, account_status, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          user.username,
          user.email,
          user.passwordHash,
          user.displayName,
          user.avatarUrl,
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
        (permission_id, owner_user_id, partner_user_id, target_device_id, maximum_session_duration,
         allowed_time_windows, allowed_session_types, blocking_config_limits, one_time_only, used_count,
         version, valid_from, expires_at, revoked_at, revoked_by_user_id, revoke_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.permissionId,
        record.ownerUserId,
        record.partnerUserId,
        record.targetDeviceId,
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

function createBundle(executor: SqlExecutor): RepositoryBundle {
  return {
    users: new MysqlUsersRepository(executor),
    refreshTokens: new MysqlRefreshTokensRepository(executor),
    devices: new MysqlDevicesRepository(executor),
    pushTokens: new MysqlPushTokensRepository(executor),
    partnerships: new MysqlPartnershipsRepository(executor),
    partnerPermissions: new MysqlPartnerPermissionsRepository(executor),
    sessions: new MysqlSessionsRepository(executor),
    commands: new MysqlCommandsRepository(executor),
    releaseRequests: new MysqlReleaseRequestsRepository(executor),
    auditLogs: new MysqlAuditLogsRepository(executor)
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
