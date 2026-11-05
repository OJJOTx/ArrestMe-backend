import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../helpers/test-context';

describe('Immediate Partner Arrest Execution & Session-Bound Authorization', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('correctly tracks one-time consumed authorization bound to approved immediate arrest session and coordinates execution', async () => {
    // 1. Create two users and register Device B for User B
    const userA = await harness.registerAndLogin({
      username: 'partner_alice',
      email: 'alice@example.com'
    });

    const userB = await harness.registerAndLogin({
      username: 'owner_bob',
      email: 'bob@example.com'
    });

    const deviceB = await harness.registerDevice(userB.accessToken, {
      deviceName: "Bob's Pixel 8",
      installationId: '11111111-2222-3333-4444-555555555555'
    });

    // 2. Establish an accepted partnership
    const inviteRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partners/requests',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: { username: userB.username }
    });
    expect(inviteRes.statusCode).toBe(201);
    const partnershipId = inviteRes.json().partnership.id as string;

    const acceptPartnerRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/partners/requests/${partnershipId}/accept`,
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(acceptPartnerRes.statusCode).toBe(200);

    // 3. Create an Immediate Partner Arrest proposal targeting Device B
    const createPropRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proposals',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        targetDeviceId: deviceB.deviceId,
        requestType: 'IMMEDIATE',
        sessionType: 'PARTNER_ARREST',
        goal: 'Study Sprint',
        durationMinutes: 45,
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'BLOCK_SELECTED',
          allowedCategories: ['CALLS', 'STUDY_APPS'],
          overlayStatusBar: true,
          disableEmergencyExit: false,
          blockedPackages: ['com.social.distraction'],
          allowedStudyPackages: ['org.anki.droid']
        }
      }
    });
    expect(createPropRes.statusCode).toBe(201);
    const proposal = createPropRes.json().proposal;
    const proposalId = proposal.proposalId as string;

    // 4. Approve the proposal with startImmediateSession: true
    const approveRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${proposalId}/accept`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: {
        expectedRevisionNumber: 1,
        startImmediateSession: true
      }
    });
    expect(approveRes.statusCode).toBe(200);
    const approveData = approveRes.json();
    expect(approveData.proposal.status).toBe('APPROVED');
    expect(approveData.session).not.toBeNull();
    expect(approveData.permission).not.toBeNull();

    const sessionId = approveData.session.sessionId as string;
    const permissionId = approveData.permission.permissionId as string;

    // 5. Verify a one-time authorization is created and consumed (usedCount = 1)
    expect(approveData.permission.oneTimeOnly).toBe(true);
    expect(approveData.permission.usedCount).toBe(1);
    expect(approveData.permission.isCurrentlyActive).toBe(false); // Exhausted for NEW sessions
    expect(approveData.permission.boundSessionId).toBe(sessionId); // Bound to this approved session!

    // 6. Verify default activeOnly query excludes consumed one-time permissions
    const listActiveDefault = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/partner-permissions?role=granted&activeOnly=true',
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(listActiveDefault.statusCode).toBe(200);
    const defaultItems = listActiveDefault.json().items;
    expect(defaultItems.some((p: { permissionId: string }) => p.permissionId === permissionId)).toBe(false);

    // 7. Verify activeOnly + includeConsumed=true query includes this permission with boundSessionId
    const listActiveWithConsumed = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/partner-permissions?role=granted&activeOnly=true&includeConsumed=true',
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(listActiveWithConsumed.statusCode).toBe(200);
    const consumedItems = listActiveWithConsumed.json().items;
    const matchedPerm = consumedItems.find((p: { permissionId: string }) => p.permissionId === permissionId);
    expect(matchedPerm).toBeDefined();
    expect(matchedPerm.boundSessionId).toBe(sessionId);

    // 8. Verify direct GET /partner-permissions/:id returns permission with boundSessionId
    const getPermRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/partner-permissions/${permissionId}`,
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(getPermRes.statusCode).toBe(200);
    const permDetail = getPermRes.json().permission;
    expect(permDetail.boundSessionId).toBe(sessionId);
    expect(permDetail.exactBlockingConfiguration).not.toBeNull();
    expect(permDetail.exactBlockingConfiguration.blockingConfiguration.blockedPackages).toEqual([
      'com.social.distraction'
    ]);

    // 9. Fetch the pending START_ARREST command as Device B
    const pollRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceB.deviceId}/commands`,
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(pollRes.statusCode).toBe(200);
    const commands = pollRes.json().items;
    expect(commands.length).toBeGreaterThanOrEqual(1);

    const startCmd = commands.find((c: { commandType: string }) => c.commandType === 'START_ARREST');
    expect(startCmd).toBeDefined();
    expect(startCmd.sessionId).toBe(sessionId);
    expect(startCmd.payload.authorizationId).toBe(permissionId);
    expect(startCmd.payload.proposalId).toBe(proposalId);
    expect(startCmd.payload.durationMinutes).toBe(45);
    expect(startCmd.payload.blockedPackages).toEqual(['com.social.distraction']);

    // 10. Device B acknowledges execution and confirms cloud session status becomes ACTIVE
    const ackStartRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/acknowledge`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        outcome: 'STARTED',
        localSessionId: 'local_android_sess_1',
        localEngineState: 'ACTIVE'
      }
    });
    expect(ackStartRes.statusCode).toBe(200);
    expect(ackStartRes.json().session.status).toBe('ACTIVE');
    expect(ackStartRes.json().session.startedAt).not.toBeNull();

    // Acknowledge command as EXECUTED
    const ackCmdRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/commands/${startCmd.commandId}/acknowledge`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        status: 'EXECUTED'
      }
    });
    expect(ackCmdRes.statusCode).toBe(200);

    // 11. Verify replaying the one-time authorization to create a NEW session fails with PERMISSION_EXHAUSTED
    const replayNewSession = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        targetDeviceId: deviceB.deviceId,
        sessionType: 'PARTNER_ARREST',
        authorizationId: permissionId,
        requestedDurationMinutes: 45,
        goal: 'Unauthorized Replay',
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'BLOCK_SELECTED',
          allowedCategories: ['CALLS', 'STUDY_APPS'],
          overlayStatusBar: true,
          disableEmergencyExit: false
        }
      }
    });
    expect(replayNewSession.statusCode).toBe(403);
    expect(replayNewSession.json().error.code).toBe('PERMISSION_EXHAUSTED');

    // 12. Complete session 1 so device is free for next test
    const completeRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/events`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        events: [
          {
            clientEventId: 'ev_completed_1',
            eventType: 'SESSION_COMPLETED',
            occurredAtClientMs: Date.now(),
            localSessionId: 'local_android_sess_1',
            reason: 'Session 1 completed'
          }
        ]
      }
    });
    expect(completeRes.statusCode).toBe(200);

    // 13. Verify revoked permission prevents session acknowledgment
    // Create another proposal to test revocation check
    const prop2Res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proposals',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        targetDeviceId: deviceB.deviceId,
        requestType: 'IMMEDIATE',
        sessionType: 'PARTNER_ARREST',
        goal: 'Revocation Test',
        durationMinutes: 30,
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'BLOCK_SELECTED',
          allowedCategories: ['CALLS'],
          overlayStatusBar: false,
          disableEmergencyExit: false
        }
      }
    });
    const prop2Id = prop2Res.json().proposal.proposalId as string;
    const approveProp2Res = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${prop2Id}/accept`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: { expectedRevisionNumber: 1, startImmediateSession: true }
    });
    const sess2Id = approveProp2Res.json().session.sessionId as string;
    const perm2Id = approveProp2Res.json().permission.permissionId as string;

    // Revoke the permission before starting
    const revokeRes = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/partner-permissions/${perm2Id}`,
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(revokeRes.statusCode).toBe(200);

    // Attempting to acknowledge session with revoked permission must be rejected
    const ackRevokedRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sess2Id}/acknowledge`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        outcome: 'STARTED',
        localSessionId: 'local_android_sess_2',
        localEngineState: 'ACTIVE'
      }
    });
    expect(ackRevokedRes.statusCode).toBe(403);
    expect(ackRevokedRes.json().error.code).toBe('PERMISSION_REVOKED');
  });
});
