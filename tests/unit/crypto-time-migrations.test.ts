import { describe, expect, it } from 'vitest';
import { parseEnvironment } from '../../src/config/environment';
import { loadMigrationFiles } from '../../src/database/migrator';
import { JwtService, ScryptPasswordHasher, safeCompareSecret } from '../../src/shared/crypto';
import { isWithinAllowedTimeWindows, toMysqlDateTime } from '../../src/shared/time';

describe('Cryptography, Time Windows, Environment & SQL Migrations', () => {
  it('hashes and verifies passwords with default OWASP scrypt parameters and rejects tampering', async () => {
    const hasher = new ScryptPasswordHasher();
    const encoded = await hasher.hash('CorrectHorseBattery#99');

    expect(encoded.startsWith('$scrypt$n=16384,r=8,p=1$')).toBe(true);
    expect(await hasher.verify('CorrectHorseBattery#99', encoded)).toBe(true);
    expect(await hasher.verify('WrongPassword#99', encoded)).toBe(false);
    expect(await hasher.verify('CorrectHorseBattery#99', '$argon2id$invalid')).toBe(false);
  });

  it('enforces HS256 JWT signing, expiration, issuer/audience, and blocks alg=none forgery', () => {
    const jwt = new JwtService({
      secret: 'unit_test_jwt_secret_value_at_least_32_bytes_long',
      issuer: 'arrestme-api',
      audience: 'arrestme-android',
      ttlSeconds: 900
    });

    const baseMs = Date.parse('2026-11-04T10:00:00.000Z');
    const signed = jwt.signAccessToken({ id: 'user-123', username: 'omar' }, baseMs);

    const claims = jwt.verifyAccessToken(signed.token, baseMs + 60_000);
    expect(claims.sub).toBe('user-123');
    expect(claims.username).toBe('omar');

    // Expired token rejected
    expect(() => jwt.verifyAccessToken(signed.token, baseMs + 900_000)).toThrow(
      /Access token has expired/
    );

    // Forged alg:none token rejected
    const forgedHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url'
    );
    const parts = signed.token.split('.');
    const forgedToken = `${forgedHeader}.${parts[1]}.`;
    expect(() => jwt.verifyAccessToken(forgedToken, baseMs)).toThrow();
  });

  it('evaluates allowed schedule time windows accurately across IANA timezones', () => {
    const schedule = {
      timezone: 'Africa/Cairo', // UTC+2 in November
      windows: [
        {
          daysOfWeek: [3], // Wednesday (2026-11-04 is Wednesday)
          startMinuteOfDay: 9 * 60, // 09:00 Cairo (07:00 UTC)
          endMinuteOfDay: 17 * 60 // 17:00 Cairo (15:00 UTC)
        }
      ]
    };

    expect(isWithinAllowedTimeWindows(new Date('2026-11-04T08:30:00.000Z'), schedule)).toBe(true);
    expect(isWithinAllowedTimeWindows(new Date('2026-11-04T06:30:00.000Z'), schedule)).toBe(false);
    expect(isWithinAllowedTimeWindows(new Date('2026-11-05T08:30:00.000Z'), schedule)).toBe(false);
  });

  it('validates production environment requirements without leaking secret values', () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'too_short'
      })
    ).toThrow(/JWT_ACCESS_SECRET/);

    expect(() =>
      parseEnvironment({
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'valid_32_byte_minimum_secret_for_production_env',
        FIREBASE_ENABLED: 'true'
      })
    ).toThrow(/MAINTENANCE_API_KEY/);

    expect(safeCompareSecret('abc', 'abc')).toBe(true);
    expect(safeCompareSecret('abc', 'def')).toBe(false);
    expect(toMysqlDateTime(new Date('2026-11-04T15:04:05.123Z'))).toBe('2026-11-04 15:04:05.123');
  });

  it('loads and parses 001_initial_schema.sql containing all required relational tables', async () => {
    const files = await loadMigrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(1);

    const initial = files[0]!;
    expect(initial.version).toBe('001_initial_schema');
    const joined = initial.statements.join('\n');

    for (const requiredTable of [
      'users',
      'devices',
      'refresh_tokens',
      'device_push_tokens',
      'partnerships',
      'partner_permissions',
      'arrest_sessions',
      'session_commands',
      'session_sync_events',
      'release_requests',
      'audit_logs'
    ]) {
      expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${requiredTable}`);
    }
  });
});
