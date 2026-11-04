import { describe, expect, it } from 'vitest';
import { createMysqlPool } from '../../src/config/database';
import { parseEnvironment } from '../../src/config/environment';
import { runPendingMigrations } from '../../src/database/migrator';
import { MysqlDataStore } from '../../src/database/mysql-datastore';
import { createTestHarness } from '../helpers/test-context';

const runMysqlSuite = process.env.TEST_WITH_MYSQL === 'true';

describe.skipIf(!runMysqlSuite)('MySQL 8 Live Repository & Migration Integration', () => {
  it('applies SQL migrations idempotently and executes end-to-end Partner Arrest workflow against MySQL 8', async () => {
    const env = parseEnvironment({
      ...process.env,
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET:
        process.env.JWT_ACCESS_SECRET ?? 'mysql_test_access_secret_minimum_32_characters',
      MAINTENANCE_API_KEY:
        process.env.MAINTENANCE_API_KEY ?? 'mysql_test_maintenance_secret_minimum_32_chars'
    });

    const pool = createMysqlPool(env);
    const mig1 = await runPendingMigrations(pool);
    expect(mig1.applied.length + mig1.skipped.length).toBeGreaterThanOrEqual(1);

    const mig2 = await runPendingMigrations(pool);
    expect(mig2.applied).toHaveLength(0);

    const mysqlStore = new MysqlDataStore(pool);
    const suffix = Date.now().toString(36);
    const harness = await createTestHarness({ store: mysqlStore });

    try {
      const pA = await harness.registerAndLogin({
        username: `mpa_${suffix}`,
        email: `mpa_${suffix}@example.com`
      });
      const oB = await harness.registerAndLogin({
        username: `mob_${suffix}`,
        email: `mob_${suffix}@example.com`
      });
      const devB = await harness.registerDevice(oB.accessToken, {
        installationId: `mysql-inst-${suffix}`,
        fcmToken: `mysql_fcm_token_${suffix}_1234567890`
      });

      const inv = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/partners/requests',
        headers: { authorization: `Bearer ${oB.accessToken}` },
        payload: { username: pA.username }
      });
      expect(inv.statusCode).toBe(201);

      await harness.app.inject({
        method: 'POST',
        url: `/api/v1/partners/requests/${inv.json().partnership.id}/accept`,
        headers: { authorization: `Bearer ${pA.accessToken}` }
      });

      const perm = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/partner-permissions',
        headers: { authorization: `Bearer ${oB.accessToken}` },
        payload: {
          partnerUserId: pA.userId,
          targetDeviceId: devB.deviceId,
          maximumSessionDuration: 45,
          expiresAt: '2026-12-01T00:00:00.000Z'
        }
      });
      expect(perm.statusCode).toBe(201);

      const sess = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: { authorization: `Bearer ${pA.accessToken}` },
        payload: {
          sessionType: 'PARTNER_ARREST',
          targetDeviceId: devB.deviceId,
          authorizationId: perm.json().permission.permissionId,
          requestedDurationMinutes: 25,
          goal: 'MySQL 8 Verified Session'
        }
      });
      expect(sess.statusCode).toBe(201);

      const poll = await harness.app.inject({
        method: 'GET',
        url: `/api/v1/devices/${devB.deviceId}/commands`,
        headers: { authorization: `Bearer ${oB.accessToken}` }
      });
      expect(poll.statusCode).toBe(200);
      expect(poll.json().items).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
