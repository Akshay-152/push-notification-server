import crypto from 'node:crypto';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Ensure the session carries a CSRF token; returns it. */
export function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  }
  return req.session.csrfToken;
}

/**
 * CSRF protection for state-changing API requests.
 * Defense in depth:
 *  1. Origin header (when present) must match the site origin or the Host.
 *  2. X-CSRF-Token header must equal the token bound to this session.
 * The token is handed out by safe GET endpoints (e.g. /api/config).
 */
export function createCsrfProtection({ siteOrigin }) {
  return (req, res, next) => {
    if (!UNSAFE.has(req.method)) return next();

    const origin = req.get('origin');
    if (origin && origin !== 'null') {
      let originHost;
      try {
        originHost = new URL(origin).origin;
      } catch {
        return res.status(403).json({ error: { code: 'csrf_rejected', message: 'Invalid Origin header' } });
      }
      const hostOrigin = `http://${req.headers.host}`;
      if (originHost !== siteOrigin && originHost !== hostOrigin) {
        return res
          .status(403)
          .json({ error: { code: 'csrf_rejected', message: 'Cross-origin request rejected' } });
      }
    }

    const sent = req.get('x-csrf-token');
    const expected = req.session?.csrfToken;
    if (!sent || !expected || !safeEqual(sent, expected)) {
      return res
        .status(403)
        .json({ error: { code: 'csrf_rejected', message: 'Missing or invalid CSRF token' } });
    }

    ensureCsrfToken(req);
    next();
  };
}
