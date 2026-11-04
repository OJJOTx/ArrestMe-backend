# Hostinger Deployment Guide — ArrestMe Backend

This document describes the exact production deployment configuration for running **ArrestMe Backend** on **Hostinger Business Web Hosting (Managed Node.js Web App)** with Managed MySQL 8 and Firebase Cloud Messaging (FCM).

---

## 1. Hostinger Hosting Architecture & Constraints

Hostinger's Managed Node.js Web App hosting runs on **CloudLinux + LiteSpeed Web Server (`lsnode`)**, not an unmanaged VPS. The backend is specifically engineered for these platform mechanics:

| Platform Property | Hostinger Behavior | Backend Design Response |
|---|---|---|
| **Supported Node.js Versions** | Node.js 18, 20 LTS, **22 LTS**, 24 | Recommended: **Node.js 22 (LTS)** (`engines.node >= 20.0.0`). |
| **Port Binding** | LiteSpeed dynamically injects `process.env.PORT` (or socket binding) at runtime. | `src/server.ts` reads `env.PORT` (`process.env.PORT`) and binds `0.0.0.0` (`env.HOST`). Never hardcode a port in hPanel. |
| **Idle Process Spin-Down** | `lsnode` suspends idle Node.js worker processes when traffic drops to zero and cold-starts them on the next HTTP request. | Zero reliance on permanent in-memory state or persistent background timers. Sessions, commands, tokens, and permissions live 100% in MySQL 8. |
| **Incoming WebSockets** | Not reliably supported on shared LiteSpeed Node hosting. | Pure REST HTTPS + FCM data-message wakeups + monotonic `sequence_no` command polling. |
| **Native C++ Addons (`node-gyp`)** | Prone to CloudLinux compiler/LVE memory limits during deployment builds. | Zero native C++ addons (`argon2`/`bcrypt` avoided in favor of built-in OpenSSL `crypto.scrypt` + native `crypto` HMAC-SHA256). |
| **HTTP Request Timeout** | ~120 seconds maximum per request. | Fastify request timeout capped at `30s`; MySQL connection timeout `10s`; FCM push timeouts handled non-blockingly. |

---

## 2. Step-by-Step Deployment Setup

### Step 1: Push Repository to GitHub

Push this standalone repository to `https://github.com/OJJOTx/ArrestMe-Backend` on branch `main`:

```bash
git remote add origin https://github.com/OJJOTx/ArrestMe-Backend.git
git push -u origin main
```

Verify that the **Backend CI** workflow (`.github/workflows/backend-ci.yml`) turns green on GitHub Actions.

---

### Step 2: Create the Managed MySQL Database in hPanel

1. Log in to **Hostinger hPanel** -> **Websites** -> **Databases** -> **Management**.
2. Create a new MySQL database and user:
   - **Database Name**: e.g. `u123456789_arrestme`
   - **Database Username**: e.g. `u123456789_arrestme_user`
   - **Database Password**: Generate a strong random password (save it for Step 5).
3. Note the **MySQL Host** displayed in hPanel (typically `127.0.0.1` or `localhost` when hosted on the same Hostinger account; prefer `127.0.0.1` so `mysql2` uses TCP cleanly).
4. Ensure the database default collation is `utf8mb4_unicode_ci` (our migrations explicitly set `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci` on every table).

---

### Step 3: Prepare Firebase Cloud Messaging (Service Account)

1. Open the **Firebase Console** -> select your **ArrestMe** Android project -> **Project settings** (gear icon) -> **Service accounts**.
2. Click **Generate new private key** to download the JSON credentials file locally (**never commit this file to Git**).
3. Extract these three values from the downloaded JSON file:
   - `project_id` -> `FIREBASE_PROJECT_ID`
   - `client_email` -> `FIREBASE_CLIENT_EMAIL`
   - `private_key` -> `FIREBASE_PRIVATE_KEY` (keep the literal `\n` escape sequences intact, e.g. `-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n`).

> **Staging without Firebase**: You may initially deploy with `FIREBASE_ENABLED=false` to verify HTTP, auth, and MySQL connectivity before enabling FCM wakeups.

---

### Step 4: Create the Hostinger Node.js Web App

1. In **Hostinger hPanel**, go to **Websites** -> **Add Website** -> select **Node.js Apps** (Managed Node.js Web App).
2. Choose **Import Git Repository** and authorize GitHub access to `OJJOTx/ArrestMe-Backend`.
3. Select your domain or dedicated API subdomain (recommended: `api.<yourdomain>.com`).
4. Configure the build and runtime settings exactly as follows:

| Setting | Exact Value | Notes |
|---|---|---|
| **Repository** | `OJJOTx/ArrestMe-Backend` | Standalone backend repo |
| **Branch** | `main` | Auto-deploy on push can be enabled |
| **Node.js Version** | `22.x` (LTS) | Node `20.x` LTS and `24.x` are also supported |
| **Root Directory** | `/` | Repository root |
| **Install Command** | `npm ci` *(or Hostinger default `npm install`)* | Installs lockfile versions so `tsc` can compile TypeScript during build |
| **Build Command** | `npm run build` | Compiles `src/` -> `dist/` CommonJS via `tsconfig.build.json` |
| **Start Command** | `npm start` | Runs `node dist/server.js` (compiled JS — **never** `ts-node` or `tsx`) |
| **Entry File** *(if prompted)* | `dist/server.js` | Matches `"main": "dist/server.js"` in `package.json` |

---

### Step 5: Configure Environment Variables in hPanel

Generate two independent cryptographic secrets locally (minimum 32 characters; 48 random bytes base64url = 64 characters recommended):

```bash
node -e "console.log('JWT_ACCESS_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('MAINTENANCE_API_KEY=' + require('crypto').randomBytes(48).toString('base64url'))"
```

In Hostinger hPanel -> **Node.js** -> **Environment Variables**, configure the following variables:

| Variable | Required | Production Value / Example | Purpose |
|---|---|---|---|
| `NODE_ENV` | Yes | `production` | Enforces strict secret validation, hides stack traces, disables dev defaults. |
| `HOST` | No | `0.0.0.0` | Network interface bound by Fastify. *(Do **not** set `PORT` unless instructed; Hostinger injects `PORT` automatically.)* |
| `LOG_LEVEL` | No | `info` | Structured JSON logging level (`info`, `warn`, `error`). |
| `APP_VERSION` | No | `0.2.0` | Reported in `/health` and OpenAPI metadata. |
| `TRUST_PROXY` | Yes | `true` | Trusts LiteSpeed reverse-proxy `X-Forwarded-For` for accurate per-IP rate limiting. |
| `CORS_ORIGINS` | No | *(leave empty)* | Native Android clients do not send browser CORS preflights; leave empty to block cross-origin browser requests. |
| `DATABASE_HOST` | Yes | `127.0.0.1` | Hostinger MySQL hostname. |
| `DATABASE_PORT` | Yes | `3306` | MySQL TCP port. |
| `DATABASE_NAME` | Yes | `u123456789_arrestme` | MySQL database created in Step 2. |
| `DATABASE_USER` | Yes | `u123456789_arrestme_user` | MySQL username created in Step 2. |
| `DATABASE_PASSWORD` | Yes | `<strong-mysql-password>` | MySQL password created in Step 2. |
| `DATABASE_CONNECTION_LIMIT` | No | `10` | Keep conservative (`5`–`10`) on shared hosting to avoid `max_user_connections` exhaustion. |
| `DATABASE_SSL` | No | `false` | `false` for local socket/loopback `127.0.0.1`; set `true` only if connecting to a remote TLS MySQL host. |
| `AUTO_MIGRATE_ON_STARTUP` | No | `false` *(set `true` for initial boot if SSH unavailable; see Step 6)* | Runs pending forward-only SQL migrations automatically before Fastify binds its port. |
| `JWT_ACCESS_SECRET` | Yes | `<64-char-random-secret>` | HMAC-SHA256 signing key for short-lived access tokens (`>= 32` chars enforced in production). |
| `JWT_ISSUER` | No | `arrestme-api` | JWT `iss` claim verified on every request. |
| `JWT_AUDIENCE` | No | `arrestme-android` | JWT `aud` claim verified on every request. |
| `ACCESS_TOKEN_TTL_SECONDS` | No | `900` | Access token lifetime (`900` = 15 minutes). |
| `REFRESH_TOKEN_TTL_DAYS` | No | `30` | Rotating refresh token lifetime in days. |
| `DEFAULT_COMMAND_TTL_SECONDS` | No | `300` | Default expiration window (`5` minutes) for remote commands. |
| `MAX_SESSION_DURATION_MINUTES` | No | `720` | Hard server ceiling on session duration (`12` hours). |
| `MAINTENANCE_API_KEY` | Yes | `<64-char-random-secret>` | Secret header (`X-Maintenance-Key`) protecting `/api/v1/health/ready` and `/api/v1/internal/maintenance/run`. |
| `FIREBASE_ENABLED` | Yes | `true` *(or `false` prior to FCM setup)* | Enables Firebase Admin SDK push wakeups. |
| `FIREBASE_PROJECT_ID` | If FCM enabled | `arrestme-prod` | Firebase project ID. |
| `FIREBASE_CLIENT_EMAIL` | If FCM enabled | `firebase-adminsdk-xxx@arrestme-prod.iam.gserviceaccount.com` | Firebase service account client email. |
| `FIREBASE_PRIVATE_KEY` | If FCM enabled | `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n` | PEM private key with `\n` newline sequences. |
| `ENABLE_SWAGGER_UI` | No | `false` | Keep `false` in production so `/docs` is not publicly exposed. |

---

### Step 6: Execute Database Migrations Safely

Migrations live in `database/migrations/` and are tracked idempotently in the `schema_migrations` table with SHA-256 checksum verification (`src/database/migrator.ts`). Migrations are strictly forward-only and non-destructive.

Choose **Option A (SSH)** or **Option B (First-Boot Auto-Migrate)**:

#### Option A — Via Hostinger SSH (Recommended)

1. Enable SSH access in **hPanel -> Advanced -> SSH Access** and connect to your account.
2. Navigate to your deployed application directory and run:

```bash
npm run migrate:status
npm run migrate
```

3. Confirm `001_initial_schema.sql` reports `APPLIED`.

#### Option B — Without SSH (`AUTO_MIGRATE_ON_STARTUP`)

1. Set `AUTO_MIGRATE_ON_STARTUP=true` in hPanel Environment Variables and redeploy/restart the Node.js app.
2. On startup (`src/server.ts`), the server acquires schema state, applies `001_initial_schema.sql` once, records its SHA-256 checksum in `schema_migrations`, and starts listening.
3. Verify `/api/v1/health/ready` returns `"status": "ready"` (Step 9).
4. Optionally set `AUTO_MIGRATE_ON_STARTUP=false` afterward until your next schema migration release.

---

### Step 7: Configure HTTPS / SSL

1. In **hPanel -> Websites -> Security -> SSL**, verify that Hostinger's automatic **Free Let's Encrypt SSL** certificate is **Active** for `api.<yourdomain>.com`.
2. Enable **Force HTTPS** so all plain HTTP requests redirect (`301`) to `https://`.
3. Never allow the Android client to communicate over cleartext HTTP (`usesCleartextTraffic="false"` in Android's `AndroidManifest.xml`).

---

### Step 8: Configure Scheduled Maintenance (Hostinger Cron Job)

Because Hostinger spins down idle Node.js processes and does not run persistent background workers, periodic housekeeping (expiring elapsed commands, completing overdue sessions, expiring stale release requests, retrying undelivered FCM wakeups, and pruning expired refresh tokens) runs via a protected HTTP endpoint.

> Note: Core correctness **never** depends on the cron job—lazy expiration checks also execute automatically during device command polling and session reads. The cron job simply keeps database states tidy and retries missed push wakeups promptly.

1. Go to **hPanel -> Advanced -> Cron Jobs**.
2. Select **Type: Custom** and schedule **Every 5 minutes** (`*/5 * * * *`).
3. Set the command to:

```bash
curl -fsS -X POST "https://api.yourdomain.com/api/v1/internal/maintenance/run" \
  -H "X-Maintenance-Key: YOUR_MAINTENANCE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' >/dev/null
```

---

## 3. Post-Deployment Verification Checklist

Run the following smoke checks from your terminal after deploying (replace `https://api.yourdomain.com` and `YOUR_MAINTENANCE_API_KEY`):

### 1. Liveness Probe (`200 OK`)

```bash
curl -i https://api.yourdomain.com/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "arrestme-backend",
  "version": "0.2.0",
  "timestamp": "2026-11-04T19:00:00.000Z"
}
```

### 2. Protected Database & Firebase Readiness Probe (`200 OK`)

```bash
curl -i https://api.yourdomain.com/api/v1/health/ready \
  -H "X-Maintenance-Key: YOUR_MAINTENANCE_API_KEY"
```

Expected response:

```json
{
  "status": "ready",
  "database": "ok",
  "firebase": "configured",
  "timestamp": "2026-11-04T19:00:05.000Z"
}
```

*(If `FIREBASE_ENABLED=false`, `"firebase"` will report `"disabled"` while `"status"` remains `"ready"`.)*

### 3. Protected Maintenance Execution (`200 OK`)

```bash
curl -i -X POST https://api.yourdomain.com/api/v1/internal/maintenance/run \
  -H "X-Maintenance-Key: YOUR_MAINTENANCE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected response:

```json
{
  "expiredCommands": 0,
  "autoCompletedSessions": 0,
  "expiredReleaseRequests": 0,
  "purgedRefreshTokens": 0,
  "retriedWakeups": 0,
  "timestamp": "2026-11-04T19:00:10.000Z"
}
```

### 4. Unauthorized Maintenance Rejection (`401 Unauthorized`)

```bash
curl -i -X POST https://api.yourdomain.com/api/v1/internal/maintenance/run
```

Confirm it returns HTTP `401` with `"code": "UNAUTHORIZED"` and **no stack trace**.

---

## 4. Troubleshooting Common Hostinger Issues

- **503 Service Unavailable on Startup**:
  - Inspect **hPanel -> Node.js -> Logs**. Most commonly caused by a missing required production environment variable (`DATABASE_PASSWORD`, `JWT_ACCESS_SECRET` < 32 chars, or `MAINTENANCE_API_KEY` < 32 chars). `src/config/environment.ts` logs the exact missing field name cleanly on boot.
- **`ER_ACCESS_DENIED_ERROR` or `ECONNREFUSED` on MySQL**:
  - Verify `DATABASE_HOST=127.0.0.1` (not an external IP) and confirm the database username/name includes Hostinger's account prefix (`uXXXXXXXXX_...`).
- **Firebase `INVALID_ARGUMENT` / PEM Parse Failure**:
  - Check `FIREBASE_PRIVATE_KEY` in hPanel Environment Variables. Ensure surrounding quotes were not doubled and `\n` escape sequences are preserved (`src/config/firebase.ts` automatically normalizes `\\n` -> `\n`).
