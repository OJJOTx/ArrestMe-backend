import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../helpers/test-context';

describe('V0.4 Advanced Partners, Approval Policies, Negotiations & Scheduled Arrests', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness({
      initialTimeIso: '2026-11-04T10:00:00.000Z' // Wednesday 10:00 UTC
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('satisfies all 12 V0.4 acceptance tests across two distinct accounts (partner discovery, directional approval policy, versioned negotiations, counteroffers, stale revision protection, exact configuration enforcement, standing authorizations, revocation, and self-arrest independence)', async () => {
    const userA = await harness.registerAndLogin({
      username: 'controller_a',
      email: 'controller_a@example.com'
    });
    const userB = await harness.registerAndLogin({
      username: 'owner_b',
      email: 'owner_b@example.com'
    });

    const deviceA = await harness.registerDevice(userA.accessToken, {
      deviceName: 'User A Pixel 8'
    });
    const deviceB = await harness.registerDevice(userB.accessToken, {
      deviceName: 'User B Galaxy S24',
      fcmToken: 'fcm_owner_b_device_token_1234567890123456'
    });

    // 1. Friend request works (including invite code discovery and invitation)
    const inviteCodeRes = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users/me/invite-code',
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(inviteCodeRes.statusCode).toBe(200);
    const bInviteCode = inviteCodeRes.json().inviteCode as string;
    expect(bInviteCode).toMatch(/^AM-[0-9A-F]{10}$/);

    const discoverRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/partners/discover?inviteCode=${encodeURIComponent(bInviteCode)}`,
      headers: { authorization: `Bearer ${userA.accessToken}` }
    });
    expect(discoverRes.statusCode).toBe(200);
    expect(discoverRes.json().found).toBe(true);
    expect(discoverRes.json().user.username).toBe('owner_b');
    expect(discoverRes.json().relationshipState).toBe('NONE');

    const sendInviteRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partners/requests',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: { inviteCode: bInviteCode }
    });
    expect(sendInviteRes.statusCode).toBe(201);
    const partnershipId = sendInviteRes.json().partnership.id as string;

    const acceptFriendRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/partners/requests/${partnershipId}/accept`,
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(acceptFriendRes.statusCode).toBe(200);
    expect(acceptFriendRes.json().partnership.state).toBe('ACCEPTED');

    // 2. Friendship alone does NOT grant Arrest authority
    const unauthorizedStart = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        requestedDurationMinutes: 30,
        goal: 'Attempt without authorization'
      }
    });
    expect(unauthorizedStart.statusCode).toBe(400);
    expect(unauthorizedStart.json().error.code).toBe('PERMISSION_NOT_FOUND');

    // 3. Approval required defaults to ON (TRUE) in both directions
    const profileRes = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/partners/${partnershipId}/profile`,
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(profileRes.statusCode).toBe(200);
    const profileB = profileRes.json().profile;
    expect(profileB.myApprovalPolicyForPartner.requireApprovalBeforeArrest).toBe(true);
    expect(profileB.partnerApprovalPolicyForMe.requireApprovalBeforeArrest).toBe(true);
    expect(profileB.permissionsGrantedToPartner).toHaveLength(0);

    // 10. Switching approval mode to FALSE does NOT silently create unlimited authority
    const toggleOffRes = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/partners/${partnershipId}/approval-policy`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: {
        requireApprovalBeforeArrest: false,
        notes: 'Testing switch without standing permission'
      }
    });
    expect(toggleOffRes.statusCode).toBe(200);
    expect(toggleOffRes.json().myApprovalPolicyForPartner.requireApprovalBeforeArrest).toBe(false);
    expect(
      toggleOffRes.json().myApprovalPolicyForPartner.activeStandingAuthorizationsCount
    ).toBe(0);

    const stillNoAuthority = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        requestedDurationMinutes: 30,
        goal: 'Still no standing permission'
      }
    });
    expect(stillNoAuthority.statusCode).toBe(400);
    expect(stillNoAuthority.json().error.code).toBe('PERMISSION_NOT_FOUND');

    // Switch requireApprovalBeforeArrest back to TRUE
    await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/partners/${partnershipId}/approval-policy`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: { requireApprovalBeforeArrest: true }
    });

    // 4. Partner A submits a one-time IMMEDIATE request proposal for Owner B's device
    const createProposalRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proposals',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        targetDeviceId: deviceB.deviceId,
        requestType: 'IMMEDIATE',
        sessionType: 'PARTNER_ARREST',
        goal: 'Evening Coding Sprint',
        durationMinutes: 90,
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'STRICT_ALLOWLIST',
          allowedCategories: ['CALLS', 'STUDY_APPS'],
          overlayStatusBar: true,
          disableEmergencyExit: true,
          blockedPackages: ['com.instagram.android', 'com.zhiliaoapp.musically'],
          allowedStudyPackages: ['com.anki.droid']
        },
        reason: 'Let us do 90 minutes strict focus'
      }
    });
    expect(createProposalRes.statusCode).toBe(201);
    const proposal1 = createProposalRes.json().proposal;
    expect(proposal1.currentRevision).toBe(1);
    expect(proposal1.status).toBe('PENDING');
    expect(proposal1.revisions).toHaveLength(1);

    // 6. Owner B makes a counteroffer (creates immutable Revision 2: 60 minutes, disableEmergencyExit = false)
    const counterRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${proposal1.proposalId}/counteroffer`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: {
        expectedRevisionNumber: 1,
        durationMinutes: 60,
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'STRICT_ALLOWLIST',
          allowedCategories: ['CALLS', 'STUDY_APPS'],
          overlayStatusBar: true,
          disableEmergencyExit: false,
          blockedPackages: ['com.instagram.android'],
          allowedStudyPackages: ['com.anki.droid']
        },
        reason: '60 minutes with emergency exit enabled works for me'
      }
    });
    expect(counterRes.statusCode).toBe(200);
    const countered = counterRes.json().proposal;
    expect(countered.currentRevision).toBe(2);
    expect(countered.status).toBe('COUNTEROFFERED');
    expect(countered.revisions).toHaveLength(2);
    expect(countered.revisions[0].revisionNumber).toBe(1);
    expect(countered.revisions[1].revisionNumber).toBe(2);

    // 7. Stale proposals cannot be accepted (attempting to accept Revision 1 when currentRevision is 2 fails with 409)
    const staleAcceptRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${proposal1.proposalId}/accept`,
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        expectedRevisionNumber: 1,
        startImmediateSession: false
      }
    });
    expect(staleAcceptRes.statusCode).toBe(409);
    expect(staleAcceptRes.json().error.code).toBe('STALE_PROPOSAL_REVISION');

    // Proposer of Revision 2 (User B) cannot self-accept their own counteroffer; recipient (User A) must accept
    const selfAcceptCounter = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${proposal1.proposalId}/accept`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: {
        expectedRevisionNumber: 2,
        startImmediateSession: false
      }
    });
    expect(selfAcceptCounter.statusCode).toBe(403);

    // 5 & 8. Recipient (User A) accepts Revision 2 (which Owner B proposed); approval stores exact approved configuration
    const acceptRev2Res = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${proposal1.proposalId}/accept`,
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        expectedRevisionNumber: 2,
        startImmediateSession: false
      }
    });
    expect(acceptRev2Res.statusCode).toBe(200);
    const approvedData = acceptRev2Res.json();
    expect(approvedData.proposal.status).toBe('APPROVED');
    expect(approvedData.proposal.approvedRevision).toBe(2);
    const exactPermId = approvedData.permission.permissionId as string;
    expect(approvedData.permission.oneTimeOnly).toBe(true);
    expect(approvedData.permission.exactBlockingConfiguration.durationMinutes).toBe(60);
    expect(
      approvedData.permission.exactBlockingConfiguration.blockingConfiguration.disableEmergencyExit
    ).toBe(false);

    // 8. Attempting to start a session with any deviation from the exact approved configuration is rejected!
    const deviatedSessionRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: exactPermId,
        requestedDurationMinutes: 45, // Deviation from exact 60m!
        goal: 'Evening Coding Sprint',
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'STRICT_ALLOWLIST',
          allowedCategories: ['CALLS', 'STUDY_APPS'],
          overlayStatusBar: true,
          disableEmergencyExit: false,
          blockedPackages: ['com.instagram.android'],
          allowedStudyPackages: ['com.anki.droid']
        }
      }
    });
    expect(deviatedSessionRes.statusCode).toBe(403);
    expect(deviatedSessionRes.json().error.code).toBe('PERMISSION_LIMIT_EXCEEDED');

    // Starting the session with the EXACT approved configuration succeeds even while requireApprovalBeforeArrest is TRUE
    const exactSessionRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: exactPermId,
        requestedDurationMinutes: 60,
        goal: 'Evening Coding Sprint',
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'STRICT_ALLOWLIST',
          allowedCategories: ['CALLS', 'STUDY_APPS'],
          overlayStatusBar: true,
          disableEmergencyExit: false,
          blockedPackages: ['com.instagram.android'],
          allowedStudyPackages: ['com.anki.droid']
        }
      }
    });
    expect(exactSessionRes.statusCode).toBe(201);
    const firstSessionId = exactSessionRes.json().session.sessionId as string;

    // Complete first session on Device B so we can test standing authorization next
    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${firstSessionId}/events`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        events: [
          {
            clientEventId: 'ev_complete_1',
            eventType: 'SESSION_COMPLETED',
            toEngineState: 'COMPLETED',
            occurredAtClientMs: harness.clock.nowMs()
          }
        ]
      }
    });

    // Subsequent sessions require another approval because the one-time authorization is now exhausted
    const reuseOneTimeRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: exactPermId,
        requestedDurationMinutes: 60,
        goal: 'Evening Coding Sprint',
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'STRICT_ALLOWLIST',
          allowedCategories: ['CALLS', 'STUDY_APPS'],
          overlayStatusBar: true,
          disableEmergencyExit: false,
          blockedPackages: ['com.instagram.android'],
          allowedStudyPackages: ['com.anki.droid']
        }
      }
    });
    expect(reuseOneTimeRes.statusCode).toBe(403);
    expect(reuseOneTimeRes.json().error.code).toBe('PERMISSION_EXHAUSTED');

    // 5. Rejecting a proposal works cleanly
    const propToReject = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proposals',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        targetDeviceId: deviceB.deviceId,
        requestType: 'IMMEDIATE',
        durationMinutes: 120,
        goal: 'Too long session'
      }
    });
    const rejectedRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${propToReject.json().proposal.proposalId}/reject`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: { expectedRevisionNumber: 1, reason: 'Busy right now' }
    });
    expect(rejectedRes.statusCode).toBe(200);
    expect(rejectedRes.json().proposal.status).toBe('REJECTED');

    // 9. Standing authorization supports pre-authorized starts within bounded limits & expiration
    const standingPropRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proposals',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        targetDeviceId: deviceB.deviceId,
        requestType: 'STANDING_AUTHORIZATION',
        sessionType: 'PARTNER_ARREST',
        goal: 'Standing Study Authorization',
        durationMinutes: 45,
        standingAuthorization: {
          expiresAtUtc: '2026-11-10T10:00:00.000Z',
          maximumSessionDuration: 45,
          blockingConfigLimits: {
            schemaVersion: 1,
            allowedRuleModes: ['BLOCK_SELECTED', 'STRICT_ALLOWLIST'],
            allowDisableEmergencyExit: false,
            allowOverlayStatusBar: true,
            requiredAllowedCategories: ['CALLS'],
            allowCustomPackageLists: true
          }
        }
      }
    });
    expect(standingPropRes.statusCode).toBe(201);
    const standingProposalId = standingPropRes.json().proposal.proposalId as string;

    const acceptStandingRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${standingProposalId}/accept`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: { expectedRevisionNumber: 1 }
    });
    expect(acceptStandingRes.statusCode).toBe(200);
    const standingPermId = acceptStandingRes.json().permission.permissionId as string;
    expect(acceptStandingRes.json().permission.oneTimeOnly).toBe(false);

    // Partner A starts a pre-authorized session under the standing authorization
    const preAuthStartRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: standingPermId,
        requestedDurationMinutes: 30,
        goal: 'Pre-authorized Afternoon Focus'
      }
    });
    expect(preAuthStartRes.statusCode).toBe(201);
    const preAuthSessionId = preAuthStartRes.json().session.sessionId as string;

    // Complete that session
    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${preAuthSessionId}/events`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: {
        deviceId: deviceB.deviceId,
        events: [
          {
            clientEventId: 'ev_complete_2',
            eventType: 'SESSION_COMPLETED',
            toEngineState: 'COMPLETED',
            occurredAtClientMs: harness.clock.nowMs()
          }
        ]
      }
    });

    // If Owner B switches requireApprovalBeforeArrest back to TRUE, standing authorization cannot start without per-session approval!
    await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/partners/${partnershipId}/approval-policy`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: { requireApprovalBeforeArrest: true }
    });

    const blockedByApprovalSwitch = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: standingPermId,
        requestedDurationMinutes: 25,
        goal: 'Blocked because approval is required again'
      }
    });
    expect(blockedByApprovalSwitch.statusCode).toBe(403);
    expect(blockedByApprovalSwitch.json().error.code).toBe('APPROVAL_REQUIRED');

    // Switch back to FALSE, then test 11. Revoked authorization prevents new remote sessions
    await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/partners/${partnershipId}/approval-policy`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: { requireApprovalBeforeArrest: false }
    });

    const revokeStandingRes = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/partner-permissions/${standingPermId}`,
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(revokeStandingRes.statusCode).toBe(200);
    expect(revokeStandingRes.json().permission.isCurrentlyActive).toBe(false);

    const revokedStartRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB.deviceId,
        authorizationId: standingPermId,
        requestedDurationMinutes: 25,
        goal: 'Should fail after revocation'
      }
    });
    expect(revokedStartRes.statusCode).toBe(403);
    expect(revokedStartRes.json().error.code).toBe('PERMISSION_REVOKED');

    // 12. Existing local Self Arrest remains functional for both accounts
    const selfArrestRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        sessionType: 'SELF_ARREST',
        targetDeviceId: deviceA.deviceId,
        requestedDurationMinutes: 25,
        goal: 'Personal Self Arrest'
      }
    });
    expect(selfArrestRes.statusCode).toBe(201);
    expect(selfArrestRes.json().session.sessionType).toBe('SELF_ARREST');
  });

  it('creates, approves, lists, and cancels SCHEDULED and RECURRING arrest proposals with UTC storage', async () => {
    const userA = await harness.registerAndLogin({
      username: 'sched_partner',
      email: 'sched_a@example.com'
    });
    const userB = await harness.registerAndLogin({
      username: 'sched_owner',
      email: 'sched_b@example.com'
    });
    const deviceB = await harness.registerDevice(userB.accessToken, {
      deviceName: 'Owner B Device'
    });

    const invite = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partners/requests',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: { username: 'sched_owner' }
    });
    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/partners/requests/${invite.json().partnership.id}/accept`,
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });

    // Submit SCHEDULED proposal
    const schedProp = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proposals',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: {
        targetDeviceId: deviceB.deviceId,
        requestType: 'SCHEDULED',
        sessionType: 'PARTNER_ARREST',
        goal: 'Morning Deep Work',
        durationMinutes: 60,
        schedule: {
          localDate: '2026-11-05',
          localStartTime: '09:00',
          localEndTime: '10:00',
          timezone: 'America/New_York' // EST (UTC-5) -> 14:00:00.000Z
        }
      }
    });
    expect(schedProp.statusCode).toBe(201);
    expect(
      schedProp.json().proposal.normalizedConfiguration.schedule.scheduledStartUtc
    ).toBe('2026-11-05T14:00:00.000Z');

    const acceptSched = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${schedProp.json().proposal.proposalId}/accept`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: { expectedRevisionNumber: 1 }
    });
    expect(acceptSched.statusCode).toBe(200);
    expect(acceptSched.json().schedule).not.toBeNull();
    expect(acceptSched.json().schedule.scheduleType).toBe('SCHEDULED');
    expect(acceptSched.json().schedule.nextOccurrenceAt).toBe('2026-11-05T14:00:00.000Z');

    // Submit RECURRING proposal from Owner B to Partner A
    const recProp = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proposals',
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: {
        targetDeviceId: deviceB.deviceId,
        partnerUserId: userA.userId,
        requestType: 'RECURRING',
        sessionType: 'PARTNER_ARREST',
        goal: 'Weekday Morning Routine',
        durationMinutes: 45,
        recurrence: {
          daysOfWeek: [1, 2, 3, 4, 5],
          localStartTime: '08:00',
          localEndTime: '08:45',
          durationMinutes: 45,
          timezone: 'UTC',
          endDate: '2026-12-31',
          maxOccurrences: 20
        }
      }
    });
    expect(recProp.statusCode).toBe(201);

    const acceptRec = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${recProp.json().proposal.proposalId}/accept`,
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: { expectedRevisionNumber: 1 }
    });
    expect(acceptRec.statusCode).toBe(200);
    const recScheduleId = acceptRec.json().schedule.scheduleId as string;
    expect(acceptRec.json().schedule.scheduleType).toBe('RECURRING');
    expect(acceptRec.json().schedule.nextOccurrenceAt).toBe('2026-11-05T08:00:00.000Z');

    // List scheduled arrests
    const listSched = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/scheduled-arrests',
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(listSched.statusCode).toBe(200);
    expect(listSched.json().total).toBe(2);

    // Cancel recurring schedule and verify linked permission is revoked
    const cancelSched = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/scheduled-arrests/${recScheduleId}/cancel`,
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(cancelSched.statusCode).toBe(200);
    expect(cancelSched.json().schedule.status).toBe('REVOKED');
  });
});
