import { unauthorized } from './errorHandler.js';

/**
 * Requires a live, database-backed admin session.
 * The admin record is re-read from the database on every request so a role
 * change or account removal takes effect immediately; the client can never
 * assert its own role.
 */
export function createRequireAdmin({ db }) {
  return (req, res, next) => {
    const adminId = req.session?.adminId;
    if (!adminId) return next(unauthorized('Admin session required'));

    const admin = db
      .prepare('SELECT id, username, role FROM admins WHERE id = ?')
      .get(adminId);

    if (!admin) {
      // Session outlived the account: tear it down.
      return req.session.destroy(() => next(unauthorized('Admin account no longer exists')));
    }
    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return next(unauthorized('Insufficient role'));
    }

    req.admin = admin;
    next();
  };
}
