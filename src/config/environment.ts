import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const booleanFromString = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === '') return defaultValue;
      if (typeof val === 'boolean') return val;
      const normalized = val.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
      throw new Error(`Invalid boolean value: "${val}"`);
    });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().trim().min(1).default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    APP_VERSION: z.string().trim().min(1).default('0.2.0'),
    TRUST_PROXY: booleanFromString(true),
    CORS_ORIGINS: z.string().optional().default(''),

    DATABASE_HOST: z.string().trim().min(1).default('127.0.0.1'),
    DATABASE_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
    DATABASE_NAME: z.string().trim().min(1).default('arrestme'),
    DATABASE_USER: z.string().trim().min(1).default('root'),
    DATABASE_PASSWORD: z.string().default(''),
    DATABASE_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_SSL: booleanFromString(false),
    AUTO_MIGRATE_ON_STARTUP: booleanFromString(false),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ISSUER: z.string().trim().min(1).default('arrestme-api'),
    JWT_AUDIENCE: z.string().trim().min(1).default('arrestme-android'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

    DEFAULT_COMMAND_TTL_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
    MAX_SESSION_DURATION_MINUTES: z.coerce.number().int().min(5).max(1440).default(720),

    MAINTENANCE_API_KEY: z
      .string()
      .min(32, 'MAINTENANCE_API_KEY must be at least 32 characters')
      .optional(),

    FIREBASE_ENABLED: booleanFromString(false),
    FIREBASE_PROJECT_ID: z.string().optional().default(''),
    FIREBASE_CLIENT_EMAIL: z.string().optional().default(''),
    FIREBASE_PRIVATE_KEY: z.string().optional().default(''),

    ENABLE_SWAGGER_UI: booleanFromString(false)
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV === 'production' && !cfg.MAINTENANCE_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAINTENANCE_API_KEY'],
        message: 'MAINTENANCE_API_KEY is required in production'
      });
    }
    if (cfg.FIREBASE_ENABLED) {
      if (!cfg.FIREBASE_PROJECT_ID.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['FIREBASE_PROJECT_ID'],
          message: 'FIREBASE_PROJECT_ID is required when FIREBASE_ENABLED=true'
        });
      }
      if (!cfg.FIREBASE_CLIENT_EMAIL.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['FIREBASE_CLIENT_EMAIL'],
          message: 'FIREBASE_CLIENT_EMAIL is required when FIREBASE_ENABLED=true'
        });
      }
      if (!cfg.FIREBASE_PRIVATE_KEY.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['FIREBASE_PRIVATE_KEY'],
          message: 'FIREBASE_PRIVATE_KEY is required when FIREBASE_ENABLED=true'
        });
      }
    }
  });

export type AppEnvironment = z.infer<typeof envSchema> & {
  corsOriginList: string[];
  normalizedFirebasePrivateKey: string;
};

export function parseEnvironment(rawEnv: NodeJS.ProcessEnv = process.env): AppEnvironment {
  const result = envSchema.safeParse(rawEnv);
  if (!result.success) {
    const fieldSummary = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${fieldSummary}`);
  }

  const data = result.data;
  const corsOriginList = data.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    ...data,
    corsOriginList,
    normalizedFirebasePrivateKey: data.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  };
}
