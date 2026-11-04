# ArrestMe REST API Reference (`/api/v1`)

Machine-readable OpenAPI 3.1 specification: [`docs/openapi.json`](openapi.json)

---

## 1. Conventions

- **Base Path**: `/api/v1` (plus `/health` liveness alias)
- **Content-Type**: `application/json; charset=utf-8` (max body size: `64 KiB`)
- **Authentication**: `Authorization: Bearer <accessToken>` (`HS256` JWT, default 15-minute TTL)
- **Request Tracing**: Every response returns `X-Request-Id` (pass `X-Request-Id` from Android to correlate logs).
- **Idempotency**: `POST /api/v1/sessions` accepts `Idempotency-Key: <unique-client-id>` header (or `idempotencyKey` body field).
- **Pagination**: Collection routes accept `?limit=20&offset=0` (`limit` `1..100`) and return:
  ```json
  {
    "items": [],
    "total": 0,
    "limit": 20,
    "offset": 0
  }
  ```

---

## 2. Error Response Envelope

All validation, authentication, authorization, conflict, and rate-limit errors return:

```json
{
  "error": {
    "code": "PERMISSION_EXPIRED",
    "message": "Partner authorization has expired."
  }
}
```

### Standard Machine-Readable Error Codes

| HTTP Status | Error Code | Meaning |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Request body, query, or path parameter failed schema validation |
| `400` | `SELF_ACTION_NOT_ALLOWED` | Attempted self-partnership, self-block, or self-delegation |
| `401` | `UNAUTHORIZED` | Missing, malformed, or expired Bearer access token |
| `401` | `INVALID_CREDENTIALS` | Incorrect email or password |
| `401` | `INVALID_REFRESH_TOKEN` | Unknown refresh token |
| `401` | `REFRESH_TOKEN_EXPIRED` | Refresh token exceeded `REFRESH_TOKEN_TTL_DAYS` |
| `401` | `REFRESH_TOKEN_REVOKED` | Refresh token was logged out or invalidated |
| `401` | `REFRESH_TOKEN_REUSED` | Rotated refresh token replayed; entire token family revoked |
| `403` | `ACCOUNT_SUSPENDED` | User account is suspended |
| `403` | `FORBIDDEN` | Caller lacks authority over resource |
| `403` | `PARTNERSHIP_REQUIRED` | Action requires an `ACCEPTED` partnership |
| `403` | `PARTNERSHIP_BLOCKED` | Relationship is blocked |
| `403` | `PERMISSION_EXPIRED` | Delegated authorization `expiresAt` has passed |
| `403` | `PERMISSION_REVOKED` | Delegated authorization was revoked |
| `403` | `PERMISSION_NOT_YET_VALID` | Current time is prior to `validFrom` |
| `403` | `PERMISSION_EXHAUSTED` | One-time authorization was already consumed |
| `403` | `PERMISSION_LIMIT_EXCEEDED` | Duration, ruleMode, emergency-exit flag, categories, daily cap, or cooldown exceeded |
| `403` | `PERMISSION_TIME_WINDOW_RESTRICTED` | Current time is outside owner-permitted schedule windows |
| `403` | `PERMISSION_SCOPE_MISMATCH` | Target device or user pair does not match authorization |
| `404` | `NOT_FOUND` / `DEVICE_NOT_FOUND` / `SESSION_NOT_FOUND` | Resource does not exist or caller has no visibility |
| `409` | `EMAIL_ALREADY_REGISTERED` / `USERNAME_ALREADY_TAKEN` | Account registration conflict |
| `409` | `PARTNERSHIP_CONFLICT` | Duplicate pending/accepted partnership |
| `409` | `ACTIVE_SESSION_EXISTS` | Target device already has a non-terminal session |
| `409` | `COMMAND_EXPIRED` | Command TTL elapsed; device must not execute |
| `409` | `COMMAND_INVALID_TRANSITION` | Command is already in an incompatible terminal state |
| `409` | `SESSION_EXPIRED` / `SESSION_ALREADY_ENDED` | Session ended before action or release decision |
| `409` | `RELEASE_REQUEST_CONFLICT` | A pending release request already exists for the session |
| `409` | `IDEMPOTENCY_CONFLICT` | Idempotency key reused with mismatched parameters |
| `413` | `PAYLOAD_TOO_LARGE` | Request body exceeded 64 KiB |
| `429` | `RATE_LIMIT_EXCEEDED` | Rate limit window exceeded |

---

## 3. Endpoint Summary

### Health & Maintenance
- `GET  /health` — Public liveness (`{ status: "ok", service: "ArrestMe API", version: "0.2.0" }`)
- `GET  /api/v1/health` — Versioned public liveness
- `GET  /api/v1/health/ready` — Protected DB readiness (`X-Maintenance-Key`)
- `POST /api/v1/internal/maintenance/run` — Protected stale-command expiry & FCM retry job (`X-Maintenance-Key`)

### Authentication & Users
- `POST  /api/v1/auth/register` — Create account & issue token pair
- `POST  /api/v1/auth/login` — Authenticate & issue token pair
- `POST  /api/v1/auth/refresh` — Rotate refresh token & issue new pair
- `POST  /api/v1/auth/logout` — Revoke current refresh token family
- `POST  /api/v1/auth/logout-all` — Revoke all refresh tokens for user
- `POST  /api/v1/auth/change-password` — Verify current password, update hash, revoke prior tokens
- `GET   /api/v1/users/me` — Fetch authenticated profile
- `PATCH /api/v1/users/me` — Update `displayName` / `avatarUrl`

### Devices & Push Tokens
- `POST   /api/v1/devices` — Register or refresh Android installation
- `GET    /api/v1/devices` — List owned devices
- `GET    /api/v1/devices/:id` — Get single owned device
- `PATCH  /api/v1/devices/:id` — Update metadata & `lastSeenAt`
- `DELETE /api/v1/devices/:id` — Revoke device, push tokens, delegated permissions, and pending commands
- `POST   /api/v1/devices/:id/push-token` — Register or rotate FCM token

### Partnerships
- `POST   /api/v1/partners/requests` — Invite partner by `username` or `recipientUserId`
- `GET    /api/v1/partners/requests` — List incoming/outgoing invitations
- `POST   /api/v1/partners/requests/:id/accept` — Accept incoming invitation
- `POST   /api/v1/partners/requests/:id/reject` — Reject incoming invitation
- `GET    /api/v1/partners` — List accepted partners
- `DELETE /api/v1/partners/:id` — Remove partner or cancel pending invite (revokes mutual permissions)
- `POST   /api/v1/partners/:id/block` — Block partner/user (revokes mutual permissions)

### Delegated Arrest Permissions
- `POST   /api/v1/partner-permissions` — Grant explicit device-scoped permission (owner only)
- `GET    /api/v1/partner-permissions` — List granted/received permissions (`?role=granted|received|all`)
- `GET    /api/v1/partner-permissions/:id` — Inspect permission details
- `PATCH  /api/v1/partner-permissions/:id` — Update limits/expiry (owner only)
- `DELETE /api/v1/partner-permissions/:id` — Revoke or surrender permission immediately

### Sessions & Synchronization
- `POST /api/v1/sessions` — Initiate remote `PARTNER_ARREST` or `SELF_ARREST` session + queue `START_ARREST`
- `GET  /api/v1/sessions` — List session history
- `GET  /api/v1/sessions/active` — List active/in-progress sessions
- `GET  /api/v1/sessions/:id` — Get session details
- `POST /api/v1/sessions/:id/acknowledge` — Report `ACCEPTED`, `STARTED`, or `REJECTED` from target device
- `POST /api/v1/sessions/:id/events` — Sync deduplicated Android `SessionController` transitions
- `POST /api/v1/sessions/:id/end` — Queue `END_SESSION` command (initiating authority only)
- `POST /api/v1/sessions/:id/sync` — Queue `SYNC_SESSION` reconciliation command

### Persistent Command Queue
- `GET  /api/v1/devices/:id/commands` — Cursor-paginated command polling (`?afterSequence=0&limit=25`)
- `POST /api/v1/commands/:id/acknowledge` — Report `ACKNOWLEDGED`, `EXECUTED`, `REJECTED`, or `FAILED`

### Early Release Workflow
- `POST /api/v1/sessions/:id/release-requests` — Submit early release request (arrested owner)
- `GET  /api/v1/release-requests` — List incoming/outgoing release requests
- `POST /api/v1/release-requests/:id/approve` — Approve request & queue `APPROVE_RELEASE` (partner authority)
- `POST /api/v1/release-requests/:id/deny` — Deny request & queue `DENY_RELEASE` (partner authority)
