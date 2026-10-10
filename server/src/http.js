export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `Body exceeds ${Math.round(limit / 1024 / 1024)}MB limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

// Fixed-window in-memory rate limiter, keyed by client IP.
export function rateLimiter(limit, windowMs) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req) => {
    const ip = clientIp(req);
    const n = (hits.get(ip) ?? 0) + 1;
    hits.set(ip, n);
    if (n > limit) throw new HttpError(429, 'Too many attempts. Try again in a minute.');
  };
}

// X-Forwarded-For is only trusted from a local reverse proxy (Caddy in the same container).
export function clientIp(req) {
  const remote = req.socket.remoteAddress ?? '';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return local && req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : remote;
}
