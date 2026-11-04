# Security Architecture & Controls

Because ArrestMe coordinates remote focus restrictions across devices owned by distinct individuals, every layer enforces explicit consent, bounded authority, and defense-in-depth.

---

## 1. Authentication & Credential Security

- **Memory-Hard Password Hashing**: Passwords are normalized (`NFKC`) and hashed with OWASP-compliant `scrypt` (`N=16384, r=8, p=1, keyLen=64`) using random 128-bit salts and constant-time verification (`crypto.timingSafeEqual`). Plaintext passwords and hashes are never logged or returned in API payloads.
- **Timing-Safe Login Enumeration Defense**: Login failures for non-existent emails execute a constant-work dummy `scrypt` verification and return the exact same generic `401 INVALID_CREDENTIALS` message as wrong-password attempts.
- **Short-Lived Access Tokens**: `HS256` JWTs default to 15 minutes (`900s`), strictly pinning `alg === "HS256"`, `typ === "JWT"`, `iss`, and `aud` (eliminating `alg: "none"` and confusion attacks).
- **Rotating Refresh Tokens & Reuse Detection**:
  - Refresh tokens are 384-bit CSPRNG opaque strings (`amrt_...`); only SHA-256 hashes are persisted in `refresh_tokens`.
  - Every `POST /api/v1/auth/refresh` rotates the token inside an InnoDB `FOR UPDATE` transaction.
  - If an already-rotated token is replayed, the backend detects potential token theft, **immediately revokes the entire `family_id`**, writes an `AUTH_REFRESH_REUSE_DETECTED` security audit event, and returns `401 REFRESH_TOKEN_REUSED`.
  - Password changes and `POST /api/v1/auth/logout-all` revoke all active refresh tokens across all devices.

---

## 2. Partnership & Delegated Authority Boundaries

1. **Friendship != Device Control**: An `ACCEPTED` partnership grants zero session authority.
2. **Owner-Only Grant & Modification**:
   - Only `device.userId === authUser.id` can create or `PATCH` a `partner_permissions` grant.
   - Any attempt by a partner to `PATCH` their received permission is blocked with `403 FORBIDDEN` and recorded as `PARTNER_PERMISSION_ESCALATION_BLOCKED` in `audit_logs`.
3. **Scoped & Bounded Enforcement**:
   - Every remote `POST /api/v1/sessions` locks the target device and permission rows (`FOR UPDATE`) and validates:
     - Active `ACCEPTED` partnership
     - Exact `targetDeviceId` match (`ACTIVE` status)
     - `revoked_at IS NULL`, `valid_from <= NOW() < expires_at`
     - `one_time_only` exhaustion check
     - `requestedDurationMinutes <= maximumSessionDuration`
     - `allowedTimeWindows` in owner's IANA timezone
     - `allowedRuleModes`, `allowDisableEmergencyExit`, `allowOverlayStatusBar`, `requiredAllowedCategories`, `allowCustomPackageLists`, `dailyMaxSessions`, and `cooldownMinutes`
4. **Cascading Revocation**:
   - Removing a partner (`DELETE /api/v1/partners/:id`), blocking a user (`POST /api/v1/partners/:id/block`), or revoking a lost device (`DELETE /api/v1/devices/:id`) atomically revokes associated delegated permissions in the same database transaction.
5. **Pre-Execution Re-Validation**:
   - Even after a `START_ARREST` command is queued, if the owner revokes the permission or the command TTL (`expires_at`) elapses before the device acknowledges execution, `POST /api/v1/commands/:id/acknowledge` rejects activation so stale or revoked commands never start a session.

---

## 3. Transport, Input, SQL & Push Protections

- **SQL Injection Prevention**: 100% of database queries use `mysql2/promise` prepared/parameterized `?` bindings.
- **Strict Validation & Payload Caps**: Every route validates params, query strings, headers, and JSON bodies with Zod schemas, with a hard `64 KiB` Fastify `bodyLimit`.
- **Non-Enumerable Resource Identifiers**: All user-facing resources use UUIDv4; cross-account probes return `404` without confirming whether a UUID exists.
- **Minimal Push Payloads**: FCM messages contain only opaque identifiers (`commandId`, `targetDeviceId`, `sequenceNo`, `commandType`) — never session goals, app package names, emails, or tokens.
- **Structured Log Redaction**: `Authorization`, `X-Maintenance-Key`, cookies, passwords, refresh tokens, and FCM tokens are automatically redacted (`[REDACTED]`) at the Pino logger layer.
