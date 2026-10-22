/**
 * Admin dashboard (single-page, hash-free view switching).
 *
 * Security notes:
 *  - Every state-changing request carries the session CSRF token.
 *  - All dynamic content is rendered with textContent / createElement -
 *    never innerHTML - so notification content cannot inject markup (XSS).
 *  - A 401 from any endpoint redirects to the login page.
 */

const state = {
  csrfToken: null,
  admin: null,
  view: 'overview',
  subs: { page: 1, search: '', status: 'all' },
  hist: { page: 1, search: '' },
  detail: { id: null, page: 1, result: 'all' },
  compose: { pollTimer: null, notificationId: null, activeSubs: null },
};

/* ------------------------------------------------------------- helpers -- */

function $(id) {
  return document.getElementById(id);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function fmtShortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function statusBadge(status) {
  const map = {
    sent: ['ok', 'sent'],
    partially_failed: ['warn', 'partially failed'],
    failed: ['bad', 'failed'],
    cancelled: ['mute', 'cancelled'],
    sending: ['info', 'sending…'],
    queued: ['info', 'queued'],
    scheduled: ['info', 'scheduled'],
    active: ['ok', 'active'],
    inactive: ['mute', 'inactive'],
    accepted: ['ok', 'accepted'],
  };
  const [cls, label] = map[status] || ['mute', String(status)];
  return el('span', { class: `badge ${cls}`, text: label });
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (state.csrfToken) headers['x-csrf-token'] = state.csrfToken;

  let res;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body });
  } catch {
    const err = new Error('Could not reach the server. Check your connection.');
    err.status = 0;
    throw err;
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  if (res.status === 401) {
    window.location.replace('/admin-login.html');
    const err = new Error('Session expired');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Request failed (HTTP ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return json?.data;
}

function flash(containerId, kind, message) {
  const box = $(containerId);
  box.textContent = message;
  box.className = `notice notice-${kind}`;
  box.hidden = false;
}

/* --------------------------------------------------------------- views -- */

function showView(name) {
  state.view = name;
  for (const btn of document.querySelectorAll('.side-nav button')) {
    btn.classList.toggle('active', btn.dataset.view === name);
  }
  for (const section of document.querySelectorAll('.view')) {
    section.hidden = section.id !== `view-${name}`;
  }
  if (name === 'overview') loadOverview();
  if (name === 'subscribers') loadSubscribers();
  if (name === 'history') loadHistory();
}

/* ------------------------------------------------------------ overview -- */

async function loadOverview() {
  try {
    const data = await api('/api/admin/dashboard');
    const { subscriptions, notifications, delivery, recentNotifications, trend } = data;

    const cards = $('stat-cards');
    cards.replaceChildren(
      el('div', { class: 'stat' },
        el('div', { class: 'label', text: 'Active subscribers' }),
        el('div', { class: 'value', text: String(subscriptions.active) }),
        el('div', { class: 'foot', text: `${subscriptions.total} total · ${subscriptions.inactive} inactive` })),
      el('div', { class: 'stat' },
        el('div', { class: 'label', text: 'Notifications dispatched' }),
        el('div', { class: 'value', text: String(notifications.dispatched) }),
        el('div', { class: 'foot', text: `${notifications.total} total including drafts/scheduled` })),
      el('div', { class: 'stat good' },
        el('div', { class: 'label', text: 'Accepted by push services' }),
        el('div', { class: 'value', text: String(delivery.accepted) }),
        el('div', { class: 'foot', text: `of ${delivery.attempted} delivery attempts` })),
      el('div', { class: 'stat bad' },
        el('div', { class: 'label', text: 'Failed deliveries' }),
        el('div', { class: 'value', text: String(delivery.failed) }),
        el('div', { class: 'foot', text: 'permanent errors + exhausted retries' }))
    );

    // Accurate labeling of what "accepted" means.
    let note = document.getElementById('delivery-note');
    if (!note) {
      note = el('p', { class: 'fineprint', id: 'delivery-note' });
      cards.insertAdjacentElement('afterend', note);
    }
    note.textContent = delivery.note;

    // Trend chart.
    const chart = $('trend-chart');
    const labels = $('trend-labels');
    const max = Math.max(1, ...trend.map((t) => t.count));
    const any = trend.some((t) => t.count > 0);
    $('trend-empty').hidden = any;
    chart.hidden = !any;
    labels.hidden = !any;
    chart.replaceChildren(...trend.map((t) =>
      el('div', {
        class: `bar${t.count === 0 ? ' zero' : ''}`,
        style: `height:${Math.max(4, Math.round((t.count / max) * 100))}%`,
        title: `${t.day}: ${t.count} new`,
      })
    ));
    labels.replaceChildren(...trend.map((t, i) =>
      el('span', { text: i % 3 === 0 ? t.day.slice(5) : '' })
    ));

    // Recent notifications.
    const body = $('recent-body');
    if (recentNotifications.length === 0) {
      body.replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'empty', text: 'No notifications sent yet.' })));
    } else {
      body.replaceChildren(...recentNotifications.map((n) => el('tr', {},
        el('td', { text: n.title }),
        el('td', { text: n.created_by_username || '—' }),
        el('td', { text: fmtShortDate(n.created_at) }),
        el('td', {}, statusBadge(n.status)),
        el('td', { class: 'num', text: String(n.counts?.accepted ?? 0) }),
        el('td', { class: 'num', text: String(n.counts?.failed ?? 0) })
      )));
    }
  } catch (err) {
    if (err.status !== 401) console.error(err);
  }
}

/* ------------------------------------------------------------- compose -- */

function updatePreview() {
  const title = $('f-title').value.trim();
  const body = $('f-body').value.trim();
  const url = $('f-url').value.trim();
  const icon = $('f-icon').value.trim();

  $('pv-title').textContent = title || 'Your notification title';
  $('pv-body').textContent = body || 'Your message will appear here.';
  $('pv-url').textContent = url || '/';
  $('pv-icon').src = icon || '/icons/icon-192.png';
  $('pv-icon').onerror = () => { $('pv-icon').src = '/icons/icon-192.png'; };

  $('title-count').textContent = `${$('f-title').value.length}/80`;
  $('body-count').textContent = `${$('f-body').value.length}/300`;
  $('title-count').classList.toggle('over', $('f-title').value.length >= 80);
  $('body-count').classList.toggle('over', $('f-body').value.length >= 300);
}

function readComposeForm() {
  const scheduledRaw = $('f-schedule').value;
  return {
    title: $('f-title').value.trim(),
    body: $('f-body').value.trim(),
    destinationUrl: $('f-url').value.trim(),
    icon: $('f-icon').value.trim() || null,
    tag: $('f-tag').value.trim() || null,
    scheduledAt: scheduledRaw ? new Date(scheduledRaw).toISOString() : null,
  };
}

function validateCompose(input) {
  const errors = [];
  if (input.title.length < 1 || input.title.length > 80) errors.push('Title must be 1-80 characters.');
  if (input.body.length < 1 || input.body.length > 300) errors.push('Message must be 1-300 characters.');
  if (!input.destinationUrl) errors.push('Destination URL is required.');
  else if (input.destinationUrl.length > 2048) errors.push('Destination URL is too long.');
  if (input.tag && !/^[A-Za-z0-9._:-]+$/.test(input.tag)) errors.push('Tag may only contain letters, digits and . _ : -');
  if (input.scheduledAt && Date.parse(input.scheduledAt) < Date.now() + 30_000) {
    errors.push('Scheduled time must be at least 30 seconds in the future.');
  }
  return errors;
}

async function openConfirm() {
  $('compose-error').hidden = true;
  const input = readComposeForm();
  const errors = validateCompose(input);
  if (errors.length) {
    flash('compose-error', 'error', errors.join(' '));
    return;
  }
  try {
    // Recipient count comes from the server, not client-side guesses.
    const data = await api('/api/admin/subscriptions?pageSize=1');
    const total = data.pagination.total;
    state.compose.activeSubs = total;
    const target = input.scheduledAt
      ? `Schedule this notification for ${fmtShortDate(input.scheduledAt)}?`
      : 'Send this notification now?';
    $('confirm-text').textContent = total === 0
      ? `${target} There are currently 0 subscribers, so no messages will be delivered.`
      : `${target} It will be delivered to ${total} subscriber${total === 1 ? '' : 's'}.`;
    $('confirm-box').hidden = false;
    $('send-btn').disabled = true;
    $('confirm-send').focus();
  } catch (err) {
    flash('compose-error', 'error', err.message);
  }
}

function closeConfirm() {
  $('confirm-box').hidden = true;
  $('send-btn').disabled = false;
}

async function submitNotification() {
  const input = readComposeForm();
  closeConfirm();
  $('compose-info').hidden = true;
  $('compose-error').hidden = true;
  $('result-grid').hidden = true;
  $('cancel-send').hidden = true;
  $('progress-fill').className = 'progress-fill';
  $('progress-box').hidden = false;
  $('progress-title').textContent = input.scheduledAt ? 'Scheduled' : 'Sending…';
  $('progress-text').textContent = input.scheduledAt
    ? `Queued for ${fmtShortDate(input.scheduledAt)}. It survives server restarts.`
    : 'Queued — starting delivery…';

  try {
    const data = await api('/api/admin/notifications', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const notification = data.notification;
    state.compose.notificationId = notification.id;

    if (input.scheduledAt) {
      $('progress-title').textContent = 'Scheduled ✓';
      $('progress-fill').className = 'progress-fill done';
      flash('compose-info', 'info',
        `Notification #${notification.id} scheduled for ${fmtShortDate(input.scheduledAt)}. See History for results.`);
      return;
    }
    $('cancel-send').hidden = false;
    startPolling(notification.id);
  } catch (err) {
    $('progress-box').hidden = true;
    flash('compose-error', 'error', err.message);
  }
}

function startPolling(id) {
  stopPolling();
  const tick = async () => {
    try {
      const data = await api(`/api/admin/notifications/${id}`);
      renderProgress(data.notification);
      if (!['queued', 'sending'].includes(data.notification.status)) {
        stopPolling();
        $('cancel-send').hidden = true;
        loadOverview();
      }
    } catch (err) {
      stopPolling();
      flash('compose-error', 'error', err.message);
    }
  };
  tick();
  state.compose.pollTimer = setInterval(tick, 1500);
}

function stopPolling() {
  if (state.compose.pollTimer) {
    clearInterval(state.compose.pollTimer);
    state.compose.pollTimer = null;
  }
}

function renderProgress(n) {
  const counts = n.counts || { accepted: 0, failed: 0, attempted: 0 };
  const terminal = ['sent', 'partially_failed', 'failed', 'cancelled'].includes(n.status);

  $('progress-title').textContent =
    n.status === 'sending' ? 'Sending…'
      : n.status === 'queued' ? 'Queued…'
        : n.status === 'cancelled' ? 'Cancelled'
          : n.status === 'sent' ? 'Delivered ✓'
            : n.status === 'partially_failed' ? 'Partially delivered'
              : n.status === 'failed' ? 'Delivery failed' : n.status;

  $('progress-fill').className =
    `progress-fill${terminal ? (n.status === 'failed' ? ' failed' : ' done') : ''}`;

  $('progress-text').textContent = terminal
    ? 'Delivery finished. Stats below are final.'
    : `${counts.attempted} delivery attempt${counts.attempted === 1 ? '' : 's'} recorded so far…`;

  const grid = $('result-grid');
  grid.hidden = false;
  grid.replaceChildren(
    el('div', { class: 'stat' },
      el('div', { class: 'label', text: 'Attempted' }),
      el('div', { class: 'value', text: String(counts.attempted) })),
    el('div', { class: 'stat good' },
      el('div', { class: 'label', text: 'Accepted' }),
      el('div', { class: 'value', text: String(counts.accepted) })),
    el('div', { class: 'stat bad' },
      el('div', { class: 'label', text: 'Failed' }),
      el('div', { class: 'value', text: String(counts.failed) }))
  );

  if (['queued', 'sending'].includes(n.status)) $('cancel-send').hidden = false;
}

async function cancelSend() {
  const id = state.compose.notificationId;
  if (!id) return;
  try {
    await api(`/api/admin/notifications/${id}/cancel`, { method: 'POST', body: '{}' });
    $('progress-text').textContent = 'Cancellation requested — finishing current batch…';
  } catch (err) {
    flash('compose-error', 'error', err.message);
  }
}

/* ---------------------------------------------------------- subscribers -- */

async function loadSubscribers() {
  const { page, search, status } = state.subs;
  try {
    const qs = new URLSearchParams({
      page: String(page),
      pageSize: '20',
      search,
      status,
    });
    const [subsData, dash] = await Promise.all([
      api(`/api/admin/subscriptions?${qs}`),
      api('/api/admin/dashboard'),
    ]);

    $('subs-counts').textContent =
      `${dash.subscriptions.active} active · ${dash.subscriptions.inactive} inactive · ${dash.subscriptions.total} total`;

    const body = $('subs-body');
    if (subsData.items.length === 0) {
      body.replaceChildren(el('tr', {},
        el('td', { colspan: '7', class: 'empty', text: 'No subscribers match this filter.' })));
    } else {
      body.replaceChildren(...subsData.items.map((s) => {
        const ua = s.userAgent || '';
        const browser = truncate(
          (ua.match(/(Firefox|Edg|Chrome|Safari)\/[\d.]+/) || [ua.slice(0, 40) || '—'])[0], 28
        );
        const row = el('tr', {},
          el('td', { text: String(s.id) }),
          el('td', { class: 'mono', text: s.maskedEndpoint }),
          el('td', {}, statusBadge(s.active ? 'active' : 'inactive')),
          el('td', { text: fmtShortDate(s.createdAt) }),
          el('td', { text: fmtShortDate(s.lastSuccessAt) }),
          el('td', { text: browser || '—' }),
          el('td', {},
            s.active
              ? el('button', {
                class: 'btn btn-danger btn-sm',
                text: 'Deactivate',
                onclick: async () => {
                  if (!window.confirm(`Deactivate subscription #${s.id}? It will stop receiving messages.`)) return;
                  try {
                    await api(`/api/admin/subscriptions/${s.id}`, { method: 'DELETE' });
                    loadSubscribers();
                  } catch (err) {
                    window.alert(err.message);
                  }
                },
              })
              : el('span', { class: 'muted', text: '—' }))
        );
        return row;
      }));
    }

    const { totalPages } = subsData.pagination;
    $('subs-page-info').textContent = `Page ${subsData.pagination.page} of ${totalPages} · ${subsData.pagination.total} subscribers`;
    $('subs-prev').disabled = subsData.pagination.page <= 1;
    $('subs-next').disabled = subsData.pagination.page >= totalPages;
  } catch (err) {
    if (err.status !== 401) window.alert(err.message);
  }
}

async function cleanupSubscribers() {
  const ok = window.confirm(
    'Permanently delete inactive subscriptions older than the retention period?\n' +
    'Active subscriptions are not affected. Delivery history is kept.'
  );
  if (!ok) return;
  try {
    const data = await api('/api/admin/subscriptions/cleanup', { method: 'POST', body: '{}' });
    window.alert(`Deleted ${data.deleted} expired subscription${data.deleted === 1 ? '' : 's'}.`);
    loadSubscribers();
  } catch (err) {
    window.alert(err.message);
  }
}

/* -------------------------------------------------------------- history -- */

async function loadHistory() {
  const { page, search } = state.hist;
  try {
    const qs = new URLSearchParams({ page: String(page), pageSize: '20', search });
    const data = await api(`/api/admin/notifications?${qs}`);
    const body = $('hist-body');
    if (data.items.length === 0) {
      body.replaceChildren(el('tr', {},
        el('td', { colspan: '7', class: 'empty', text: 'No notifications yet.' })));
    } else {
      body.replaceChildren(...data.items.map((n) => {
        const row = el('tr', { class: 'clickable', tabindex: '0' },
          el('td', { text: `#${n.id}` }),
          el('td', { text: n.title }),
          el('td', { text: n.created_by_username || '—' }),
          el('td', { text: fmtShortDate(n.created_at) }),
          el('td', {}, statusBadge(n.status)),
          el('td', { class: 'num', text: String(n.counts?.accepted ?? 0) }),
          el('td', { class: 'num', text: String(n.counts?.failed ?? 0) })
        );
        const open = () => openDetail(n.id);
        row.addEventListener('click', open);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
        return row;
      }));
    }
    const { totalPages, total } = data.pagination;
    $('hist-page-info').textContent = `Page ${data.pagination.page} of ${totalPages} · ${total} notifications`;
    $('hist-prev').disabled = data.pagination.page <= 1;
    $('hist-next').disabled = data.pagination.page >= totalPages;
  } catch (err) {
    if (err.status !== 401) window.alert(err.message);
  }
}

async function openDetail(id) {
  state.detail = { id, page: 1, result: 'all' };
  $('detail-filter').value = 'all';
  $('history-list-panel').hidden = true;
  $('history-detail-panel').hidden = false;
  await loadDetail();
}

async function loadDetail() {
  const { id, page, result } = state.detail;
  try {
    const qs = new URLSearchParams({ page: String(page), pageSize: '20', result });
    const [detail, results] = await Promise.all([
      api(`/api/admin/notifications/${id}`),
      api(`/api/admin/notifications/${id}/results?${qs}`),
    ]);
    const n = detail.notification;

    $('detail-title').textContent = `#${n.id} — ${n.title}`;
    $('detail-status').replaceChildren(statusBadge(n.status));

    const kv = $('detail-kv');
    kv.replaceChildren(
      el('dt', { text: 'Message' }), el('dd', { text: n.body }),
      el('dt', { text: 'Destination' }), el('dd', { class: 'mono', text: n.destination_url }),
      el('dt', { text: 'Sent by' }), el('dd', { text: n.created_by_username || '—' }),
      el('dt', { text: 'Created' }), el('dd', { text: fmtDate(n.created_at) }),
      el('dt', { text: 'Scheduled' }), el('dd', { text: n.scheduled_at ? fmtDate(n.scheduled_at) : '—' }),
      el('dt', { text: 'Tag' }), el('dd', { text: n.tag || '(default)' }),
      el('dt', { text: 'Icon' }), el('dd', { class: 'mono', text: n.icon || '(default)' })
    );

    const counts = $('detail-counts');
    counts.replaceChildren(
      el('div', { class: 'stat' },
        el('div', { class: 'label', text: 'Attempted' }),
        el('div', { class: 'value', text: String(n.counts.attempted) })),
      el('div', { class: 'stat good' },
        el('div', { class: 'label', text: 'Accepted' }),
        el('div', { class: 'value', text: String(n.counts.accepted) })),
      el('div', { class: 'stat bad' },
        el('div', { class: 'label', text: 'Failed' }),
        el('div', { class: 'value', text: String(n.counts.failed) })),
      el('div', { class: 'stat' },
        el('div', { class: 'label', text: 'Skipped' }),
        el('div', { class: 'value', text: String(n.counts.skipped) }))
    );

    const body = $('detail-body');
    if (results.items.length === 0) {
      body.replaceChildren(el('tr', {},
        el('td', { colspan: '6', class: 'empty', text: 'No delivery attempts recorded.' })));
    } else {
      body.replaceChildren(...results.items.map((r) => el('tr', {},
        el('td', { class: 'mono', text: r.endpoint }),
        el('td', {}, statusBadge(r.result)),
        el('td', { text: r.httpStatus ? String(r.httpStatus) : '—' }),
        el('td', { text: String(r.attemptCount) }),
        el('td', { text: fmtShortDate(r.attemptAt) }),
        el('td', { text: r.errorMessage ? truncate(r.errorMessage, 80) : (r.errorCode || '—') })
      )));
    }

    const { totalPages, total } = results.pagination;
    $('detail-page-info').textContent = `Page ${results.pagination.page} of ${totalPages} · ${total} attempts`;
    $('detail-prev').disabled = results.pagination.page <= 1;
    $('detail-next').disabled = results.pagination.page >= totalPages;
  } catch (err) {
    if (err.status !== 401) window.alert(err.message);
  }
}

/* --------------------------------------------------------------- wiring -- */

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function wireEvents() {
  // Navigation
  for (const btn of document.querySelectorAll('.side-nav button')) {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  }
  $('logout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* session may be gone */ }
    window.location.replace('/admin-login.html');
  });

  // Overview
  $('overview-refresh').addEventListener('click', loadOverview);

  // Compose
  for (const id of ['f-title', 'f-body', 'f-url', 'f-icon']) {
    $(id).addEventListener('input', updatePreview);
  }
  $('compose-form').addEventListener('submit', (e) => { e.preventDefault(); openConfirm(); });
  $('confirm-send').addEventListener('click', submitNotification);
  $('confirm-cancel').addEventListener('click', closeConfirm);
  $('cancel-send').addEventListener('click', cancelSend);
  $('clear-btn').addEventListener('click', () => {
    $('compose-form').reset();
    $('f-url').value = '/';
    $('f-schedule').value = '';
    $('confirm-box').hidden = true;
    $('send-btn').disabled = false;
    $('compose-error').hidden = true;
    $('compose-info').hidden = true;
    $('progress-box').hidden = true;
    stopPolling();
    updatePreview();
  });

  // Subscribers
  $('subs-search').addEventListener('input', debounce((e) => {
    state.subs.search = e.target.value.trim();
    state.subs.page = 1;
    loadSubscribers();
  }, 300));
  $('subs-status').addEventListener('change', (e) => {
    state.subs.status = e.target.value;
    state.subs.page = 1;
    loadSubscribers();
  });
  $('subs-prev').addEventListener('click', () => { state.subs.page -= 1; loadSubscribers(); });
  $('subs-next').addEventListener('click', () => { state.subs.page += 1; loadSubscribers(); });
  $('subs-cleanup').addEventListener('click', cleanupSubscribers);

  // History
  $('hist-search').addEventListener('input', debounce((e) => {
    state.hist.search = e.target.value.trim();
    state.hist.page = 1;
    loadHistory();
  }, 300));
  $('hist-prev').addEventListener('click', () => { state.hist.page -= 1; loadHistory(); });
  $('hist-next').addEventListener('click', () => { state.hist.page += 1; loadHistory(); });
  $('detail-back').addEventListener('click', () => {
    $('history-detail-panel').hidden = true;
    $('history-list-panel').hidden = false;
    loadHistory();
  });
  $('detail-filter').addEventListener('change', (e) => {
    state.detail.result = e.target.value;
    state.detail.page = 1;
    loadDetail();
  });
  $('detail-prev').addEventListener('click', () => { state.detail.page -= 1; loadDetail(); });
  $('detail-next').addEventListener('click', () => { state.detail.page += 1; loadDetail(); });
}

async function init() {
  wireEvents();
  try {
    const me = await api('/api/auth/me');
    state.admin = me.admin;
    state.csrfToken = me.csrfToken || state.csrfToken;
    $('admin-name').textContent = me.admin.username;
  } catch (err) {
    if (err.status === 401) return; // redirect already triggered
    window.alert(err.message);
    return;
  }
  updatePreview();
  showView('overview');
}

init();
