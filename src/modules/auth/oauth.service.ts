import { createRemoteJWKSet, jwtVerify } from 'jose';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { Errors } from '../../lib/errors.js';
import { issueSession, type LoginResult } from './auth.service.js';
import type { OAuthProvider } from '../../generated/prisma/enums.js';

/**
 * OAuth sign-in. [GAP §1] Google + Apple at MVP. We use the "verify ID token"
 * model: native/web clients obtain an ID token from the provider and POST it
 * here; the backend verifies the token's signature against the provider JWKS,
 * checks issuer + audience, then links or creates the account and issues the
 * same session a password login would. This works uniformly for web, iOS and
 * Android without a server redirect dance.
 */

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const APPLE_ISSUER = 'https://appleid.apple.com';

function audiences(csv?: string): string[] {
  return (csv ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

interface VerifiedIdentity {
  providerAccountId: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}

async function verifyGoogle(idToken: string): Promise<VerifiedIdentity> {
  const aud = audiences(env.GOOGLE_OAUTH_CLIENT_IDS);
  if (aud.length === 0) throw Errors.badRequest('Google sign-in is not configured');
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: GOOGLE_ISSUERS,
    audience: aud,
  }).catch(() => {
    throw Errors.unauthorized('Invalid Google token');
  });
  return {
    providerAccountId: String(payload.sub),
    email: payload.email as string | undefined,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: payload.name as string | undefined,
  };
}

async function verifyApple(idToken: string): Promise<VerifiedIdentity> {
  const aud = audiences(env.APPLE_OAUTH_CLIENT_IDS);
  if (aud.length === 0) throw Errors.badRequest('Apple sign-in is not configured');
  const { payload } = await jwtVerify(idToken, APPLE_JWKS, {
    issuer: APPLE_ISSUER,
    audience: aud,
  }).catch(() => {
    throw Errors.unauthorized('Invalid Apple token');
  });
  return {
    providerAccountId: String(payload.sub),
    email: payload.email as string | undefined,
    // Apple marks verification as a string boolean.
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
  };
}

export async function signInWithProvider(
  provider: OAuthProvider,
  idToken: string,
  meta: { ip?: string; userAgent?: string },
): Promise<LoginResult> {
  const identity = provider === 'GOOGLE' ? await verifyGoogle(idToken)
    : provider === 'APPLE' ? await verifyApple(idToken)
    : (() => { throw Errors.badRequest('Unsupported OAuth provider'); })();

  // 1) Already linked? -> straight to session.
  const existingLink = await prisma.oAuthAccount.findUnique({
    where: { provider_providerAccountId: { provider, providerAccountId: identity.providerAccountId } },
    include: { user: true },
  });
  if (existingLink) {
    return issueSession(existingLink.user, meta);
  }

  // 2) Otherwise, match by verified email or create a fresh account, and link.
  const email = identity.email?.toLowerCase();
  const user = await prisma.$transaction(async (tx) => {
    let u = email ? await tx.user.findFirst({ where: { email, deletedAt: null } }) : null;

    if (!u) {
      if (!email) throw Errors.badRequest('Provider did not return an email; cannot create an account');
      u = await tx.user.create({
        data: {
          email,
          fullName: identity.name ?? email.split('@')[0] ?? 'User',          // OAuth-verified emails satisfy the [GAP §1] mandatory-verification rule.
          emailVerifiedAt: identity.emailVerified ? new Date() : null,
          isFamilyUser: true,
          vault: { create: {} },
        },
      });
    } else if (!u.emailVerifiedAt && identity.emailVerified) {
      u = await tx.user.update({ where: { id: u.id }, data: { emailVerifiedAt: new Date() } });
    }

    await tx.oAuthAccount.create({
      data: { userId: u.id, provider, providerAccountId: identity.providerAccountId },
    });
    return u;
  });

  return issueSession(user, meta);
}
