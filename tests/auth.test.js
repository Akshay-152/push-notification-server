import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, createClient } from './helpers.js';

let srv;

before(async () => {
  srv = await createTestServer({
    configOverrides: { login: { max: 3, windowMs: 60_000 } },
  });
  await srv.seedAdmin('main-admin', 'super-secret-pass-1');
  await srv.seedAdmin('victim-admin', 'victim-secret-pass-1');
});
after(async () => {
  await srv.close();
});

async function signedInClient(username, password) {
  const c = createClient(srv.base);
  await c.bootstrap();
  const res = await c.post('/api/auth/login', { username, password });
  assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.body)}`);
  return c;
}

test('admin endpoints return 401 when signed out', async () => {
  const c = createClient(srv.base);
  await c.bootstrap();
  for (const path of ['/api/admin/dashboard', '/api/admin/subscriptions', '/api/admin/notifications', '/api/auth/me']) {
    const res = await c.get(path);
    assert.equal(res.status, 401, `${path} must be 401`);
  }
});

test('login requires a CSRF token', async () => {
  const c = createClient(srv.base);
  await c.bootstrap();
  const res = await c.post('/api/auth/login', { username: 'main-admin', password: 'x' }, { csrf: false });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'csrf_rejected');
});

test('login with wrong password returns 401 and no session', async () => {
  const c = createClient(srv.base);
  await c.bootstrap();
  const res = await c.post('/api/auth/login', { username: 'victim-admin', password: 'wrong-password-x' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'invalid_credentials');

  const dash = await c.get('/api/admin/dashboard');
  assert.equal(dash.status, 401, 'failed login must not open a session');
});

test('login with unknown username returns 401 (no user enumeration)', async () => {
  const c = createClient(srv.base);
  await c.bootstrap();
  const res = await c.post('/api/auth/login', { username: 'nobody-here', password: 'whatever-long-pw' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'invalid_credentials');
});

test('successful login opens a session, regenerates the sid, and unlocks admin API', async () => {
  const c = createClient(srv.base);
  await c.bootstrap();

  const sidBefore = c.cookies.get('webpush.sid');
  assert.ok(sidBefore, 'session cookie exists after bootstrap');

  const res = await c.post('/api/auth/login', { username: 'main-admin', password: 'super-secret-pass-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.admin.username, 'main-admin');
  assert.ok(res.body.data.csrfToken);

  const sidAfter = c.cookies.get('webpush.sid');
  assert.ok(sidAfter && sidAfter !== sidBefore, 'session id must change after login (fixation defense)');

  const me = await c.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.data.admin.username, 'main-admin');
  assert.equal(me.body.data.admin.role, 'admin');

  const dash = await c.get('/api/admin/dashboard');
  assert.equal(dash.status, 200);
});

test('logout destroys the session', async () => {
  const c = await signedInClient('victim-admin', 'victim-secret-pass-1');
  assert.equal((await c.get('/api/auth/me')).status, 200);

  const out = await c.post('/api/auth/logout');
  assert.equal(out.status, 200);

  assert.equal((await c.get('/api/auth/me')).status, 401, 'session must be dead after logout');
  assert.equal((await c.get('/api/admin/dashboard')).status, 401);

  // The old sid no longer authenticates anything.
  const reused = await createClient(srv.base);
  reused.setCsrf(c.getCsrf());
  for (const [name, value] of c.cookies) reused.cookies.set(name, value);
  assert.equal((await reused.get('/api/admin/dashboard')).status, 401);
});

test('login rate limiting kicks in after the configured number of attempts', async () => {
  const c = createClient(srv.base);
  await c.bootstrap();

  // max = 3 per IP+username window: first 3 wrong attempts -> 401
  for (let i = 1; i <= 3; i += 1) {
    const res = await c.post('/api/auth/login', { username: 'flood-admin', password: `wrong-attempt-${i}` });
    assert.equal(res.status, 401, `attempt ${i} should be 401`);
  }
  const blocked = await c.post('/api/auth/login', { username: 'flood-admin', password: 'wrong-again' });
  assert.equal(blocked.status, 429, '4th attempt must be rate limited');
  assert.ok(blocked.headers.get('retry-after'), 'Retry-After header present');

  // A different username from the same IP is still allowed (separate bucket).
  const other = await c.post('/api/auth/login', { username: 'main-admin', password: 'wrong-password-y' });
  assert.equal(other.status, 401, 'other accounts are not locked out by one attacker');
});

test('missing admin account cannot be created implicitly at runtime', async () => {
  // Only seeded admins exist; login never creates rows.
  const before = srv.db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  const c = createClient(srv.base);
  await c.bootstrap();
  await c.post('/api/auth/login', { username: 'brand-new', password: 'brand-new-password' }).catch(() => {});
  const after = srv.db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  assert.equal(after, before, 'login must never create admin accounts');
});
