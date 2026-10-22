import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDestinationUrl,
  validatePushSubscription,
  validateNotificationInput,
  validateTag,
  validateIconUrl,
  validateFutureTimestamp,
  paginate,
  maskEndpoint,
  LIMITS,
} from '../src/utils/validators.js';

const ORIGIN = 'https://example.com';

test('destination URL accepts internal paths', () => {
  const ok = validateDestinationUrl('/news/42?x=1', ORIGIN);
  assert.equal(ok.ok, true);
  assert.equal(ok.value, '/news/42?x=1');
});

test('destination URL accepts same-origin absolute URLs, normalized to path', () => {
  const ok = validateDestinationUrl('https://example.com/blog/post-1', ORIGIN);
  assert.equal(ok.ok, true);
  assert.equal(ok.value, '/blog/post-1');
});

test('destination URL rejects other origins', () => {
  const bad = validateDestinationUrl('https://evil.com/phish', ORIGIN);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /example\.com/);
});

test('destination URL rejects dangerous schemes', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.com/x', '//evil.com/x']) {
    const res = validateDestinationUrl(url, ORIGIN);
    assert.equal(res.ok, false, `should reject ${url}`);
  }
});

test('destination URL rejects missing / oversized values', () => {
  assert.equal(validateDestinationUrl('', ORIGIN).ok, false);
  assert.equal(validateDestinationUrl(null, ORIGIN).ok, false);
  assert.equal(validateDestinationUrl(`/${'a'.repeat(LIMITS.url + 10)}`, ORIGIN).ok, false);
});

test('push subscription accepts a well-formed subscription', () => {
  const res = validatePushSubscription({
    endpoint: 'https://push.example.com/ep/abc',
    keys: { p256dh: `B${'a'.repeat(86)}`, auth: `A${'b'.repeat(21)}` },
  });
  assert.equal(res.ok, true);
  assert.equal(res.value.endpoint, 'https://push.example.com/ep/abc');
});

test('push subscription rejects non-https endpoints (except loopback)', () => {
  const base = { keys: { p256dh: `B${'a'.repeat(86)}`, auth: `A${'b'.repeat(21)}` } };
  assert.equal(validatePushSubscription({ ...base, endpoint: 'http://evil.com/ep' }).ok, false);
  assert.equal(validatePushSubscription({ ...base, endpoint: 'http://localhost:9000/ep' }).ok, true);
});

test('push subscription rejects malformed keys and shapes', () => {
  assert.equal(validatePushSubscription(null).ok, false);
  assert.equal(validatePushSubscription('nope').ok, false);
  assert.equal(validatePushSubscription({ endpoint: 'not a url', keys: { p256dh: 'x', auth: 'y' } }).ok, false);
  assert.equal(
    validatePushSubscription({
      endpoint: 'https://push.example.com/ep',
      keys: { p256dh: 'short', auth: 'also-short' },
    }).ok,
    false
  );
  assert.equal(
    validatePushSubscription({
      endpoint: 'https://push.example.com/ep',
      keys: { p256dh: `B${'a'.repeat(86)}` }, // missing auth
    }).ok,
    false
  );
});

test('tag validation', () => {
  assert.equal(validateTag('release-2.0').ok, true);
  assert.equal(validateTag(null).value, null);
  assert.equal(validateTag('bad tag!').ok, false);
  assert.equal(validateTag('x'.repeat(LIMITS.tag + 1)).ok, false);
});

test('icon validation: internal path or https only', () => {
  assert.equal(validateIconUrl('/icons/a.png').ok, true);
  assert.equal(validateIconUrl('https://cdn.example.com/i.png').ok, true);
  assert.equal(validateIconUrl('http://cdn.example.com/i.png').ok, false);
  assert.equal(validateIconUrl('javascript:alert(1)').ok, false);
  assert.equal(validateIconUrl('').value, null);
});

test('scheduledAt must be a future ISO timestamp', () => {
  const now = Date.now();
  assert.equal(validateFutureTimestamp(undefined, { now }).value, null);
  assert.equal(validateFutureTimestamp('not-a-date', { now }).ok, false);
  assert.equal(validateFutureTimestamp(new Date(now + 5000).toISOString(), { now }).ok, false, 'too soon');
  assert.equal(validateFutureTimestamp(new Date(now + 3600000).toISOString(), { now }).ok, true);
});

test('notification input aggregates errors and normalizes valid input', () => {
  const bad = validateNotificationInput(
    { title: '', body: 'x'.repeat(500), destinationUrl: 'https://evil.com', tag: '!!' },
    ORIGIN
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 3, `expected multiple errors, got: ${bad.errors}`);

  const good = validateNotificationInput(
    { title: '  Hello ', body: 'World', destinationUrl: 'https://example.com/a', tag: 't1' },
    ORIGIN
  );
  assert.equal(good.ok, true);
  assert.equal(good.value.title, 'Hello');
  assert.equal(good.value.destinationUrl, '/a');
  assert.equal(good.value.tag, 't1');
  assert.equal(good.value.scheduledAt, null);
});

test('paginate clamps page and pageSize', () => {
  assert.deepEqual(paginate({}), { page: 1, pageSize: 20, offset: 0 });
  assert.deepEqual(paginate({ page: '-3', pageSize: '5' }), { page: 1, pageSize: 5, offset: 0 });
  assert.equal(paginate({ pageSize: '9999' }).pageSize, LIMITS.pageSize);
  assert.equal(paginate({ page: '3', pageSize: '10' }).offset, 20);
});

test('maskEndpoint never exposes the raw endpoint', () => {
  const masked = maskEndpoint('https://fcm.googleapis.com/fcm/send/VERY-SECRET-ENDPOINT-ID');
  assert.ok(!masked.includes('VERY-SECRET-ENDPOINT-ID'));
  assert.ok(masked.includes('…'));
  assert.ok(masked.includes('fcm.googleapis.com'));
});
