# Web Push Notification System

A complete, self-hosted web push notification platform built on the **native Web Push protocol**
(W3C Push API + VAPID). No Firebase, no third-party SaaS — subscriptions, campaign delivery,
scheduling, retry logic and the admin dashboard all run on your own server.

## Features

**Subscribers**
- One-click opt-in from the public page — permission is requested *only* on an explicit button click
- Subscriptions persist across browsers via an owner cookie; unsubscribe without an account
- Web app manifest + icons so the site installs as a PWA
- Service worker renders pushes, groups duplicates by tag, and focuses/opens the right tab on click

**Admin dashboard** (`/admin.html`)
- Session login (Argon2id hashing, session-id regeneration, per-IP+username rate limiting)
- Compose notifications: title, body, destination URL, optional icon/tag, or **schedule** for later
- Real-time progress: accepted / failed / attempted per campaign, retried automatically
- Subscriber management: paginated list, search, status filter, deactivation, stale-data cleanup
- Notification history with per-subscription delivery results (masked endpoints only)
- Audit trail of every admin action

**Engineering**
- Restart-safe: scheduled sends and delivery state live in SQLite, not memory
- Batched delivery (200/subscriber batch, bounded concurrency) with exponential-backoff retry
- 404/410 responses automatically deactivate dead subscriptions
- CSRF double-submit protection + same-origin checks on every state-changing request
- Strict CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`
- Portable SQL schema (straightforward PostgreSQL migration path)
- 54 integration/unit tests on `node:test` with a mocked push transport

## Requirements

- Node.js >= 20 (native `fetch`, `node:test`)
- No external services: SQLite and the `web-push` library are the only runtime dependencies

## Quick start

```bash
npm install
cp .env.example .env                # then edit it

npm run generate:vapid              # put the printed keys into .env
npm run migrate                     # create ./data/app.sqlite schema
npm run create:admin                # interactive admin account creation

npm start                           # http://localhost:3000
```

- Public subscribe page: `http://localhost:3000/`
- Admin login: `http://localhost:3000/admin-login.html`

> Local development works even without VAPID keys or `SESSION_SECRET` — ephemeral values are
> generated with a warning. **Production refuses to start without them** (see DEPLOYMENT.md).

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `SITE_URL` | `http://localhost:$PORT` | Public origin; used to validate destination URLs |
| `SESSION_SECRET` | *(required in prod)* | Session + CSRF signing secret |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | *(required in prod)* | Web Push auth keys (`npm run generate:vapid`) |
| `VAPID_SUBJECT` | `mailto:admin@localhost` | `mailto:` or `https:` contact for push services |
| `DATABASE_PATH` | `./data/app.sqlite` | SQLite file |
| `SESSION_TTL_SECONDS` | `86400` | Session lifetime |
| `COOKIE_SECURE` | `1` in prod | `Secure` cookie flag (set to `1` behind HTTPS) |
| `PUSH_CONCURRENCY` | `8` | Concurrent push sends |
| `PUSH_MAX_RETRIES` | `3` | Retries per subscription per campaign |
| `PUSH_RETRY_BASE_MS` | `500` | Backoff base (doubles per retry) |
| `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_SECONDS` | `10` / `900` | Login throttle |
| `INACTIVE_RETENTION_DAYS` | `30` | Cleanup deletes inactive subscriptions older than this |

## npm scripts

| Script | Purpose |
| --- | --- |
| `npm start` | Run the server |
| `npm run dev` | Run with file watching |
| `npm run migrate` | Apply pending SQL migrations (idempotent) |
| `npm run generate:vapid` | Generate a VAPID key pair |
| `npm run create:admin` | Create an admin (`ADMIN_USERNAME`/`ADMIN_PASSWORD` env or interactive) |
| `npm test` | Full test suite (in-memory SQLite, mocked push transport) |

## API overview

Public (CSRF token via `GET /api/config` or any response's `csrfToken`):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/config` | Public VAPID key, CSRF token, limits |
| `POST` | `/api/subscriptions` | Save a browser subscription |
| `GET` | `/api/subscriptions/status` | This browser's subscriptions |
| `DELETE` | `/api/subscriptions/current` | Unsubscribe this browser |
| `POST` | `/api/auth/login` · `/api/auth/logout` · `GET /api/auth/me` | Admin session |

Admin (session + CSRF required):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/dashboard` | Stats + 14-day signup trend + recent campaigns |
| `GET` | `/api/admin/subscriptions` | Paginated list, `?search=&status=&page=&pageSize=` |
| `DELETE` | `/api/admin/subscriptions/:id` | Deactivate a subscription |
| `POST` | `/api/admin/subscriptions/cleanup` | Purge stale inactive subscriptions |
| `POST` | `/api/admin/notifications` | Create/send (or schedule) a campaign |
| `GET` | `/api/admin/notifications` · `/:id` | History + live status |
| `POST` | `/api/admin/notifications/:id/cancel` | Cancel a queued/scheduled/sending campaign |
| `GET` | `/api/admin/notifications/:id/results` | Per-subscription delivery results |
| `GET` | `/api/admin/audit` | Admin action log |

All errors return `{ "error": { "code", "message" } }` with stable machine codes
(`invalid_credentials`, `csrf_rejected`, `rate_limited`, ...).

## Project layout

```
src/
  server.js            entrypoint (config, migrations, graceful shutdown)
  app.js               Express wiring: security -> sessions -> CSRF -> routes -> static
  config/              env-based configuration
  database/            SQLite connection, migrations runner, session store
  middleware/          auth, CSRF, rate limit, security headers, error handler
  routes/              public, auth, admin APIs
  services/            push transport, subscriptions, campaigns, audit
  utils/               validators, logger, cookies
public/                subscribe page, service worker, manifest, admin UI, icons
scripts/               migrate, generate-vapid, create-admin
tests/                 node:test suite with mocked web-push transport
```

## How delivery works

1. Admin composes a campaign → row inserted as `queued` (or `scheduled`).
2. The sender walks active subscriptions in **batches of 200** with bounded concurrency and
   encrypts a compact JSON payload per subscriber (RFC 8188 via `web-push`).
3. Each attempt is recorded in `notification_deliveries`; transient failures retry with
   exponential backoff, `404/410` deactivates the subscription permanently.
4. Final status: `sent`, `partially_failed`, `failed`, or `cancelled`.
5. Scheduled campaigns are picked up by a DB-backed scheduler that survives restarts.

"Accepted" means the push service (FCM/Mozilla/etc.) accepted the message — it does **not**
mean the user saw it; browsers expose no read receipts.

## Testing

```bash
npm test
# equivalent: node --test --test-concurrency=1 "tests/*.test.js"
```

The suite boots the real Express app with an in-memory database and a mocked push transport,
covering subscription lifecycle, auth + enumeration safety, CSRF/origin enforcement, campaign
batching/cancellation/pagination, retry classification and input validation.

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the production checklist, reverse-proxy config, systemd
unit, backups and troubleshooting.
