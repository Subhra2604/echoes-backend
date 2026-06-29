import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { env, isProd } from '../config/env.js';
import { logger } from './logger.js';
import sgMail from '@sendgrid/mail';

// /**
//  * Transactional email via AWS SES. [GAP §7] SES chosen to stay in the AWS
//  * ecosystem alongside S3. In non-production, if no AWS credentials are present
//  * we log the email instead of sending, so local dev never needs real SES.
//  */

// const hasAwsCreds = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);

// const ses = hasAwsCreds
//   ? new SESv2Client({ region: env.AWS_REGION })
//   : null;

/**
 * Transactional email via SendGrid. In non-production, if no API key is present
 * we log the email instead of sending, so local dev never needs real SendGrid.
 */
const hasSendgrid = Boolean(env.SENDGRID_API_KEY);
if (hasSendgrid) sgMail.setApiKey(env.SENDGRID_API_KEY!);

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}


export async function sendEmail(msg: EmailMessage): Promise<void> {
  if (!hasSendgrid) {
    if (isProd) {
      throw new Error('SendGrid is not configured (missing SENDGRID_API_KEY) in production');
    }
    logger.info({ to: msg.to, subject: msg.subject }, '[dev email] (not actually sent)');
    logger.debug({ text: msg.text }, '[dev email] body');
    return;
  }
console.log(JSON.stringify(msg, null, 2));
  try {
    console.log("detail from env",env.EMAIL_FROM,env.EMAIL_FROM_NAME)
    await sgMail.send({
      to: msg.to,
      from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME },
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
  }
  catch (error: any) {
    const message =
      error?.response?.body?.errors?.[0]?.message ||
      error?.message ||
      "Failed to send email";

    console.error(message);

    throw new Error(message);
  }
}
