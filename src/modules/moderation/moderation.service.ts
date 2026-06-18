import { RekognitionClient, DetectModerationLabelsCommand } from '@aws-sdk/client-rekognition';
import { env, isProd } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Content moderation.
 *  - Text profanity: a local word-list screen (fast, zero-cost, deterministic),
 *    applied to guestbook entries and stories.
 *  - Image: AWS Rekognition DetectModerationLabels, applied ONLY to images that
 *    become publicly visible (memorial-page photos). Private vault content is
 *    never sent to Rekognition.
 *
 * Returning a structured result (not throwing) lets callers decide whether to
 * block, queue for human review, or surface the reason to the author.
 */

export interface ModerationResult {
  ok: boolean;
  reason?: string;
}

// A compact starter list; the product team can expand or externalize this.
const PROFANITY = [
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'bastard', 'dick', 'piss',
  'slut', 'whore', 'nigger', 'faggot', 'retard',
];

const PROFANITY_RE = new RegExp(`\\b(${PROFANITY.join('|')})\\b`, 'i');

/** Screen free-text (guestbook messages, story content). */
export function screenText(text: string): ModerationResult {
  if (PROFANITY_RE.test(text)) {
    return {
      ok: false,
      reason: 'Your message was blocked because it appears to contain profanity. Please revise and try again.',
    };
  }
  return { ok: true };
}

const hasAwsCreds = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
const rekognition = hasAwsCreds ? new RekognitionClient({ region: env.AWS_REGION }) : null;

// Rekognition top-level categories we treat as disqualifying for a public page.
const BLOCKED_CATEGORIES = ['Explicit Nudity', 'Sexual Activity', 'Violence', 'Visually Disturbing', 'Hate Symbols'];

/**
 * Screen a PUBLIC image (memorial-page photo) by S3 key via AWS Rekognition.
 * Reads the object straight from S3 (no proxying). If credentials are absent in
 * a non-production environment, screening is skipped (treated as clean) so local
 * dev never needs Rekognition; in production, missing config is a hard failure.
 */
export async function screenImage(s3Key: string): Promise<ModerationResult> {
  if (!rekognition) {
    if (isProd) throw new Error('Image moderation is not configured (missing AWS credentials) in production');
    logger.debug({ s3Key }, '[dev] skipping Rekognition image screen (no AWS creds)');
    return { ok: true };
  }

  const out = await rekognition.send(
    new DetectModerationLabelsCommand({
      Image: { S3Object: { Bucket: env.S3_BUCKET, Name: s3Key } },
      MinConfidence: env.REKOGNITION_MIN_CONFIDENCE,
    }),
  );

  const labels = out.ModerationLabels ?? [];
  const hit = labels.find((l) => {
    const top = l.ParentName && l.ParentName.length > 0 ? l.ParentName : l.Name;
    return top ? BLOCKED_CATEGORIES.includes(top) : false;
  });

  if (hit) {
    logger.info({ s3Key, label: hit.Name, confidence: hit.Confidence }, 'image blocked by moderation');
    return {
      ok: false,
      reason: 'This image was blocked by automated content moderation and cannot be published to a memorial page.',
    };
  }
  return { ok: true };
}
