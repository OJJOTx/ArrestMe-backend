import { describe, expect, it } from 'vitest';
import { parseEnvironment } from '../../src/config/environment';
import { loadMigrationFiles } from '../../src/database/migrator';
import { JwtService, ScryptPasswordHasher, safeCompareSecret } from '../../src/shared/crypto';
import {
  computeNextRecurrenceUtc,
  isWithinAllowedTimeWindows,
  resolveLocalDateTimeToUtc,
  toMysqlDateTime
} from '../../src/shared/time';

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

    const v04 = files.find((f) => f.version === '002_v04_partners_proposals_schedules');
    expect(v04).toBeDefined();
    const v04Joined = v04!.statements.join('\n');
    for (const v04Table of [
      'partner_approval_policies',
      'arrest_proposals',
      'arrest_proposal_revisions',
      'scheduled_arrests'
    ]) {
      expect(v04Joined).toContain(`CREATE TABLE IF NOT EXISTS ${v04Table}`);
    }

    const v06 = files.find((f) => f.version === '004_v06_chat_and_structured_requests');
    expect(v06).toBeDefined();
    const v06Joined = v06!.statements.join('\n');
    for (const v06Table of [
      'conversations',
      'conversation_members',
      'messages',
      'structured_requests',
      'temporary_app_access_grants',
      'session_rule_revisions'
    ]) {
      expect(v06Joined).toContain(`CREATE TABLE IF NOT EXISTS ${v06Table}`);
    }
    expect(v06Joined).toContain('REFERENCES arrest_sessions(session_id)');
    expect(v06Joined).toContain('ALTER TABLE session_commands');
    expect(v06Joined).not.toContain('REFERENCES arrest_sessions(id)');
    expect(v06Joined).not.toContain('ALTER TABLE commands ');
  });

  it('validates proposal revision response schema accepts both auto-increment strings and UUIDs', async () => {
    const { ProposalRevisionResponseSchema } = await import(
      '../../src/modules/proposals/proposals.schemas.js'
    );
    expect(ProposalRevisionResponseSchema.shape.id.safeParse('1').success).toBe(true);
    expect(ProposalRevisionResponseSchema.shape.id.safeParse('42').success).toBe(true);
    expect(
      ProposalRevisionResponseSchema.shape.id.safeParse('f47ac10b-58cc-4372-a567-0e02b2c3d479')
        .success
    ).toBe(true);
  });

  it('deterministically resolves DST transitions and recurring schedules across IANA timezones', () => {
    // Fall-back DST in America/New_York: 2026-11-01 01:30 occurs twice (EDT -04:00 = 05:30Z, EST -05:00 = 06:30Z)
    // Deterministic rule: selects the first occurrence (05:30:00.000Z)
    const fallBackUtc = resolveLocalDateTimeToUtc('2026-11-01', '01:30', 'America/New_York');
    expect(fallBackUtc.toISOString()).toBe('2026-11-01T05:30:00.000Z');

    // Spring-forward DST gap in America/New_York: 2026-03-08 02:30 jumps to 03:30 EDT (07:30:00.000Z)
    const springForwardUtc = resolveLocalDateTimeToUtc('2026-03-08', '02:30', 'America/New_York');
    expect(springForwardUtc.toISOString()).toBe('2026-03-08T07:30:00.000Z');

    // Recurring schedule across DST fall-back weekend
    const rule = {
      daysOfWeek: [0, 1], // Sunday & Monday
      localStartTime: '09:00',
      localEndTime: '10:00',
      durationMinutes: 60,
      timezone: 'America/New_York',
      endDate: '2026-11-15',
      maxOccurrences: 2
    };

    // Before Sunday 2026-11-01 (after fallback at 02:00, 09:00 is EST = UTC-5 -> 14:00Z)
    const occ1 = computeNextRecurrenceUtc(rule, new Date('2026-10-31T12:00:00.000Z'), 0);
    expect(occ1?.toISOString()).toBe('2026-11-01T14:00:00.000Z');

    // Next occurrence after Sunday 09:00 is Monday 2026-11-02 09:00 EST -> 14:00Z
    const occ2 = computeNextRecurrenceUtc(rule, occ1!, 1);
    expect(occ2?.toISOString()).toBe('2026-11-02T14:00:00.000Z');

    // Reached maxOccurrences = 2 -> returns null
    const occ3 = computeNextRecurrenceUtc(rule, occ2!, 2);
    expect(occ3).toBeNull();
  });
});
