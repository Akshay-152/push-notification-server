/**
 * Run `worker` over `items` with at most `limit` concurrent executions.
 */
async function runPool(items, limit, worker) {
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
}

/**
 * Campaign orchestration: persist -> batch -> deliver -> record -> summarize.
 *
 * Guarantees:
 *  - Never sends to every subscription in one unbounded loop (batches of 200
 *    with a concurrency limit from config).
 *  - Never runs two delivery jobs for the same notification (in-flight set +
 *    DB status guard), so a double-click or restart cannot duplicate a send.
 *  - Cancellable while sending (stops before the next batch).
 *  - Scheduled sends are recovered after restart because the schedule lives
 *    in the database, not in memory.
 */
export function createNotificationService({
  db,
  config,
  pushService,
  subscriptionService,
  audit,
  logger,
}) {
  const inFlight = new Set();
  let schedulerTimer = null;

  const BATCH_SIZE = 200;

  const insertStmt = db.prepare(`
    INSERT INTO notifications (title, body, destination_url, icon, tag,
                               created_by_admin_id, created_at, scheduled_at, status, cancel_requested)
    VALUES (@title, @body, @destination_url, @icon, @tag,
            @admin_id, @now, @scheduled_at, @status, 0)
  `);

  function getStatus(id) {
    return db.prepare('SELECT status FROM notifications WHERE id = ?').get(id)?.status ?? null;
  }

  function requestCancel(id) {
    const row = db.prepare('SELECT id, status FROM notifications WHERE id = ?').get(id);
    if (!row) return null;
    if (row.status === 'queued' || row.status === 'scheduled') {
      db.prepare("UPDATE notifications SET status = 'cancelled' WHERE id = ?").run(id);
      return 'cancelled';
    }
    if (row.status === 'sending') {
      db.prepare('UPDATE notifications SET cancel_requested = 1 WHERE id = ?').run(id);
      return 'cancelling';
    }
    return row.status;
  }

  function isCancelRequested(id) {
    const row = db.prepare('SELECT cancel_requested FROM notifications WHERE id = ?').get(id);
    return row?.cancel_requested === 1;
  }

  /**
   * Validate-and-save a notification, then either queue an immediate send
   * or register it with the persistent scheduler.
   */
  function create({ input, admin, ip }) {
    const now = new Date().toISOString();
    const status = input.scheduledAt ? 'scheduled' : 'queued';
    const info = insertStmt.run({
      title: input.title,
      body: input.body,
      destination_url: input.destinationUrl,
      icon: input.icon,
      tag: input.tag,
      admin_id: admin.id,
      now,
      scheduled_at: input.scheduledAt,
      status,
    });
    const id = Number(info.lastInsertRowid);

    audit.record({
      adminId: admin.id,
      action: input.scheduledAt ? 'notification.schedule' : 'notification.create',
      detail: `notification #${id} "${input.title}"`,
      ip,
    });

    if (!input.scheduledAt) {
      // Fire-and-forget: the HTTP response returns immediately; the dashboard
      // polls GET /api/admin/notifications/:id for progress.
      setImmediate(() => {
        startSend(id).catch((err) => logger.error('Send job crashed', { id, err: err.message }));
      });
    }

    return getById(id);
  }

  /**
   * Deliver a notification to all active subscriptions.
   * Safe to call repeatedly: only runs when status is queued/scheduled.
   */
  async function startSend(id) {
    if (inFlight.has(id)) return null;
    const notification = getById(id);
    if (!notification) return null;
    if (!['queued', 'scheduled'].includes(notification.status)) return null;

    inFlight.add(id);
    const startedAt = Date.now();
    try {
      db.prepare("UPDATE notifications SET status = 'sending', cancel_requested = 0 WHERE id = ?").run(id);

      let payload;
      try {
        payload = pushService.buildPayload(notification);
      } catch (err) {
        db.prepare("UPDATE notifications SET status = 'failed' WHERE id = ?").run(id);
        logger.error('Payload build failed', { id, err: err.message });
        return null;
      }

      const summary = { attempted: 0, accepted: 0, failed: 0, deactivated: 0, cancelled: false };
      const recordDelivery = db.prepare(`
        INSERT INTO notification_deliveries
          (notification_id, subscription_id, attempt_at, attempt_count, result, http_status, error_code, error_message)
        VALUES (@notification_id, @subscription_id, @attempt_at, @attempt_count, @result, @http_status, @error_code, @error_message)
        ON CONFLICT(notification_id, subscription_id) DO UPDATE SET
          attempt_at = excluded.attempt_at,
          attempt_count = excluded.attempt_count,
          result = excluded.result,
          http_status = excluded.http_status,
          error_code = excluded.error_code,
          error_message = excluded.error_message
      `);

      let cursor = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (isCancelRequested(id)) {
          summary.cancelled = true;
          break;
        }
        const batch = db
          .prepare(
            'SELECT * FROM subscriptions WHERE active = 1 AND id > ? ORDER BY id LIMIT ?'
          )
          .all(cursor, BATCH_SIZE);
        if (batch.length === 0) break;
        cursor = batch[batch.length - 1].id;

        await runPool(batch, config.push.concurrency, async (sub) => {
          if (isCancelRequested(id)) return;
          summary.attempted += 1;

          const outcome = await pushService.sendWithRetry(
            { id: sub.id, endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } },
            payload
          );

          const row = {
            notification_id: id,
            subscription_id: sub.id,
            attempt_at: new Date().toISOString(),
            attempt_count: outcome.attempts,
            result: outcome.result === 'gone' ? 'failed' : outcome.result,
            http_status: outcome.httpStatus,
            error_code: outcome.errorCode,
            error_message: outcome.errorMessage,
          };
          recordDelivery.run(row);

          if (outcome.result === 'accepted') {
            summary.accepted += 1;
            subscriptionService.markDeliverySuccess(sub.id);
          } else {
            summary.failed += 1;
          }
          if (outcome.result === 'gone') {
            // 404/410: the browser subscription is gone for good.
            subscriptionService.deactivateById(sub.id);
            summary.deactivated += 1;
          }
        });
      }

      let finalStatus;
      if (summary.cancelled) finalStatus = 'cancelled';
      else if (summary.attempted === 0) finalStatus = 'sent'; // nothing to do is still a completed send
      else if (summary.failed === 0) finalStatus = 'sent';
      else if (summary.accepted === 0) finalStatus = 'failed';
      else finalStatus = 'partially_failed';

      db.prepare('UPDATE notifications SET status = ? WHERE id = ?').run(finalStatus, id);

      logger.info('Send finished', {
        id,
        status: finalStatus,
        ...summary,
        durationMs: Date.now() - startedAt,
      });
      return { status: finalStatus, ...summary };
    } finally {
      inFlight.delete(id);
    }
  }

  function deliveryCounts(notificationId) {
    const rows = db
      .prepare(
        `SELECT result, COUNT(*) AS n FROM notification_deliveries
          WHERE notification_id = ? GROUP BY result`
      )
      .all(notificationId);
    const map = { accepted: 0, failed: 0, skipped: 0 };
    for (const r of rows) map[r.result] = r.n;
    return {
      accepted: map.accepted,
      failed: map.failed,
      skipped: map.skipped,
      attempted: map.accepted + map.failed + map.skipped,
    };
  }

  function getById(id) {
    const row = db
      .prepare(
        `SELECT n.*, a.username AS created_by_username
           FROM notifications n LEFT JOIN admins a ON a.id = n.created_by_admin_id
          WHERE n.id = ?`
      )
      .get(id);
    if (!row) return null;
    return { ...row, counts: deliveryCounts(id) };
  }

  function list({ page, pageSize, offset, search = '' }) {
    const params = {};
    let whereSql = '';
    if (search) {
      whereSql = 'WHERE n.title LIKE @q OR n.body LIKE @q';
      params.q = `%${search}%`;
    }
    const total = db.prepare(`SELECT COUNT(*) AS n FROM notifications n ${whereSql}`).get(params).n;
    const rows = db
      .prepare(
        `SELECT n.id, n.title, n.body, n.destination_url, n.tag, n.created_at,
                n.scheduled_at, n.status, a.username AS created_by_username,
                (SELECT COUNT(*) FROM notification_deliveries d
                  WHERE d.notification_id = n.id AND d.result = 'accepted') AS accepted_count,
                (SELECT COUNT(*) FROM notification_deliveries d
                  WHERE d.notification_id = n.id AND d.result = 'failed') AS failed_count
           FROM notifications n LEFT JOIN admins a ON a.id = n.created_by_admin_id
           ${whereSql}
          ORDER BY n.id DESC LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: pageSize, offset });

    return {
      items: rows.map((r) => ({
        ...r,
        counts: { accepted: r.accepted_count, failed: r.failed_count },
      })),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  /** Paginated per-subscription delivery attempts for one notification. */
  function results(notificationId, { page, pageSize, offset, result = 'all' }) {
    const params = { notification_id: notificationId };
    let where = 'WHERE d.notification_id = @notification_id';
    if (result !== 'all') {
      where += ' AND d.result = @result';
      params.result = result;
    }
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM notification_deliveries d ${where}`)
      .get(params).n;
    const rows = db
      .prepare(
        `SELECT d.id, d.subscription_id, d.attempt_at, d.attempt_count, d.result,
                d.http_status, d.error_code, d.error_message, s.endpoint, s.active
           FROM notification_deliveries d
           LEFT JOIN subscriptions s ON s.id = d.subscription_id
           ${where}
          ORDER BY d.id DESC LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: pageSize, offset });

    return {
      items: rows.map((r) => ({
        id: r.id,
        subscriptionId: r.subscription_id,
        subscriptionActive: r.subscription_id ? r.active === 1 : null,
        // Masked: raw endpoints are never sent to the browser.
        endpoint: r.endpoint ? mask(r.endpoint) : '(removed subscription)',
        attemptAt: r.attempt_at,
        attemptCount: r.attempt_count,
        result: r.result,
        httpStatus: r.http_status,
        errorCode: r.error_code,
        errorMessage: r.error_message,
      })),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  function mask(endpoint) {
    try {
      const u = new URL(endpoint);
      return `${u.host}/…${u.pathname.slice(-4)}`;
    } catch {
      return '…';
    }
  }

  /** Aggregated dashboard statistics with accurate labels. */
  function dashboard() {
    const subscriptions = subscriptionService.counts();
    const campaignRow = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN ('sent','partially_failed','failed') THEN 1 ELSE 0 END) AS dispatched
           FROM notifications`
      )
      .get();
    const deliveryRow = db
      .prepare(
        `SELECT
           COUNT(*) AS attempted,
           SUM(CASE WHEN result = 'accepted' THEN 1 ELSE 0 END) AS accepted,
           SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM notification_deliveries`
      )
      .get();

    const recent = list({ page: 1, pageSize: 8, offset: 0, search: '' });

    return {
      subscriptions: {
        active: subscriptions.active,
        total: subscriptions.total,
        inactive: subscriptions.total - subscriptions.active,
        trend: subscriptionService.dailySignups(14),
      },
      notifications: {
        total: campaignRow.total,
        dispatched: campaignRow.dispatched || 0,
      },
      delivery: {
        attempted: deliveryRow.attempted || 0,
        accepted: deliveryRow.accepted || 0,
        failed: deliveryRow.failed || 0,
        note: 'Accepted means the push service accepted the message - not that the user saw it.',
      },
      recentNotifications: recent.items,
      sending: [...inFlight],
    };
  }

  /**
   * Persistent scheduler: scans the database for due scheduled notifications.
   * Because the schedule lives in SQLite, pending jobs survive restarts.
   */
  function startScheduler(intervalMs = 15_000) {
    if (schedulerTimer) return;
    schedulerTimer = setInterval(() => {
      try {
        const due = db
          .prepare(
            `SELECT id FROM notifications
              WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`
          )
          .all(new Date().toISOString());
        for (const { id } of due) {
          startSend(id).catch((err) => logger.error('Scheduled send crashed', { id, err: err.message }));
        }
      } catch (err) {
        logger.error('Scheduler tick failed', { err: err.message });
      }
    }, intervalMs);
    schedulerTimer.unref?.();
  }

  function stopScheduler() {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  }

  return {
    create,
    startSend,
    requestCancel,
    getById,
    list,
    results,
    dashboard,
    startScheduler,
    stopScheduler,
  };
}
