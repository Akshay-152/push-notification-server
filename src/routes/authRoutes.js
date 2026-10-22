import crypto from 'node:crypto';
import { Router } from 'express';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { asyncHandler, badRequest, unauthorized } from '../middleware/errorHandler.js';
import { createLoginRateLimiter } from '../middleware/rateLimit.js';
import { LIMITS } from '../utils/validators.js';

// Argon2id tuned to OWASP 2024 guidance (m=19 MiB, t=2, p=1).
const HASH_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

// Real hash used to equalize timing when the username does not exist.
// Generated once per process from random throwaway input.
let dummyHashPromise = null;
function getDummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = hash(crypto.randomBytes(32).toString('hex'), HASH_OPTIONS);
  }
  return dummyHashPromise;
}

export async function hashPassword(password) {
  return hash(password, HASH_OPTIONS);
}

export async function verifyPassword(storedHash, password) {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/**
 * Login / logout / session introspection.
 * - Session is regenerated on successful login (fixation defense).
 * - Login attempts are rate limited per IP+username.
 * - No default accounts exist; create one with `npm run create:admin`.
 */
export function createAuthRoutes({ config, db, audit, ensureCsrfToken }) {
  const router = Router();
  const loginLimiter = createLoginRateLimiter(config.login);
  const findAdmin = db.prepare('SELECT * FROM admins WHERE username = ?');

  router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';

      if (!username || username.length > LIMITS.username) {
        throw badRequest('Username is required');
      }
      if (!password || password.length > LIMITS.password.max) {
        throw badRequest('Password is required');
      }

      const admin = findAdmin.get(username);
      const ok = admin
        ? await verifyPassword(admin.password_hash, password)
        : (await verifyPassword(await getDummyHash(), password).catch(() => false)) && false;

      if (!ok || !admin) {
        audit.record({
          adminId: admin?.id ?? null,
          action: 'auth.login_failed',
          detail: `username=${username.slice(0, 64)}`,
          ip: req.ip,
        });
        throw unauthorized('Invalid username or password', 'invalid_credentials');
      }

      // Regenerate the session id to prevent fixation, then bind the admin.
      await new Promise((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });
      req.session.adminId = admin.id;
      req.session.loginAt = new Date().toISOString();
      const csrfToken = ensureCsrfToken(req);
      await new Promise((resolve, reject) => {
        req.session.save((err) => (err ? reject(err) : resolve()));
      });

      audit.record({ adminId: admin.id, action: 'auth.login', ip: req.ip });

      res.json({
        data: {
          admin: { id: admin.id, username: admin.username, role: admin.role },
          csrfToken,
        },
      });
    })
  );

  /** Current session info (401 when signed out) + fresh CSRF token. */
  router.get(
    '/me',
    asyncHandler(async (req, res) => {
      const adminId = req.session?.adminId;
      if (!adminId) throw unauthorized('Admin session required');
      const admin = db
        .prepare('SELECT id, username, role FROM admins WHERE id = ?')
        .get(adminId);
      if (!admin) throw unauthorized('Admin session no longer valid');
      res.json({
        data: {
          admin: { id: admin.id, username: admin.username, role: admin.role },
          csrfToken: ensureCsrfToken(req),
        },
      });
    })
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      const adminId = req.session?.adminId ?? null;
      await new Promise((resolve) => req.session.destroy(() => resolve()));
      res.clearCookie('webpush.sid', { path: '/' });
      if (adminId) audit.record({ adminId, action: 'auth.logout', ip: req.ip });
      res.json({ data: { ok: true } });
    })
  );

  return router;
}
