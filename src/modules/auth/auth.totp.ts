import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { prisma } from '../../lib/prisma.js';
import { encryptSecret, decryptSecret } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';

/**
 * [GAP §1] MFA = Google Authenticator (TOTP). Flow:
 *   1. enrollTotp -> returns an otpauth URL + QR data URL; secret stored encrypted,
 *      totpEnabled stays false until the user proves possession.
 *   2. confirmTotp(code) -> verifies a code and flips totpEnabled = true.
 *   3. verifyTotpCode used at login.
 */
export async function enrollTotp(userId: string): Promise<{ otpauthUrl: string; qrDataUrl: string }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const secret = speakeasy.generateSecret({ name: `Echoes (${user.email})`, issuer: 'Echoes' });

  await prisma.user.update({
    where: { id: userId },
    data: { totpSecret: encryptSecret(secret.base32), totpEnabled: false },
  });

  const otpauthUrl = secret.otpauth_url!;
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
  return { otpauthUrl, qrDataUrl };
}

export async function confirmTotp(userId: string, code: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.totpSecret) throw Errors.badRequest('TOTP enrollment not started');
  if (!verify(user.totpSecret, code)) throw Errors.badRequest('Invalid authenticator code');
  await prisma.user.update({ where: { id: userId }, data: { totpEnabled: true } });
}

export function verify(encryptedSecret: string, code: string): boolean {
  return speakeasy.totp.verify({
    secret: decryptSecret(encryptedSecret),
    encoding: 'base32',
    token: code,
    window: 1, // allow +/- one 30s step for clock drift
  });
}
