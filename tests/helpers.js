/**
 * Shared test harness.
 *
 * IMPORTANT: this module sets NODE_ENV before importing any application
 * code (via dynamic import), so tests must import ONLY this helper plus
 * node:test / node:assert - never src/* directly at the top of a test file.
 */
process.env.NODE_ENV ||= 'test';
process.env.LOG_LEVEL ||= 'error';

import { once } from 'node:events';

/** Build an isolated app instance: in-memory DB, ephemeral config, port 0. */
export async function createTestServer({ configOverrides = {}, pushSender } = {}) {
  const { loadConfig } = await import('../src/config/index.js');
  const { initDatabase } = await import('../src/database/db.js');
  const { createApp } = await import('../src/app.js');
  const { hashPassword } = await import('../src/routes/authRoutes.js');
  const { createLogger } = await import('../src/utils/logger.js');

  const config = loadConfig(configOverrides);
  const db = initDatabase(':memory:');

  const pushLog = [];
  const sender =
    pushSender ||
    (async (subscription, payload, options) => {
      pushLog.push({ subscription, payload: String(payload), options });
      return { statusCode: 201 };
    });

  const logger = createLogger('test', { level: 50 }); // silent
  const { app, services, sessionStore } = createApp({ config, db, logger, pushSender: sender });

  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  async function close() {
    services.notificationService.stopScheduler();
    await new Promise((resolve) => server.close(resolve));
    sessionStore.stopCleanup();
    db.close();
  }

  async function seedAdmin(username, password, role = 'admin') {
    const passwordHash = await hashPassword(password);
    const info = db
      .prepare(
        `INSERT INTO admins (username, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(username, passwordHash, role, new Date().toISOString(), new Date().toISOString());
    return { id: Number(info.lastInsertRowid), username, role };
  }

  return { config, db, app, server, base, close, seedAdmin, pushLog, services, sender };
}

/**
 * Cookie-jar HTTP client for the test server.
 * - Stores Set-Cookie values between requests (session + owner cookies).
 * - Captures the CSRF token from any response that carries one and replays
 *   it automatically as X-CSRF-Token (unless csrf:false).
 */
export function createClient(base) {
  const cookies = new Map();
  let csrfToken = null;

  function cookieHeader() {
    return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function storeCookies(res) {
    const list =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      const isExpiry =
        /expires=Thu, 01 Jan 1970/i.test(raw) || /max-age=0/i.test(raw) || value === '';
      if (isExpiry) cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  async function request(method, path, body, opts = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookies.size) headers.cookie = cookieHeader();
    if (opts.csrf !== false && csrfToken && method !== 'GET') {
      headers['x-csrf-token'] = opts.csrfToken || csrfToken;
    }
    if (opts.headers) Object.assign(headers, opts.headers);

    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    storeCookies(res);

    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    const foundCsrf = json?.data?.csrfToken;
    if (foundCsrf && opts.csrf !== false) csrfToken = foundCsrf;

    return { status: res.status, body: json, headers: res.headers };
  }

  return {
    request,
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body, opts) => request('POST', path, body, opts),
    del: (path, body, opts) => request('DELETE', path, body, opts),
    /** Load /api/config to obtain a session + CSRF token. */
    bootstrap: () => request('GET', '/api/config'),
    setCsrf: (token) => {
      csrfToken = token;
    },
    getCsrf: () => csrfToken,
    clearCookies: () => cookies.clear(),
    cookies,
  };
}

/** A push payload object for building a valid subscription body. */
export function fakeSubscription(i = 1) {
  const rand = (n) => 'a'.repeat(n);
  return {
    endpoint: `https://push.example.test/ep/${'x'.repeat(i)}${Math.random().toString(36).slice(2)}`,
    keys: {
      p256dh: `B${rand(86)}`,
      auth: `A${rand(21)}`,
    },
  };
}

/** Mock sender that always fails with a given HTTP status. */
export function failingSender(statusCode, { body = 'error' } = {}) {
  const calls = [];
  const fn = async (subscription, payload, options) => {
    calls.push({ subscription, payload: String(payload), options });
    const err = new Error(`Received ${statusCode}, expected 2xx`);
    err.statusCode = statusCode;
    err.body = body;
    throw err;
  };
  fn.calls = calls;
  return fn;
}

/** Mock sender that fails with `codes` in order, then succeeds. */
export function flakySender(codes = []) {
  const calls = [];
  let i = 0;
  const fn = async (subscription, payload, options) => {
    calls.push({ subscription, payload: String(payload), options });
    const code = codes[i];
    i += 1;
    if (code) {
      const err = new Error(`Received ${code}, expected 2xx`);
      err.statusCode = code;
      err.body = 'flaky';
      throw err;
    }
    return { statusCode: 201 };
  };
  fn.calls = calls;
  return fn;
}

/** Poll a function until it returns a truthy value or the timeout expires. */
export async function waitFor(fn, { timeoutMs = 4000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}
