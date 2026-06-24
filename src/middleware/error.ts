import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Wrap async handlers so thrown/rejected errors reach the error middleware.
 *
 * The handler's `req.params` is typed as a record of validated values. Every
 * route runs the `validate` middleware first, which parses and coerces params
 * with Zod, so by the time a handler reads `req.params.pageId` it is guaranteed
 * present. (Express 5 would otherwise type params as `string | string[]`, and
 * `noUncheckedIndexedAccess` would add `undefined`, forcing a cast everywhere.)
 */
export function asyncHandler(
  fn: (req: Request<Record<string, any>>, res: Response, next: NextFunction) => unknown,
): RequestHandler {
  return (req, res, next) =>
    Promise.resolve(fn(req as unknown as Request<Record<string, any>>, res, next)).catch(next);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}
