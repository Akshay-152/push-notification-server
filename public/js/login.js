/**
 * Admin login form.
 * Fetches a CSRF token first (GET /api/config), then posts credentials.
 * Never stores credentials; redirects to the dashboard on success.
 */
const form = document.getElementById('login-form');
const errorEl = document.getElementById('login-error');
const loadingEl = document.getElementById('login-loading');
const btn = document.getElementById('login-btn');

let csrfToken = null;

async function api(path, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (csrfToken) headers['x-csrf-token'] = csrfToken;

  let res;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body });
  } catch {
    const err = new Error('Could not reach the server. Check your connection and try again.');
    err.status = 0;
    throw err;
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Request failed (HTTP ${res.status}).`);
    err.status = res.status;
    err.retryAfter = res.headers.get('retry-after');
    throw err;
  }
  return json?.data;
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}
function clearError() {
  errorEl.hidden = true;
}
function setLoading(on) {
  loadingEl.hidden = !on;
  btn.disabled = on;
}

async function init() {
  try {
    const data = await api('/api/config');
    csrfToken = data.csrfToken;
    // Already signed in? Go straight to the dashboard.
    const me = await fetch('/api/auth/me', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (me.ok) window.location.replace('/admin.html');
  } catch (err) {
    showError(err.message);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) {
    showError('Enter your username and password.');
    return;
  }

  setLoading(true);
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    window.location.replace('/admin.html');
  } catch (err) {
    if (err.status === 429 && err.retryAfter) {
      showError(`Too many attempts. Try again in ${err.retryAfter} seconds.`);
    } else {
      showError(err.message);
    }
    setLoading(false);
  }
});

init();
