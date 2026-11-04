import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../helpers/test-context';

describe('Partnerships & Delegated Arrest Permissions API', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness({
      initialTimeIso: '2026-11-04T10:00:00.000Z' // Wednesday 10:00 UTC
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('manages partnership invitations, rejects duplicates, accepts/rejects, and revokes permissions on block', async () => {
    const userA = await harness.registerAndLogin({
      username: 'partner_a',
      email: 'a@example.com'
    });
    const userB = await harness.registerAndLogin({
      username: 'owner_b',
      email: 'b@example.com'
    });
    const deviceB = await harness.registerDevice(userB.accessToken, {
      deviceName: 'User B Phone',
      fcmToken: 'fcm_user_b_token_1234567890123456'
    });

    // Self-invitation rejected
    const selfInvite = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partners/requests',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: { username: 'partner_a' }
    });
    expect(selfInvite.statusCode).toBe(400);

    // A invites B
    const inviteRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partners/requests',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: { username: 'OWNER_B' }
    });
    expect(inviteRes.statusCode).toBe(201);
    const partnershipId = inviteRes.json().partnership.id as string;
    // Public profile must never expose email
    expect(inviteRes.json().partnership.recipient.email).toBeUndefined();

    // Duplicate/conflicting reverse invite rejected
    const dupInvite = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partners/requests',
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: { username: 'partner_a' }
    });
    expect(dupInvite.statusCode).toBe(409);

    // Sender cannot self-accept their own outgoing invite
    const senderAccept = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/partners/requests/${partnershipId}/accept`,
      headers: { authorization: `Bearer ${userA.accessToken}` }
    });
    expect(senderAccept.statusCode).toBe(403);

    // B rejects first, then re-invites A, and A accepts
    const rejectRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/partners/requests/${partnershipId}/reject`,
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.json().partnership.state).toBe('REJECTED');

    const reinvite = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partners/requests',
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: { username: 'partner_a' }
    });
    expect(reinvite.statusCode).toBe(201);

    const acceptRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/partners/requests/${reinvite.json().partnership.id}/accept`,
      headers: { authorization: `Bearer ${userA.accessToken}` }
    });
    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.json().partnership.state).toBe('ACCEPTED');

    // Owner B grants delegated permission to Partner A
    const grantRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partner-permissions',
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: {
        partnerUserId: userA.userId,
        targetDeviceId: deviceB.deviceId,
        maximumSessionDuration: 60,
        expiresAt: '2026-11-11T10:00:00.000Z'
      }
    });
    expect(grantRes.statusCode).toBe(201);
    const permissionId = grantRes.json().permission.permissionId as string;

    // Blocking partner immediately revokes delegated permissions and blocks future invites
    const blockRes = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnershipId}/block`,
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(blockRes.statusCode).toBe(200);
    expect(blockRes.json().partnership.state).toBe('BLOCKED');

    const permCheck = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/partner-permissions/${permissionId}`,
      headers: { authorization: `Bearer ${userB.accessToken}` }
    });
    expect(permCheck.json().permission.revokedAt).not.toBeNull();
    expect(permCheck.json().permission.isCurrentlyActive).toBe(false);

    const blockedInvite = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partners/requests',
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: { username: 'owner_b' }
    });
    expect(blockedInvite.statusCode).toBe(403);
  });

  it('strictly enforces delegated permission ownership, expiration, revocation, device scope, and session limits', async () => {
    const partnerA = await harness.registerAndLogin({
      username: 'trusted_partner',
      email: 'partner@example.com'
    });
    const ownerB = await harness.registerAndLogin({
      username: 'device_owner',
      email: 'owner@example.com'
    });
    const strangerC = await harness.registerAndLogin({
      username: 'stranger_c',
      email: 'stranger@example.com'
    });

    const deviceB1 = await harness.registerDevice(ownerB.accessToken, {
      deviceName: 'Owner Primary Phone'
    });
    const deviceB2 = await harness.registerDevice(ownerB.accessToken, {
      deviceName: 'Owner Secondary Tablet'
    });

    // Cannot grant permission without an accepted partnership
    const prematureGrant = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partner-permissions',
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        partnerUserId: partnerA.userId,
        targetDeviceId: deviceB1.deviceId,
        maximumSessionDuration: 60,
        expiresAt: '2026-11-11T10:00:00.000Z'
      }
    });
    expect(prematureGrant.statusCode).toBe(403);
    expect(prematureGrant.json().error.code).toBe('PARTNERSHIP_REQUIRED');

    // Establish partnership A <-> B
    const inv = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partners/requests',
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { username: 'trusted_partner' }
    });
    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/partners/requests/${inv.json().partnership.id}/accept`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` }
    });

    // Unauthorized grant rejected: Partner A tries to grant themselves permission on Owner B's device!
    const forgedGrant = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partner-permissions',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        partnerUserId: strangerC.userId,
        targetDeviceId: deviceB1.deviceId,
        maximumSessionDuration: 60,
        expiresAt: '2026-11-11T10:00:00.000Z'
      }
    });
    expect(forgedGrant.statusCode).toBe(403);
    expect(forgedGrant.json().error.code).toBe('PERMISSION_SCOPE_MISMATCH');

    // Owner B creates scoped permission on deviceB1 (max 45m, BLOCK_SELECTED only, emergency exit required)
    const validGrant = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partner-permissions',
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: {
        partnerUserId: partnerA.userId,
        targetDeviceId: deviceB1.deviceId,
        maximumSessionDuration: 45,
        allowedSessionTypes: ['PARTNER_ARREST'],
        blockingConfigLimits: {
          schemaVersion: 1,
          allowedRuleModes: ['BLOCK_SELECTED'],
          allowDisableEmergencyExit: false,
          allowOverlayStatusBar: false,
          requiredAllowedCategories: ['CALLS', 'STUDY_APPS'],
          allowCustomPackageLists: false
        },
        expiresAt: '2026-11-05T10:00:00.000Z'
      }
    });
    expect(validGrant.statusCode).toBe(201);
    const permissionId = validGrant.json().permission.permissionId as string;

    // Partner A cannot silently escalate permission via PATCH
    const escalationTry = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/partner-permissions/${permissionId}`,
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: { maximumSessionDuration: 240 }
    });
    expect(escalationTry.statusCode).toBe(403);

    // Over-limit session duration rejected (60m > 45m)
    const overDuration = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB1.deviceId,
        authorizationId: permissionId,
        requestedDurationMinutes: 60,
        goal: 'Too long'
      }
    });
    expect(overDuration.statusCode).toBe(403);
    expect(overDuration.json().error.code).toBe('PERMISSION_LIMIT_EXCEEDED');

    // Unauthorized BlockingRuleMode (WHITELIST_ONLY) rejected
    const badRuleMode = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB1.deviceId,
        authorizationId: permissionId,
        requestedDurationMinutes: 30,
        goal: 'Study',
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'WHITELIST_ONLY',
          allowedCategories: ['CALLS', 'STUDY_APPS'],
          overlayStatusBar: false,
          disableEmergencyExit: false
        }
      }
    });
    expect(badRuleMode.statusCode).toBe(403);
    expect(badRuleMode.json().error.code).toBe('PERMISSION_LIMIT_EXCEEDED');

    // Unauthorized disableEmergencyExit: true rejected
    const badEmergencyFlag = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB1.deviceId,
        authorizationId: permissionId,
        requestedDurationMinutes: 30,
        goal: 'Study',
        blockingConfiguration: {
          schemaVersion: 1,
          ruleMode: 'BLOCK_SELECTED',
          allowedCategories: ['CALLS', 'STUDY_APPS'],
          overlayStatusBar: false,
          disableEmergencyExit: true
        }
      }
    });
    expect(badEmergencyFlag.statusCode).toBe(403);

    // Wrong target device (deviceB2 instead of deviceB1) rejected
    const wrongDevice = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${partnerA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB2.deviceId,
        authorizationId: permissionId,
        requestedDurationMinutes: 30,
        goal: 'Study'
      }
    });
    expect(wrongDevice.statusCode).toBe(403);
    expect(wrongDevice.json().error.code).toBe('PERMISSION_SCOPE_MISMATCH');

    // Advance clock past permission expiration -> refresh short-lived JWT first, then verify PERMISSION_EXPIRED
    harness.clock.advanceMs(25 * 60 * 60 * 1000);
    const refreshedA = (
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: partnerA.refreshToken }
      })
    ).json().tokens;
    const refreshedB = (
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: ownerB.refreshToken }
      })
    ).json().tokens;

    const expiredTry = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${refreshedA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB1.deviceId,
        authorizationId: permissionId,
        requestedDurationMinutes: 30,
        goal: 'Study'
      }
    });
    expect(expiredTry.statusCode).toBe(403);
    expect(expiredTry.json().error.code).toBe('PERMISSION_EXPIRED');

    // Revoked permission rejected
    const secondGrant = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/partner-permissions',
      headers: { authorization: `Bearer ${refreshedB.accessToken}` },
      payload: {
        partnerUserId: partnerA.userId,
        targetDeviceId: deviceB1.deviceId,
        maximumSessionDuration: 30,
        expiresAt: '2026-11-15T10:00:00.000Z'
      }
    });
    const secondPermId = secondGrant.json().permission.permissionId as string;

    await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/partner-permissions/${secondPermId}`,
      headers: { authorization: `Bearer ${refreshedB.accessToken}` }
    });

    const revokedTry = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${refreshedA.accessToken}` },
      payload: {
        sessionType: 'PARTNER_ARREST',
        targetDeviceId: deviceB1.deviceId,
        authorizationId: secondPermId,
        requestedDurationMinutes: 20,
        goal: 'Study'
      }
    });
    expect(revokedTry.statusCode).toBe(403);
    expect(revokedTry.json().error.code).toBe('PERMISSION_REVOKED');
  });
});
