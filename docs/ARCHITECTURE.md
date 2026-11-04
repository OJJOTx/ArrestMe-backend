# System Architecture — ArrestMe Cloud Backend

## 1. Architectural Principles

1. **Android Controls Local Enforcement; Cloud Coordinates Authorized Remote Actions**:
   - The native Android engine (`SessionController`, `BlockingEngine`, `ArrestAccessibilityService`, `OverlayManager`, `PersistenceManager`) remains 100% authoritative for on-device blocking, timer expiration (`endTimestampMs`), and foreground package evaluation.
   - The backend **never** assumes a session is active simply because an HTTP request succeeded or an FCM wakeup was transmitted. Cloud sessions begin in `REQUESTED`, advance to `DELIVERED` upon device retrieval, and enter `ACTIVE` only after explicit authenticated acknowledgment from the target Android installation.
2. **Managed Shared/Cloud Hosting Compatibility (Hostinger LiteSpeed `lsnode`)**:
   - **Stateless HTTP**: Zero in-memory session or command queues; Hostinger's LiteSpeed `lsnode` runtime spins processes down during idle periods and enforces a 120-second request timeout.
   - **Zero Heavy Infrastructure**: No Redis, RabbitMQ, Kafka, Docker, or inbound WebSockets required.
   - **Zero Native C++ Addons (`node-gyp`)**: Uses Node.js built-in OpenSSL `crypto.scrypt` and `crypto.createHmac` (`HS256`) to prevent CloudLinux ABI/glibc and LVE virtual-memory failures.
3. **Explicit Delegated Authority**:
   - An `ACCEPTED` partnership establishes mutual identity discovery only.
   - Remote session initiation (`PARTNER_ARREST`, `MUTUAL_ARREST`) requires a separate, owner-created, device-scoped, time-bounded `partner_permissions` grant validated inside a serialized MySQL transaction (`SELECT ... FOR UPDATE`).

---

## 2. Layered Module Topology

```text
HTTP Request (Android Client / Cron)
   │
   ▼
Fastify 5 + Zod Type Provider + Helmet + Rate Limit + Request ID
   │
   ├── Middleware (`authenticate`, `verifyMaintenanceKey`)
   │
   ├── Route Handlers (`*.routes.ts` — transport & HTTP status codes only)
   │
   ├── Domain Services (`*.service.ts` — authorization, state transitions, audit)
   │
   ├── DataStore Abstraction (`withTransaction` + RepositoryBundle)
   │     ├── Production: `MysqlDataStore` (`mysql2/promise` prepared statements, InnoDB `FOR UPDATE`)
   │     └── Local Test: `InMemoryDataStore` (snapshot rollback + mutex serialization)
   │
   └── External Notification Adapter (`FcmTransport`)
         ├── Production: `FirebaseAdminTransport` (minimal wakeup metadata only)
         └── Dev / Test: `DisabledFcmTransport` / `FakeFcmTransport`
```

No module imports routes from another module, and dependencies flow strictly downward (`routes -> services -> repositories`).

---

## 3. Session & Command State Machines

### Cloud Session Lifecycle (`arrest_sessions.status`)

```text
REQUESTED ──(device polls queue)──► DELIVERED ──(device starts engine)──► ACTIVE
    │                                   │                                  │  ▲
    ├──(TTL elapsed)──► EXPIRED         ├──(TTL elapsed)──► EXPIRED        │  │
    ├──(perm revoked)─► CANCELLED       └──(device rejects)► REJECTED      ▼  │
    └──(device rejects)► REJECTED                                    PAUSED / INTERRUPTED
                                                                           │
                       ┌───────────────────────────────────────────────────┴──────────────┐
                       ▼                                   ▼                              ▼
                   COMPLETED                         RELEASED_EARLY               EMERGENCY_STOPPED
         (normal endTimestampMs reached)      (APPROVE_RELEASE / END_SESSION)    (local emergencyStop)
```

### Persistent Command Queue Lifecycle (`session_commands.status`)

- `PENDING`: Committed in MySQL transaction with monotonic `sequence_no`.
- `DELIVERED`: Fetched by target device via `GET /api/v1/devices/:id/commands`.
- `ACKNOWLEDGED`: Device confirmed command receipt and pre-execution checks.
- `EXECUTED`: Local `SessionController` action completed on device.
- `REJECTED`: Device refused execution (e.g., local duplicate or missing OS permissions).
- `FAILED`: Unexpected local execution error.
- `EXPIRED`: Command `expires_at` elapsed prior to execution; **never** allowed to start a new session.

---

## 4. Synchronization & Conflict Resolution Rules

1. **Monotonic Terminal Finality**: Once a cloud session enters any terminal state (`COMPLETED`, `RELEASED_EARLY`, `EMERGENCY_STOPPED`, `REJECTED`, `EXPIRED`, `CANCELLED`), late out-of-order `SESSION_PAUSED`, `SESSION_INTERRUPTED`, or `SESSION_RESUMED` events arriving after offline reconnection are recorded in `session_sync_events` for telemetry but never reopen the session.
2. **Idempotent Event Deduplication**: Every item in `POST /api/v1/sessions/:id/events` carries a client-generated `clientEventId` enforced by `UNIQUE (session_id, client_event_id)`. Retried batches after dropped mobile connections are safely ignored (`duplicateCount`).
3. **Clock-Skew & Offline Safety**:
   - Backend persistence timestamps (`created_at`, `started_at`, `completed_at`) use server UTC (`DATETIME(3)`).
   - Local Android enforcement continues using persisted `endTimestampMs` + monotonic `SystemClock.elapsedRealtime()` boot-count checks (`SessionController.checkClockIntegrity`), ensuring server clock changes or network outages can never trap a user in an infinite local session.
4. **FCM Wakeup Resilience**:
   - Push notifications are sent strictly *after* MySQL `COMMIT`.
   - Transient FCM errors perform one bounded retry and mark `push_delivery_status = 'FAILED_RETRYABLE'`.
   - Pending wakeup notifications can be retried via `POST /api/v1/internal/maintenance/run` (Hostinger Cron), and the Android client reconciles directly via `GET /api/v1/devices/:id/commands` on app launch, connectivity restoration, or `WorkManager` sync.
