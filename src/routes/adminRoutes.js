import { Router } from 'express';
import { asyncHandler, badRequest, notFound } from '../middleware/errorHandler.js';
import { paginate, validateNotificationInput } from '../utils/validators.js';

/**
 * Admin API. Every route requires a live admin session (enforced by the
 * requireAdmin middleware mounted in app.js); unsafe methods additionally
 * require a valid CSRF token (enforced app-wide for /api).
 */
export function createAdminRoutes({ config, db, services }) {
  const router = Router();
  const { subscriptionService, notificationService, audit } = services;

  // ---- Dashboard -----------------------------------------------------------
  router.get(
    '/dashboard',
    asyncHandler(async (req, res) => {
      res.json({ data: notificationService.dashboard() });
    })
  );

  // ---- Subscribers ---------------------------------------------------------
  router.get(
    '/subscriptions',
    asyncHandler(async (req, res) => {
      const { page, pageSize, offset } = paginate(req.query);
      const status = ['all', 'active', 'inactive'].includes(req.query.status)
        ? req.query.status
        : 'all';
      const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : '';
      res.json({ data: subscriptionService.list({ page, pageSize, offset, search, status }) });
    })
  );

  router.delete(
    '/subscriptions/:id',
    asyncHandler(async (req, res) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid subscription id');
      const row = subscriptionService.getById(id);
      if (!row) throw notFound('Subscription not found');
      subscriptionService.deactivateById(id);
      audit.record({
        adminId: req.admin.id,
        action: 'subscription.deactivate',
        detail: `subscription #${id}`,
        ip: req.ip,
      });
      res.json({ data: { id, active: false } });
    })
  );

  /** Hard-delete inactive subscriptions past the retention window. */
  router.post(
    '/subscriptions/cleanup',
    asyncHandler(async (req, res) => {
      const deleted = subscriptionService.cleanupInactive();
      audit.record({
        adminId: req.admin.id,
        action: 'subscription.cleanup',
        detail: `deleted=${deleted}`,
        ip: req.ip,
      });
      res.json({ data: { deleted } });
    })
  );

  // ---- Notifications -------------------------------------------------------
  router.post(
    '/notifications',
    asyncHandler(async (req, res) => {
      const parsed = validateNotificationInput(req.body, config.siteOrigin);
      if (!parsed.ok) {
        throw badRequest(parsed.errors.join('; '));
      }
      const notification = notificationService.create({
        input: parsed.value,
        admin: req.admin,
        ip: req.ip,
      });
      res.status(201).json({ data: { notification } });
    })
  );

  router.get(
    '/notifications',
    asyncHandler(async (req, res) => {
      const { page, pageSize, offset } = paginate(req.query);
      const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : '';
      res.json({ data: notificationService.list({ page, pageSize, offset, search }) });
    })
  );

  router.get(
    '/notifications/:id',
    asyncHandler(async (req, res) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid notification id');
      const notification = notificationService.getById(id);
      if (!notification) throw notFound('Notification not found');
      res.json({ data: { notification } });
    })
  );

  router.post(
    '/notifications/:id/cancel',
    asyncHandler(async (req, res) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid notification id');
      const status = notificationService.requestCancel(id);
      if (status === null) throw notFound('Notification not found');
      audit.record({ adminId: req.admin.id, action: 'notification.cancel', detail: `#${id}`, ip: req.ip });
      res.json({ data: { id, status } });
    })
  );

  router.get(
    '/notifications/:id/results',
    asyncHandler(async (req, res) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid notification id');
      const notification = notificationService.getById(id);
      if (!notification) throw notFound('Notification not found');
      const { page, pageSize, offset } = paginate(req.query);
      const result = ['all', 'accepted', 'failed'].includes(req.query.result)
        ? req.query.result
        : 'all';
      res.json({
        data: {
          notification: { id: notification.id, title: notification.title, status: notification.status, counts: notification.counts },
          ...notificationService.results(id, { page, pageSize, offset, result }),
        },
      });
    })
  );

  // ---- Audit trail ---------------------------------------------------------
  router.get(
    '/audit',
    asyncHandler(async (req, res) => {
      const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
      res.json({ data: { items: audit.list({ limit }) } });
    })
  );

  return router;
}
