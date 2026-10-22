/**
 * Small in-memory sliding-window rate limiter.
 * Suitable for a single-process deployment (the documented VPS setup).
 * Returns 429 with Retry-After when a key exceeds `max` hits per window.
 */
export function createRateLimiter({ windowMs, max, keyFn = (req) => req.ip, message = 'Too many requests' }) {
  const hits = new Map();
  let lastPrune = 0;

  function prune(now) {
    if (now - lastPrune < windowMs) return;
    lastPrune = now;
    for (const [key, entry] of hits) {
      if (now - entry.start >= windowMs) hits.delete(key);
    }
  }

  function limiter(req, res, next) {
    const now = Date.now();
    prune(now);
    const key = keyFn(req) || 'unknown';
    let entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: { code: 'rate_limited', message } });
    }
    next();
  }

  limiter.reset = () => hits.clear();
  limiter.size = () => hits.size;
  return limiter;
}

/** Login limiter keyed by IP AND username so one attacker cannot lock out
 *  every account from one IP, nor hammer one account from many IPs fast. */
export function createLoginRateLimiter({ windowMs, max }) {
  return createRateLimiter({
    windowMs,
    max,
    keyFn: (req) => {
      const username = typeof req.body?.username === 'string' ? req.body.username.toLowerCase().slice(0, 64) : '';
      return `${req.ip}|${username}`;
    },
    message: 'Too many login attempts. Try again later.',
  });
}
