import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../helpers/test-context';

describe('V0.5 Remote Arrest Execution, Scheduling Engine, Selectable App Catalog & Live Dashboard', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness({
      initialTimeIso: '2026-11-05T08:00:00.000Z' // Thursday 08:00 UTC
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('satisfies all 10 V0.5 acceptance tests across two distinct accounts (authorized immediate remote arrest, unauthorized rejection, scheduled remote start on time, cancelled schedule prevention, revoked authorization prevention, expired command rejection, missed scheduled window expiry, controlled app catalog filtering, accurate live session phase progression, and offline-to-online reconciliation)', async () => {
    const partnerA = await harness.registerAndLogin({
      username: 'partner_alpha',
      email: 'partner_alpha@example.com'
    });
    const ownerB = await harness.registerAndLogin({
      username: 'owner_bravo',
      email: 'owner_bravo@example.com'
    });
    const strangerC = await harness.registerAndLogin({
      username: 'stranger_charlie',
      email: 'stranger_charlie@example.com'
    });

    const deviceB = await harness.registerDevice(ownerB.accessToken, {
      deviceName: 'Owner Bravo Pixel 9',
      fcmToken: 'fcm_owner_bravo_pixel9_token_1234567890123456'
    });

    const refreshTokensIfNeeded = async () => {
      const rA = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: partnerA.refreshToken }
      });
      if (rA.statusCode === 200) {
        partnerA.accessToken = rA.json().tokens.accessToken;
        partnerA.refreshToken = rA.json().tokens.refreshToken;
      }
      const rB = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: ownerB.refreshToken }
      });
      if (rB.statusCode === 200) {
        ownerB.accessToken = rB.json().tokens.accessToken;
        ownerB.refreshToken = rB.json().tokens.refreshToken;
      }
    };

    // Establish accepted partnership between A and B
    const reqRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partners/requests',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: { username: 'owner_bravo' }
    });
    expect(reqRes.statusCode).toBe(201);
    const partnershipId = reqRes.json().partnership.id as string;

    const acceptRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/partners/requests/${partnershipId}/accept`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    expect(acceptRes.statusCode).toBe(200);

    // =========================================================================
    // Test 8: Controlled Selectable App Catalog (filters out system packages,
    // accessible to owner & accepted partners, forbidden to non-partners)
    // =========================================================================
    const uploadCatalogRes = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${deviceB.deviceId}/app-catalog`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        apps: [
          {
            packageName: 'com.instagram.android',
            appLabel: 'Instagram',
            category: 'SOCIAL',
            isStudyCandidate: false
          },
          {
            packageName: 'org.anki.droid',
            appLabel: 'AnkiDroid Flashcards',
            category: 'EDUCATION',
            isStudyCandidate: true
          },
          // Critical system packages that MUST be filtered out automatically
          {
            packageName: 'com.android.systemui',
            appLabel: 'System UI',
            category: 'SYSTEM',
            isStudyCandidate: false
          },
          {
            packageName: 'com.android.settings',
            appLabel: 'Android Settings',
            category: 'SYSTEM',
            isStudyCandidate: false
          },
          {
            packageName: 'com.arrestme.benchmark',
            appLabel: 'ArrestMe',
            category: 'PRODUCTIVITY',
            isStudyCandidate: false
          }
        ]
      }
    });
    expect(uploadCatalogRes.statusCode).toBe(200);
    const uploadedCatalog = uploadCatalogRes.json().catalog;
    expect(uploadedCatalog.apps).toHaveLength(2);
    expect(uploadedCatalog.filteredOutSystemCount).toBe(3);
    expect(uploadedCatalog.apps.map((a: { packageName: string }) => a.packageName)).toEqual([
      'org.anki.droid',
      'com.instagram.android'
    ]);

    // Accepted partner A can view B's selectable app catalog
    const partnerGetCatalogRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceB.deviceId}/app-catalog`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` }
    });
    expect(partnerGetCatalogRes.statusCode).toBe(200);
    expect(partnerGetCatalogRes.json().catalog.apps).toHaveLength(2);

    // Non-partner C is forbidden from viewing B's app catalog
    const strangerGetCatalogRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceB.deviceId}/app-catalog`,
      headers: { authorization: `Bearer ${strangerC.accessToken}` }
    });
    expect(strangerGetCatalogRes.statusCode).toBe(403);

    // =========================================================================
    // Test 2: Unauthorized remote session is rejected
    // =========================================================================
    const unauthSessionRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        requestedDurationMinutes: 45,
        goal: 'Unauthorized Remote Arrest Attempt'
      }
    });
    expect(unauthSessionRes.statusCode).toBe(400);
    expect(unauthSessionRes.json().error.code).toBe('PERMISSION_NOT_FOUND');

    // =========================================================================
    // Test 1 & Test 9: Partner starts immediate remote session when authorized,
    // and both users see accurate live session status (QUEUED -> DELIVERED ->
    // EXECUTING -> ACTIVE -> COMPLETED), never falsely ACTIVE when only queued!
    // =========================================================================
    const grantPermRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partner-permissions',
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        partnerUserId: partnerA.userId,
        targetDeviceId: deviceB.deviceId,
        allowedSessionTypes: ['PARTNER_ARREST'],
        maximumSessionDuration: 120,
        blockingConfigLimits: {
          schemaVersion: 1,
          allowedRuleModes: ['BLOCK_SELECTED', 'STRICT_ALLOWLIST', 'WHITELIST_ONLY'],
          allowOverlayStatusBar: true,
          allowDisableEmergencyExit: false,
          requiredAllowedCategories: ['CALLS'],
          allowCustomPackageLists: true,
          dailyMaxSessions: 5
        },
        expiresAt: '2026-11-12T08:00:00.000Z'
      }
    });
    expect(grantPermRes.statusCode).toBe(201);
    const standingPermissionId = grantPermRes.json().permission.permissionId as string;

    const disableApprovalRes = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/partners/${partnerA.userId}/approval-policy`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        requireApprovalBeforeArrest: false,
        standingPermissionId
      }
    });
    expect(disableApprovalRes.statusCode).toBe(200);

    const startImmediateRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: standingPermissionId,
        requestedDurationMinutes: 45,
        goal: 'Immediate Deep Work Session',
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'BLOCK_SELECTED',
          allowedCategories: ['CALLS', 'STUDY_APPS'],
          overlayStatusBar: true,
          disableEmergencyExit: false,
          blockedPackages: ['com.instagram.android'],
          allowedStudyPackages: ['org.anki.droid']
        }
      }
    });
    expect(startImmediateRes.statusCode).toBe(201);
    const immediateSessionId = startImmediateRes.json().session.sessionId as string;

    // Immediately after queueing, status MUST be REQUESTED and remoteExecutionPhase MUST be QUEUED (not ACTIVE!)
    expect(startImmediateRes.json().session.status).toBe('REQUESTED');
    expect(startImmediateRes.json().session.remoteExecutionPhase).toBe('QUEUED');

    // Check Live Controller Dashboard for Partner A while command is still queued
    const dashQueuedRes = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/sessions/live-dashboard',
      headers: { authorization: `Bearer ${partnerA.accessToken}` }
    });
    expect(dashQueuedRes.statusCode).toBe(200);
    expect(dashQueuedRes.json().items[0].session.sessionId).toBe(immediateSessionId);
    expect(dashQueuedRes.json().items[0].session.remoteExecutionPhase).toBe('QUEUED');
    expect(dashQueuedRes.json().items[0].owner.username).toBe('owner_bravo');
    expect(dashQueuedRes.json().items[0].initiator.username).toBe('partner_alpha');

    // Target Android device polls pending commands -> transitions session to DELIVERED
    const pollCmdRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceB.deviceId}/commands`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    expect(pollCmdRes.statusCode).toBe(200);
    expect(pollCmdRes.json().items).toHaveLength(1);
    expect(pollCmdRes.json().items[0].commandType).toBe('START_ARREST');

    const dashDeliveredRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${immediateSessionId}`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` }
    });
    expect(dashDeliveredRes.json().session.status).toBe('DELIVERED');
    expect(dashDeliveredRes.json().session.remoteExecutionPhase).toBe('DELIVERED');

    // Target Android device acknowledges ACCEPTED (engine preparing) -> phase becomes EXECUTING
    const ackAcceptedRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${immediateSessionId}/acknowledge`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        outcome: 'ACCEPTED',
        localSessionId: 'local_sess_immediate_1',
        localEngineState: 'PREPARING'
      }
    });
    expect(ackAcceptedRes.statusCode).toBe(200);
    expect(ackAcceptedRes.json().session.remoteExecutionPhase).toBe('EXECUTING');

    // Target Android device acknowledges STARTED -> phase becomes ACTIVE
    const ackStartedRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${immediateSessionId}/acknowledge`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        outcome: 'STARTED',
        localSessionId: 'local_sess_immediate_1',
        localEngineState: 'ACTIVE'
      }
    });
    expect(ackStartedRes.statusCode).toBe(200);
    expect(ackStartedRes.json().session.status).toBe('ACTIVE');
    expect(ackStartedRes.json().session.remoteExecutionPhase).toBe('ACTIVE');

    // =========================================================================
    // Test 10: Reconnection after offline execution reconciles events idempotently
    // =========================================================================
    harness.clock.advanceMs(45 * 60 * 1000); // 45 minutes later (08:45 UTC)
    await refreshTokensIfNeeded();
    const syncEventsRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${immediateSessionId}/events`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        events: [
          {
            clientEventId: 'evt_pause_1',
            eventType: 'SESSION_PAUSED',
            fromEngineState: 'ACTIVE',
            toEngineState: 'PAUSED',
            occurredAtClientMs: Date.now() - 120_000
          },
          {
            clientEventId: 'evt_resume_1',
            eventType: 'SESSION_RESUMED',
            fromEngineState: 'PAUSED',
            toEngineState: 'ACTIVE',
            accumulatedPausedMs: 30_000,
            occurredAtClientMs: Date.now() - 90_000
          },
          {
            clientEventId: 'evt_complete_1',
            eventType: 'SESSION_COMPLETED',
            fromEngineState: 'ACTIVE',
            toEngineState: 'COMPLETED',
            occurredAtClientMs: Date.now(),
            reason: 'Timer finished on Android device'
          }
        ]
      }
    });
    expect(syncEventsRes.statusCode).toBe(200);
    expect(syncEventsRes.json().processedCount).toBe(3);
    expect(syncEventsRes.json().session.status).toBe('COMPLETED');
    expect(syncEventsRes.json().session.remoteExecutionPhase).toBe('COMPLETED');

    // Replaying the same events after reconnection is 100% idempotent
    const replayEventsRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${immediateSessionId}/events`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        events: [
          {
            clientEventId: 'evt_complete_1',
            eventType: 'SESSION_COMPLETED',
            fromEngineState: 'ACTIVE',
            toEngineState: 'COMPLETED',
            occurredAtClientMs: Date.now()
          }
        ]
      }
    });
    expect(replayEventsRes.statusCode).toBe(200);
    expect(replayEventsRes.json().processedCount).toBe(0);
    expect(replayEventsRes.json().duplicateCount).toBe(1);

    // =========================================================================
    // Test 6: Expired command is rejected
    // =========================================================================
    const expirableSessionRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: standingPermissionId,
        requestedDurationMinutes: 30,
        goal: 'Short TTL Command Test',
        commandTtlSeconds: 60
      }
    });
    expect(expirableSessionRes.statusCode).toBe(201);
    const expirableSessionId = expirableSessionRes.json().session.sessionId as string;

    // Advance clock past command TTL (2 minutes)
    harness.clock.advanceMs(120 * 1000);

    const ackExpiredRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${expirableSessionId}/acknowledge`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        outcome: 'STARTED',
        localSessionId: 'local_expired_1',
        localEngineState: 'ACTIVE'
      }
    });
    expect(ackExpiredRes.statusCode).toBe(409);
    expect(ackExpiredRes.json().error.code).toBe('COMMAND_EXPIRED');

    // =========================================================================
    // Test 3: Scheduled remote session starts on time (via command poll materialization)
    // =========================================================================
    // Current clock is 2026-11-05T08:47:00.000Z. Let's create & accept a scheduled proposal for 09:00 UTC.
    const schedProposalRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proposals',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        targetDeviceId: deviceB.deviceId,
        requestType: 'SCHEDULED',
        sessionType: 'PARTNER_ARREST',
        goal: '09:00 Scheduled Study Block',
        durationMinutes: 60,
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'WHITELIST_ONLY',
          allowedCategories: ['CALLS', 'STUDY_APPS'],
          overlayStatusBar: true,
          disableEmergencyExit: false,
          allowedStudyPackages: ['org.anki.droid']
        },
        requireApprovalBeforeArrest: true,
        schedule: {
          localDate: '2026-11-05',
          localStartTime: '09:00',
          localEndTime: '10:00',
          timezone: 'UTC'
        }
      }
    });
    expect(schedProposalRes.statusCode).toBe(201);
    const schedProposalId = schedProposalRes.json().proposal.proposalId as string;

    const acceptSchedProposalRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${schedProposalId}/accept`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { expectedRevisionNumber: 1 }
    });
    expect(acceptSchedProposalRes.statusCode).toBe(200);
    const schedule1Id = acceptSchedProposalRes.json().schedule.scheduleId as string;

    // Triggering before 09:00 (outside early grace window) is rejected
    const earlyTriggerRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/scheduled-arrests/${schedule1Id}/trigger`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { deviceId: deviceB.deviceId }
    });
    expect(earlyTriggerRes.statusCode).toBe(409);
    expect(earlyTriggerRes.json().error.code).toBe('SCHEDULE_NOT_DUE_YET');

    // Advance clock to 09:00:05 UTC -> polling commands automatically materializes the due scheduled arrest!
    harness.clock.set(new Date('2026-11-05T09:00:05.000Z'));
    await refreshTokensIfNeeded();
    const pollDueScheduleRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceB.deviceId}/commands`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    expect(pollDueScheduleRes.statusCode).toBe(200);
    expect(pollDueScheduleRes.json().items).toHaveLength(1);
    const scheduledStartCmd = pollDueScheduleRes.json().items[0];
    expect(scheduledStartCmd.commandType).toBe('START_ARREST');
    expect(scheduledStartCmd.payload.scheduleId).toBe(schedule1Id);

    // Complete that scheduled session so device is free for next tests
    const scheduledSessionId = scheduledStartCmd.sessionId as string;
    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${scheduledSessionId}/events`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        events: [
          {
            clientEventId: 'evt_sched_complete_1',
            eventType: 'SESSION_COMPLETED',
            fromEngineState: 'ACTIVE',
            toEngineState: 'COMPLETED',
            occurredAtClientMs: Date.now()
          }
        ]
      }
    });

    // =========================================================================
    // Test 4: Cancelled schedule does not start
    // =========================================================================
    const cancelledPropRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proposals',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        targetDeviceId: deviceB.deviceId,
        requestType: 'SCHEDULED',
        sessionType: 'PARTNER_ARREST',
        goal: '11:00 Cancelled Schedule Block',
        durationMinutes: 30,
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'BLOCK_SELECTED',
          allowedCategories: ['CALLS'],
          overlayStatusBar: false,
          disableEmergencyExit: false
        },
        requireApprovalBeforeArrest: true,
        schedule: {
          localDate: '2026-11-05',
          localStartTime: '11:00',
          localEndTime: '11:30',
          timezone: 'UTC'
        }
      }
    });
    const cancelledPropId = cancelledPropRes.json().proposal.proposalId as string;
    const acceptCancelledPropRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${cancelledPropId}/accept`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { expectedRevisionNumber: 1 }
    });
    const cancelledScheduleId = acceptCancelledPropRes.json().schedule.scheduleId as string;

    // Partner A cancels the schedule before 11:00
    const cancelSchedRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/scheduled-arrests/${cancelledScheduleId}/cancel`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` }
    });
    expect(cancelSchedRes.statusCode).toBe(200);

    harness.clock.set(new Date('2026-11-05T11:01:00.000Z'));
    await refreshTokensIfNeeded();
    const triggerCancelledRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/scheduled-arrests/${cancelledScheduleId}/trigger`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {}
    });
    expect(triggerCancelledRes.statusCode).toBe(409);

    // =========================================================================
    // Test 5: Revoked authorization blocks scheduled start
    // =========================================================================
    const revocablePropRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proposals',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        targetDeviceId: deviceB.deviceId,
        requestType: 'SCHEDULED',
        sessionType: 'PARTNER_ARREST',
        goal: '12:00 Revoked Permission Schedule Block',
        durationMinutes: 30,
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'BLOCK_SELECTED',
          allowedCategories: ['CALLS'],
          overlayStatusBar: false,
          disableEmergencyExit: false
        },
        requireApprovalBeforeArrest: true,
        schedule: {
          localDate: '2026-11-05',
          localStartTime: '12:00',
          localEndTime: '12:30',
          timezone: 'UTC'
        }
      }
    });
    const revocablePropId = revocablePropRes.json().proposal.proposalId as string;
    const acceptRevocablePropRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${revocablePropId}/accept`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { expectedRevisionNumber: 1 }
    });
    const revocableScheduleId = acceptRevocablePropRes.json().schedule.scheduleId as string;
    const revocablePermId = acceptRevocablePropRes.json().permission.permissionId as string;

    // Owner revokes the underlying permission before 12:00
    const revokePermRes = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/partner-permissions/${revocablePermId}`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    expect(revokePermRes.statusCode).toBe(200);

    harness.clock.set(new Date('2026-11-05T12:01:00.000Z'));
    await refreshTokensIfNeeded();
    const triggerRevokedRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/scheduled-arrests/${revocableScheduleId}/trigger`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {}
    });
    expect(triggerRevokedRes.statusCode).toBe(403);
    expect(triggerRevokedRes.json().error.code).toBe('PERMISSION_REVOKED');

    // =========================================================================
    // Test 7: Missed scheduled window (past scheduled end time) expires cleanly
    // and never starts late
    // =========================================================================
    const missedPropRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proposals',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        targetDeviceId: deviceB.deviceId,
        requestType: 'SCHEDULED',
        sessionType: 'PARTNER_ARREST',
        goal: '13:00-13:30 Window Missed Offline',
        durationMinutes: 30,
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'BLOCK_SELECTED',
          allowedCategories: ['CALLS'],
          overlayStatusBar: false,
          disableEmergencyExit: false
        },
        requireApprovalBeforeArrest: true,
        schedule: {
          localDate: '2026-11-05',
          localStartTime: '13:00',
          localEndTime: '13:30',
          timezone: 'UTC'
        }
      }
    });
    const missedPropId = missedPropRes.json().proposal.proposalId as string;
    const acceptMissedPropRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${missedPropId}/accept`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { expectedRevisionNumber: 1 }
    });
    const missedScheduleId = acceptMissedPropRes.json().schedule.scheduleId as string;

    // Device was off until 14:00 UTC (past the 13:30 end time)
    harness.clock.set(new Date('2026-11-05T14:00:00.000Z'));
    await refreshTokensIfNeeded();
    const triggerMissedRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/scheduled-arrests/${missedScheduleId}/trigger`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {}
    });
    expect(triggerMissedRes.statusCode).toBe(409);
    expect(triggerMissedRes.json().error.code).toBe('SCHEDULE_WINDOW_EXPIRED');
  });
});
