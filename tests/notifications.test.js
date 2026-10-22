import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestServer,
  createClient,
  fakeSubscription,
  failingSender,
  flakySender,
  waitFor,
} from './helpers.js';

const ADMIN = { username: 'sender-admin', password: 'admin-password-123' };

/** Fresh server + signed-in admin client for an isolated test. */
async function withAdmin(opts, fn) {
  const srv = await createTestServer(opts);
  try {
    await srv.seedAdmin(ADMIN.username, ADMIN.password);
    const c = createClient(srv.base);
    await c.bootstrap();
    const login = await c.post('/api/auth/login', ADMIN);
    assert.equal(login.status, 200, 'admin login must succeed');
    await fn(srv, c);
  } finally {
    await srv.close();
  }
}

/** Subscribe `n` fresh browsers; returns their clients. */
async function subscribeClients(srv, n) {
  const clients = [];
  for (let i = 0; i < n; i += 1) {
    const c = createClient(srv.base);
    await c.bootstrap();
    const res = await c.post('/api/subscriptions', { subscription: fakeSubscription(i + 10) });
    assert.equal(res.status, 201);
    clients.push(c);
  }
  return clients;
}

const validNotification = {
  title: 'Release 2.0',
  body: 'The new version is live.',
  destinationUrl: '/releases/2.0',
};

async function sendAndGetResult(admin, id, srv, timeoutMs = 4000) {
  return waitFor(
    async () => {
      const res = await admin.get(`/api/admin/notifications/${id}`);
      const n = res.body?.data?.notification;
      if (n && !['queued', 'sending'].includes(n.status)) return n;
      return null;
    },
    { timeoutMs, label: `notification #${id} to finish` }
  );
}

test('notification validation rejects bad input with 400', async () => {
  await withAdmin({}, async (srv, admin) => {
    const cases = [
      { ...validNotification, title: '' },
      { ...validNotification, title: 'x'.repeat(200) },
      { ...validNotification, body: '' },
      { ...validNotification, body: 'x'.repeat(1000) },
      { ...validNotification, destinationUrl: 'https://evil.com/phish' },
      { ...validNotification, destinationUrl: 'javascript:alert(1)' },
      { ...validNotification, tag: 'bad tag!' },
      { ...validNotification, scheduledAt: new Date(Date.now() + 1000).toISOString() },
      { ...validNotification, scheduledAt: 'not-a-date' },
    ];
    for (const payload of cases) {
      const res = await admin.post('/api/admin/notifications', payload);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(payload).slice(0, 90)}`);
      assert.ok(res.body.error.message);
    }
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
  });
});

test('the public cannot create or list notifications', async () => {
  await withAdmin({}, async (srv) => {
    const anon = createClient(srv.base);
    await anon.bootstrap();
    const create = await anon.post('/api/admin/notifications', validNotification);
    assert.equal(create.status, 401);
    const list = await anon.get('/api/admin/notifications');
    assert.equal(list.status, 401);
    const results = await anon.get('/api/admin/notifications/1/results');
    assert.equal(results.status, 401);
  });
});

test('send with zero subscribers completes with accurate zero counts', async () => {
  await withAdmin({}, async (srv, admin) => {
    const res = await admin.post('/api/admin/notifications', validNotification);
    assert.equal(res.status, 201);
    const n = await sendAndGetResult(admin, res.body.data.notification.id, srv);

    assert.equal(n.status, 'sent');
    assert.equal(n.counts.attempted, 0);
    assert.equal(n.counts.accepted, 0);
    assert.equal(srv.pushLog.length, 0, 'no push calls with no subscribers');
  });
});

test('delivers to all active subscribers and records deliveries + stats', async () => {
  await withAdmin({}, async (srv, admin) => {
    await subscribeClients(srv, 3);

    const res = await admin.post('/api/admin/notifications', validNotification);
    assert.equal(res.status, 201);
    const id = res.body.data.notification.id;
    const n = await sendAndGetResult(admin, id, srv);

    assert.equal(n.status, 'sent');
    assert.equal(srv.pushLog.length, 3, 'one push attempt per subscriber');
    assert.equal(n.counts.accepted, 3);
    assert.equal(n.counts.failed, 0);

    // Payload carries the right content.
    const payload = JSON.parse(srv.pushLog[0].payload);
    assert.equal(payload.title, validNotification.title);
    assert.equal(payload.url, '/releases/2.0');

    // Results endpoint: masked endpoints only.
    const results = await admin.get(`/api/admin/notifications/${id}/results`);
    assert.equal(results.status, 200);
    assert.equal(results.body.data.items.length, 3);
    for (const item of results.body.data.items) {
      assert.ok(item.endpoint.includes('…'), 'endpoint must be masked');
      assert.ok(!item.endpoint.startsWith('https://'), 'raw endpoint leaked');
      assert.equal(item.result, 'accepted');
      assert.equal(item.httpStatus, 201);
    }

    // Dashboard reflects the deliveries; subscriptions got last_success_at.
    const dash = (await admin.get('/api/admin/dashboard')).body.data;
    assert.equal(dash.delivery.accepted, 3);
    assert.equal(dash.delivery.failed, 0);
    assert.equal(dash.subscriptions.active, 3);
    const ok = srv.db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE last_success_at IS NOT NULL').get().n;
    assert.equal(ok, 3);
  });
});

test('permanent errors (400) are not retried and keep the subscription active', async () => {
  const sender = failingSender(400, { body: 'Bad Request' });
  await withAdmin({ pushSender: sender }, async (srv, admin) => {
    await subscribeClients(srv, 1);

    const res = await admin.post('/api/admin/notifications', validNotification);
    const n = await sendAndGetResult(admin, res.body.data.notification.id, srv);

    assert.equal(n.status, 'failed');
    assert.equal(sender.calls.length, 1, 'permanent errors must not be retried');
    assert.equal(n.counts.failed, 1);

    const row = srv.db.prepare('SELECT result, http_status, error_code FROM notification_deliveries').get();
    assert.equal(row.result, 'failed');
    assert.equal(row.http_status, 400);

    const sub = srv.db.prepare('SELECT active FROM subscriptions').get();
    assert.equal(sub.active, 1, '400 does not invalidate the subscription');
  });
});

test('410 Gone deactivates the subscription (no retry)', async () => {
  const sender = failingSender(410, { body: 'Gone' });
  await withAdmin({ pushSender: sender }, async (srv, admin) => {
    await subscribeClients(srv, 2);
    const before = srv.services.subscriptionService.counts();
    assert.equal(before.active, 2);

    const res = await admin.post('/api/admin/notifications', validNotification);
    const n = await sendAndGetResult(admin, res.body.data.notification.id, srv);

    assert.equal(sender.calls.length, 2, 'one attempt each, no retries for 410');
    assert.equal(n.counts.failed, 2);

    const after = srv.services.subscriptionService.counts();
    assert.equal(after.active, 0, 'gone subscriptions must be deactivated');
    assert.equal(after.total, 2, 'rows kept for audit, just inactive');

    const codes = srv.db.prepare('SELECT error_code FROM notification_deliveries').all();
    for (const c of codes) assert.equal(c.error_code, 'subscription_gone');
  });
});

test('transient failures retry with backoff and can succeed', async () => {
  const sender = flakySender([500, 500, null]); // fails twice, then works
  await withAdmin({ pushSender: sender }, async (srv, admin) => {
    await subscribeClients(srv, 1);

    const res = await admin.post('/api/admin/notifications', validNotification);
    const n = await sendAndGetResult(admin, res.body.data.notification.id, srv);

    assert.equal(sender.calls.length, 3, 'initial try + 2 retries');
    assert.equal(n.status, 'sent');
    assert.equal(n.counts.accepted, 1);

    const row = srv.db.prepare('SELECT result, attempt_count, http_status FROM notification_deliveries').get();
    assert.equal(row.result, 'accepted');
    assert.equal(row.attempt_count, 3, 'attempts recorded');
  });
});

test('retries are bounded: exhausted transient failures are recorded as failed', async () => {
  const sender = failingSender(503, { body: 'Service Unavailable' });
  await withAdmin({ pushSender: sender, configOverrides: { push: {
    concurrency: 4, maxRetries: 2, retryBaseMs: 0, maxPayloadBytes: 3500,
  } } }, async (srv, admin) => {
    await subscribeClients(srv, 1);

    const res = await admin.post('/api/admin/notifications', validNotification);
    const n = await sendAndGetResult(admin, res.body.data.notification.id, srv);

    assert.equal(sender.calls.length, 3, '1 + maxRetries(2) attempts total');
    assert.equal(n.status, 'failed');

    const row = srv.db.prepare('SELECT result, attempt_count FROM notification_deliveries').get();
    assert.equal(row.result, 'failed');
    assert.equal(row.attempt_count, 3);
  });
});

test('concurrent startSend calls for the same notification do not double-send', async () => {
  let resolveSend;
  const gate = new Promise((r) => { resolveSend = r; });
  const calls = [];
  const slowSender = async (sub, payload, options) => {
    calls.push({ sub, payload, options });
    await gate;
    return { statusCode: 201 };
  };

  await withAdmin({ pushSender: slowSender }, async (srv, admin) => {
    await subscribeClients(srv, 3);
    const res = await admin.post('/api/admin/notifications', validNotification);
    const id = res.body.data.notification.id;

    // Fire the job a second time while the first is still running.
    const [first, second] = await Promise.all([
      srv.services.notificationService.startSend(id),
      srv.services.notificationService.startSend(id),
    ]);
    resolveSend();

    const running = first || second;
    if (running) assert.equal(running.status, 'sent');
    assert.equal(calls.length, 3, 'each subscriber gets exactly one message');
  });
});

test('notification list paginates (25 rows across 3 pages)', async () => {
  await withAdmin({}, async (srv, admin) => {
    for (let i = 0; i < 25; i += 1) {
      const res = await admin.post('/api/admin/notifications', {
        ...validNotification,
        title: `Notification ${i + 1}`,
      });
      assert.equal(res.status, 201);
      await sendAndGetResult(admin, res.body.data.notification.id, srv, 2000);
    }

    const p1 = await admin.get('/api/admin/notifications?page=1&pageSize=10');
    assert.equal(p1.body.data.items.length, 10);
    assert.equal(p1.body.data.pagination.total, 25);
    assert.equal(p1.body.data.pagination.totalPages, 3);

    const p3 = await admin.get('/api/admin/notifications?page=3&pageSize=10');
    assert.equal(p3.body.data.items.length, 5);

    const p99 = await admin.get('/api/admin/notifications?page=99&pageSize=10');
    assert.equal(p99.body.data.items.length, 0, 'out-of-range page is empty, not an error');

    // Search narrows the list.
    const search = await admin.get('/api/admin/notifications?search=Notification 7');
    assert.equal(search.body.data.items.length, 1);
    assert.equal(search.body.data.items[0].title, 'Notification 7');
  });
});

test('history records the author and the audit trail captures admin actions', async () => {
  await withAdmin({}, async (srv, admin) => {
    const res = await admin.post('/api/admin/notifications', validNotification);
    await sendAndGetResult(admin, res.body.data.notification.id, srv);

    const list = await admin.get('/api/admin/notifications');
    assert.equal(list.body.data.items[0].created_by_username, ADMIN.username);

    const audit = await admin.get('/api/admin/audit');
    assert.equal(audit.status, 200);
    const actions = audit.body.data.items.map((a) => a.action);
    assert.ok(actions.includes('auth.login'), 'login audited');
    assert.ok(actions.includes('notification.create'), 'send audited');
  });
});

test('scheduled notifications wait, survive, and can be cancelled', async () => {
  await withAdmin({}, async (srv, admin) => {
    await subscribeClients(srv, 1);
    const scheduledAt = new Date(Date.now() + 3600_000).toISOString();

    const res = await admin.post('/api/admin/notifications', {
      ...validNotification,
      scheduledAt,
    });
    assert.equal(res.status, 201);
    const id = res.body.data.notification.id;
    assert.equal(res.body.data.notification.status, 'scheduled');
    assert.equal(res.body.data.notification.scheduled_at, scheduledAt);

    // Nothing sent yet.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.pushLog.length, 0);

    const cancel = await admin.post(`/api/admin/notifications/${id}/cancel`);
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.data.status, 'cancelled');

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.pushLog.length, 0, 'cancelled notification never sends');
    assert.equal(srv.db.prepare('SELECT status FROM notifications WHERE id = ?').get(id).status, 'cancelled');
  });
});

test('scheduled jobs recover after restart (persistent scheduler path)', async () => {
  await withAdmin({}, async (srv, admin) => {
    await subscribeClients(srv, 1);

    // Create a due job directly in the DB, as if the server had been
    // restarted with a schedule time already in the past.
    const info = srv.db.prepare(`
      INSERT INTO notifications (title, body, destination_url, icon, tag,
                                 created_by_admin_id, created_at, scheduled_at, status)
      VALUES ('Due', 'Due message', '/due', NULL, NULL,
              (SELECT id FROM admins LIMIT 1), ?, ?, 'scheduled')
    `).run(new Date().toISOString(), new Date(Date.now() - 60_000).toISOString());
    const id = Number(info.lastInsertRowid);

    await srv.services.notificationService.startSend(id);
    const n = (await admin.get(`/api/admin/notifications/${id}`)).body.data.notification;
    assert.equal(n.status, 'sent');
    assert.equal(srv.pushLog.length, 1);
  });
});

test('subscriber pagination, search and deactivation', async () => {
  await withAdmin({}, async (srv, admin) => {
    await subscribeClients(srv, 5);

    const p1 = await admin.get('/api/admin/subscriptions?page=1&pageSize=2');
    assert.equal(p1.body.data.items.length, 2);
    assert.equal(p1.body.data.pagination.total, 5);
    assert.equal(p1.body.data.pagination.totalPages, 3);

    const all = await admin.get('/api/admin/subscriptions?pageSize=100');
    const target = all.body.data.items[0];
    assert.ok(target.maskedEndpoint, 'masked endpoint present');

    const del = await admin.del(`/api/admin/subscriptions/${target.id}`);
    assert.equal(del.status, 200);

    const active = await admin.get('/api/admin/subscriptions?status=active');
    assert.equal(active.body.data.pagination.total, 4);
    const inactive = await admin.get('/api/admin/subscriptions?status=inactive');
    assert.equal(inactive.body.data.pagination.total, 1);

    // Search by masked endpoint fragment or owner id.
    const search = await admin.get(`/api/admin/subscriptions?search=${encodeURIComponent(target.maskedEndpoint.split('…')[0])}`);
    assert.ok(search.body.data.pagination.total >= 1);

    // Invalid id -> 400; unknown id -> 404.
    assert.equal((await admin.del('/api/admin/subscriptions/abc')).status, 400);
    assert.equal((await admin.del('/api/admin/subscriptions/999999')).status, 404);
  });
});

test('cleanup deletes only stale inactive subscriptions', async () => {
  await withAdmin({}, async (srv, admin) => {
    const c = createClient(srv.base);
    await c.bootstrap();
    await c.post('/api/subscriptions', { subscription: fakeSubscription(50) });
    await c.post('/api/subscriptions', { subscription: fakeSubscription(51) });
    assert.equal(srv.services.subscriptionService.counts().total, 2);

    // Deactivate one and age it past retention; keep one active.
    srv.db.prepare("UPDATE subscriptions SET active = 0, updated_at = '2020-01-01T00:00:00.000Z' WHERE id = 1").run();

    const res = await admin.post('/api/admin/subscriptions/cleanup');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.deleted, 1);
    assert.equal(srv.services.subscriptionService.counts().total, 1);
    assert.equal(srv.services.subscriptionService.counts().active, 1);
  });
});

test('CSRF is required for admin state-changing requests', async () => {
  await withAdmin({}, async (srv, admin) => {
    const res = await admin.post('/api/admin/notifications', validNotification, { csrf: false });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'csrf_rejected');

    // Cross-origin request with an Origin header from elsewhere is rejected
    // even when the token is right.
    const cross = await admin.post('/api/admin/notifications', validNotification, {
      headers: { origin: 'https://attacker.example' },
    });
    assert.equal(cross.status, 403);
  });
});
