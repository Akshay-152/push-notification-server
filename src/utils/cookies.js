/** Minimal cookie header parsing (avoids a cookie-parser dependency). */
export function parseCookies(req) {
  if (req.cookies) return req.cookies;
  const jar = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) {
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        try {
          jar[name] = decodeURIComponent(value);
        } catch {
          jar[name] = value;
        }
      }
    }
  }
  req.cookies = jar;
  return jar;
}

export function getCookie(req, name) {
  return parseCookies(req)[name];
}
