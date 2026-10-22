import crypto from 'node:crypto';
import { Router } from 'express';
import { getCookie } from '../utils/cookies.js';
import { validatePushSubscription, LIMITS } from '../utils/validators.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const OWNER_COOKIE = 'wp_owner';
const OWNER_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
const OWNER_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Public (unauthenticated) endpoints.
 *
 * Subscribers are identified by a random HttpOnly owner cookie - a secure
 * anonymous subscription identifier. The push endpoint itself is never
 * treated as authentication.
 */
export function createPublicRoutes({ config, subscriptionService, ensureCsrfToken }) {
  const router = Router();

  /** Ensure the browser has a stable, unguessable owner id. */
  function attachOwner(req, res, next) {
    let ownerId = getCookie(req, OWNER_COOKIE);
    if (!ownerId || !OWNER_ID_RE.test(ownerId)) {
      ownerId = crypto.randomBytes(24).toString('base64url');
      res.cookie(OWNER_COOKIE, ownerId, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        maxAge: OWNER_MAX_AGE_MS,
        path: '/',
      });
      req.ownerId = ownerId;
      return next();
    }
    req.ownerId = ownerId;
    next();
  }

  router.use(attachOwner);

  /** Public application config incl. the VAPID PUBLIC key (never the private one). */
  router.get(
    '/config',
    asyncHandler(async (req, res) => {
      const csrfToken = ensureCsrfToken(req);
      res.json({
        data: {
          vapidPublicKey: config.vapid.publicKey,
          csrfToken,
          siteUrl: config.siteUrl,
          limits: {
            title: LIMITS.title,
            body: LIMITS.body,
          },
          defaultIcon: '/icons/icon-192.png',
          defaultBadge: '/icons/badge.png',
        },
      });
    })
  );

  /** Store a browser PushSubscription. Idempotent (upsert on endpoint). */
  router.post(
    '/subscriptions',
    asyncHandler(async (req, res) => {
      const parsed = validatePushSubscription(req.body?.subscription);
      if (!parsed.ok) return res.status(400).json({ error: { code: 'invalid_subscription', message: parsed.errors.join('; ') } });

      const row = subscriptionService.upsert({
        ownerId: req.ownerId,
        endpoint: parsed.value.endpoint,
        keys: parsed.value.keys,
        userAgent: req.get('user-agent'),
      });

      res.status(201).json({ data: { subscription: subscriptionService.toPublic(row) } });
    })
  );

  /** Current subscription status for this browser. */
  router.get(
    '/subscriptions/status',
    asyncHandler(async (req, res) => {
      res.json({
        data: {
          subscriptions: subscriptionService.statusForOwner(req.ownerId),
          csrfToken: ensureCsrfToken(req),
        },
      });
    })
  );

  /** Unsubscribe: deactivate every subscription this browser owns. */
  router.delete(
    '/subscriptions/current',
    asyncHandler(async (req, res) => {
      const removed = subscriptionService.deactivateByOwner(req.ownerId);
      res.json({ data: { removed } });
    })
  );

  return router;
}
