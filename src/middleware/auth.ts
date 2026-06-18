import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { Errors } from '../lib/errors.js';
import type { PlatformRole } from '../generated/prisma/enums.js';

export interface AuthContext {
  userId: string;
  tokenId: string;
  platformRole: PlatformRole;
  // ids of owners this user is an ACTIVE guardian for (memorial mode on).
  guardianForActive: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

interface JwtPayload {
  sub: string; // userId
  jti: string; // tokenId == Session.tokenId
}

/**
 * Verifies the bearer token AND the server-side session.
 *
 * [GAP §1] "TOKEN EXPIRES 60 MIN NO ACTIVITY / MUST LOG BACK IN."
 * We model this as an idle timeout on the Session row:
 *   - every authenticated request slides `lastActivityAt = now`
 *   - if the gap since the last activity exceeds SESSION_IDLE_TIMEOUT_MIN, or the
 *     absolute ceiling is passed, the session is dead -> 401, must log back in.
 * A fresh short-lived JWT is returned via the `x-refresh-token` header so the
 * client keeps a valid token as long as the user stays active.
 */
/**
 * Core resolver. Verifies the bearer token + server-side session, enforces the
 * idle/absolute timeouts, slides the activity window, and returns the auth
 * context plus a freshly minted token. Throws AppError on any failure. Shared by
 * `requireAuth` (fails closed) and `optionalAuth` (swallows failures).
 */
async function resolveAuth(req: Request): Promise<{ auth: AuthContext; refreshedToken: string }> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Errors.unauthorized();
  const token = header.slice('Bearer '.length);

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch {
    throw Errors.unauthorized('Invalid or expired token');
  }

  const session = await prisma.session.findUnique({ where: { tokenId: payload.jti } });
  if (!session || session.revokedAt || session.userId !== payload.sub) {
    throw Errors.unauthorized('Session no longer valid');
  }

  const now = Date.now();
  const idleMs = env.SESSION_IDLE_TIMEOUT_MIN * 60_000;
  const idleExpired = now - session.lastActivityAt.getTime() > idleMs;
  const absoluteExpired = now > session.expiresAt.getTime();
  if (idleExpired || absoluteExpired) {
    await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    throw Errors.unauthorized('Session expired due to inactivity — please log in again');
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || user.deletedAt) throw Errors.unauthorized('Account not found');
  // [GAP §9] suspended accounts cannot authenticate until reinstated.
  if (user.suspendedAt) throw Errors.forbidden('This account has been suspended');
  // [GAP §1] email verification mandatory before account access.
  if (!user.emailVerifiedAt) throw Errors.forbidden('Email not verified');

  // Slide the session activity window.
  await prisma.session.update({ where: { id: session.id }, data: { lastActivityAt: new Date() } });

  // Resolve which owners this user is an ACTIVE guardian for.
  const activeGuardianships = await prisma.guardianInvitation.findMany({
    where: { guardianId: user.id, status: 'ACCEPTED', owner: { isDeceased: true } },
    select: { ownerId: true },
  });

  const auth: AuthContext = {
    userId: user.id,
    tokenId: session.tokenId,
    platformRole: user.platformRole,
    guardianForActive: activeGuardianships.map((g: { ownerId: string }) => g.ownerId),
  };

  // Hand the client a freshly minted token so its clock resets on activity.
  const refreshedToken = jwt.sign({ sub: user.id, jti: session.tokenId }, env.JWT_SECRET, {
    expiresIn: `${env.SESSION_IDLE_TIMEOUT_MIN}m`,
  });

  return { auth, refreshedToken };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { auth, refreshedToken } = await resolveAuth(req);
    req.auth = auth;
    res.setHeader('x-refresh-token', refreshedToken);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Best-effort auth for routes that are usable signed-out but richer signed-in
 * (e.g. signing a public guestbook, viewing a PUBLIC memorial page). If a valid
 * session is present, `req.auth` is populated; otherwise the request proceeds
 * anonymously. Never rejects on a missing/invalid token.
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.headers.authorization) return next();
    const { auth, refreshedToken } = await resolveAuth(req);
    req.auth = auth;
    res.setHeader('x-refresh-token', refreshedToken);
  } catch {
    // ignore — proceed unauthenticated
  }
  next();
}
