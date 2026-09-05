import { SignJWT, importPKCS8 } from 'jose';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Server-to-server calls to Apple's own OAuth endpoints.
 *
 * The `/auth/oauth/apple` login route only ever verifies an *identity token*
 * (a signed JWT) — that's enough to authenticate the user, but an identity
 * token is not an OAuth token and Apple will not let us revoke it. To be
 * able to revoke access later (required by App Store Review Guideline
 * 5.1.1(v) once an app offers account deletion), we additionally exchange
 * the one-time `authorizationCode` the iOS client receives alongside the
 * identity token for a refresh token, store that (encrypted), and revoke it
 * on account deletion.
 *
 * All of this is optional/best-effort: if the four APPLE_* server
 * credentials below aren't configured, or a call to Apple fails, sign-in
 * itself must not be affected — we just log and move on.
 *
 * Docs: https://developer.apple.com/documentation/sign_in_with_apple/generate_and_validate_tokens
 */

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

// Apple allows a client-secret JWT lifetime of up to ~6 months, but there's
// no reason to mint one that outlives the single request it's used for.
const CLIENT_SECRET_TTL_SECONDS = 5 * 60;

export function appleServerCredentialsConfigured(): boolean {
  return Boolean(
    env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY,
  );
}

/**
 * Apple's /auth/token and /auth/revoke endpoints authenticate the *server*
 * with a short-lived ES256 JWT ("client_secret") in place of a static
 * secret, signed with the private key from a "Sign in with Apple" key
 * generated in the Apple Developer portal.
 */
async function buildClientSecret(): Promise<string> {
  const pem = env.APPLE_PRIVATE_KEY!.replace(/\\n/g, '\n');
  const key = await importPKCS8(pem, 'ES256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID })
    .setIssuer(env.APPLE_TEAM_ID!)
    .setIssuedAt(now)
    .setExpirationTime(now + CLIENT_SECRET_TTL_SECONDS)
    .setAudience('https://appleid.apple.com')
    .setSubject(env.APPLE_CLIENT_ID!)
    .sign(key);
}

/**
 * Exchange the iOS client's one-time `authorizationCode` for a refresh
 * token. Returns null (and logs a warning) on any failure — this must
 * never be allowed to break login.
 */
export async function exchangeAppleAuthCode(
  authorizationCode: string,
): Promise<{ refreshToken: string } | null> {
  if (!appleServerCredentialsConfigured()) {
    logger.warn(
      'Apple server credentials (APPLE_CLIENT_ID/TEAM_ID/KEY_ID/PRIVATE_KEY) are not set; ' +
        'skipping auth-code exchange. Login still works, but this sign-in cannot be revoked ' +
        'server-side on account deletion.',
    );
    return null;
  }
  try {
    const clientSecret = await buildClientSecret();
    const res = await fetch(APPLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.APPLE_CLIENT_ID!,
        client_secret: clientSecret,
        code: authorizationCode,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, body: await res.text().catch(() => undefined) },
        'Apple auth-code exchange failed',
      );
      return null;
    }
    const data = (await res.json()) as { refresh_token?: string };
    return data.refresh_token ? { refreshToken: data.refresh_token } : null;
  } catch (err) {
    logger.warn({ err }, 'Apple auth-code exchange threw');
    return null;
  }
}

/**
 * Revoke a previously-stored Apple refresh token. Called on account
 * deletion. Best-effort: swallows and logs errors so a flaky call to Apple
 * never blocks a user from deleting their account.
 */
export async function revokeAppleRefreshToken(refreshToken: string): Promise<void> {
  if (!appleServerCredentialsConfigured()) return;
  try {
    const clientSecret = await buildClientSecret();
    const res = await fetch(APPLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.APPLE_CLIENT_ID!,
        client_secret: clientSecret,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Apple token revocation failed');
    }
  } catch (err) {
    logger.warn({ err }, 'Apple token revocation threw');
  }
}