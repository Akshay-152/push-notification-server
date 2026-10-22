import webPush from 'web-push';

const GONE_STATUSES = new Set([404, 410]);
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

/**
 * Classify a push-service failure.
 *  - 'gone'       : subscription no longer exists -> deactivate, never retry
 *  - 'transient'  : rate limit / server error / network -> bounded retry
 *  - 'permanent'  : bad payload, auth or request -> never retry
 */
function classify(err) {
  const status = err?.statusCode;
  if (status === undefined || status === null) return 'transient'; // network-level
  if (GONE_STATUSES.has(status)) return 'gone';
  if (TRANSIENT_STATUSES.has(status)) return 'transient';
  return 'permanent';
}

function sanitizeMessage(err) {
  const raw = err?.body || err?.message || 'Unknown push error';
  return String(raw).replace(/\s+/g, ' ').slice(0, 200);
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Push delivery layer around the `web-push` library.
 *
 * `sender` is injectable so unit tests can mock delivery without touching
 * real browser push services. Production wiring uses web-push directly.
 */
export function createPushService({ config, logger, sender = null }) {
  webPush.setVapidDetails(
    config.vapid.subject,
    config.vapid.publicKey,
    config.vapid.privateKey
  );

  const defaultSender = (subscription, payload, options) =>
    webPush.sendNotification(subscription, payload, options);

  const sendRaw = sender || defaultSender;

  /** Serialize the admin's notification into the Web Push payload. */
  function buildPayload(notification) {
    const payload = {
      v: 1, // payload schema version
      title: notification.title,
      body: notification.body,
      url: notification.destination_url,
      icon: notification.icon || null,
      tag: notification.tag || `n-${notification.id}`,
      timestamp: notification.created_at,
    };
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, 'utf8') > config.push.maxPayloadBytes) {
      throw new Error('Payload exceeds Web Push size limit');
    }
    return json;
  }

  /**
   * Send one payload to one subscription with bounded retries + exponential
   * backoff for transient failures. Permanent and gone failures are final.
   *
   * Returns a sanitized result record:
   *   { result: 'accepted'|'failed'|'gone', httpStatus, errorCode, errorMessage, attempts }
   */
  async function sendWithRetry(subscription, payload) {
    const maxRetries = config.push.maxRetries;
    const base = config.push.retryBaseMs;
    let attempts = 0;
    let lastError = null;

    while (attempts <= maxRetries) {
      attempts += 1;
      try {
        const response = await sendRaw(
          { endpoint: subscription.endpoint, keys: subscription.keys },
          payload,
          {
            TTL: 60 * 60 * 24 * 7, // keep undelivered messages max 7 days
            urgency: 'normal',
            topic: String(subscription.id ?? '').slice(0, 32) || undefined,
          }
        );
        return {
          result: 'accepted',
          httpStatus: response?.statusCode ?? 201,
          errorCode: null,
          errorMessage: null,
          attempts,
        };
      } catch (err) {
        lastError = err;
        const kind = classify(err);
        if (kind === 'gone') {
          return {
            result: 'gone',
            httpStatus: err.statusCode ?? null,
            errorCode: 'subscription_gone',
            errorMessage: sanitizeMessage(err),
            attempts,
          };
        }
        if (kind === 'permanent') {
          return {
            result: 'failed',
            httpStatus: err.statusCode ?? null,
            errorCode: err.statusCode ? `http_${err.statusCode}` : 'push_error',
            errorMessage: sanitizeMessage(err),
            attempts,
          };
        }
        if (attempts > maxRetries) break;
        const backoff = base * 2 ** (attempts - 1) + Math.floor(Math.random() * (base || 1));
        logger.debug('Transient push failure, retrying', {
          attempts,
          status: err?.statusCode,
          backoffMs: backoff,
        });
        await sleep(backoff);
      }
    }

    return {
      result: 'failed',
      httpStatus: lastError?.statusCode ?? null,
      errorCode: lastError?.statusCode ? `http_${lastError.statusCode}` : 'network_error',
      errorMessage: sanitizeMessage(lastError),
      attempts,
    };
  }

  return { buildPayload, sendWithRetry };
}
