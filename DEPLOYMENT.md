# Deployment Guide

This app is a single Node.js process with a SQLite file. It runs well on one small VPS.
The only hard requirements are **Node >= 20** and **HTTPS in front of it** (browsers refuse
push notifications and service workers on insecure origins).

## 1. Production configuration checklist

The server **refuses to start in production** unless all of these are set. Do this first.

```bash
# 1. VAPID key pair (one-time). Keep the private key on the server only.
npm run generate:vapid
#   -> VAPID_PUBLIC_KEY=...  VAPID_PRIVATE_KEY=...

# 2. Session secret (32+ chars).
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Then create `/etc/webpush/app.env` (root:root, mode 600):

```ini
NODE_ENV=production
PORT=3000
SITE_URL=https://push.example.com
SESSION_SECRET=<long random value>
VAPID_PUBLIC_KEY=<from generate:vapid>
VAPID_PRIVATE_KEY=<from generate:vapid>
VAPID_SUBJECT=mailto:ops@example.com
DATABASE_PATH=/var/lib/webpush/app.sqlite
COOKIE_SECURE=1
```

Notes:
- `SITE_URL` must be the exact public origin users browse, or destination-URL validation fails.
- Never commit `.env` or the private key; only the *public* key reaches browsers.
- In production `COOKIE_SECURE` defaults to `1`, which is correct behind HTTPS.

## 2. Install and initialize

```bash
sudo useradd --system --home /var/lib/webpush --shell /usr/sbin/nologin webpush
sudo mkdir -p /var/lib/webpush && sudo chown webpush:webpush /var/lib/webpush

git clone <repo> /opt/webpush && cd /opt/webpush
sudo npm ci --omit=dev
sudo -u webpush DATABASE_PATH=/var/lib/webpush/app.sqlite npm run migrate
sudo -u webpush DATABASE_PATH=/var/lib/webpush/app.sqlite npm run create:admin
```

## 3. Run it under systemd

`/etc/systemd/system/webpush.service`:

```ini
[Unit]
Description=Web Push Notification System
After=network.target

[Service]
Type=simple
User=webpush
WorkingDirectory=/opt/webpush
EnvironmentFile=/etc/webpush/app.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=3

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/webpush
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now webpush
sudo systemctl status webpush
journalctl -u webpush -f
```

## 4. HTTPS with nginx

Browsers only allow the Push API, service workers and notification permission over HTTPS
(`localhost` is the sole exception). Terminate TLS at a reverse proxy.

```nginx
server {
    listen 443 ssl http2;
    server_name push.example.com;

    ssl_certificate     /etc/letsencrypt/live/push.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/push.example.com/privkey.pem;

    # The service worker must always be fresh.
    location = /sw.js {
        proxy_pass http://127.0.0.1:3000;
        add_header Cache-Control "no-cache, must-revalidate" always;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Point `SITE_URL` at `https://push.example.com` and keep the Node port bound to `127.0.0.1`
so it is not reachable directly. Obtain certificates with `certbot --nginx`.

## 5. Backups

All state lives in one SQLite file. Because WAL mode is enabled, use the online backup
API rather than copying the file mid-write:

```bash
sqlite3 /var/lib/webpush/app.sqlite ".backup '/backups/app-$(date +%F).sqlite'"
```

Run it from cron/systemd-timer, retain several days, and **test a restore** — the only things
not in the database are the VAPID keys in `app.env`; losing them orphans every subscription,
so back that file up too (secrets manager, encrypted).

## 6. Firewall

Only the reverse proxy should be reachable from the internet. Keep Node bound to loopback
(`127.0.0.1`) so its port is never exposed directly, then allow just SSH + HTTP/HTTPS:

```bash
# ufw (Ubuntu)
sudo ufw default deny incoming
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Outbound traffic must be allowed to the push services — delivery fails with
`network_error` if the host cannot reach them:

```bash
# Google/FCM: fcm.googleapis.com:443
# Mozilla: updates.push.services.mozilla.com:443
sudo ufw default allow outgoing
```

## 7. Log rotation

The app logs JSON lines to stdout; under systemd they go to the journal, which is already
size-capped. Ensure journald keeps enough history without filling the disk
(`/etc/systemd/journald.conf`):

```ini
[Journal]
SystemMaxUse=200M
MaxRetentionSec=1month
```

```bash
sudo systemctl restart systemd-journald
```

If you redirect logs to files instead (e.g. behind pm2 or a `>` redirect), rotate them with
logrotate, e.g. `/etc/logrotate.d/webpush`:

```
/var/log/webpush/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

## 8. Upgrades

```bash
cd /opt/webpush && git pull && sudo npm ci --omit=dev
sudo -u webpush DATABASE_PATH=/var/lib/webpush/app.sqlite npm run migrate   # idempotent
sudo systemctl restart webpush
```

Restarting is safe: scheduled notifications and delivery progress live in the database and the
scheduler resumes them after boot.

## 9. Monitoring

- Logs are JSON lines on stdout -> `journalctl -u webpush`.
- Alert on `Send job crashed`, `Scheduler tick failed`, and a rising `partially_failed` rate.
- `GET /api/admin/dashboard` exposes live campaign and delivery counters once logged in.
- Confirm `https://<host>/sw.js` and `/api/config` return `200` after every change.

## 10. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Refuses to start: `SESSION_SECRET is required` | Set it in `app.env` (32+ chars). |
| Refuses to start: `VAPID... required in production` | Generate and set both VAPID keys. |
| Refuses to start: `Invalid SITE_URL` | Must be a plain `http(s)://` origin, no trailing path. |
| Permission prompt never appears | Site not on HTTPS; or the user previously denied — browser ignores repeat prompts. Check the site's notification permission state. |
| Campaign stays `sending` | Long retry backoff against an unreachable push service. Check `errorCode` in the campaign's results. |
| Deliveries all `network_error` | Server cannot reach the push service (outbound firewall/DNS). |
| Deliveries all `404`/`410` | Subscriptions are stale; browsers dropped them. Those rows are auto-deactivated. |
| Subscribers see nothing after `accepted` | OS/browser notification settings, or the SW was replaced — hard-reload clients. |
| `401` on admin calls after idle | Session expired (`SESSION_TTL_SECONDS`); log in again. |
| `403 csrf_rejected` / origin blocked | Request must come from `SITE_URL` with a valid CSRF token from `/api/config`. |

## 11. Testing on desktop and mobile browsers

Web Push is the one part of this system that the automated suite deliberately does **not** cover:
the tests mock the push transport, so a real end-to-end check needs an actual browser, HTTPS,
and a reachable push service. Run this checklist once after deploying to a new host.

### What the automated suite does and does not prove

- **Covered by `npm test`**: subscription CRUD, auth + CSRF + origin enforcement, validation,
  campaign batching/cancellation/pagination, retry classification, and the delivery pipeline
  against a mocked push transport.
- **Not covered**: a live round-trip through a browser's service worker and a real push service
  (FCM for Chrome/Edge, Mozilla's service for Firefox). That requires the steps below.

### Manual end-to-end checklist

Serve over `https://` (or `http://localhost` for the SW/push exception), then in each browser:

1. Open the site root. The service worker must register (DevTools > Application > Service Workers
   shows it **activated**).
2. Click **Enable notifications**. The OS/browser permission prompt appears *only* on this click.
   Accept it; the page should flip to "Notifications are enabled" and the subscription should
   appear in the dashboard with a masked endpoint.
3. Send a test notification from the dashboard. It should reach the OS notification center, and
   the per-subscription result should show `accepted`.
4. Click the notification: it should focus the existing tab or open the destination URL.
5. Click **Disable notifications**; the row goes inactive in the dashboard.

### Browser support notes

| Platform | Notes |
| --- | --- |
| Chrome / Edge (desktop & Android) | Full support. Uses FCM; requires a real `SITE_URL` the device can reach. |
| Firefox (desktop & Android) | Full support. Uses Mozilla's push service. |
| Safari (macOS 16.4+, iOS/iPadOS 16.4+) | Supported. Safari requires an APNs Web Push certificate and a service worker; some older iOS 16.x versions had known delivery quirks. |
| iOS/iPadOS < 16.4 | No Web Push for websites. Prompt users to "Add to Home Screen" instead. |
| Older browsers / insecure origins | Unsupported. The subscribe page detects this and shows guidance rather than a broken button. |

### Per-platform settings that affect delivery

Delivery and visibility depend on the browser, OS, user settings, network, and push-service
behavior — a `accepted` result means the push service took the message, **not** that the user
saw it. When a platform shows nothing, check these first:

- **Android**: notifications must be enabled for the *browser app* itself (Settings > Apps >
  Chrome/Firefox > Notifications), and battery-saver modes can delay background delivery.
- **iOS/iPadOS**: the site must be added to the Home Screen; focus/DND modes suppress banners.
- **macOS**: System Settings > Notifications > the browser must allow alerts.
- **Windows**: Settings > System > Notifications must be on for the browser's entry.
- **Linux**: depends on the desktop notification daemon; some tiling WMs need one installed.

To exercise a real push end-to-end without a phone, subscribe in one browser and send from the
admin dashboard — the message is delivered even with the tab closed, which is the point of the
service worker.
