/** Typed API error carrying an HTTP status and a stable machine code. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message) => new ApiError(400, 'bad_request', message);
export const unauthorized = (message = 'Authentication required', code = 'unauthorized') =>
  new ApiError(401, code, message);
export const forbidden = (message = 'Forbidden') => new ApiError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const conflict = (message) => new ApiError(409, 'conflict', message);
export const tooMany = (message) => new ApiError(429, 'rate_limited', message);

/** Wrap async route handlers so rejections reach the error middleware. */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** JSON 404 for unmatched API routes. */
export function apiNotFound(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });
}

/**
 * Final error middleware. Never leaks stack traces to clients; logs them
 * server-side instead. Handles body-parser errors as 400/413.
 */
export function createErrorHandler({ logger, isProduction }) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }

    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } });
    }
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON body' } });
    }

    logger.error('Unhandled error', {
      method: req.method,
      path: req.path,
      message: err?.message,
      stack: isProduction ? undefined : err?.stack,
    });

    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  };
}
