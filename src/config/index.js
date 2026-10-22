import crypto from 'node:crypto';
import webPush from 'web-push';
import 'dotenv/config';

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid environment variable ${name}: expected a non-negative integer`);
  }
  return value;
}

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function warn(message) {
  if (!isTest) console.warn(`[config] WARNING: ${message}`);
}

/**
 * Build the application configuration from environment variables.
 *
 * Production is strict: SESSION_SECRET and VAPID keys must be provided.
 * Development/test fall back to ephemeral generated values so the app can
 * always start locally, with a warning in dev (silenced in tests).
 */
export function loadConfig(overrides = {}) {
  const port = readInt('PORT', 3000);
  const rawSiteUrl = process.env.SITE_URL || `http://localhost:${port}`;
  let siteUrl;
  let siteOrigin;
  try {
    const parsed = new URL(rawSiteUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('scheme');
    }
    siteUrl = parsed.origin;
    siteOrigin = parsed.origin;
  } catch {
    throw new Error(`Invalid SITE_URL: ${rawSiteUrl} (must be an http(s) origin)`);
  }

  let sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    if (isProduction) {
      throw new Error(
        'SESSION_SECRET is required in production. Generate one with: ' +
          "node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
      );
    }
    sessionSecret = crypto.randomBytes(48).toString('base64url');
    warn('SESSION_SECRET not set - using an ephemeral development secret (sessions reset on restart).');
  } else if (isProduction && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production');
  }

  let vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  let vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublicKey || !vapidPrivateKey) {
    if (isProduction) {
      throw new Error(
        'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required in production. Generate them with: npm run generate:vapid'
      );
    }
    const keys = webPush.generateVAPIDKeys();
    vapidPublicKey = keys.publicKey;
    vapidPrivateKey = keys.privateKey;
    warn('VAPID keys not set - generated ephemeral keys for local development (existing subscriptions will stop working after restart).');
  }

  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@localhost';
  if (!/^mailto:|^https:\/\//.test(vapidSubject)) {
    throw new Error('VAPID_SUBJECT must be a mailto: or https: URL');
  }

  const config = {
    nodeEnv: NODE_ENV,
    isProduction,
    isTest,
    port,
    siteUrl,
    siteOrigin,
    sessionSecret,
    sessionTtlMs: readInt('SESSION_TTL_SECONDS', 86400) * 1000,
    // Secure cookies default ON in production (site is HTTPS there).
    cookieSecure: readBool('COOKIE_SECURE', isProduction),
    vapid: { publicKey: vapidPublicKey, privateKey: vapidPrivateKey, subject: vapidSubject },
    databasePath: process.env.DATABASE_PATH || './data/app.sqlite',
    push: {
      concurrency: readInt('PUSH_CONCURRENCY', 8),
      maxRetries: readInt('PUSH_MAX_RETRIES', 3),
      retryBaseMs: readInt('PUSH_RETRY_BASE_MS', isTest ? 0 : 500),
      maxPayloadBytes: 3500, // Web Push payloads stay small; ~4 KB is the hard cap.
    },
    login: {
      max: readInt('LOGIN_RATE_LIMIT_MAX', 10),
      windowMs: readInt('LOGIN_RATE_LIMIT_WINDOW_SECONDS', 900) * 1000,
    },
    cleanup: {
      inactiveRetentionDays: readInt('INACTIVE_RETENTION_DAYS', 30),
    },
    ...overrides,
  };

  return Object.freeze(config);
}
