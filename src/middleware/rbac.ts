import type { Request, Response, NextFunction } from 'express';
import { Errors } from '../lib/errors.js';
import type { PlatformRole } from '../generated/prisma/enums.js';

/** Require one of the given platform roles (ADMIN / SUPPORT_AGENT). [GAP §9] */
export function requirePlatformRole(...roles: PlatformRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(Errors.unauthorized());
    if (!roles.includes(req.auth.platformRole)) return next(Errors.forbidden());
    next();
  };
}

/**
 * Require that the caller is an ACTIVE guardian for the owner identified by the
 * `:ownerId` route param. Active = the owner is deceased and memorial mode is on.
 * This is the gate that unlocks guardian management rights. [Role_Docs][GAP §2]
 */
export function requireActiveGuardian(paramName = 'ownerId') {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(Errors.unauthorized());
    const raw = req.params[paramName];
    const ownerId = Array.isArray(raw) ? raw[0] : raw;
    if (!ownerId || !req.auth.guardianForActive.includes(ownerId)) {
      return next(Errors.forbidden('You are not an active guardian for this account'));
    }
    next();
  };
}
