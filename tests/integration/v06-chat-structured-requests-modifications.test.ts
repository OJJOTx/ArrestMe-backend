import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../helpers/test-context';

describe('V0.6 Full Chat, Structured Requests & Live Session Modifications', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness({
      initialTimeIso: '2026-11-05T12:00:00.000Z'
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('satisfies all 15 V0.6 acceptance tests (conversations, deduplication, unread markers, structured requests, early release, temporary app access grants, early revocation, live rule revisions, session extension, and cancellation)', async () => {
    // 1. Setup accounts: Partner A (controller), Owner B (arrested device owner), Stranger C
    const partnerA = await harness.registerAndLogin({
      username: 'controller_amy',
      email: 'amy@example.com'
    });
    const ownerB = await harness.registerAndLogin({
      username: 'arrested_bob',
      email: 'bob@example.com'
    });
    const strangerC = await harness.registerAndLogin({
      username: 'stranger_charlie',
      email: 'charlie@example.com'
    });

    const deviceB = await harness.registerDevice(ownerB.accessToken, {
      deviceName: "Bob's Galaxy S24",
      fcmToken: 'fcm_bobs_galaxy_s24_token_1234567890123456'
    });

    // 2. Establish accepted partnership between A and B
    const reqRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partners/requests',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: { username: 'arrested_bob' }
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
    // Test 1: Conversation Initialization between accepted partners
    // =========================================================================
    const convRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/conversations/partnership/${partnershipId}`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    expect(convRes.statusCode).toBe(200);
    const conversation = convRes.json().conversation;
    expect(conversation.partnershipId).toBe(partnershipId);
    expect(conversation.partner.username).toBe('controller_amy');
    const conversationId = conversation.id as string;

    // =========================================================================
    // Test 2: Stranger cannot access conversation
    // =========================================================================
    const strangerAccessRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${strangerC.accessToken}` }
    });
    expect(strangerAccessRes.statusCode).toBe(403);

    // =========================================================================
    // Test 3: Text messaging with clientMessageId deduplication
    // =========================================================================
    const msg1Res = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        clientMessageId: 'client_msg_001',
        text: 'Hey Amy, starting my focus block now!'
      }
    });
    expect(msg1Res.statusCode).toBe(201);
    const msg1 = msg1Res.json().message;
    expect(msg1.clientMessageId).toBe('client_msg_001');
    expect(msg1.messageType).toBe('TEXT');
    expect(msg1.textContent).toBe('Hey Amy, starting my focus block now!');

    // Replay with identical clientMessageId is deduplicated idempotently
    const replayMsg1Res = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        clientMessageId: 'client_msg_001',
        text: 'Hey Amy, starting my focus block now!'
      }
    });
    expect(replayMsg1Res.statusCode).toBe(201);
    expect(replayMsg1Res.json().message.id).toBe(msg1.id);

    // =========================================================================
    // Test 4: Unread message count and read marker
    // =========================================================================
    // Amy lists conversations: unread count for Amy should be 1
    const amyConvListRes = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${partnerA.accessToken}` }
    });
    expect(amyConvListRes.statusCode).toBe(200);
    const amyConv = amyConvListRes.json().items.find((c: { id: string }) => c.id === conversationId);
    expect(amyConv).toBeDefined();
    expect(amyConv.unreadCount).toBe(1);

    // Amy marks conversation as read up to msg1
    const markReadRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/read`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: { lastReadMessageId: msg1.id }
    });
    expect(markReadRes.statusCode).toBe(200);

    // Verify unread count is now 0 for Amy
    const amyConvListAfterRes = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${partnerA.accessToken}` }
    });
    const amyConvAfter = amyConvListAfterRes.json().items.find((c: { id: string }) => c.id === conversationId);
    expect(amyConvAfter.unreadCount).toBe(0);

    // Setup an active partner arrest session for Bob controlled by Amy
    // First, grant standing permission or proposal
    const permRes = await harness.app.inject({
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
        expiresAt: '2026-11-06T12:00:00.000Z'
      }
    });
    expect(permRes.statusCode).toBe(201);
    const permId = permRes.json().permission.permissionId as string;

    const disableApprovalRes = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/partners/${partnerA.userId}/approval-policy`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        requireApprovalBeforeArrest: false,
        standingPermissionId: permId
      }
    });
    expect(disableApprovalRes.statusCode).toBe(200);

    // Amy starts remote arrest on Bob's device
    const startRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: permId,
        requestedDurationMinutes: 60,
        goal: 'Deep Work on V0.6 Specification',
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'BLOCK_SELECTED',
          overlayStatusBar: false,
          disableEmergencyExit: false,
          allowedCategories: ['CALLS'],
          blockedPackages: ['com.instagram.android', 'com.zhiliaoapp.musically']
        }
      }
    });
    expect(startRes.statusCode).toBe(201);
    const sessionId = startRes.json().session.sessionId as string;

    // Bob's device acknowledges start
    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/ack`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        outcome: 'STARTED',
        localSessionId: 'local_sess_bob_001',
        localEngineState: 'ACTIVE'
      }
    });

    // =========================================================================
    // Test 5: Bob sends REQUEST_EARLY_RELEASE in chat
    // =========================================================================
    const releaseReqRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/structured-requests`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        clientMessageId: 'req_msg_release_001',
        requestType: 'REQUEST_EARLY_RELEASE',
        sessionId,
        messageText: 'Finished my goal 20 minutes early, please release me!'
      }
    });
    expect(releaseReqRes.statusCode).toBe(201);
    const releaseMsg = releaseReqRes.json().message;
    expect(releaseMsg.messageType).toBe('STRUCTURED_REQUEST');
    expect(releaseMsg.structuredRequest).toBeDefined();
    expect(releaseMsg.structuredRequest.status).toBe('PENDING');
    expect(releaseMsg.structuredRequest.requestType).toBe('REQUEST_EARLY_RELEASE');
    const earlyReleaseRequestId = releaseMsg.structuredRequest.id as string;

    // =========================================================================
    // Test 6: Stranger cannot respond to the request
    // =========================================================================
    const strangerRespondRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/structured-requests/${earlyReleaseRequestId}/respond`,
      headers: { authorization: `Bearer ${strangerC.accessToken}` },
      payload: { decision: 'APPROVE' }
    });
    expect(strangerRespondRes.statusCode).toBe(403);

    // =========================================================================
    // Test 7: Rejecting structured request records decision & sends chat event
    // =========================================================================
    const amyRejectRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/structured-requests/${earlyReleaseRequestId}/respond`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        decision: 'REJECT',
        reason: 'Still 15 minutes left, stay focused!'
      }
    });
    expect(amyRejectRes.statusCode).toBe(200);
    expect(amyRejectRes.json().request.status).toBe('REJECTED');
    expect(amyRejectRes.json().request.decisionReason).toBe('Still 15 minutes left, stay focused!');

    // =========================================================================
    // Test 8: Bob sends a new REQUEST_EARLY_RELEASE & Amy APPROVES it
    // =========================================================================
    const releaseReq2Res = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/structured-requests`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        clientMessageId: 'req_msg_release_002',
        requestType: 'REQUEST_EARLY_RELEASE',
        sessionId,
        messageText: 'Okay, all deliverables pushed!'
      }
    });
    expect(releaseReq2Res.statusCode).toBe(201);
    const releaseReq2Id = releaseReq2Res.json().message.structuredRequest.id as string;

    const amyApproveReleaseRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/structured-requests/${releaseReq2Id}/respond`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        decision: 'APPROVE',
        reason: 'Great job!'
      }
    });
    expect(amyApproveReleaseRes.statusCode).toBe(200);
    expect(amyApproveReleaseRes.json().request.status).toBe('APPROVED');

    // Verify APPROVE_RELEASE command was queued for Bob's device
    const cmdsAfterReleaseRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceB.deviceId}/commands`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    expect(cmdsAfterReleaseRes.statusCode).toBe(200);
    const releaseCmd = cmdsAfterReleaseRes.json().items.find((c: { commandType: string }) => c.commandType === 'APPROVE_RELEASE');
    expect(releaseCmd).toBeDefined();

    // =========================================================================
    // Test 9 & 10: REQUEST_TEMPORARY_APP_ACCESS -> Approval -> Grant & Command
    // =========================================================================
    const tempAccessReqRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/structured-requests`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        clientMessageId: 'req_msg_temp_insta_001',
        requestType: 'REQUEST_TEMPORARY_APP_ACCESS',
        sessionId,
        targetPackage: 'com.instagram.android',
        durationMinutes: 10,
        messageText: 'Need to check a 2FA code sent via Instagram DM'
      }
    });
    expect(tempAccessReqRes.statusCode).toBe(201);
    const tempReqId = tempAccessReqRes.json().message.structuredRequest.id as string;

    // Amy approves 10 minutes of Instagram access
    const approveTempRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/structured-requests/${tempReqId}/respond`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        decision: 'APPROVE',
        reason: 'Granted 10 minutes for 2FA'
      }
    });
    expect(approveTempRes.statusCode).toBe(200);
    expect(approveTempRes.json().request.status).toBe('APPROVED');

    // Verify APPLY_TEMPORARY_APP_ACCESS command was enqueued to device
    const cmdsAfterTempRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceB.deviceId}/commands`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    const applyGrantCmd = cmdsAfterTempRes.json().items.find(
      (c: { commandType: string }) => c.commandType === 'APPLY_TEMPORARY_APP_ACCESS'
    );
    expect(applyGrantCmd).toBeDefined();
    expect(applyGrantCmd.payload.packageName).toBe('com.instagram.android');
    expect(applyGrantCmd.payload.durationMinutes).toBe(10);
    const grantId = applyGrantCmd.payload.grantId as string;

    // =========================================================================
    // Test 11: List active temporary grants
    // =========================================================================
    const grantsListRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/temporary-grants`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    expect(grantsListRes.statusCode).toBe(200);
    expect(grantsListRes.json().items.length).toBe(1);
    const activeGrant = grantsListRes.json().items[0];
    expect(activeGrant.id).toBe(grantId);
    expect(activeGrant.packageName).toBe('com.instagram.android');
    expect(activeGrant.isCurrentlyActive).toBe(true);

    // =========================================================================
    // Test 12: Early Revocation of temporary grant by controlling partner
    // =========================================================================
    const revokeGrantRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/temporary-grants/${grantId}/revoke`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` }
    });
    expect(revokeGrantRes.statusCode).toBe(200);

    // Verify active grants list is now empty
    const grantsAfterRevokeRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/temporary-grants`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    expect(grantsAfterRevokeRes.json().items.length).toBe(0);

    // Verify REVOKE_TEMPORARY_APP_ACCESS command was enqueued
    const cmdsAfterRevokeRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceB.deviceId}/commands`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    const revokeCmd = cmdsAfterRevokeRes.json().items.find(
      (c: { commandType: string }) => c.commandType === 'REVOKE_TEMPORARY_APP_ACCESS'
    );
    expect(revokeCmd).toBeDefined();

    // =========================================================================
    // Test 13: REQUEST_SESSION_EXTENSION -> Approval -> Extended Time Command
    // =========================================================================
    const extReqRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/structured-requests`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        clientMessageId: 'req_msg_ext_001',
        requestType: 'REQUEST_SESSION_EXTENSION',
        sessionId,
        durationMinutes: 30,
        messageText: 'I want to study 30 more minutes'
      }
    });
    expect(extReqRes.statusCode).toBe(201);
    const extReqId = extReqRes.json().message.structuredRequest.id as string;

    const approveExtRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/structured-requests/${extReqId}/respond`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: { decision: 'APPROVE', reason: 'Extended by 30 min' }
    });
    expect(approveExtRes.statusCode).toBe(200);

    // Verify UPDATE_SESSION_RULES command for extension
    const cmdsAfterExtRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceB.deviceId}/commands`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    const extCmd = cmdsAfterExtRes.json().items.find(
      (c: { commandType: string; payload: { action?: string } }) =>
        c.commandType === 'UPDATE_SESSION_RULES' && c.payload?.action === 'SESSION_EXTENSION'
    );
    expect(extCmd).toBeDefined();
    expect(extCmd.payload.extendedByMinutes).toBe(30);

    // =========================================================================
    // Test 14: Live rule revision (REQUEST_ADD_ALLOWED_APP)
    // =========================================================================
    const addAppReqRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/structured-requests`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        clientMessageId: 'req_msg_allow_app_001',
        requestType: 'REQUEST_ADD_ALLOWED_APP',
        sessionId,
        targetPackage: 'com.wolfram.android.alpha',
        messageText: 'Need Wolfram Alpha for calculus assignment'
      }
    });
    expect(addAppReqRes.statusCode).toBe(201);
    const addAppReqId = addAppReqRes.json().message.structuredRequest.id as string;

    const approveAddAppRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/structured-requests/${addAppReqId}/respond`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: { decision: 'APPROVE' }
    });
    expect(approveAddAppRes.statusCode).toBe(200);

    // Verify UPDATE_SESSION_RULES revision command
    const cmdsAfterRuleRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceB.deviceId}/commands`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    const ruleChangeCmd = cmdsAfterRuleRes.json().items.find(
      (c: { commandType: string; payload: { revisionNumber?: number } }) =>
        c.commandType === 'UPDATE_SESSION_RULES' && typeof c.payload?.revisionNumber === 'number'
    );
    expect(ruleChangeCmd).toBeDefined();
    expect(ruleChangeCmd.payload.revisionNumber).toBeGreaterThanOrEqual(1);

    // =========================================================================
    // Test 15: Initiator cancelling a pending structured request
    // =========================================================================
    const cancelCandidateReqRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/structured-requests`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        clientMessageId: 'req_msg_cancel_001',
        requestType: 'REQUEST_CHANGE_BLOCKING_MODE',
        sessionId,
        messageText: 'Actually nevermind changing mode'
      }
    });
    expect(cancelCandidateReqRes.statusCode).toBe(201);
    const cancelReqId = cancelCandidateReqRes.json().message.structuredRequest.id as string;

    // Bob cancels his own pending request
    const cancelRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/structured-requests/${cancelReqId}/cancel`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` }
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().request.status).toBe('CANCELLED');

    // Partner cannot approve a cancelled request (conflict)
    const lateApproveRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/structured-requests/${cancelReqId}/respond`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: { decision: 'APPROVE' }
    });
    expect(lateApproveRes.statusCode).toBe(409);
  });
});
