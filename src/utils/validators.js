/** Central input limits (documented in README and enforced server-side). */
export const LIMITS = {
  title: 80,
  body: 300,
  url: 2048,
  tag: 64,
  icon: 2048,
  username: 64,
  password: { min: 10, max: 128 },
  endpoint: 2048,
  pageSize: 100,
};

export function isNonEmptyString(value, max = Infinity) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function fail(...messages) {
  return { ok: false, errors: messages };
}

export function pass(value) {
  return { ok: true, value };
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Validate the destination a notification click should open.
 * Accepts an internal path ("/news/42") or an absolute same-origin URL.
 * Rejects javascript:, data:, protocol-relative ("//evil"), other origins,
 * and anything that would amount to an open redirect.
 * Always returns a normalized internal path (never an absolute URL).
 */
export function validateDestinationUrl(raw, siteOrigin) {
  if (!isNonEmptyString(raw, LIMITS.url)) {
    return fail('destinationUrl must be a non-empty string of at most 2048 characters');
  }
  const value = raw.trim();

  if (value.startsWith('/') && !value.startsWith('//')) {
    // Internal path: normalize to block path tricks like "/\evil" or embedded schemes.
    try {
      const resolved = new URL(value, siteOrigin);
      if (resolved.origin !== siteOrigin) return fail('destinationUrl resolves outside this site');
      return pass(resolved.pathname + resolved.search);
    } catch {
      return fail('destinationUrl is not a valid path');
    }
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return fail('destinationUrl must be an internal path (/page) or an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('destinationUrl must use http(s)');
  }
  if (parsed.origin !== siteOrigin) {
    return fail(`destinationUrl must point to ${siteOrigin}`);
  }
  return pass(parsed.pathname + parsed.search);
}

/**
 * Optional notification icon: internal path or absolute https URL.
 */
export function validateIconUrl(raw) {
  if (raw === undefined || raw === null || raw === '') return pass(null);
  if (!isNonEmptyString(raw, LIMITS.icon)) {
    return fail(`icon must be a string of at most ${LIMITS.icon} characters`);
  }
  const value = raw.trim();
  if (value.startsWith('/') && !value.startsWith('//')) {
    if (value.includes('..')) return fail('icon path is invalid');
    return pass(value);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return fail('icon must be an internal path or an absolute URL');
  }
  if (parsed.protocol !== 'https:') return fail('icon URL must be https');
  return pass(parsed.href);
}

/** Optional dedup tag: short, URL/JSON safe. */
export function validateTag(raw) {
  if (raw === undefined || raw === null || raw === '') return pass(null);
  if (typeof raw !== 'string' || raw.length > LIMITS.tag) {
    return fail(`tag must be a string of at most ${LIMITS.tag} characters`);
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(raw)) {
    return fail('tag may only contain letters, digits and . _ : -');
  }
  return pass(raw);
}

/**
 * Validate an ISO timestamp used for scheduling (must be in the future).
 */
export function validateFutureTimestamp(raw, { now = Date.now() } = {}) {
  if (raw === undefined || raw === null || raw === '') return pass(null);
  if (typeof raw !== 'string') return fail('scheduledAt must be an ISO timestamp string');
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return fail('scheduledAt must be a valid ISO timestamp');
  if (ts < now + 30_000) return fail('scheduledAt must be at least 30 seconds in the future');
  return pass(new Date(ts).toISOString());
}

/**
 * Validate the PushSubscription JSON posted by the browser.
 * The endpoint is treated purely as a delivery address, never as identity.
 */
export function validatePushSubscription(raw) {
  if (!raw || typeof raw !== 'object') {
    return fail('subscription must be an object');
  }
  const { endpoint, keys } = raw;
  if (!isNonEmptyString(endpoint, LIMITS.endpoint)) {
    return fail('subscription.endpoint is missing or too long');
  }
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return fail('subscription.endpoint must be a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    // Allow plain http only against loopback for local development.
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'http:' || !isLoopback) {
      return fail('subscription.endpoint must use https');
    }
  }
  if (!keys || typeof keys !== 'object') return fail('subscription.keys is required');
  const { p256dh, auth } = keys;
  if (!isNonEmptyString(p256dh, 256) || !BASE64URL_RE.test(p256dh)) {
    return fail('subscription.keys.p256dh must be a base64url key');
  }
  if (!isNonEmptyString(auth, 256) || !BASE64URL_RE.test(auth)) {
    return fail('subscription.keys.auth must be a base64url key');
  }
  if (p256dh.length < 40 || auth.length < 20) {
    return fail('subscription.keys contain malformed key material');
  }
  return pass({ endpoint, keys: { p256dh, auth } });
}

/** Validate and normalize the compose-notification request body. */
export function validateNotificationInput(body, siteOrigin, now = Date.now()) {
  if (!body || typeof body !== 'object') return fail('Request body must be a JSON object');
  const errors = [];

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length < 1 || title.length > LIMITS.title) {
    errors.push(`title must be 1-${LIMITS.title} characters`);
  }

  const message = typeof body.body === 'string' ? body.body.trim() : '';
  if (message.length < 1 || message.length > LIMITS.body) {
    errors.push(`body must be 1-${LIMITS.body} characters`);
  }

  const url = validateDestinationUrl(body.destinationUrl ?? body.url, siteOrigin);
  if (!url.ok) errors.push(...url.errors);

  const icon = validateIconUrl(body.icon);
  if (!icon.ok) errors.push(...icon.errors);

  const tag = validateTag(body.tag);
  if (!tag.ok) errors.push(...tag.errors);

  const scheduledAt = validateFutureTimestamp(body.scheduledAt, { now });
  if (!scheduledAt.ok) errors.push(...scheduledAt.errors);

  if (errors.length) return fail(...errors);

  return pass({
    title,
    body: message,
    destinationUrl: url.value,
    icon: icon.value,
    tag: tag.value,
    scheduledAt: scheduledAt.value,
  });
}

/** Parse pagination query params with safe bounds. */
export function paginate(query = {}, { defaultPageSize = 20 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  let pageSize = Number.parseInt(query.pageSize, 10) || defaultPageSize;
  pageSize = Math.min(Math.max(1, pageSize), LIMITS.pageSize);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Mask a push endpoint so raw URLs/auth material never reach the UI. */
export function maskEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    const tail = u.pathname.slice(-4);
    return `${u.host}/…${tail ? tail : ''}`;
  } catch {
    return '…';
  }
}
