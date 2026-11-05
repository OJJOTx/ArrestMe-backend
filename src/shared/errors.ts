export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_REFRESH_TOKEN'
  | 'REFRESH_TOKEN_EXPIRED'
  | 'REFRESH_TOKEN_REVOKED'
  | 'REFRESH_TOKEN_REUSED'
  | 'ACCOUNT_SUSPENDED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'USERNAME_ALREADY_TAKEN'
  | 'DEVICE_NOT_FOUND'
  | 'DEVICE_REVOKED'
  | 'PARTNERSHIP_NOT_FOUND'
  | 'PARTNERSHIP_CONFLICT'
  | 'PARTNERSHIP_BLOCKED'
  | 'PARTNERSHIP_REQUIRED'
  | 'SELF_ACTION_NOT_ALLOWED'
  | 'PERMISSION_NOT_FOUND'
  | 'PERMISSION_EXPIRED'
  | 'PERMISSION_REVOKED'
  | 'PERMISSION_NOT_YET_VALID'
  | 'PERMISSION_EXHAUSTED'
  | 'PERMISSION_LIMIT_EXCEEDED'
  | 'PERMISSION_TIME_WINDOW_RESTRICTED'
  | 'PERMISSION_SCOPE_MISMATCH'
  | 'ACTIVE_SESSION_EXISTS'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_INVALID_STATE'
  | 'SESSION_ALREADY_ENDED'
  | 'SESSION_EXPIRED'
  | 'COMMAND_NOT_FOUND'
  | 'COMMAND_EXPIRED'
  | 'COMMAND_INVALID_TRANSITION'
  | 'RELEASE_REQUEST_NOT_FOUND'
  | 'RELEASE_REQUEST_CONFLICT'
  | 'RELEASE_REQUEST_INVALID_STATE'
  | 'APPROVAL_REQUIRED'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_CONFLICT'
  | 'PROPOSAL_INVALID_STATE'
  | 'PROPOSAL_EXPIRED'
  | 'STALE_PROPOSAL_REVISION'
  | 'SCHEDULE_NOT_FOUND'
  | 'SCHEDULE_INVALID_STATE'
  | 'SCHEDULE_NOT_DUE_YET'
  | 'SCHEDULE_WINDOW_EXPIRED'
  | 'INVALID_SCHEDULE_TIME'
  | 'CONVERSATION_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'REQUEST_NOT_FOUND'
  | 'REQUEST_CONFLICT'
  | 'REQUEST_INVALID_STATE'
  | 'REQUEST_EXPIRED'
  | 'GRANT_NOT_FOUND'
  | 'UNAUTHORIZED_MODIFICATION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RATE_LIMIT_EXCEEDED'
  | 'PAYLOAD_TOO_LARGE'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_SERVER_ERROR';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  badRequest: (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
    new AppError(400, code, message, details),
  unauthorized: (code: ErrorCode = 'UNAUTHORIZED', message = 'Authentication is required.') =>
    new AppError(401, code, message),
  forbidden: (code: ErrorCode = 'FORBIDDEN', message = 'You do not have permission for this action.') =>
    new AppError(403, code, message),
  notFound: (code: ErrorCode = 'NOT_FOUND', message = 'Requested resource was not found.') =>
    new AppError(404, code, message),
  conflict: (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
    new AppError(409, code, message, details),
  unprocessable: (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
    new AppError(422, code, message, details),
  serviceUnavailable: (message = 'Service is temporarily unavailable.') =>
    new AppError(503, 'SERVICE_UNAVAILABLE', message)
};
