/**
 * Service worker: background push + notification clicks.
 *
 * Payload schema (JSON, versioned with "v"):
 *   { v: 1, title, body, url, icon, tag, timestamp }
 *
 * Duplicate handling:
 *   - `tag` (payload tag or `n-<notification id>`) groups notifications;
 *     browsers replace an existing visible notification with the same tag
 *     instead of stacking duplicates. The `renotify` option is intentionally
 *     unset so replacements do not re-alert the user.
 *   - Because the tag derives from the notification id, re-sends of the same
 *     campaign collapse; different campaigns always stack separately.
 *
 * Trust: payloads are encrypted end-to-end for this subscription, but we
 * still validate shape, clamp lengths, and only navigate to URLs on this
 * site's own origin.
 */
const SW_VERSION = 'v1';

/* Install/activate: new worker takes control immediately so the next
 * notification is handled by fresh code. Browsers still check sw.js for
 * updates on navigation (served with no-cache). */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older versions, if any were ever created.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('notifyme-')).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

/** Clamp strings from the payload so a hostile/broken sender can't bloat UI. */
function clamp(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

/** Only allow navigation targets on this exact origin (no open redirects). */
function safeUrl(raw) {
  const fallback = '/';
  if (!raw || typeof raw !== 'string') return fallback;
  try {
    const resolved = new URL(raw, self.location.origin);
    if (resolved.origin !== self.location.origin) return fallback;
    return resolved.pathname + resolved.search;
  } catch {
    return fallback;
  }
}

self.addEventListener('push', (event) => {
  const process = async () => {
    let payload = null;
    let rawText = '';
    try {
      if (event.data) {
        rawText = event.data.text();
        payload = JSON.parse(rawText);
      }
    } catch {
      payload = null; // malformed JSON -> handled below
    }

    const valid = payload && typeof payload === 'object';
    const title = valid ? clamp(payload.title?.trim?.() ?? '', 80) : '';
    const body = valid ? clamp(payload.body, 300) : clamp(rawText, 300);

    const options = {
      body: body || 'A new notification is available.',
      icon: valid && typeof payload.icon === 'string' ? payload.icon : '/icons/icon-192.png',
      badge: '/icons/badge.png',
      tag: (valid && clamp(payload.tag, 64)) || 'notifyme',
      timestamp: valid && Number.isFinite(Date.parse(payload.timestamp))
        ? Date.parse(payload.timestamp)
        : Date.now(),
      data: { url: safeUrl(valid ? payload.url : null) },
      renotify: false,
      requireInteraction: false,
    };

    await self.registration.showNotification(title || 'Notification', options);
  };

  event.waitUntil(process().catch(() => {
    // Last resort: never drop a push silently without telling the user.
    return self.registration.showNotification('Notification', {
      body: 'A new notification is available.',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge.png',
      tag: 'notifyme-fallback',
      data: { url: '/' },
    });
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const target = safeUrl(event.notification.data?.url);
  const url = new URL(target, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of allClients) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          await client.focus();
          if ('navigate' in client) await client.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
