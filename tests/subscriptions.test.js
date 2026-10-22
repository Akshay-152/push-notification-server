import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, createClient, fakeSubscription } from './helpers.js';

let srv;

before(async () => {
  srv = await createTestServer();
});
after(async () => {
  await srv.close();
});

test('GET /api/config exposes the VAPID PUBLIC key and a CSRF token', async () => {
  const c = createClient(srv.base);
  const res = await c.bootstrap();
  assert.equal(res.status, 200);
  assert.ok(res.body.data.vapidPublicKey, 'public key present');
  assert.ok(res.body.data.csrfToken, 'csrf token present');
  // The private key must never appear anywhere in the response.
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes(srv.config.vapid.privateKey), 'private VAPID key leaked!');
});

test('POST /api/subscriptions requires a CSRF token', async () => {
  const c = createClient(srv.base); // never bootstrapped -> no CSRF token
  const res = await c.post('/api/subscriptions', { subscription: fakeSubscription() });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'csrf_rejected');
});

test('POST /api/subscriptions rejects invalid payloads with 400', async () => {
  const c = createClient(srv.base);
  await c.bootstrap();

  const missing = await c.post('/api/subscriptions', {});
  assert.equal(missing.status, 400);

  const badEndpoint = await c.post('/api/subscriptions', {
    subscription: { endpoint: 'not-a-url', keys: { p256dh: `B${'a'.repeat(86)}`, auth: `A${'b'.repeat(21)}` } },
  });
  assert.equal(badEndpoint.status, 400);

  const badKeys = await c.post('/api/subscriptions', {
    subscription: { endpoint: 'https://push.example.com/ep', keys: { p256dh: 'short', auth: 'short' } },
  });
  assert.equal(badKeys.status, 400);

  // Nothing was persisted by the failed attempts.
  assert.equal(srv.services.subscriptionService.counts().total, 0);
});

test('subscription is created, reported by status, and upserts duplicates', async () => {
  const c = createClient(srv.base);
  await c.bootstrap();
  const sub = fakeSubscription(2);

  const created = await c.post('/api/subscriptions', { subscription: sub });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.subscription.active, true);
  const firstId = created.body.data.subscription.id;

  const status = await c.get('/api/subscriptions/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.data.subscriptions.length, 1);

  // Same endpoint again (browser re-subscribed): still exactly one row.
  const again = await c.post('/api/subscriptions', { subscription: sub });
  assert.equal(again.status, 201);
  assert.equal(again.body.data.subscription.id, firstId);

  const counts = srv.services.subscriptionService.counts();
  assert.equal(counts.total, 1, 'duplicate endpoint must not create a second row');
  assert.equal(counts.active, 1);
});

test('owner isolation: one browser cannot unsubscribe another', async () => {
  const ownerA = createClient(srv.base);
  await ownerA.bootstrap();
  await ownerA.post('/api/subscriptions', { subscription: fakeSubscription(3) });

  const ownerB = createClient(srv.base); // fresh cookie jar = different owner
  await ownerB.bootstrap();

  const del = await ownerB.del('/api/subscriptions/current');
  assert.equal(del.status, 200);
  assert.equal(del.body.data.removed, 0, 'owner B must not remove owner A subscriptions');

  const statusA = await ownerA.get('/api/subscriptions/status');
  assert.equal(statusA.body.data.subscriptions.length, 1);
});

test('unsubscribe removes the subscription; re-subscribing reactivates it', async () => {
  const c = createClient(srv.base);
  await c.bootstrap();
  await c.post('/api/subscriptions', { subscription: fakeSubscription(4) });

  const before = srv.services.subscriptionService.counts();
  assert.ok(before.active >= 1);

  const del = await c.del('/api/subscriptions/current');
  assert.equal(del.status, 200);
  assert.equal(del.body.data.removed, 1);

  const status = await c.get('/api/subscriptions/status');
  assert.equal(status.body.data.subscriptions.length, 0);
  assert.equal(srv.services.subscriptionService.counts().active, before.active - 1);

  // Resubscribe -> active again (soft delete is reversible).
  const resub = await c.post('/api/subscriptions', { subscription: fakeSubscription(4) });
  assert.equal(resub.status, 201);
  assert.equal(resub.body.data.subscription.active, true);
  assert.equal(srv.services.subscriptionService.counts().active, before.active);
});

test('unauthenticated users cannot reach admin subscription endpoints', async () => {
  const c = createClient(srv.base);
  await c.bootstrap();
  const list = await c.get('/api/admin/subscriptions');
  assert.equal(list.status, 401);
});
