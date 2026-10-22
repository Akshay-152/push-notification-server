/** Append-only audit trail for sensitive admin actions. */
export function createAuditService({ db }) {
  const insert = db.prepare(`
    INSERT INTO audit_logs (admin_id, action, detail, ip, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  function record({ adminId = null, action, detail = null, ip = null }) {
    try {
      insert.run(adminId, action, detail ? String(detail).slice(0, 1000) : null, ip, new Date().toISOString());
    } catch {
      /* auditing must never break the main flow */
    }
  }

  function list({ limit = 50 } = {}) {
    return db
      .prepare(
        `SELECT a.id, a.admin_id, a.action, a.detail, a.ip, a.created_at, u.username
           FROM audit_logs a LEFT JOIN admins u ON u.id = a.admin_id
          ORDER BY a.id DESC LIMIT ?`
      )
      .all(limit);
  }

  return { record, list };
}
