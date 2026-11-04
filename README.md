# ArrestMe — Cloud Coordination Backend

Production-oriented **Node.js + TypeScript + Fastify + MySQL 8** cloud coordination backend for **[ArrestMe](https://github.com/OJJOTx/ArrestMe)**, a native Android digital detox and focus session application.

Designed specifically for **Hostinger Managed Node.js Web App Hosting** without requiring Docker, Redis, WebSockets, persistent background workers, or native C++ (`node-gyp`) addons.

---

## Core Capabilities

- **Engine-Compatible Session Coordination**: Aligns directly with the existing Android `SessionController` and `SessionModels.kt` (`SELF_ARREST`, `PARTNER_ARREST`, `MUTUAL_ARREST`, `AllowedCategory`, `BlockingRuleMode`, `overlayStatusBar`, `disableEmergencyExit`) while keeping enforcement strictly on-device.
- **Explicit Delegated Partner Permissions**: Device owners grant granular, revocable, device-scoped permissions specifying maximum duration, IANA timezone windows, allowed rule modes, emergency-exit lock constraints, daily session caps, cooldowns, and one-time vs recurring grants.
- **MySQL Persistent Command Queue**: Monotonic `sequence_no` cursor polling, explicit command TTL (`expires_at`), stale command rejection, and idempotent acknowledgments across `START_ARREST`, `REQUEST_RELEASE`, `APPROVE_RELEASE`, `DENY_RELEASE`, `END_SESSION`, and `SYNC_SESSION`.
- **Honest Execution State Machine**: Strictly separates cloud request (`REQUESTED` / `DELIVERED`) from confirmed on-device enforcement (`ACTIVE`).
- **Early Release Workflow**: End-to-end partner approval/denial workflow for sessions locked with `disableEmergencyExit = true`.
- **Firebase Cloud Messaging (FCM) Wakeups**: Metadata-only data push messages (`firebase-admin`) wake target Android devices to poll authenticated REST endpoints; survives FCM outages and automatically invalidates unregistered tokens.
- **Hardened Token Security**: Memory-hard OpenSSL `crypto.scrypt` password hashing, short-lived `HS256` JWT access tokens, rotating opaque refresh tokens with family-wide replay detection, server-side revocation, rate limiting, and structured audit logging.

---

## Technology Stack

| Layer | Technology |
|---|---|
| **Runtime** | Node.js `>= 20.0.0` (Node 22 LTS recommended on Hostinger) |
| **Language** | TypeScript (`strict: true`) |
| **HTTP Framework** | Fastify 5 + `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit` |
| **Validation & OpenAPI** | Zod 4 + `fastify-type-provider-zod` + `@fastify/swagger` (OpenAPI 3.1) |
| **Database** | MySQL 8 (`mysql2/promise` prepared statements + InnoDB row-locking transactions) |
| **Cryptography** | Node built-in `crypto` (`scrypt`, `timingSafeEqual`, HMAC-SHA256 JWTs) |
| **Push Wakeups** | Firebase Admin SDK (`firebase-admin` FCM HTTP v1) |
| **Testing & CI** | Vitest + GitHub Actions (Node 20/22 matrix + live MySQL 8 service verification) |

---

## Repository Structure

```text
ArrestMe-Backend/
├── src/
│   ├── app.ts                      # Fastify application factory, security plugins, error boundary
│   ├── server.ts                   # Production HTTP bootstrap & graceful SIGTERM/SIGINT shutdown
│   ├── config/                     # Environment validation, MySQL pool, Firebase Admin client
│   ├── database/                   # SQL migrator CLI, MysqlDataStore, and InMemoryDataStore
│   ├── middleware/                 # Bearer JWT authentication guard
│   ├── modules/
│   │   ├── auth/                   # Register, login, token rotation, logout, password change
│   │   ├── users/                  # Authenticated user profile management
│   │   ├── devices/                # Android device & FCM push token registration
│   │   ├── partners/               # Partnership requests, accept/reject/remove, and blocking
│   │   ├── permissions/            # Granular delegated Arrest permissions & window validation
│   │   ├── sessions/               # Session initiation, acknowledgment, lifecycle events, sync
│   │   ├── commands/               # Persistent device command polling & acknowledgments
│   │   ├── releases/               # Early release requests, approval, and denial workflows
│   │   └── notifications/          # Metadata-only FCM wakeup service & token invalidation
│   ├── plugins/                    # Liveness, readiness, and protected maintenance endpoints
│   ├── scripts/                    # OpenAPI 3.1 specification generator & drift checker
│   ├── services/                   # Structured audit log & idempotent maintenance services
│   ├── shared/                     # AppError hierarchy, scrypt/JWT crypto, time-window utilities
│   └── types/                      # Domain models and transactional DataStore contracts
├── database/
│   ├── migrations/                 # Forward-only SQL migrations (001_initial_schema.sql)
│   └── seeds/                      # Seed notes
├── tests/
│   ├── helpers/                    # Deterministic ManualClock, MockPushSender, test app harness
│   ├── unit/                       # Crypto, timezone window, and migration checksum unit tests
│   └── integration/                # End-to-end HTTP + MySQL 8 integration suites
├── docs/
│   ├── ARCHITECTURE.md             # System architecture, Android compatibility & state machines
│   ├── API.md                      # Complete REST endpoint & error code reference
│   ├── openapi.json                # Generated OpenAPI 3.1.0 specification
│   ├── DATABASE.md                 # Relational MySQL 8 schema & indexing reference
│   ├── ANDROID_INTEGRATION.md      # Kotlin/Android integration contract & sync guide
│   ├── DEPLOYMENT.md               # Exact Hostinger Node.js Web App deployment runbook
│   └── SECURITY.md                 # Threat model, token design & authorization invariants
└── .github/workflows/
    └── backend-ci.yml              # Automated lint, typecheck, unit/integration & MySQL 8 CI
```

---

## Local Development & Verification (Zero Local MySQL / Zero Docker Required)

All unit tests, HTTP integration tests, TypeScript checks, linting, builds, and OpenAPI verification run locally with **only Node.js (`>= 20`) installed**:

```bash
# 1. Install dependencies
npm install

# 2. Type-check and lint
npm run typecheck
npm run lint

# 3. Run unit & end-to-end HTTP integration tests (uses transactional InMemoryDataStore)
npm test

# 4. Compile TypeScript to dist/
npm run build

# 5. Regenerate or verify OpenAPI 3.1 specification (docs/openapi.json)
npm run openapi:generate
npm run openapi:verify
```

### Running Locally Against a MySQL 8 Instance

If you want to run the server locally against a remote/staging or local MySQL 8 database:

1. Copy `.env.example` to `.env` and fill in `DATABASE_*`, `JWT_ACCESS_SECRET`, and `MAINTENANCE_API_KEY`:
   ```bash
   cp .env.example .env
   ```
2. Build and apply database migrations:
   ```bash
   npm run build
   npm run migrate
   npm run migrate:status
   ```
3. Start the server:
   ```bash
   # Production mode (compiled JS)
   npm start

   # Watch mode during development
   npm run dev
   ```

To also run the live MySQL integration test (`tests/integration/mysql-optional.test.ts`) against your configured MySQL database, set `TEST_WITH_MYSQL=true` when running `npm test` (automatically executed on every push in `.github/workflows/backend-ci.yml`).

---

## Available npm Scripts

| Script | Command | Description |
|---|---|---|
| `npm run dev` | `tsx watch src/server.ts` | Start local development server with hot reload |
| `npm run build` | `tsc -p tsconfig.build.json` | Compile production CommonJS output to `dist/` |
| `npm start` | `node dist/server.js` | Start compiled production server (Hostinger start command) |
| `npm run migrate` | `node dist/database/migrate-cli.js up` | Apply pending SQL migrations in `database/migrations/` |
| `npm run migrate:status` | `node dist/database/migrate-cli.js status` | Inspect applied vs pending SQL migrations & checksums |
| `npm run openapi:generate` | `npm run build && node dist/scripts/generate-openapi.js` | Generate `docs/openapi.json` (OpenAPI 3.1.0) |
| `npm run openapi:verify` | `node dist/scripts/generate-openapi.js --check` | Fail if `docs/openapi.json` is out of sync with route schemas |
| `npm run typecheck` | `tsc --noEmit` | Strict TypeScript type check across `src/` and `tests/` |
| `npm run lint` | `eslint src tests` | Lint all TypeScript source and test files |
| `npm test` | `vitest run` | Run automated unit and integration test suites |

---

## Documentation Index

- [**System Architecture & State Machines**](docs/ARCHITECTURE.md)
- [**REST API Reference**](docs/API.md) & [**OpenAPI 3.1 Spec (`openapi.json`)**](docs/openapi.json)
- [**MySQL 8 Database Schema**](docs/DATABASE.md)
- [**Android Client Integration Guide**](docs/ANDROID_INTEGRATION.md)
- [**Hostinger Deployment Runbook**](docs/DEPLOYMENT.md)
- [**Security & Authorization Architecture**](docs/SECURITY.md)
