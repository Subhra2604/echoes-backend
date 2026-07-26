import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { logger } from './lib/logger.js';
import { buildOpenApiDocument } from './openapi.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

import { authRouter } from './modules/auth/auth.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { guardiansRouter } from './modules/guardians/guardians.routes.js';
import { vaultRouter } from './modules/vault/vault.routes.js';
import { capsulesRouter } from './modules/capsules/capsules.routes.js';
import { memorialRouter } from './modules/memorial/memorial.routes.js';
import { eulogyRouter } from './modules/eulogy/eulogy.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { billingRouter } from './modules/billing/billing.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { uploadsRouter } from './modules/uploads/uploads.routes.js';
import { memoriesRouter } from './modules/memories/memories.routes.js';
import { recordingsRouter } from './modules/recordings/recordings.routes.js';
import { feedRouter } from './modules/feed/feed.routes.js';
import { contactsRouter } from './modules/contacts/contacts.routes.js';
import { groupsRouter } from './modules/groups/groups.routes.js';
const pino = require('pino');


export function createApp() {
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled so Swagger UI assets load; tighten per your CDN setup
  app.use(cors());
  // app.use(pinoHttp({ logger }));

  const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
});

app.use(pinoHttp({
  logger,
  // Don't log full req/res objects — just the essentials
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
  // Optional: only log slow/error requests, skip normal 200s entirely
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Optional: skip logging entirely for noisy routes like health checks
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/favicon.ico',
  },
}));

  // API documentation: raw OpenAPI 3 spec + interactive Swagger UI.
  const openApiDocument = buildOpenApiDocument();
  app.get('/openapi.json', (_req, res) => res.json(openApiDocument));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, { customSiteTitle: 'Echoes Remembered API' }));

  // The Stripe webhook needs the RAW body for signature verification, so the
  // global JSON parser must skip it. Its router installs its own raw() parser.
  app.use((req, res, next) => {
    if (req.originalUrl === '/api/billing/webhook') return next();
    express.json({ limit: '2mb' })(req, res, next);
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'echoes-backend' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/guardians', guardiansRouter);
  app.use('/api/vault', vaultRouter);
  app.use('/api/capsules', capsulesRouter);
  app.use('/api/memorial', memorialRouter);
  app.use('/api/eulogies', eulogyRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/admin', adminRouter);

  // ── Memories & Voice Recordings (shared presigned-S3 upload architecture) ──
  app.use('/api/uploads', uploadsRouter);
  app.use('/api/memories', memoriesRouter);
  app.use('/api/voice-recordings', recordingsRouter);
  app.use('/api/my-memories', feedRouter);

  // ── Contacts & Groups (address book + WhatsApp-style shared spaces) ──
  app.use('/api/contacts', contactsRouter);
  app.use('/api/groups', groupsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
