import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_MAINTENANCE_KEY,
  createTestHarness,
  type TestHarness
} from '../helpers/test-context';

describe('Authentication, Health & Device Registration API', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('serves safe public health responses and protects readiness diagnostics', async () => {
    const h1 = await harness.app.inject({ method: 'GET', url: '/health' });
    expect(h1.statusCode).toBe(200);
    expect(h1.json()).toEqual({
      status: 'ok',
      service: 'ArrestMe API',
      version: '0.2.0'
    });
    expect(h1.headers['x-request-id']).toBeTruthy();

    const h2 = await harness.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(h2.statusCode).toBe(200);

    const unauthReady = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/health/ready'
    });
    expect(unauthReady.statusCode).toBe(401);

    const authReady = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/health/ready',
      headers: { 'x-maintenance-key': TEST_MAINTENANCE_KEY }
    });
    expect(authReady.statusCode).toBe(200);
    expect(authReady.json().database).toBe('reachable');

    harness.memoryStore!.setHealthy(false);
    const degraded = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/health/ready',
      headers: { 'x-maintenance-key': TEST_MAINTENANCE_KEY }
    });
    expect(degraded.statusCode).toBe(503);
  });

  it('registers users cleanly, normalizes identifiers, never leaks password hashes, and rejects duplicates', async () => {
    const reg = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        username: '  User_Alpha ',
        email: '  Alpha@Example.COM ',
        password: 'SuperSecure#Password1',
        displayName: 'Alpha'
      }
    });

    expect(reg.statusCode).toBe(201);
    const body = reg.json();
    expect(body.user.username).toBe('user_alpha');
    expect(body.user.email).toBe('alpha@example.com');
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.user.password_hash).toBeUndefined();
    expect(body.tokens.accessToken).toBeTruthy();
    expect(body.tokens.refreshToken).toMatch(/^amrt_/);

    // Duplicate email rejected
    const dupEmail = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        username: 'different_user',
        email: 'alpha@example.com',
        password: 'SuperSecure#Password1'
      }
    });
    expect(dupEmail.statusCode).toBe(409);
    expect(dupEmail.json().error.code).toBe('EMAIL_ALREADY_REGISTERED');

    // Duplicate username rejected
    const dupUser = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        username: 'USER_ALPHA',
        email: 'second@example.com',
        password: 'SuperSecure#Password1'
      }
    });
    expect(dupUser.statusCode).toBe(409);
    expect(dupUser.json().error.code).toBe('USERNAME_ALREADY_TAKEN');
  });

  it('rejects invalid login credentials generically and validates access tokens', async () => {
    await harness.registerAndLogin({
      username: 'nour',
      email: 'nour@example.com',
      password: 'ValidPassword!42'
    });

    const wrongPass = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nour@example.com', password: 'WrongPassword!42' }
    });
    expect(wrongPass.statusCode).toBe(401);
    expect(wrongPass.json().error.code).toBe('INVALID_CREDENTIALS');

    const unknownEmail = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'ValidPassword!42' }
    });
    expect(unknownEmail.statusCode).toBe(401);
    expect(unknownEmail.json().error.message).toBe(wrongPass.json().error.message);

    const validLogin = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'NOUR@example.com', password: 'ValidPassword!42' }
    });
    expect(validLogin.statusCode).toBe(200);
    const accessToken = validLogin.json().tokens.accessToken as string;

    const meRes = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().user.username).toBe('nour');

    const patchRes = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { displayName: 'Nour Updated' }
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().user.displayName).toBe('Nour Updated');
  });

  it('rotates refresh tokens, detects replay of rotated tokens (revoking family), and enforces logout/password change revocation', async () => {
    const user = await harness.registerAndLogin({
      username: 'karim',
      email: 'karim@example.com',
      password: 'InitialPassword#10'
    });

    // Rotate once: R1 -> R2
    const refresh1 = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken }
    });
    expect(refresh1.statusCode).toBe(200);
    const rotatedTokenR2 = refresh1.json().tokens.refreshToken as string;
    expect(rotatedTokenR2).not.toBe(user.refreshToken);

    // Replay R1 -> triggers family reuse detection!
    const replayRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken }
    });
    expect(replayRes.statusCode).toBe(401);
    expect(replayRes.json().error.code).toBe('REFRESH_TOKEN_REUSED');

    // Now even R2 (in the compromised family) must be rejected!
    const afterCompromise = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: rotatedTokenR2 }
    });
    expect(afterCompromise.statusCode).toBe(401);
    expect(afterCompromise.json().error.code).toBe('REFRESH_TOKEN_REVOKED');

    // Fresh login + explicit logout revocation
    const freshLogin = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'karim@example.com', password: 'InitialPassword#10' }
    });
    const loginTokens = freshLogin.json().tokens;

    const logoutRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      payload: { refreshToken: loginTokens.refreshToken }
    });
    expect(logoutRes.statusCode).toBe(200);

    const postLogoutRefresh = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: loginTokens.refreshToken }
    });
    expect(postLogoutRefresh.statusCode).toBe(401);
    expect(postLogoutRefresh.json().error.code).toBe('REFRESH_TOKEN_REVOKED');

    // Password change revokes prior sessions
    const secondLogin = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'karim@example.com', password: 'InitialPassword#10' }
    });
    const sessionBeforePwChange = secondLogin.json().tokens;

    const pwChange = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { authorization: `Bearer ${sessionBeforePwChange.accessToken}` },
      payload: {
        currentPassword: 'InitialPassword#10',
        newPassword: 'UpdatedPassword#20'
      }
    });
    expect(pwChange.statusCode).toBe(200);

    const oldRefreshTry = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: sessionBeforePwChange.refreshToken }
    });
    expect(oldRefreshTry.statusCode).toBe(401);
  });

  it('enforces authentication rate limiting when enabled', async () => {
    const rateLimitedHarness = await createTestHarness({ enableRateLimit: true });
    try {
      let saw429 = false;
      for (let i = 0; i < 18; i++) {
        const res = await rateLimitedHarness.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'nobody@example.com', password: 'WrongPassword!1' }
        });
        if (res.statusCode === 429) {
          saw429 = true;
          expect(res.json().error.code).toBe('RATE_LIMIT_EXCEEDED');
          break;
        }
      }
      expect(saw429).toBe(true);
    } finally {
      await rateLimitedHarness.close();
    }
  });

  it('manages multi-device registration, push-token rotation, cross-account isolation, and revocation', async () => {
    const alice = await harness.registerAndLogin({
      username: 'alice',
      email: 'alice@example.com'
    });
    const bob = await harness.registerAndLogin({
      username: 'bob',
      email: 'bob@example.com'
    });

    const dev1 = await harness.registerDevice(alice.accessToken, {
      installationId: 'install-alice-phone-001',
      deviceName: 'Alice Pixel 9',
      fcmToken: 'fcm_token_initial_value_1234567890'
    });
    const dev2 = await harness.registerDevice(alice.accessToken, {
      installationId: 'install-alice-tablet-002',
      deviceName: 'Alice Galaxy Tab'
    });

    const listRes = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${alice.accessToken}` }
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().total).toBe(2);

    // Cross-account access rejected with 404
    const crossRead = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/devices/${dev1.deviceId}`,
      headers: { authorization: `Bearer ${bob.accessToken}` }
    });
    expect(crossRead.statusCode).toBe(404);

    // Rotate push token on dev1
    const rotatePush = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${dev1.deviceId}/push-token`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { fcmToken: 'fcm_token_rotated_value_0987654321' }
    });
    expect(rotatePush.statusCode).toBe(200);

    const tokensSnapshot = harness.memoryStore!.getPushTokensSnapshot();
    const activeForDev1 = tokensSnapshot.filter(
      (t) => t.deviceId === dev1.deviceId && t.tokenStatus === 'ACTIVE'
    );
    expect(activeForDev1).toHaveLength(1);
    expect(activeForDev1[0]?.fcmToken).toBe('fcm_token_rotated_value_0987654321');

    // Revoke dev2
    const revokeRes = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${dev2.deviceId}`,
      headers: { authorization: `Bearer ${alice.accessToken}` }
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json().device.deviceStatus).toBe('REVOKED');
  });
});
