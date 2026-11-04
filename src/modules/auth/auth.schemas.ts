import { z } from 'zod';

export const UsernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .transform((val) => val.toLowerCase())
  .refine((val) => /^[a-z0-9_]+$/.test(val), {
    message: 'Username may only contain lowercase letters, numbers, and underscores.'
  });

export const EmailSchema = z
  .string()
  .trim()
  .max(255)
  .transform((val) => val.toLowerCase())
  .pipe(z.string().email('Invalid email address format.'));

export const StrongPasswordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters.')
  .max(128, 'Password must not exceed 128 characters.')
  .refine((val) => /[A-Za-z]/.test(val) && /[0-9\W_]/.test(val), {
    message: 'Password must contain at least one letter and one number or symbol.'
  });

export const RegisterBodySchema = z.object({
  username: UsernameSchema,
  email: EmailSchema,
  password: StrongPasswordSchema,
  displayName: z.string().trim().min(1).max(80).optional()
});

export const LoginBodySchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(128),
  deviceId: z.string().uuid().optional()
});

export const RefreshBodySchema = z.object({
  refreshToken: z.string().trim().min(20).max(256)
});

export const LogoutBodySchema = z.object({
  refreshToken: z.string().trim().min(20).max(256)
});

export const ChangePasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: StrongPasswordSchema
});

export const AuthenticatedUserResponseSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  email: z.string().email(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  accountStatus: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastLoginAt: z.string().nullable()
});

export const AuthTokensResponseSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  expiresInSeconds: z.number().int(),
  refreshToken: z.string(),
  refreshTokenExpiresAt: z.string(),
  tokenType: z.literal('Bearer')
});

export const AuthSessionResponseSchema = z.object({
  user: AuthenticatedUserResponseSchema,
  tokens: AuthTokensResponseSchema
});
