import { test } from 'node:test';
import assert from 'node:assert/strict';
import webPush from 'web-push';
import { createPushService } from '../src/services/pushService.js';

const keys = webPush.generateVAPIDKeys();

function makeService({ maxRetries = 2, maxPayloadBytes = 3500, sender } = {}) {
  const config = {
    vapid: { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:test@example.com' },
    push: { concurrency: 2, maxRetries, retryBaseMs: 0, maxPayloadBytes },
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  return createPushService({ config, logger, sender });
}

const sub = (id = 1) => ({
  id,
  endpoint: `https://push.example.test/${id}`,
  keys: { p256dh: `B${'a'.repeat(86)}`, auth: `A${'b'.repeat(21)}` },
});

const notification = {
  id: 7,
  title: 'Hi',
  body: 'There',
  destination_url: '/x',
  icon: null,
  tag: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

function errWith(status, body = 'err') {
  const e = new Error(`Received ${status}, expected 2xx`);
  e.statusCode = status;
  e.body = body;
  return e;
}

test('buildPayload produces a versioned JSON payload', async () => {
  const svc = makeService();
  const payload = svc.buildPayload(notification);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.title, 'Hi');
  assert.equal(parsed.body, 'There');
  assert.equal(parsed.url, '/x');
  assert.equal(parsed.tag, 'n-7');
  assert.ok(parsed.timestamp);
});

test('buildPayload enforces the payload size limit', () => {
  const svc = makeService({ maxPayloadBytes: 100 });
  assert.throws(() => svc.buildPayload({ ...notification, body: 'x'.repeat(500) }), /size limit/);
});

test('accepted delivery returns accepted with one attempt', async () => {
  const calls = [];
  const svc = makeService({
    sender: async (s, p, o) => {
      calls.push({ s, p, o });
      return { statusCode: 201 };
    },
  });
  const out = await svc.sendWithRetry(sub(), 'payload');
  assert.equal(out.result, 'accepted');
  assert.equal(out.attempts, 1);
  assert.equal(out.httpStatus, 201);
  assert.equal(calls.length, 1);
  // VAPID details are applied by the service (web-push accepts the call).
  assert.ok(calls[0].o.TTL > 0, 'TTL set');
});

test('404/410 are gone: never retried', async () => {
  for (const status of [404, 410]) {
    let count = 0;
    const svc = makeService({
      sender: async () => {
        count += 1;
        throw errWith(status, 'Gone');
      },
    });
    const out = await svc.sendWithRetry(sub(), 'payload');
    assert.equal(out.result, 'gone');
    assert.equal(out.attempts, 1, `${status} must not be retried`);
    assert.equal(count, 1);
    assert.equal(out.errorCode, 'subscription_gone');
    assert.equal(out.httpStatus, status);
  }
});

test('permanent errors (400/401/403) are never retried', async () => {
  for (const status of [400, 401, 403]) {
    let count = 0;
    const svc = makeService({
      sender: async () => {
        count += 1;
        throw errWith(status);
      },
    });
    const out = await svc.sendWithRetry(sub(), 'payload');
    assert.equal(out.result, 'failed');
    assert.equal(count, 1, `${status} must not be retried`);
    assert.equal(out.errorCode, `http_${status}`);
  }
});

test('transient errors retry up to maxRetries, then fail', async () => {
  let count = 0;
  const svc = makeService({
    maxRetries: 3,
    sender: async () => {
      count += 1;
      throw errWith(503, 'unavailable');
    },
  });
  const out = await svc.sendWithRetry(sub(), 'payload');
  assert.equal(out.result, 'failed');
  assert.equal(count, 4, '1 initial + 3 retries');
  assert.equal(out.attempts, 4);
  assert.equal(out.httpStatus, 503);
});

test('network errors (no status) count as transient', async () => {
  let count = 0;
  const svc = makeService({
    maxRetries: 1,
    sender: async () => {
      count += 1;
      throw new Error('socket hang up');
    },
  });
  const out = await svc.sendWithRetry(sub(), 'payload');
  assert.equal(out.result, 'failed');
  assert.equal(out.errorCode, 'network_error');
  assert.equal(count, 2, 'retried once');
});

test('a transient failure followed by success reports accepted with attempt count', async () => {
  let count = 0;
  const svc = makeService({
    maxRetries: 3,
    sender: async () => {
      count += 1;
      if (count < 3) throw errWith(429, 'slow down');
      return { statusCode: 201 };
    },
  });
  const out = await svc.sendWithRetry(sub(), 'payload');
  assert.equal(out.result, 'accepted');
  assert.equal(out.attempts, 3);
});

test('error messages are sanitized and truncated', async () => {
  const svc = makeService({
    sender: async () => {
      throw errWith(400, `secret-key-material ${'x'.repeat(500)}`);
    },
  });
  const out = await svc.sendWithRetry(sub(), 'payload');
  assert.ok(out.errorMessage.length <= 200, 'truncated to 200 chars');
  assert.ok(!out.errorMessage.includes('\n'), 'newlines collapsed');
});
