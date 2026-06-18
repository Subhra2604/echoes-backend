/**
 * AppError — a typed, HTTP-aware error. Anything thrown that is an AppError is
 * rendered to the client with its status + code; everything else becomes a 500.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthorized: (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'You do not have permission to do that') => new AppError(403, 'FORBIDDEN', msg),
  notFound: (msg = 'Resource not found') => new AppError(404, 'NOT_FOUND', msg),
  conflict: (msg: string) => new AppError(409, 'CONFLICT', msg),
  badRequest: (msg: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details),
  gone: (msg: string) => new AppError(410, 'GONE', msg),
  payload: (msg: string) => new AppError(413, 'PAYLOAD_TOO_LARGE', msg),
  quota: (msg: string) => new AppError(402, 'QUOTA_EXCEEDED', msg),
  tooManyRequests: (msg: string) => new AppError(429, 'TOO_MANY_REQUESTS', msg),
};
