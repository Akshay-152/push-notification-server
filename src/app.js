import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';

import SQLiteSessionStore from './database/sessionStore.js';
import { createSecurityHeaders } from './middleware/securityHeaders.js';
import { createCsrfProtection, ensureCsrfToken } from './middleware/csrf.js';
import { createRequireAdmin } from './middleware/auth.js';
import { createErrorHandler, apiNotFound } from './middleware/errorHandler.js';
import { createAuditService } from './services/auditService.js';
import { createPushService } from './services/pushService.js';
import { createSubscriptionService } from './services/subscriptionService.js';
import { createNotificationService } from './services/notificationService.js';
import { createPublicRoutes } from './routes/publicRoutes.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import { createAdminRoutes } from './routes/adminRoutes.js';
import { createLogger } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Build the Express application.
 *
 * Order matters:
 *   security headers -> body parsing -> sessions -> CSRF -> routes
 *   -> static assets -> 404s -> error handler
 *
 * `pushSender` lets tests inject a mock web-push transport.
 */
export function createApp({ config, db, logger = createLogger('app'), pushSender = null }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.isProduction) app.set('trust proxy', 1);

  const sessionStore = new SQLiteSessionStore(db);
  const audit = createAuditService({ db });
  const pushService = createPushService({ config, logger, sender: pushSender });
  const subscriptionService = createSubscriptionService({ db, config, logger });
  const notificationService = createNotificationService({
    db,
    config,
    pushService,
    subscriptionService,
    audit,
    logger,
  });
  const services = { audit, pushService, subscriptionService, notificationService };

  app.use(createSecurityHeaders({ ...config }));
  app.use(express.json({ limit: '32kb' }));

  app.use(
    session({
      name: 'webpush.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      store: sessionStore,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        maxAge: config.sessionTtlMs,
        path: '/',
      },
    })
  );

  // CSRF: every state-changing API request (login included) needs a token.
  app.use('/api', createCsrfProtection({ siteOrigin: config.siteOrigin }));

  app.use(
    '/api',
    createPublicRoutes({ config, subscriptionService, ensureCsrfToken })
  );
  app.use(
    '/api/auth',
    createAuthRoutes({ config, db, audit, ensureCsrfToken })
  );
  // Every admin route requires a verified session + admin role.
  app.use('/api/admin', createRequireAdmin({ db }), createAdminRoutes({ config, db, services }));

  // Static frontend (public/). Service worker must never be cached hard.
  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      etag: true,
      lastModified: true,
      maxAge: 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        } else if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=3600');
        }
      },
    })
  );

  app.use('/api', apiNotFound);
  app.use((req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  app.use(createErrorHandler({ logger, isProduction: config.isProduction }));

  return { app, services, sessionStore };
}
