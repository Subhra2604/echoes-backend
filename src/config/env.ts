import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  JWT_SECRET: z.string().min(16),
  SESSION_IDLE_TIMEOUT_MIN: z.coerce.number().default(60),
  SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().default(24),

  TOTP_ENC_KEY: z.string().length(64, 'TOTP_ENC_KEY must be 32 bytes (64 hex chars)'),

  // [GAP §1] OAuth = Google + Apple at MVP (Facebook optional). Comma-separated
  // allowed audiences (a mobile app + web typically use different client IDs).
  GOOGLE_OAUTH_CLIENT_IDS: z.string().optional(),
  APPLE_OAUTH_CLIENT_IDS: z.string().optional(),

  AWS_REGION: z.string(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().default('echoes-vault'),
  S3_SSE: z.string().default('AES256'),
  // Image moderation (AWS Rekognition) minimum confidence to block, 0–100.
  REKOGNITION_MIN_CONFIDENCE: z.coerce.number().min(0).max(100).default(80),
  SES_FROM_EMAIL: z.string().email().default('no-reply@echoes.example'),

  EULOGY_PROVIDER: z.enum(['ANTHROPIC', 'OPENAI', 'GOOGLE']).default('ANTHROPIC'),
  ANTHROPIC_API_KEY: z.string().optional(),
  EULOGY_MODEL: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Stripe Price IDs per paid subscription plan (from the Stripe dashboard).
  STRIPE_PRICE_BASIC: z.string().optional(),
  STRIPE_PRICE_FAMILY: z.string().optional(),
  STRIPE_PRICE_LEGACY_PREMIUM: z.string().optional(),

  MAX_CAPSULE_MEDIA_SECONDS: z.coerce.number().default(60),
  MAX_PHOTO_BYTES: z.coerce.number().default(52_428_800),
  GUARDIAN_INVITE_EXPIRY_DAYS: z.coerce.number().default(30),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast on misconfiguration rather than booting a half-working server.
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
