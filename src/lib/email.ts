import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { env, isProd } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Transactional email via AWS SES. [GAP §7] SES chosen to stay in the AWS
 * ecosystem alongside S3. In non-production, if no AWS credentials are present
 * we log the email instead of sending, so local dev never needs real SES.
 */

const hasAwsCreds = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);

const ses = hasAwsCreds
  ? new SESv2Client({ region: env.AWS_REGION })
  : null;

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  if (!ses) {
    if (isProd) {
      // In production we must have a real transport configured.
      throw new Error('SES is not configured (missing AWS credentials) in production');
    }
    logger.info({ to: msg.to, subject: msg.subject }, '[dev email] (not actually sent)');
    logger.debug({ text: msg.text }, '[dev email] body');
    return;
  }

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: env.SES_FROM_EMAIL,
      Destination: { ToAddresses: [msg.to] },
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: msg.html, Charset: 'UTF-8' },
            Text: { Data: msg.text, Charset: 'UTF-8' },
          },
        },
      },
    }),
  );
}
