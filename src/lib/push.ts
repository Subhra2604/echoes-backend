import { initializeApp, cert, type App } from 'firebase-admin/app';
import { getMessaging, type SendResponse } from 'firebase-admin/messaging';
import { env, isProd } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Push delivery via Firebase Cloud Messaging. Unlike email, push is always
 * best-effort fan-out — a missing/misconfigured provider or a send failure
 * must never break the in-app notification or the caller's request, so this
 * never throws.
 */

const hasFirebase = Boolean(env.FIREBASE_SERVICE_ACCOUNT_BASE64);

const app: App | null = hasFirebase
  ? initializeApp({
      credential: cert(
        JSON.parse(
          Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_BASE64!, 'base64').toString('utf8'),
        ),
      ),
    })
  : null;

if (!hasFirebase && isProd) {
  logger.warn('FIREBASE_SERVICE_ACCOUNT_BASE64 not set — push notifications are disabled');
}

export interface PushResult {
  /** Tokens FCM reported as dead (unregistered/invalid) — safe to delete. */
  invalidTokens: string[];
}

const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

export async function sendPush(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<PushResult> {
  if (tokens.length === 0) return { invalidTokens: [] };

  if (!app) {
    logger.debug({ tokens: tokens.length, title }, '[dev push] (Firebase not configured, not sent)');
    return { invalidTokens: [] };
  }

  // FCM data payloads must be flat string maps.
  const stringData = data
    ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]))
    : undefined;

  try {
    const result = await getMessaging(app).sendEachForMulticast({
      tokens,
      notification: { title, body },
      ...(stringData ? { data: stringData } : {}),
    });

    const invalidTokens: string[] = [];
    result.responses.forEach((r: SendResponse, i: number) => {
      if (!r.success && r.error && INVALID_TOKEN_CODES.has(r.error.code)) {
        invalidTokens.push(tokens[i]!);
      }
    });
    return { invalidTokens };
  } catch (err) {
    logger.error({ err }, 'push send failed');
    return { invalidTokens: [] };
  }
}
