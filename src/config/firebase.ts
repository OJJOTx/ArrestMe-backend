import { cert, getApps, initializeApp, type App as FirebaseApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import type { AppEnvironment } from './environment';

export interface FcmSendRequest {
  token: string;
  data: Record<string, string>;
  ttlSeconds?: number;
  collapseKey?: string;
}

export type FcmSendOutcome =
  | { status: 'SENT'; messageId: string }
  | { status: 'INVALID_TOKEN'; errorCode: string; message: string }
  | { status: 'RETRYABLE_FAILURE'; errorCode: string; message: string }
  | { status: 'PERMANENT_FAILURE'; errorCode: string; message: string }
  | { status: 'DISABLED' };

export interface FcmTransport {
  readonly isEnabled: boolean;
  sendDataMessage(request: FcmSendRequest): Promise<FcmSendOutcome>;
}

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/mismatched-credential'
]);

const RETRYABLE_CODES = new Set([
  'messaging/unavailable',
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/quota-exceeded',
  'app/network-error',
  'app/network-timeout'
]);

export class FirebaseAdminTransport implements FcmTransport {
  public readonly isEnabled = true;
  private readonly messaging: Messaging;

  constructor(firebaseApp: FirebaseApp) {
    this.messaging = getMessaging(firebaseApp);
  }

  async sendDataMessage(request: FcmSendRequest): Promise<FcmSendOutcome> {
    const ttlMs = Math.max(30, Math.min(request.ttlSeconds ?? 300, 86400)) * 1000;

    try {
      const messageId = await this.messaging.send({
        token: request.token,
        data: request.data,
        android: {
          priority: 'high',
          ttl: ttlMs,
          ...(request.collapseKey ? { collapseKey: request.collapseKey } : {})
        }
      });
      return { status: 'SENT', messageId };
    } catch (err: unknown) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code: unknown }).code)
          : 'messaging/unknown-error';
      const message = err instanceof Error ? err.message : 'Unknown FCM error';

      if (
        INVALID_TOKEN_CODES.has(code) ||
        (code === 'messaging/invalid-argument' &&
          message.toLowerCase().includes('registration token'))
      ) {
        return { status: 'INVALID_TOKEN', errorCode: code, message };
      }

      if (RETRYABLE_CODES.has(code)) {
        return { status: 'RETRYABLE_FAILURE', errorCode: code, message };
      }

      return { status: 'PERMANENT_FAILURE', errorCode: code, message };
    }
  }
}

export class DisabledFcmTransport implements FcmTransport {
  public readonly isEnabled = false;

  async sendDataMessage(_request: FcmSendRequest): Promise<FcmSendOutcome> {
    return { status: 'DISABLED' };
  }
}

export function createFcmTransport(env: AppEnvironment): FcmTransport {
  if (!env.FIREBASE_ENABLED) {
    return new DisabledFcmTransport();
  }

  const appName = `arrestme-fcm-${env.FIREBASE_PROJECT_ID}`;
  const existing = getApps().find((a) => a.name === appName);
  const app =
    existing ??
    initializeApp(
      {
        credential: cert({
          projectId: env.FIREBASE_PROJECT_ID,
          clientEmail: env.FIREBASE_CLIENT_EMAIL,
          privateKey: env.normalizedFirebasePrivateKey
        })
      },
      appName
    );

  return new FirebaseAdminTransport(app);
}
