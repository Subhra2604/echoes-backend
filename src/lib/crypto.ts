import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * One-way hash for opaque tokens (email verification, guardian invites, page
 * invites). We store only the hash; the raw token is emailed once and never
 * persisted. SHA-256 is appropriate here because the tokens are high-entropy.
 */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Generate a URL-safe, high-entropy opaque token. */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

const ENC_KEY = Buffer.from(env.TOTP_ENC_KEY, 'hex'); // 32 bytes
const ENC_ALGO = 'aes-256-gcm';

/** Encrypt a TOTP secret for storage (returns iv:tag:ciphertext, hex). */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

export function decryptSecret(stored: string): string {
  const [ivHex, tagHex, dataHex] = stored.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Malformed encrypted secret');
  const decipher = crypto.createDecipheriv(ENC_ALGO, ENC_KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
