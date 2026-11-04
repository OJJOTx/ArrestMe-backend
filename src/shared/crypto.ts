import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual
} from 'node:crypto';
import { Errors } from './errors';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encodedHash: string): Promise<boolean>;
}

export interface ScryptOptions {
  cost?: number;
  blockSize?: number;
  parallelization?: number;
  keyLength?: number;
}

/**
 * Memory-hard OWASP-recommended scrypt password hasher using Node's built-in C/OpenSSL
 * implementation. Avoids native C++ addon (node-gyp) and WebAssembly LVE memory issues
 * on managed LiteSpeed/CloudLinux Node.js hosting while maintaining strong KDF security.
 */
export class ScryptPasswordHasher implements PasswordHasher {
  private readonly cost: number;
  private readonly blockSize: number;
  private readonly parallelization: number;
  private readonly keyLength: number;
  private readonly maxmem: number;

  constructor(options: ScryptOptions = {}) {
    this.cost = options.cost ?? 16384;
    this.blockSize = options.blockSize ?? 8;
    this.parallelization = options.parallelization ?? 1;
    this.keyLength = options.keyLength ?? 64;
    this.maxmem = Math.max(64 * 1024 * 1024, 256 * this.cost * this.blockSize);
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await this.deriveKey(
      password,
      salt,
      this.cost,
      this.blockSize,
      this.parallelization,
      this.keyLength,
      this.maxmem
    );

    const params = `n=${this.cost},r=${this.blockSize},p=${this.parallelization}`;
    return `$scrypt$${params}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  async verify(password: string, encodedHash: string): Promise<boolean> {
    const parts = encodedHash.split('$');
    if (parts.length !== 5 || parts[1] !== 'scrypt') {
      return false;
    }

    const paramSegment = parts[2] ?? '';
    const saltSegment = parts[3] ?? '';
    const digestSegment = parts[4] ?? '';

    const kv = Object.fromEntries(
      paramSegment.split(',').map((pair) => {
        const [k, v] = pair.split('=');
        return [k, Number(v)];
      })
    );

    const cost = kv.n;
    const blockSize = kv.r;
    const parallelization = kv.p;

    if (
      !cost ||
      !blockSize ||
      !parallelization ||
      !Number.isInteger(cost) ||
      cost < 1024 ||
      cost > 1048576 ||
      (cost & (cost - 1)) !== 0 ||
      blockSize < 1 ||
      blockSize > 32 ||
      parallelization < 1 ||
      parallelization > 16
    ) {
      return false;
    }

    const salt = Buffer.from(saltSegment, 'base64url');
    const expected = Buffer.from(digestSegment, 'base64url');
    if (salt.length < 8 || expected.length < 32) {
      return false;
    }

    const maxmem = Math.max(64 * 1024 * 1024, 256 * cost * blockSize);
    const derived = await this.deriveKey(
      password,
      salt,
      cost,
      blockSize,
      parallelization,
      expected.length,
      maxmem
    );

    if (derived.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(derived, expected);
  }

  private deriveKey(
    password: string,
    salt: Buffer,
    cost: number,
    blockSize: number,
    parallelization: number,
    keyLength: number,
    maxmem: number
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      scryptCallback(
        password.normalize('NFKC'),
        salt,
        keyLength,
        { N: cost, r: blockSize, p: parallelization, maxmem },
        (err, derivedKey) => {
          if (err) reject(err);
          else resolve(derivedKey);
        }
      );
    });
  }
}

export interface AccessTokenClaims {
  sub: string;
  username: string;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface JwtConfig {
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

/**
 * Standards-compliant RFC 7519 HS256 JWT service with strict algorithm pinning,
 * timing-safe HMAC verification, and zero external runtime dependencies.
 */
export class JwtService {
  private readonly secretKey: Buffer;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly ttlSeconds: number;

  constructor(config: JwtConfig) {
    if (config.secret.length < 32) {
      throw new Error('JWT secret must be at least 32 characters.');
    }
    this.secretKey = Buffer.from(config.secret, 'utf8');
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.ttlSeconds = config.ttlSeconds;
  }

  signAccessToken(
    user: { id: string; username: string },
    nowMs: number = Date.now()
  ): { token: string; expiresAt: Date; expiresInSeconds: number } {
    const iat = Math.floor(nowMs / 1000);
    const exp = iat + this.ttlSeconds;

    const header = { alg: 'HS256', typ: 'JWT' };
    const payload: AccessTokenClaims = {
      sub: user.id,
      username: user.username,
      jti: randomUUID(),
      iat,
      exp,
      iss: this.issuer,
      aud: this.audience
    };

    const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = createHmac('sha256', this.secretKey)
      .update(signingInput)
      .digest('base64url');

    return {
      token: `${signingInput}.${signature}`,
      expiresAt: new Date(exp * 1000),
      expiresInSeconds: this.ttlSeconds
    };
  }

  verifyAccessToken(token: string, nowMs: number = Date.now()): AccessTokenClaims {
    const segments = token.split('.');
    if (segments.length !== 3) {
      throw Errors.unauthorized('UNAUTHORIZED', 'Malformed access token.');
    }

    const [encodedHeader, encodedPayload, encodedSig] = segments as [string, string, string];
    if (!encodedHeader || !encodedPayload || !encodedSig) {
      throw Errors.unauthorized('UNAUTHORIZED', 'Malformed access token.');
    }

    let header: unknown;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    } catch {
      throw Errors.unauthorized('UNAUTHORIZED', 'Invalid token header.');
    }

    if (
      typeof header !== 'object' ||
      header === null ||
      (header as Record<string, unknown>).alg !== 'HS256' ||
      (header as Record<string, unknown>).typ !== 'JWT'
    ) {
      throw Errors.unauthorized('UNAUTHORIZED', 'Unsupported token algorithm.');
    }

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const expectedSig = createHmac('sha256', this.secretKey).update(signingInput).digest();
    const actualSig = Buffer.from(encodedSig, 'base64url');

    if (expectedSig.length !== actualSig.length || !timingSafeEqual(expectedSig, actualSig)) {
      throw Errors.unauthorized('UNAUTHORIZED', 'Invalid access token signature.');
    }

    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
      throw Errors.unauthorized('UNAUTHORIZED', 'Invalid token payload.');
    }

    if (typeof claims !== 'object' || claims === null) {
      throw Errors.unauthorized('UNAUTHORIZED', 'Invalid token claims.');
    }

    const record = claims as Record<string, unknown>;
    if (
      typeof record.sub !== 'string' ||
      !record.sub ||
      typeof record.username !== 'string' ||
      typeof record.jti !== 'string' ||
      typeof record.iat !== 'number' ||
      typeof record.exp !== 'number' ||
      record.iss !== this.issuer ||
      record.aud !== this.audience
    ) {
      throw Errors.unauthorized('UNAUTHORIZED', 'Invalid token claims.');
    }

    const nowSec = Math.floor(nowMs / 1000);
    if (nowSec >= record.exp) {
      throw Errors.unauthorized('UNAUTHORIZED', 'Access token has expired.');
    }

    return record as unknown as AccessTokenClaims;
  }
}

export function generateOpaqueRefreshToken(): string {
  return `amrt_${randomBytes(48).toString('base64url')}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time secret comparison over fixed-length SHA-256 digests so string length
 * differences cannot leak via timing side-channels.
 */
export function safeCompareSecret(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const hashA = createHash('sha256').update(provided, 'utf8').digest();
  const hashB = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(hashA, hashB);
}
