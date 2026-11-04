import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { parseEnvironment } from '../../src/config/environment';
import type { FcmSendOutcome, FcmSendRequest, FcmTransport } from '../../src/config/firebase';
import { InMemoryDataStore } from '../../src/database/memory-datastore';
import { ScryptPasswordHasher } from '../../src/shared/crypto';
import { ManualClock } from '../../src/shared/time';
import type { DataStore } from '../../src/types/repositories';

export class FakeFcmTransport implements FcmTransport {
  public isEnabled = true;
  public readonly sentMessages: FcmSendRequest[] = [];
  private nextOutcomes: FcmSendOutcome[] = [];
  private invalidTokens = new Set<string>();
  private messageCounter = 1;

  queueOutcome(outcome: FcmSendOutcome): void {
    this.nextOutcomes.push(outcome);
  }

  markTokenAsUnregisteredOnFcm(token: string): void {
    this.invalidTokens.add(token);
  }

  async sendDataMessage(request: FcmSendRequest): Promise<FcmSendOutcome> {
    if (!this.isEnabled) {
      return { status: 'DISABLED' };
    }

    this.sentMessages.push(structuredClone(request));

    if (this.invalidTokens.has(request.token)) {
      return {
        status: 'INVALID_TOKEN',
        errorCode: 'messaging/registration-token-not-registered',
        message: 'Requested entity was not found.'
      };
    }

    const queued = this.nextOutcomes.shift();
    if (queued) {
      return queued;
    }

    return {
      status: 'SENT',
      messageId: `projects/arrestme-test/messages/msg-${this.messageCounter++}`
    };
  }
}

export const TEST_MAINTENANCE_KEY = 'test_maintenance_secret_key_minimum_32_chars_long';
export const TEST_JWT_SECRET = 'test_jwt_access_secret_key_minimum_32_characters_long';

export interface TestHarness {
  app: FastifyInstance;
  store: DataStore;
  memoryStore?: InMemoryDataStore;
  clock: ManualClock;
  fcm: FakeFcmTransport;
  registerAndLogin(params: {
    username: string;
    email: string;
    password?: string;
    displayName?: string;
  }): Promise<{
    userId: string;
    username: string;
    email: string;
    accessToken: string;
    refreshToken: string;
  }>;
  registerDevice(
    accessToken: string,
    overrides?: Partial<{
      installationId: string;
      deviceName: string;
      appVersion: string;
      androidVersion: string;
      fcmToken: string;
    }>
  ): Promise<{
    deviceId: string;
    deviceName: string;
  }>;
  close(): Promise<void>;
}

export async function createTestHarness(options?: {
  store?: DataStore;
  enableRateLimit?: boolean;
  initialTimeIso?: string;
}): Promise<TestHarness> {
  const clock = new ManualClock(
    new Date(options?.initialTimeIso ?? '2026-11-04T12:00:00.000Z')
  );
  const memoryStore = options?.store ? undefined : new InMemoryDataStore();
  const store = options?.store ?? memoryStore!;
  const fcm = new FakeFcmTransport();

  // Lightweight scrypt cost (1024) keeps integration suite fast while exercising real KDF code
  const fastHasher = new ScryptPasswordHasher({
    cost: 1024,
    blockSize: 8,
    parallelization: 1,
    keyLength: 64
  });

  const env = parseEnvironment({
    NODE_ENV: 'test',
    PORT: '3000',
    LOG_LEVEL: 'silent',
    APP_VERSION: '0.2.0',
    JWT_ACCESS_SECRET: TEST_JWT_SECRET,
    MAINTENANCE_API_KEY: TEST_MAINTENANCE_KEY,
    ACCESS_TOKEN_TTL_SECONDS: '900',
    REFRESH_TOKEN_TTL_DAYS: '30',
    DEFAULT_COMMAND_TTL_SECONDS: '300',
    MAX_SESSION_DURATION_MINUTES: '720',
    FIREBASE_ENABLED: 'true',
    FIREBASE_PROJECT_ID: 'arrestme-test',
    FIREBASE_CLIENT_EMAIL: 'firebase-adminsdk@arrestme-test.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----'
  });

  const app = await buildApp({
    env,
    store,
    fcmTransport: fcm,
    clock,
    passwordHasher: fastHasher,
    enableRateLimit: options?.enableRateLimit ?? false,
    notificationRetryDelayMs: 0
  });

  await app.ready();

  return {
    app,
    store,
    memoryStore,
    clock,
    fcm,
    async registerAndLogin(params) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          username: params.username,
          email: params.email,
          password: params.password ?? 'StrongPass#2026',
          displayName: params.displayName ?? params.username
        }
      });
      if (res.statusCode !== 201) {
        throw new Error(`Expected 201 on registerAndLogin, got ${res.statusCode}: ${res.body}`);
      }
      const body = res.json();
      return {
        userId: body.user.id,
        username: body.user.username,
        email: body.user.email,
        accessToken: body.tokens.accessToken,
        refreshToken: body.tokens.refreshToken
      };
    },
    async registerDevice(accessToken, overrides = {}) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/devices',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          installationId: overrides.installationId,
          deviceName: overrides.deviceName ?? 'Pixel 8 Pro',
          platform: 'ANDROID',
          manufacturer: 'Google',
          model: 'Pixel 8 Pro',
          appVersion: overrides.appVersion ?? '0.2.0',
          androidVersion: overrides.androidVersion ?? '15',
          sdkInt: 35,
          fcmToken: overrides.fcmToken
        }
      });
      if (res.statusCode !== 201 && res.statusCode !== 200) {
        throw new Error(`Expected 201/200 on registerDevice, got ${res.statusCode}: ${res.body}`);
      }
      const body = res.json();
      return {
        deviceId: body.device.id,
        deviceName: body.device.deviceName
      };
    },
    async close() {
      await app.close();
      await store.close();
    }
  };
}
