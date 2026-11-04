import { z } from 'zod';
import { AuthenticatedUserResponseSchema } from '../auth/auth.schemas';

export const UpdateProfileBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    avatarUrl: z.string().trim().url().max(512).nullable().optional()
  })
  .refine((data) => data.displayName !== undefined || data.avatarUrl !== undefined, {
    message: 'At least one profile field must be provided.'
  });

export const CurrentUserResponseSchema = z.object({
  user: AuthenticatedUserResponseSchema
});

export const InviteCodeResponseSchema = z.object({
  inviteCode: z.string()
});
