# Android Integration Contract (`OJJOTx/ArrestMe` ↔ `ArrestMe-Backend`)

This contract specifies how the existing native Android application (`com.arrestme.benchmark`) integrates with the ArrestMe Cloud Backend **without modifying or introducing network dependencies into `BlockingEngine`, `BlockingRulesEvaluator`, `ArrestAccessibilityService`, or `OverlayManager`**.

---

## 1. Architectural Integration Boundary on Android

Keep the existing V0.1 local engine (`core/blocking/`, `core/accessibility/`, `core/overlay/`) 100% offline and deterministic. Add a separate `data/remote/` + `core/cloud/` coordination layer:

```text
com.arrestme.benchmark/
├── core/
│   ├── session/        # Existing SessionController + SessionModels (add PARTNER_ARREST, MUTUAL_ARREST enum values + partner-authorized release method)
│   ├── blocking/       # UNCHANGED — zero cloud dependencies
│   ├── accessibility/  # UNCHANGED — zero cloud dependencies
│   ├── overlay/        # UNCHANGED — zero cloud dependencies
│   └── cloud/          # NEW: CloudCommandCoordinator, CloudSyncObserver (implements SessionLifecycleObserver)
└── data/
    └── remote/         # NEW: ArrestApiService, AuthTokenStore (EncryptedSharedPreferences/DataStore), FcmWakeupService, CommandSyncWorker
```

---

## 2. Exact Enum & Configuration Alignment

Every backend enum and configuration field maps 1-to-1 to `SessionModels.kt`:

| Backend JSON Field | Existing Android Symbol (`SessionModels.kt`) | Values |
|---|---|---|
| `sessionType` | `SessionType` | `SELF_ARREST`, `PARTNER_ARREST`, `MUTUAL_ARREST` |
| `localEngineState` | `SessionState` | `IDLE`, `PREPARING`, `ACTIVE`, `PAUSED`, `COMPLETED`, `EMERGENCY_STOPPED`, `INTERRUPTED` |
| `ruleMode` | `BlockingRuleMode` | `BLOCK_SELECTED`, `STRICT_ALLOWLIST`, `WHITELIST_ONLY` |
| `allowedCategories` | `Set<AllowedCategory>` | `CALLS`, `STUDY_APPS` |
| `requestedDurationMinutes` | `SessionConfig.durationMinutes` | `Int` (`durationMs = durationMinutes * 60_000L`) |
| `goal` | `SessionConfig.goal` | `String` |
| `overlayStatusBar` | `SessionConfig.overlayStatusBar` | `Boolean` |
| `disableEmergencyExit` | `SessionConfig.disableEmergencyExit` | `Boolean` |

---

## 3. Kotlin Serialization DTO Models (`kotlinx.serialization`)

```kotlin
package com.arrestme.benchmark.data.remote.dto

import kotlinx.serialization.Serializable

@Serializable
data class ApiErrorEnvelope(
    val error: ApiErrorBody
)

@Serializable
data class ApiErrorBody(
    val code: String,
    val message: String
)

@Serializable
data class RegisterRequest(
    val username: String,
    val email: String,
    val password: String,
    val displayName: String? = null
)

@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
    val deviceId: String? = null
)

@Serializable
data class RefreshRequest(
    val refreshToken: String
)

@Serializable
data class AuthTokensDto(
    val accessToken: String,
    val accessTokenExpiresAt: String,
    val expiresInSeconds: Int,
    val refreshToken: String,
    val refreshTokenExpiresAt: String,
    val tokenType: String
)

@Serializable
data class UserDto(
    val id: String,
    val username: String,
    val email: String,
    val displayName: String,
    val avatarUrl: String? = null,
    val accountStatus: String,
    val createdAt: String,
    val updatedAt: String,
    val lastLoginAt: String? = null
)

@Serializable
data class AuthSessionResponse(
    val user: UserDto,
    val tokens: AuthTokensDto
)

@Serializable
data class RegisterDeviceRequest(
    val installationId: String,
    val deviceName: String,
    val platform: String = "ANDROID",
    val manufacturer: String? = null,
    val model: String? = null,
    val appVersion: String,
    val androidVersion: String,
    val sdkInt: Int? = null,
    val fcmToken: String? = null
)

@Serializable
data class DeviceDto(
    val id: String,
    val userId: String,
    val installationId: String? = null,
    val deviceName: String,
    val platform: String,
    val appVersion: String,
    val androidVersion: String,
    val deviceStatus: String,
    val lastSeenAt: String? = null
)

@Serializable
data class BlockingConfigurationDto(
    val schemaVersion: Int = 1,
    val ruleMode: String = "BLOCK_SELECTED",
    val allowedCategories: List<String> = listOf("CALLS", "STUDY_APPS"),
    val overlayStatusBar: Boolean = false,
    val disableEmergencyExit: Boolean = false,
    val blockedPackages: List<String>? = null,
    val allowedStudyPackages: List<String>? = null
)

@Serializable
data class CreateSessionRequest(
    val sessionType: String = "PARTNER_ARREST",
    val targetDeviceId: String,
    val authorizationId: String? = null,
    val requestedDurationMinutes: Int,
    val goal: String,
    val blockingConfiguration: BlockingConfigurationDto = BlockingConfigurationDto(),
    val idempotencyKey: String? = null
)

@Serializable
data class SessionCommandDto(
    val sequenceNo: Long,
    val commandId: String,
    val sessionId: String,
    val targetDeviceId: String,
    val issuedByUserId: String,
    val commandType: String,
    val payload: StartOrControlPayloadDto,
    val status: String,
    val idempotencyKey: String,
    val createdAt: String,
    val expiresAt: String
)

@Serializable
data class StartOrControlPayloadDto(
    val schemaVersion: Int = 1,
    val sessionId: String,
    val sessionType: String? = null,
    val durationMinutes: Int? = null,
    val goal: String? = null,
    val ruleMode: String? = null,
    val allowedCategories: List<String>? = null,
    val overlayStatusBar: Boolean? = null,
    val disableEmergencyExit: Boolean? = null,
    val blockedPackages: List<String>? = null,
    val allowedStudyPackages: List<String>? = null,
    val authorizationId: String? = null,
    val releaseRequestId: String? = null,
    val decision: String? = null,
    val decisionReason: String? = null,
    val reason: String? = null
)

@Serializable
data class PollCommandsResponse(
    val items: List<SessionCommandDto>,
    val nextCursorSequence: Long,
    val serverTime: String
)

@Serializable
data class AcknowledgeCommandRequest(
    val deviceId: String,
    val status: String, // ACKNOWLEDGED | EXECUTED | REJECTED | FAILED
    val localSessionId: String? = null,
    val executedAtClientMs: Long? = null,
    val failureReason: String? = null
)

@Serializable
data class SyncEventDto(
    val clientEventId: String,
    val eventType: String,
    val fromEngineState: String? = null,
    val toEngineState: String? = null,
    val occurredAtClientMs: Long,
    val localSessionId: String? = null,
    val accumulatedPausedMs: Long? = null,
    val reason: String? = null
)

@Serializable
data class PostSessionEventsRequest(
    val deviceId: String,
    val events: List<SyncEventDto>
)
```

---

## 4. End-to-End Integration Workflows

### 4.1 Authentication & Token Rotation
1. Authenticate via `POST /api/v1/auth/register` or `POST /api/v1/auth/login`.
2. Persist `accessToken` and `refreshToken` inside encrypted local storage (`Jetpack DataStore` + `Android Keystore`).
3. Configure an OkHttp `Authenticator` synchronized with a Kotlin `Mutex`:
   - On `401 UNAUTHORIZED`, call `POST /api/v1/auth/refresh` once and overwrite **both** `accessToken` and `refreshToken`.
   - **Critical**: Never send two concurrent `/auth/refresh` calls with the same refresh token; rotating refresh tokens trigger family revocation (`REFRESH_TOKEN_REUSED`) if replayed.
   - If refresh returns `401` (`REFRESH_TOKEN_EXPIRED`, `REFRESH_TOKEN_REVOKED`, `REFRESH_TOKEN_REUSED`), clear stored credentials and prompt sign-in (never interrupting an already-running local `SessionController` session!).

### 4.2 Device Registration & FCM Token Lifecycle
1. Generate a stable per-install UUID (`installationId`) stored in `SharedPreferences`.
2. Call `POST /api/v1/devices` with `Build.MANUFACTURER`, `Build.MODEL`, `BuildConfig.VERSION_NAME`, `Build.VERSION.RELEASE`, `Build.VERSION.SDK_INT`, and current `FirebaseMessaging.getInstance().token`.
3. Persist returned `device.id` (`cloudDeviceId`).
4. In `FirebaseMessagingService.onNewToken(token)`, enqueue a `WorkManager` `NetworkType.CONNECTED` job calling `POST /api/v1/devices/{cloudDeviceId}/push-token`.

### 4.3 Partnerships & Delegated Permissions
1. User A invites User B by username: `POST /api/v1/partners/requests` `{ "username": "user_b" }`.
2. User B accepts: `POST /api/v1/partners/requests/{id}/accept`.
3. User B explicitly grants Partner A permission on a specific registered device:
   `POST /api/v1/partner-permissions` specifying `targetDeviceId`, `maximumSessionDuration`, `allowedRuleModes`, `allowDisableEmergencyExit`, `allowedTimeWindows`, and `expiresAt`.
4. Partner A lists active permissions received (`GET /api/v1/partner-permissions?role=received&activeOnly=true`) to display authorized target devices and allowed limits in UI.

### 4.4 Retrieving & Mapping Remote Commands to `SessionController`
1. **Wakeup Triggers** (all funnel into a single `Mutex`-guarded `CommandSyncWorker`):
   - `FirebaseMessagingService.onMessageReceived` with `data["type"] == "COMMAND_AVAILABLE"`
   - App foreground (`ProcessLifecycleOwner` `onStart`)
   - Network restoration (`WorkManager` `NetworkType.CONNECTED` constraint)
   - `BootRecoveryReceiver` (`BOOT_COMPLETED`)
2. **Polling**:
   - Read `lastProcessedSequence` from local `SharedPreferences` (default `0`).
   - Call `GET /api/v1/devices/{cloudDeviceId}/commands?afterSequence={lastProcessedSequence}`.
3. **Executing `START_ARREST`**:
   - Verify `Instant.parse(cmd.expiresAt).toEpochMilli() > System.currentTimeMillis()`.
   - Verify `permissionChecker.inspectAll().isCoreBlockingReady`. If overlay or accessibility permission is missing, call `POST /api/v1/commands/{commandId}/acknowledge` with `status = "REJECTED"`, `failureReason = "Missing Accessibility or Overlay permission"`.
   - Map `cmd.payload` directly into `SessionConfig`:
     ```kotlin
     val config = SessionConfig(
         sessionType = SessionType.valueOf(cmd.payload.sessionType ?: "PARTNER_ARREST"),
         durationMinutes = cmd.payload.durationMinutes ?: 15,
         goal = cmd.payload.goal ?: "Partner Focus Session",
         allowedCategories = cmd.payload.allowedCategories.orEmpty()
             .mapNotNull { runCatching { AllowedCategory.valueOf(it) }.getOrNull() }
             .toSet()
             .ifEmpty { setOf(AllowedCategory.CALLS) },
         ruleMode = BlockingRuleMode.valueOf(cmd.payload.ruleMode ?: "BLOCK_SELECTED"),
         overlayStatusBar = cmd.payload.overlayStatusBar ?: false,
         disableEmergencyExit = cmd.payload.disableEmergencyExit ?: false
     )
     ```
   - Call `sessionController.startSession(config)`:
     - `StartSessionResult.Started(snapshot)` -> Persist `(cloudSessionId = cmd.sessionId, localSessionId = snapshot.sessionId)` mapping in Room, then call `POST /api/v1/commands/{commandId}/acknowledge` with `status = "EXECUTED"`, `localSessionId = snapshot.sessionId`.
     - `StartSessionResult.DuplicatePrevented(...)` -> Report `status = "REJECTED"`, `failureReason = "Local session already active"`.
     - If server responds `409 COMMAND_EXPIRED` or `403 PERMISSION_REVOKED` during pre-check acknowledgment, do not start (or immediately stop if preparing).
   - Advance `lastProcessedSequence = cmd.sequenceNo` only after local handling + acknowledgment (or terminal `409`/`403` rejection).

### 4.5 Early Release Commands (`APPROVE_RELEASE` & `DENY_RELEASE`)
- Note that in `SessionController.kt`, `emergencyStop()` checks `if (current.disableEmergencyExit) return`.
- Add a dedicated internal method on `SessionController` (e.g., `completeAuthorizedRelease(expectedLocalSessionId: String, reason: String)`) callable **only** by `CloudCommandCoordinator` when an authenticated `APPROVE_RELEASE` or `END_SESSION` command is fetched from `/api/v1/devices/{id}/commands` matching the active `cloudSessionId`:
  1. Completes the active session cleanly (`SessionState.COMPLETED` with `completionReason = "Partner-approved early release"`).
  2. Dismisses any active overlay via `SessionLifecycleObserver`.
  3. Calls `POST /api/v1/commands/{commandId}/acknowledge` with `status = "EXECUTED"`.
- For `DENY_RELEASE`: update local UI state to display the partner's `decisionReason` and acknowledge `EXECUTED`.

### 4.6 Reconciling Interrupted Connections
- Register a `CloudSyncObserver : SessionLifecycleObserver` on `SessionController`:
  - Whenever `SessionController` transitions (`ACTIVE -> PAUSED`, `ACTIVE -> INTERRUPTED`, `ACTIVE -> COMPLETED`, `ACTIVE -> EMERGENCY_STOPPED`), append a `PendingCloudSyncEventEntity` (with a generated UUID `clientEventId`) to Room.
  - Enqueue a `WorkManager` `OneTimeWorkRequest` with `Constraints(requiredNetworkType = NetworkType.CONNECTED)` that flushes queued events to `POST /api/v1/sessions/{cloudSessionId}/events` and deletes them upon `200 OK`.
  - Because the backend deduplicates `(sessionId, clientEventId)`, retrying after flaky mobile disconnects is 100% idempotent.

---

## 5. Client Error Handling Matrix

| Error Code | Recommended Android Action |
|---|---|
| `UNAUTHORIZED` | Refresh token once via OkHttp `Authenticator`; if refresh fails, mark account signed-out |
| `PERMISSION_EXPIRED` / `PERMISSION_REVOKED` | Refresh partner permissions list in UI and inform partner that owner's authorization ended |
| `PERMISSION_LIMIT_EXCEEDED` / `PERMISSION_TIME_WINDOW_RESTRICTED` | Show `error.message` directly in session creation sheet so partner adjusts duration or settings |
| `ACTIVE_SESSION_EXISTS` | Display active session banner rather than allowing duplicate submission |
| `COMMAND_EXPIRED` | Discard stale command without starting local `SessionController` |
| `SESSION_EXPIRED` | Reconcile local session expiry (`sessionController.checkAndCompleteIfExpired()`) and refresh UI |
| `RATE_LIMIT_EXCEEDED` / `5xx` / IOException | Exponential backoff via `WorkManager` (`Result.retry()`); never crash or block local `BlockingEngine` |
