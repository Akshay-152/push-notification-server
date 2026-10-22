-- 001_init.sql - core schema
-- SQL is kept portable (TEXT ISO-8601 timestamps, standard FK/INDEX syntax)
-- so a later migration to PostgreSQL only requires a driver swap + type tweaks.

CREATE TABLE admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'admin',
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE TABLE subscriptions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Secure anonymous subscription identifier (HttpOnly cookie on the browser).
  -- The push endpoint is explicitly NOT treated as authentication.
  owner_id       TEXT    NOT NULL,
  -- Reserved for sites with real user accounts; NULL = anonymous subscriber.
  user_id        TEXT,
  endpoint       TEXT    NOT NULL UNIQUE,
  p256dh_key     TEXT    NOT NULL,
  auth_key       TEXT    NOT NULL,
  user_agent     TEXT,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  last_success_at TEXT
);

CREATE INDEX idx_subscriptions_owner  ON subscriptions (owner_id);
CREATE INDEX idx_subscriptions_active ON subscriptions (active);
CREATE INDEX idx_subscriptions_created ON subscriptions (created_at);

CREATE TABLE notifications (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  title               TEXT    NOT NULL,
  body                TEXT    NOT NULL,
  destination_url     TEXT    NOT NULL,
  icon                TEXT,
  tag                 TEXT,
  created_by_admin_id INTEGER NOT NULL REFERENCES admins (id),
  created_at          TEXT    NOT NULL,
  scheduled_at        TEXT,
  -- queued | scheduled | sending | sent | partially_failed | failed | cancelled
  status              TEXT    NOT NULL DEFAULT 'queued',
  cancel_requested    INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1))
);

CREATE INDEX idx_notifications_created ON notifications (created_at);
CREATE INDEX idx_notifications_status   ON notifications (status);

CREATE TABLE notification_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  -- Nullable: survives cleanup of expired subscriptions (link set to NULL).
  subscription_id INTEGER REFERENCES subscriptions (id) ON DELETE SET NULL,
  attempt_at      TEXT    NOT NULL,
  attempt_count    INTEGER NOT NULL DEFAULT 1,
  -- accepted (push service accepted) | failed | skipped
  result          TEXT    NOT NULL,
  http_status     INTEGER,
  error_code      TEXT,
  -- Sanitized message; never contains auth keys or full internals.
  error_message   TEXT,
  UNIQUE (notification_id, subscription_id)
);

CREATE INDEX idx_deliveries_notification ON notification_deliveries (notification_id, result);
CREATE INDEX idx_deliveries_subscription ON notification_deliveries (subscription_id);

CREATE TABLE audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER REFERENCES admins (id),
  action     TEXT    NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT    NOT NULL
);

CREATE INDEX idx_audit_created ON audit_logs (created_at);

-- Database-backed sessions (express-session Store).
-- Stores only the session payload; cookie flags are enforced in app.js.
CREATE TABLE sessions (
  sid        TEXT    PRIMARY KEY,
  data       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_expires ON sessions (expires_at);
