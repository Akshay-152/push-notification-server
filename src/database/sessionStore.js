import session from 'express-session';

/**
 * Database-backed express-session Store backed by the same SQLite database.
 * Implements the full Store contract: get / set / destroy / touch, plus
 * opportunistic expiry cleanup on writes.
 */
export default class SQLiteSessionStore extends session.Store {
  constructor(db, { cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this._get = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?');
    this._set = db.prepare(`
      INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET data = excluded.data,
                                     expires_at = excluded.expires_at
    `);
    this._destroy = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._touch = db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?');
    this._purge = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

    this._timer = setInterval(() => {
      try {
        this._purge.run(Date.now());
      } catch {
        /* best-effort cleanup; never crash the process */
      }
    }, cleanupIntervalMs);
    this._timer.unref?.();
  }

  get(sid, cb) {
    try {
      const row = this._get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at <= Date.now()) {
        this._destroy.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const maxAge = sess.cookie?.maxAge ?? 86400000;
      this._set.run(sid, JSON.stringify(sess), Date.now() + maxAge);
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  destroy(sid, cb) {
    try {
      this._destroy.run(sid);
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      const maxAge = sess.cookie?.maxAge ?? 86400000;
      this._touch.run(Date.now() + maxAge, sid);
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  stopCleanup() {
    clearInterval(this._timer);
  }
}
