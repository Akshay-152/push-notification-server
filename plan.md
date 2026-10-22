# Project: Build a Complete Self-Hosted Web Push Notification System

Act as a senior full-stack developer and software architect. Build a complete, production-ready web push notification system for my website using native Web Push technology, without Firebase, without Firebase Cloud Messaging, and without any third-party push notification SaaS.

## 1. Main objective

Create a system where:

- Visitors can subscribe to browser push notifications.
- The website asks permission when a user explicitly clicks an “Enable Notifications” button.
- The subscription is securely saved in my own backend database.
- An authenticated administrator can compose and send notifications from an admin dashboard.
- All subscribed users can receive notifications even when the website is closed, provided their browser and device support background push.
- Clicking a notification opens the appropriate page on my website.
- Users can unsubscribe from notifications.
- The administrator can view subscriber counts, send history, and delivery results.
- The system is deployable to my own server or VPS.

Do not use Firebase, FCM, Firebase Admin SDK, OneSignal, Pusher, or any managed push notification service.

Use the standard Web Push protocol and browser Push API. Browser-vendor push services may still be used by browsers for message delivery; do not attempt to replace them.

## 2. Technology stack

Use the following stack:

- Frontend: HTML5, CSS3, vanilla JavaScript.
- Backend: Node.js and Express.
- Push library: `web-push`.
- Database: SQLite using a maintained Node.js SQLite library, with a clear migration path to PostgreSQL.
- Authentication: secure server-side admin sessions.
- Session storage: database-backed sessions for production.
- Password security: Argon2id or another appropriately configured modern password hashing algorithm.
- Validation: server-side request validation.
- Environment configuration: dotenv.
- Testing: Node.js test runner or an appropriate testing framework.
- Deployment: Linux VPS, HTTPS, reverse proxy, and systemd or another reliable process manager.

Prefer stable, mutually compatible package versions. Do not introduce unnecessary frameworks or dependencies.

## 3. Project structure

Create a clean and maintainable structure similar to:

web-push-system/
├── public/
│   ├── index.html
│   ├── admin-login.html
│   ├── admin.html
│   ├── css/
│   │   └── style.css
│   ├── js/
│   │   ├── subscribe.js
│   │   ├── admin.js
│   │   └── login.js
│   ├── sw.js
│   ├── manifest.webmanifest
│   └── icons/
├── src/
│   ├── server.js
│   ├── config/
│   ├── routes/
│   ├── middleware/
│   ├── services/
│   │   ├── pushService.js
│   │   └── subscriptionService.js
│   ├── database/
│   │   ├── db.js
│   │   └── migrations/
│   └── utils/
├── tests/
├── scripts/
│   └── create-admin.js
├── .env.example
├── .gitignore
├── package.json
├── README.md
└── DEPLOYMENT.md

You may improve this structure if needed, but maintain clear separation between frontend, API routes, business logic, database operations, and authentication.

## 4. Native Web Push implementation

Implement browser push notifications using:

- `navigator.serviceWorker`
- `Notification.requestPermission()`
- `registration.pushManager.subscribe()`
- `registration.pushManager.getSubscription()`
- `registration.pushManager`
- The `push` event in the Service Worker.
- `self.registration.showNotification()`
- The `notificationclick` event.
- The Node.js `web-push` package.
- VAPID public and private keys.

Generate VAPID keys using an appropriate command-line script or documented CLI command.

The VAPID public key must be exposed to the frontend through a public configuration endpoint or safe application configuration.

The VAPID private key must remain on the server and must never be sent to the browser.

Use a VAPID subject such as a configured `mailto:` address.

Do not implement a fake notification system that only displays JavaScript alerts or works while the page remains open.

Implement actual browser push delivery.

## 5. User-facing website

Create a modern, responsive subscription page.

Include:

- Website branding and navigation.
- A clear explanation of what notifications the user will receive.
- An “Enable Notifications” button.
- Subscription status.
- An unsubscribe button.
- Loading, success, and error messages.
- A graceful fallback for unsupported browsers.
- An informative message when notification permission is denied.
- A way to check the current subscription status.
- A link to the privacy policy.

Request notification permission only after an explicit user action.

Do not repeatedly prompt users who previously denied permission.

When a user subscribes, send the PushSubscription JSON to the backend over HTTPS.

Associate subscriptions with an authenticated user when the website supports user accounts. If anonymous subscriptions are allowed, use a secure anonymous subscription identifier and avoid treating the push endpoint itself as authentication.

Allow users to unsubscribe by calling `unsubscribe()` in the browser and removing or deactivating the subscription on the backend.

Handle expired, revoked, and invalid subscriptions correctly.

## 6. Service Worker

Create `public/sw.js` at the appropriate root URL so that it controls the website.

Implement:

- Background push-event handling.
- JSON payload parsing.
- Notification title, body, icon, badge, tag, and timestamp where supported.
- Notification click handling.
- Safe navigation to internal website URLs.
- Handling of malformed payloads.
- Appropriate error handling.
- A simple service worker versioning and update strategy.

Validate destination URLs against the current website origin before navigating.

Do not trust notification payloads blindly.

Avoid displaying duplicate notifications. Document how the system distinguishes notification payloads and how browser notification options affect duplicate handling.

Use HTTPS in production and document the localhost exception for development.

## 7. Admin authentication

Build a secure admin login and dashboard.

Implement:

- An admin user stored in the database.
- Secure password hashing.
- Login and logout routes.
- Server-side session management.
- HttpOnly session cookies.
- Secure cookies in production.
- SameSite cookie settings.
- Session expiration.
- Session regeneration after successful login.
- CSRF protection for state-changing requests.
- Login rate limiting.
- Authorization middleware.
- A script to create the first administrator from environment variables or interactive terminal input.

Never create a default production username or password.

Never hardcode admin credentials in frontend JavaScript.

Never use a shared secret embedded in HTML as the main authentication mechanism.

Every admin API endpoint must verify the authenticated session and the user's admin role.

## 8. Admin dashboard UI

Create a polished, responsive admin dashboard with these sections.

### Dashboard overview

Display:

- Total active subscriptions.
- Total notifications sent.
- Successful delivery attempts.
- Failed delivery attempts.
- Recent notification history.
- Subscription changes over time if the data is available.

Label delivery statistics accurately. A successful Web Push HTTP response indicates acceptance by the push service, not proof that the user saw the notification.

### Compose notification

Provide fields for:

- Notification title.
- Notification message.
- Destination URL or internal path.
- Notification icon selection or URL.
- Optional notification tag.
- Optional delivery scheduling, if implemented.

Include:

- Character limits.
- Form validation.
- Notification preview.
- A confirmation step before sending to all subscribers.
- A sending-progress indicator.
- A result summary.
- A way to cancel before sending.

### Subscriber management

Provide:

- Subscriber list with pagination.
- Subscription creation date.
- Associated user information, when available.
- Active or expired status.
- Search and filtering.
- Ability to deactivate a subscription.
- Accurate subscriber counts.
- Safe deletion or cleanup of expired subscriptions.

Do not expose raw push endpoints or subscription authentication keys unnecessarily in the interface.

### Notification history

Display:

- Notification title.
- Message.
- Administrator who sent it.
- Creation timestamp.
- Sending status.
- Success and failure counts.
- A details page for delivery attempts.
- Pagination and search.

Store an audit record for each admin send action.

## 9. Backend API

Implement documented, validated endpoints similar to:

Public endpoints:
- `GET /api/config`
- `POST /api/subscriptions`
- `GET /api/subscriptions/status`
- `DELETE /api/subscriptions/current`

Authentication:
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

Admin endpoints:
- `GET /api/admin/dashboard`
- `GET /api/admin/subscriptions`
- `DELETE /api/admin/subscriptions/:id`
- `POST /api/admin/notifications`
- `GET /api/admin/notifications`
- `GET /api/admin/notifications/:id`
- `GET /api/admin/notifications/:id/results`

You may modify these routes to improve security and correctness.

Use appropriate HTTP status codes and a consistent JSON response format.

Validate all incoming data on the server.

Never accept a subscription's ownership or admin role solely from client-provided data.

## 10. Database design

Create database migrations for tables such as:

### admins

- id
- username
- password_hash
- role
- created_at
- updated_at

### subscriptions

- id
- user_id, nullable if anonymous subscriptions are supported
- endpoint
- p256dh_key
- auth_key
- user_agent, if needed
- created_at
- updated_at
- last_success_at
- active status

Make the endpoint unique.

### notifications

- id
- title
- body
- destination_url
- icon
- tag
- created_by_admin_id
- created_at
- scheduled_at, if scheduling is implemented
- status

### notification_deliveries

- id
- notification_id
- subscription_id
- attempt timestamp
- delivery result
- HTTP status or error code
- sanitized error message

### sessions

Use a database-backed session store compatible with the selected session middleware.

Add appropriate indexes, constraints, foreign keys, and transaction handling.

Avoid storing unnecessary personal information.

Do not store private VAPID keys in the database.

## 11. Sending notifications

Implement a reusable push service.

When an admin sends a notification:

1. Validate the request.
2. Verify the admin session and CSRF token.
3. Save the notification record.
4. Load active subscriptions in batches.
5. Send push messages using `web-push`.
6. Record individual delivery attempts.
7. Remove or deactivate subscriptions when the push service returns `404` or `410`.
8. Retry temporary failures using bounded retries and exponential backoff.
9. Avoid retrying permanent errors indefinitely.
10. Return an accurate summary of attempted, accepted, failed, and skipped deliveries.

Do not send to every subscription in a single unbounded loop.

Use concurrency limits or a background job queue for large subscriber counts.

Prevent accidental repeated sends and duplicate jobs.

If scheduling is implemented, use a persistent job mechanism that survives server restarts.

Document Web Push payload size limits and keep notification payloads small.

## 12. Security requirements

Treat security as a core requirement, not an optional improvement.

Implement:

- HTTPS deployment.
- Secure admin authentication.
- CSRF protection.
- Login rate limiting.
- Request size limits.
- Strict input validation.
- Safe output rendering.
- Protection against stored and reflected XSS.
- Appropriate security headers.
- Restricted CORS, preferably same-origin by default.
- Secure cookie settings.
- Protection against open redirects.
- URL validation and origin checks.
- Environment-based secrets.
- Safe error handling that does not expose internal stack traces.
- Audit logging.
- Database backups and restore instructions.
- Dependency and secret management.

Never trust a subscription endpoint as proof of user identity.

Do not let public users send notifications to other subscribers.

Only authorized administrators can broadcast messages.

Never expose VAPID private keys, session secrets, password hashes, or subscription authentication keys to the frontend.

## 13. Reliability and compatibility

Handle:

- Unsupported browsers.
- Notification permission denial.
- Permission revocation.
- Service Worker installation failures.
- Push subscription failures.
- Invalid subscriptions.
- Expired subscriptions.
- Browser offline states.
- Server restarts.
- Temporary push service failures.
- Malformed notification payloads.
- Empty subscriber lists.
- Partial delivery failures.

Document that notification delivery and visibility depend on the browser, operating system, user settings, network availability, and push-service behavior.

Do not claim that every notification is guaranteed to appear or that successful delivery means it was read.

## 14. Testing

Create tests for:

- Subscription creation and validation.
- Duplicate subscription handling.
- Subscription removal.
- Admin login and logout.
- Unauthorized admin requests.
- CSRF protection.
- Notification request validation.
- Notification persistence.
- Successful and failed push attempts using mocks.
- Removal of expired subscriptions.
- Retry behavior.
- Notification URL validation.
- Pagination.
- Audit history.

Provide commands to run the tests.

Do not require actual browser push services for every automated test. Mock push delivery in unit tests, and document a separate end-to-end browser test.

## 15. Deployment and documentation

Create a detailed README.md and DEPLOYMENT.md.

Explain:

- Prerequisites.
- Installation.
- Environment variables.
- VAPID key generation.
- Database migrations.
- Initial admin creation.
- Local development.
- HTTPS setup.
- Nginx or another reverse proxy.
- Running the application with systemd or a process manager.
- Firewall configuration.
- Database backups.
- Log rotation.
- Production security.
- Updating the application.
- Troubleshooting notifications.
- Testing on desktop and mobile browsers.

Provide an `.env.example` containing placeholder values only.

Make sure `.env`, database files, private keys, and credentials are excluded from version control.

## 16. Implementation instructions

Work directly in the existing repository.

First inspect the current files and determine whether an application already exists. Preserve existing functionality and adapt the implementation to the current structure when possible.

Then:

1. Present a brief implementation plan.
2. Build the working backend and frontend.
3. Add database migrations and initialization.
4. Add the Service Worker.
5. Implement authentication and authorization.
6. Implement the admin dashboard.
7. Add tests.
8. Run tests and fix errors.
9. Verify that all frontend API routes match the backend.
10. Write complete setup and deployment documentation.
11. Summarize created files, commands to run, environment variables, and any remaining manual setup.

Do not merely provide snippets or a tutorial. Create the actual files in the repository.

Do not leave placeholder functions, TODO-only implementations, fake delivery results, or unimplemented API routes. If a feature cannot be completed, clearly explain why.

Before finishing, verify that the application starts, migrations work, tests pass, the public subscription flow is connected to the database, admin authentication protects all sending endpoints, and notification delivery uses the actual `web-push` library.

The final result must be a complete self-hosted web push notification application that I can run and deploy on my own server without Firebase or a managed notification SaaS.