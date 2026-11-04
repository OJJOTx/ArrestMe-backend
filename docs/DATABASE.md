# Database Schema & Migration Reference

## 1. Engine & Conventions

- **RDBMS**: MySQL 8.0+ (`InnoDB`, `utf8mb4_unicode_ci`)
- **Timestamps**: All temporal columns use `DATETIME(3)` stored and queried in strict UTC (`timezone: 'Z'`).
- **Primary Keys**:
  - Publicly addressable entities (`users`, `devices`, `partnerships`, `partner_permissions`, `arrest_sessions`, `release_requests`) use non-enumerable `CHAR(36)` UUIDv4 identifiers.
  - Sequential logs and cursor queues (`session_commands.sequence_no`, `session_sync_events.id`, `audit_logs.id`) use `BIGINT UNSIGNED AUTO_INCREMENT` clustered primary keys for append-only InnoDB locality, paired with `CHAR(36)` `command_id` where external references are needed.
- **Query Safety**: All SQL execution uses `mysql2/promise` parameterized prepared statements (`?`).

---

## 2. Tables Overview

| Table | Purpose | Key Indexes & Constraints |
|---|---|---|
| `schema_migrations` | Tracks applied `.sql` migration versions and SHA-256 checksums | `PRIMARY KEY (version)` |
| `users` | Authenticated accounts (`ACTIVE`, `SUSPENDED`, `DELETED`) | `uq_users_username`, `uq_users_email` |
| `devices` | Registered Android installations per user | `uq_devices_user_installation (user_id, installation_id)`, `fk_devices_user` |
| `refresh_tokens` | SHA-256 hashed rotating refresh tokens with token-family tracking | `uq_refresh_tokens_hash`, `idx_refresh_tokens_family` |
| `device_push_tokens` | FCM registration tokens with rotation & invalidation tracking | `uq_device_push_tokens_hash`, `idx_device_push_tokens_device_status` |
| `partnerships` | Canonical user-pair relationship state (`PENDING`, `ACCEPTED`, `REJECTED`, `CANCELLED`, `BLOCKED`) | `uq_partnerships_pair (user_low_id, user_high_id)` prevents bidirectional race duplicates |
| `partner_permissions` | Owner-granted, device-scoped, time-bounded delegated Arrest authority | `idx_permissions_owner_active`, `idx_permissions_partner_active`, `idx_permissions_device_active` |
| `arrest_sessions` | Cloud-coordinated sessions distinguishing `REQUESTED` vs `ACTIVE` local execution | `uq_sessions_initiator_idem (initiated_by_user_id, idempotency_key)`, `idx_sessions_device_status` |
| `session_commands` | Persistent MySQL command queue (`START_ARREST`, `APPROVE_RELEASE`, `DENY_RELEASE`, `END_SESSION`, `SYNC_SESSION`, `REQUEST_RELEASE`) | `PRIMARY KEY (sequence_no)`, `uq_session_commands_id`, `uq_session_commands_idempotency`, `idx_commands_device_poll` |
| `session_sync_events` | Idempotent deduplication log for Android lifecycle transitions | `uq_sync_events_client_id (session_id, client_event_id)` |
| `release_requests` | Early release workflow linking arrested requester and partner approver | `idx_release_requests_session_status`, `idx_release_requests_approver_status` |
| `audit_logs` | Security and authority audit trail without sensitive Android usage content | `idx_audit_actor_created`, `idx_audit_resource_created` |

---

## 3. JSON Column Schemas

### `partner_permissions.blocking_config_limits` (v1)

```json
{
  "schemaVersion": 1,
  "allowedRuleModes": ["BLOCK_SELECTED", "STRICT_ALLOWLIST"],
  "allowDisableEmergencyExit": false,
  "allowOverlayStatusBar": false,
  "requiredAllowedCategories": ["CALLS"],
  "allowCustomPackageLists": false,
  "dailyMaxSessions": 3,
  "cooldownMinutes": 30
}
```

### `partner_permissions.allowed_time_windows`

```json
{
  "timezone": "Africa/Cairo",
  "windows": [
    {
      "daysOfWeek": [0, 1, 2, 3, 4],
      "startMinuteOfDay": 540,
      "endMinuteOfDay": 1320
    }
  ]
}
```

### `arrest_sessions.blocking_configuration` (v1)

```json
{
  "schemaVersion": 1,
  "ruleMode": "BLOCK_SELECTED",
  "allowedCategories": ["CALLS", "STUDY_APPS"],
  "overlayStatusBar": false,
  "disableEmergencyExit": false,
  "blockedPackages": ["com.instagram.android"],
  "allowedStudyPackages": ["com.google.android.apps.docs"]
}
```

---

## 4. Migration Workflow

Migrations live in `database/migrations/` and are applied in lexical order:

```bash
# Compile TypeScript first
npm run build

# Check migration status
npm run migrate:status

# Apply pending migrations safely (validates SHA-256 checksums of prior migrations)
npm run migrate
```

Never edit an already-deployed `.sql` file; always add a new numbered migration (`002_*.sql`).
