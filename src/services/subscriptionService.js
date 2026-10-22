import { maskEndpoint } from '../utils/validators.js';

/**
 * Subscription persistence. The push endpoint is only a delivery address:
 * ownership is tracked by a separate random owner cookie, never by the
 * endpoint itself.
 */
export function createSubscriptionService({ db, config, logger }) {
  const insertStmt = db.prepare(`
    INSERT INTO subscriptions (owner_id, user_id, endpoint, p256dh_key, auth_key, user_agent,
                               active, created_at, updated_at, last_success_at)
    VALUES (@owner_id, NULL, @endpoint, @p256dh_key, @auth_key, @user_agent,
            1, @now, @now, NULL)
  `);
  const conflictStmt = db.prepare(`
    UPDATE subscriptions
       SET p256dh_key = @p256dh_key,
           auth_key = @auth_key,
           user_agent = @user_agent,
           owner_id = @owner_id,
           active = 1,
           updated_at = @now
     WHERE endpoint = @endpoint
  `);
  const getByEndpoint = db.prepare('SELECT * FROM subscriptions WHERE endpoint = ?');
  const getById = db.prepare('SELECT * FROM subscriptions WHERE id = ?');
  const activeByOwner = db.prepare(
    'SELECT * FROM subscriptions WHERE owner_id = ? AND active = 1 ORDER BY id DESC'
  );

  /**
   * Create or refresh a subscription (idempotent upsert on endpoint).
   * Reactivates previously deactivated rows and refreshes key material.
   */
  function upsert({ ownerId, endpoint, keys, userAgent = null }) {
    const now = new Date().toISOString();
    const params = {
      owner_id: ownerId,
      endpoint,
      p256dh_key: keys.p256dh,
      auth_key: keys.auth,
      user_agent: userAgent ? String(userAgent).slice(0, 512) : null,
      now,
    };

    const run = db.transaction(() => {
      const existing = getByEndpoint.get(endpoint);
      if (existing) {
        conflictStmt.run(params);
        return getById.get(existing.id);
      }
      const info = insertStmt.run(params);
      return getById.get(info.lastInsertRowid);
    });

    return run();
  }

  function statusForOwner(ownerId) {
    if (!ownerId) return [];
    return activeByOwner.all(ownerId).map(toPublic);
  }

  function toPublic(row) {
    if (!row) return null;
    return {
      id: row.id,
      maskedEndpoint: maskEndpoint(row.endpoint),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastSuccessAt: row.last_success_at,
      active: row.active === 1,
      userAgent: row.user_agent,
    };
  }

  /** Deactivate every subscription owned by this browser (soft delete). */
  function deactivateByOwner(ownerId) {
    if (!ownerId) return 0;
    const info = db
      .prepare('UPDATE subscriptions SET active = 0, updated_at = ? WHERE owner_id = ? AND active = 1')
      .run(new Date().toISOString(), ownerId);
    return info.changes;
  }

  function deactivateById(id) {
    const info = db
      .prepare('UPDATE subscriptions SET active = 0, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    return info.changes;
  }

  /** Called when the push service accepts a message for this subscription. */
  function markDeliverySuccess(id) {
    const now = new Date().toISOString();
    db.prepare('UPDATE subscriptions SET last_success_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, id);
  }

  const countActive = db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE active = 1');
  const countAll = db.prepare('SELECT COUNT(*) AS n FROM subscriptions');

  function counts() {
    return { active: countActive.get().n, total: countAll.get().n };
  }

  /** Paginated admin listing with search + status filter. */
  function list({ page, pageSize, offset, search = '', status = 'all' }) {
    const where = [];
    const params = {};
    if (status === 'active') where.push('active = 1');
    else if (status === 'inactive') where.push('active = 0');
    if (search) {
      where.push('(endpoint LIKE @q OR user_agent LIKE @q OR owner_id LIKE @q)');
      params.q = `%${search}%`;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM subscriptions ${whereSql}`)
      .get(params).n;
    const rows = db
      .prepare(
        `SELECT * FROM subscriptions ${whereSql} ORDER BY id DESC LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: pageSize, offset });

    return {
      items: rows.map(toPublic),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  /**
   * Hard-delete subscriptions that are inactive and older than the retention
   * window. Delivery rows keep their history (FK set null on delete).
   */
  function cleanupInactive({ retentionDays = config.cleanup.inactiveRetentionDays } = {}) {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    const info = db
      .prepare('DELETE FROM subscriptions WHERE active = 0 AND updated_at < ?')
      .run(cutoff);
    return info.changes;
  }

  /** Daily new-subscription counts for the dashboard trend chart. */
  function dailySignups(days = 14) {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const rows = db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
           FROM subscriptions WHERE created_at >= ?
          GROUP BY day ORDER BY day`
      )
      .all(since);
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r.count]));
    const out = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      out.push({ day, count: byDay[day] || 0 });
    }
    return out;
  }

  return {
    upsert,
    toPublic,
    statusForOwner,
    deactivateByOwner,
    deactivateById,
    markDeliverySuccess,
    counts,
    list,
    cleanupInactive,
    dailySignups,
    getById: (id) => getById.get(id),
  };
}
