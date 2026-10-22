/**
 * Public subscription page logic.
 *
 * Permission is requested ONLY from the explicit "Enable notifications"
 * button click. Users who previously denied are shown guidance instead of
 * being prompted again (browsers ignore repeat requests anyway).
 */
const els = {
  dot: document.getElementById('status-dot'),
  title: document.getElementById('status-title'),
  detail: document.getElementById('status-detail'),
  enable: document.getElementById('enable-btn'),
  disable: document.getElementById('disable-btn'),
  refresh: document.getElementById('refresh-btn'),
  denied: document.getElementById('denied-notice'),
  error: document.getElementById('error-notice'),
  success: document.getElementById('success-notice'),
  loading: document.getElementById('loading-notice'),
  year: document.getElementById('year'),
};

if (els.year) els.year.textContent = new Date().getFullYear();

let appConfig = null;
let csrfToken = null;

const supported =
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

/* ---------------------------------------------------------------- api --- */

async function api(path, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (csrfToken) headers['x-csrf-token'] = csrfToken;

  let res;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    throw new Error(json?.error?.message || `Request failed (HTTP ${res.status}).`);
  }
  return json?.data;
}

async function loadConfig() {
  const data = await api('/api/config');
  appConfig = data;
  csrfToken = data.csrfToken;
  return data;
}

/* --------------------------------------------------------------- ui ----- */

function setLoading(on) {
  els.loading.hidden = !on;
  els.enable.disabled = on;
  els.disable.disabled = on;
  els.refresh.disabled = on;
}

function clearMessages() {
  els.error.hidden = true;
  els.success.hidden = true;
}
function showError(msg) {
  els.success.hidden = true;
  els.error.textContent = msg;
  els.error.hidden = false;
}
function showSuccess(msg) {
  els.error.hidden = true;
  els.success.textContent = msg;
  els.success.hidden = false;
}

const STATES = {
  unsupported: {
    dot: 'denied',
    title: 'Notifications not supported',
    detail:
      'This browser does not support Web Push. Try a recent version of Chrome, Edge, Firefox, or Safari (macOS 16.4+).',
  },
  denied: {
    dot: 'denied',
    title: 'Notifications are blocked',
    detail: 'You previously denied permission for this site.',
  },
  subscribed: {
    dot: 'active',
    title: 'Notifications are enabled',
    detail: 'You will receive messages published on this site.',
  },
  granted: {
    dot: 'off',
    title: 'Permission granted',
    detail: 'Your browser allows notifications — finish by subscribing.',
  },
  default: {
    dot: 'off',
    title: 'Notifications are off',
    detail: 'Enable them to receive updates when the site is closed.',
  },
  checking: { dot: 'unknown', title: 'Checking status…', detail: 'Looking up your notification settings.' },
};

function render(stateName, detailOverride) {
  const s = STATES[stateName] || STATES.default;
  els.dot.dataset.state = s.dot;
  els.title.textContent = s.title;
  els.detail.textContent = detailOverride || s.detail;

  const isSubscribed = stateName === 'subscribed';
  els.enable.hidden = isSubscribed || stateName === 'unsupported';
  els.disable.hidden = !isSubscribed;
  els.enable.textContent = stateName === 'granted' ? 'Finish setup' : 'Enable notifications';
  els.denied.hidden = stateName !== 'denied';
}

async function refreshStatus({ quiet = false } = {}) {
  if (!quiet) render('checking');
  try {
    if (!appConfig) await loadConfig();

    const localPermission = supported ? Notification.permission : 'unsupported';
    const data = await api('/api/subscriptions/status');
    const serverCount = data.subscriptions?.length || 0;
    csrfToken = data.csrfToken || csrfToken;

    let state;
    if (!supported) state = 'unsupported';
    else if (localPermission === 'denied') state = 'denied';
    else if (localPermission === 'granted' && serverCount > 0) state = 'subscribed';
    else if (localPermission === 'granted') state = 'granted';
    else state = 'default';

    render(state, serverCount > 1 ? `${serverCount} active subscriptions on this browser.` : undefined);
    return { state, serverCount };
  } catch (err) {
    if (!quiet) {
      render('default', 'Could not read your subscription status.');
      showError(err.message);
    }
    return { state: 'error', serverCount: 0 };
  }
}

/* ------------------------------------------------------------ actions --- */

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

async function enableNotifications() {
  clearMessages();
  setLoading(true);
  try {
    if (!supported) throw new Error('This browser does not support push notifications.');
    if (!appConfig) await loadConfig();

    // 1. Register the service worker (no permission prompt here).
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;

    // 2. Ask for permission — only from this explicit click.
    let permission = Notification.permission;
    if (permission !== 'granted') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      await refreshStatus({ quiet: true });
      render(permission === 'denied' ? 'denied' : 'default');
      if (permission === 'denied') {
        showError('Permission was denied. See the guidance above to re-enable notifications.');
      } else {
        showError('Permission was not granted. You can try again any time.');
      }
      return;
    }

    // 3. Subscribe with our VAPID public key and send it to our backend.
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(appConfig.vapidPublicKey),
    });
    await api('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });

    showSuccess('Notifications enabled! You will receive messages published here.');
    await refreshStatus({ quiet: true });
    render('subscribed');
  } catch (err) {
    showError(err.message);
    await refreshStatus({ quiet: true }).catch(() => {});
  } finally {
    setLoading(false);
  }
}

async function disableNotifications() {
  clearMessages();
  setLoading(true);
  try {
    // Unsubscribe locally first, then remove on the backend.
    if (supported) {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    }
    const data = await api('/api/subscriptions/current', { method: 'DELETE' });
    showSuccess(
      data.removed > 0
        ? 'Unsubscribed. You will no longer receive notifications from this site.'
        : 'Already unsubscribed.'
    );
    await refreshStatus({ quiet: true });
    render(Notification.permission === 'denied' ? 'denied' : 'default');
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

/* ------------------------------------------------------------- wiring --- */

els.enable.addEventListener('click', enableNotifications);
els.disable.addEventListener('click', disableNotifications);
els.refresh.addEventListener('click', () => refreshStatus());

// Register the SW early (no prompt) so updates are picked up promptly.
if (supported) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
    /* registration failure surfaces when the user tries to subscribe */
  });
}

refreshStatus();

// If the user changes browser permission elsewhere, keep state fresh.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshStatus({ quiet: true });
});
