import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_MAINTENANCE_KEY,
  createTestHarness,
  type TestHarness
} from '../helpers/test-context';

describe('Remote Sessions, Command Queue, Synchronization, Early Release & FCM Resilience', () => {
  let harness: TestHarness;
  let partnerA!: Awaited<ReturnType<TestHarness['registerAndLogin']>>;
  let ownerB!: Awaited<ReturnType<TestHarness['registerAndLogin']>>;
  let outsiderC!: Awaited<ReturnType<TestHarness['registerAndLogin']>>;
  let deviceB!: Awaited<ReturnType<TestHarness['registerDevice']>>;
  let permissionId!: string;

  beforeEach(async () => {
    harness = await createTestHarness({
      initialTimeIso: '2026-11-04T12:00:00.000Z'
    });

    partnerA = await harness.registerAndLogin({
      username: 'partner_a',
      email: 'partner_a@example.com'
    });
    ownerB = await harness.registerAndLogin({
      username: 'owner_b',
      email: 'owner_b@example.com'
    });
    outsiderC = await harness.registerAndLogin({
      username: 'outsider_c',
      email: 'outsider_c@example.com'
    });

    await harness.registerDevice(partnerA.accessToken, {
      deviceName: 'Partner A Phone',
      fcmToken: 'fcm_partner_a_device_token_1234567890'
    });
    deviceB = await harness.registerDevice(ownerB.accessToken, {
      deviceName: 'Owner B Pixel',
      fcmToken: 'fcm_owner_b_device_token_1234567890'
    });

    // Establish partnership A <-> B
    const inv = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partners/requests',
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { username: 'partner_a' }
    });
    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/partners/requests/${inv.json().partnership.id}/accept`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` }
    });

    // Grant delegated permission (up to 60m, allows disableEmergencyExit)
    const permRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partner-permissions',
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        partnerUserId: partnerA.userId,
        targetDeviceId: deviceB.deviceId,
        maximumSessionDuration: 60,
        allowedSessionTypes: ['PARTNER_ARREST'],
        blockingConfigLimits: {
          schemaVersion: 1,
          allowedRuleModes: ['BLOCK_SELECTED', 'STRICT_ALLOWLIST'],
          allowDisableEmergencyExit: true,
          allowOverlayStatusBar: false,
          requiredAllowedCategories: ['CALLS'],
          allowCustomPackageLists: false
        },
        expiresAt: '2026-11-11T12:00:00.000Z'
      }
    });
    permissionId = permRes.json().permission.permissionId;
    harness.fcm.sentMessages.length = 0;
  });

  afterEach(async () => {
    await harness.close();
  });

  it('creates remote session safely, deduplicates idempotency keys, prevents concurrent conflicts, and coordinates full lifecycle', async () => {
    // 1. Create remote session with Idempotency-Key
    const createRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: {
        authorization: `Bearer ${partnerA.accessToken}`,
        'idempotency-key': 'idem-focus-session-001'
      },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: permissionId,
        requestedDurationMinutes: 45,
        goal: 'Deep work: Operating Systems Lab',
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'STRICT_ALLOWLIST',
          allowedCategories: ['CALLS', 'STUDY_APPS'],
          overlayStatusBar: false,
          disableEmergencyExit: true
        }
      }
    });

    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    // Server must NOT assume session is ACTIVE merely because FCM was sent!
    expect(created.session.status).toBe('REQUESTED');
    expect(created.session.startedAt).toBeNull();
    expect(created.command.commandType).toBe('START_ARREST');
    expect(created.command.status).toBe('PENDING');

    // Verify FCM payload contains ONLY minimal metadata (no goal text or secrets!)
    expect(harness.fcm.sentMessages).toHaveLength(1);
    const pushData = harness.fcm.sentMessages[0]!.data;
    expect(pushData).toEqual({
      type: 'COMMAND_AVAILABLE',
      commandId: created.command.commandId,
      targetDeviceId: deviceB.deviceId,
      sequenceNo: String(created.command.sequenceNo),
      commandType: 'START_ARREST'
    });
    expect(JSON.stringify(pushData)).not.toContain('Operating Systems Lab');

    // 2. Retried request with same Idempotency-Key returns 200 without duplicating session/command
    const retryRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: {
        authorization: `Bearer ${partnerA.accessToken}`,
        'idempotency-key': 'idem-focus-session-001'
      },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: permissionId,
        requestedDurationMinutes: 45,
        goal: 'Deep work: Operating Systems Lab',
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'STRICT_ALLOWLIST',
          allowedCategories: ['CALLS', 'STUDY_APPS'],
          overlayStatusBar: false,
          disableEmergencyExit: true
        }
      }
    });
    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.json().idempotentReplay).toBe(true);
    expect(retryRes.json().session.sessionId).toBe(created.session.sessionId);
    expect(harness.fcm.sentMessages).toHaveLength(1);

    // 3. Outsider C cannot inspect session or poll Owner B's commands
    const outsiderRead = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${created.session.sessionId}`,
      headers: { authorization: `Bearer ${outsiderC.accessToken}` }
    });
    expect(outsiderRead.statusCode).toBe(404);

    const outsiderPoll = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceB.deviceId}/commands`,
      headers: { authorization: `Bearer ${outsiderC.accessToken}` }
    });
    expect(outsiderPoll.statusCode).toBe(404);

    // 4. Owner B's Android device polls command queue
    const pollRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceB.deviceId}/commands?afterSequence=0`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    expect(pollRes.statusCode).toBe(200);
    expect(pollRes.json().items).toHaveLength(1);
    expect(pollRes.json().items[0].status).toBe('DELIVERED');

    // Duplicate FCM delivery (device polling again with cursor) does NOT duplicate commands
    const secondPollAfterCursor = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceB.deviceId}/commands?afterSequence=${pollRes.json().nextCursorSequence}`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    expect(secondPollAfterCursor.json().items).toHaveLength(0);

    // 5. Android executes SessionController.startSession() and acknowledges command
    const ackRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/commands/${created.command.commandId}/acknowledge`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        status: 'EXECUTED',
        localSessionId: 'arrest-9f8e7d6c'
      }
    });
    expect(ackRes.statusCode).toBe(200);
    expect(ackRes.json().command.status).toBe('EXECUTED');

    // Idempotent duplicate acknowledgment succeeds safely
    const dupAck = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/commands/${created.command.commandId}/acknowledge`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        status: 'EXECUTED',
        localSessionId: 'arrest-9f8e7d6c'
      }
    });
    expect(dupAck.statusCode).toBe(200);
    expect(dupAck.json().idempotentReplay).toBe(true);

    // Cloud session is now confirmed ACTIVE with Android localSessionId
    const activeCheck = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/sessions/active',
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    expect(activeCheck.json().items).toHaveLength(1);
    expect(activeCheck.json().items[0].status).toBe('ACTIVE');
    expect(activeCheck.json().items[0].localSessionId).toBe('arrest-9f8e7d6c');

    // 6. Synchronize interrupted/resumed/completed events with duplicate event suppression
    harness.clock.advanceMs(45 * 60 * 1000);
    const refreshedOwnerTokens = (
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: ownerB.refreshToken }
      })
    ).json().tokens;

    const syncRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${created.session.sessionId}/events`,
      headers: { authorization: `Bearer ${refreshedOwnerTokens.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        events: [
          {
            clientEventId: 'evt-int-1',
            eventType: 'SESSION_INTERRUPTED',
            fromEngineState: 'ACTIVE',
            toEngineState: 'INTERRUPTED',
            occurredAtClientMs: Date.now() - 120_000,
            reason: 'Temporary process restart'
          },
          {
            clientEventId: 'evt-res-2',
            eventType: 'SESSION_RESUMED',
            fromEngineState: 'INTERRUPTED',
            toEngineState: 'ACTIVE',
            occurredAtClientMs: Date.now() - 115_000
          },
          {
            clientEventId: 'evt-comp-3',
            eventType: 'SESSION_COMPLETED',
            fromEngineState: 'ACTIVE',
            toEngineState: 'COMPLETED',
            occurredAtClientMs: Date.now(),
            reason: 'Session duration reached persisted endTimestampMs'
          }
        ]
      }
    });
    expect(syncRes.statusCode).toBe(200);
    expect(syncRes.json().processedCount).toBe(3);
    expect(syncRes.json().session.status).toBe('COMPLETED');

    // Replaying exact same event batch after network hiccup suppresses duplicates cleanly
    const replaySync = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${created.session.sessionId}/events`,
      headers: { authorization: `Bearer ${refreshedOwnerTokens.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        events: [
          {
            clientEventId: 'evt-comp-3',
            eventType: 'SESSION_COMPLETED',
            fromEngineState: 'ACTIVE',
            toEngineState: 'COMPLETED',
            occurredAtClientMs: Date.now()
          }
        ]
      }
    });
    expect(replaySync.statusCode).toBe(200);
    expect(replaySync.json().duplicateCount).toBe(1);
    expect(replaySync.json().processedCount).toBe(0);
  });

  it('serializes concurrent session requests on the same target device and prevents conflicts', async () => {
    const [res1, res2] = await Promise.all([
      harness.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: { authorization: `Bearer ${partnerA.accessToken}` },
        payload: {
          sessionType: 'PARTNER_ARREST',
          targetDeviceId: deviceB.deviceId,
          authorizationId: permissionId,
          requestedDurationMinutes: 25,
          goal: 'Concurrent Request 1'
        }
      }),
      harness.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: { authorization: `Bearer ${partnerA.accessToken}` },
        payload: {
          sessionType: 'PARTNER_ARREST',
          targetDeviceId: deviceB.deviceId,
          authorizationId: permissionId,
          requestedDurationMinutes: 30,
          goal: 'Concurrent Request 2'
        }
      })
    ]);

    const statuses = [res1.statusCode, res2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it('rejects stale/expired START_ARREST commands so offline delayed commands never start late sessions', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: permissionId,
        requestedDurationMinutes: 30,
        commandTtlSeconds: 120,
        goal: 'Time-sensitive session'
      }
    });
    const commandId = created.json().command.commandId as string;
    const sessionId = created.json().session.sessionId as string;

    // Advance clock 3 minutes (> 120s TTL) while device was offline
    harness.clock.advanceMs(180_000);

    const lateAck = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/commands/${commandId}/acknowledge`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        status: 'EXECUTED',
        localSessionId: 'arrest-late0001'
      }
    });
    expect(lateAck.statusCode).toBe(409);
    expect(lateAck.json().error.code).toBe('COMMAND_EXPIRED');

    const sessionState = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    expect(sessionState.json().session.status).toBe('EXPIRED');
  });

  it('coordinates early release requests, blocks unauthorized decisions, handles deny/approve, and handles expired sessions', async () => {
    // Start active session
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: permissionId,
        requestedDurationMinutes: 30,
        goal: 'Study Calculus'
      }
    });
    const sessionId = created.json().session.sessionId as string;

    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/acknowledge`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        outcome: 'STARTED',
        localSessionId: 'arrest-calc1234'
      }
    });

    // 1. Owner B requests early release
    const relReq1 = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/release-requests`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { reason: 'Need to open banking app for urgent payment' }
    });
    expect(relReq1.statusCode).toBe(201);
    const req1Id = relReq1.json().releaseRequest.id as string;

    // Duplicate pending request rejected
    const dupRel = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/release-requests`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { reason: 'Duplicate request' }
    });
    expect(dupRel.statusCode).toBe(409);
    expect(dupRel.json().error.code).toBe('RELEASE_REQUEST_CONFLICT');

    // Arrested Owner B cannot self-approve their own release!
    const selfApprove = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/release-requests/${req1Id}/approve`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {}
    });
    expect(selfApprove.statusCode).toBe(403);

    // Outsider C cannot approve or deny!
    const outsiderDeny = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/release-requests/${req1Id}/deny`,
      headers: { authorization: `Bearer ${outsiderC.accessToken}` },
      payload: {}
    });
    expect(outsiderDeny.statusCode).toBe(403);

    // 2. Partner A denies first request -> queues DENY_RELEASE command
    const denyRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/release-requests/${req1Id}/deny`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: { decisionReason: 'Stay focused for 10 more minutes first' }
    });
    expect(denyRes.statusCode).toBe(200);
    expect(denyRes.json().releaseRequest.status).toBe('DENIED');
    expect(denyRes.json().command.commandType).toBe('DENY_RELEASE');

    // 3. Owner B submits a second request later, Partner A approves -> queues APPROVE_RELEASE
    const relReq2 = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/release-requests`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { reason: 'Finished all calculus problems early!' }
    });
    const req2Id = relReq2.json().releaseRequest.id as string;

    const approveRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/release-requests/${req2Id}/approve`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: { decisionReason: 'Great job!' }
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().releaseRequest.status).toBe('APPROVED');
    expect(approveRes.json().command.commandType).toBe('APPROVE_RELEASE');

    // Target Android device acknowledges APPROVE_RELEASE execution -> session becomes RELEASED_EARLY
    const execRelease = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/commands/${approveRes.json().command.commandId}/acknowledge`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        status: 'EXECUTED'
      }
    });
    expect(execRelease.statusCode).toBe(200);

    const afterRelease = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    expect(afterRelease.json().session.status).toBe('RELEASED_EARLY');

    // 4. Test expired session during unresolved release request
    const session2Res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: permissionId,
        requestedDurationMinutes: 15,
        goal: 'Short Sprint'
      }
    });
    const s2Id = session2Res.json().session.sessionId as string;

    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${s2Id}/acknowledge`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { deviceId: deviceB.deviceId, outcome: 'STARTED' }
    });

    const relReq3 = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${s2Id}/release-requests`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { reason: 'Release me please' }
    });
    const req3Id = relReq3.json().releaseRequest.id as string;

    // Advance clock past 15-minute session end before partner responds (refreshing 15m JWT)
    harness.clock.advanceMs(16 * 60 * 1000);
    const refreshedPartnerTokens = (
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: partnerA.refreshToken }
      })
    ).json().tokens;

    const lateApprove = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/release-requests/${req3Id}/approve`,
      headers: { authorization: `Bearer ${refreshedPartnerTokens.accessToken}` },
      payload: {}
    });
    expect(lateApprove.statusCode).toBe(409);
    expect(lateApprove.json().error.code).toBe('SESSION_EXPIRED');
  });

  it('survives FCM outages without corrupting sessions, retries pushes in maintenance, and invalidates bad FCM tokens', async () => {
    // 1. Simulate transient FCM outage (both initial attempt and immediate retry fail)
    harness.fcm.queueOutcome({
      status: 'RETRYABLE_FAILURE',
      errorCode: 'messaging/unavailable',
      message: 'FCM temporarily unavailable'
    });
    harness.fcm.queueOutcome({
      status: 'RETRYABLE_FAILURE',
      errorCode: 'messaging/unavailable',
      message: 'FCM temporarily unavailable'
    });

    const createDuringOutage = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: permissionId,
        requestedDurationMinutes: 20,
        goal: 'Resilient Session'
      }
    });

    // Session & command MUST still commit cleanly!
    expect(createDuringOutage.statusCode).toBe(201);
    const cmdId = createDuringOutage.json().command.commandId as string;

    // Maintenance job retries the failed push wakeup once FCM recovers
    const maintRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/internal/maintenance/run',
      headers: { 'x-maintenance-key': TEST_MAINTENANCE_KEY }
    });
    expect(maintRes.statusCode).toBe(200);
    expect(maintRes.json().retriedPushNotificationsSent).toBe(1);

    // Cancel/reject this session so we can test invalid token handling next
    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/commands/${cmdId}/acknowledge`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        status: 'REJECTED',
        failureReason: 'Testing cleanup'
      }
    });

    // 2. Mark Owner B's FCM token as unregistered on Firebase -> must be marked INVALID safely
    harness.fcm.markTokenAsUnregisteredOnFcm('fcm_owner_b_device_token_1234567890');

    const secondSession = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: permissionId,
        requestedDurationMinutes: 20,
        goal: 'Invalid Token Safety Check'
      }
    });
    expect(secondSession.statusCode).toBe(201);

    const tokenRecords = harness.memoryStore!.getPushTokensSnapshot();
    const ownerBToken = tokenRecords.find(
      (t) => t.fcmToken === 'fcm_owner_b_device_token_1234567890'
    );
    expect(ownerBToken?.tokenStatus).toBe('INVALID');
  });
});
