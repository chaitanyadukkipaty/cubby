// Proxies <slug>.<domain>/pb/* to the shared PocketBase, only allowing access to that project's
// collections and only accepting auth tokens issued by that project's auth collections.
import http from 'node:http';
import { config, prefixFor } from './config.js';
import { collectionIndex } from './schema.js';
import { sendJson, readBody } from './http.js';

const pbUrl = new URL(config.pb.url);

export function tokenCollectionId(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.collectionId ?? null;
  } catch {
    return null;
  }
}

// `index` resolves a project's collection ids (injectable for tests).
export async function isAllowed(slug, method, path, index = collectionIndex) {
  const prefix = prefixFor(slug);
  if (path === '/api/health' || path === '/api/realtime') return true;

  let m = path.match(/^\/api\/collections\/([^/]+)\/(.+)$/);
  if (m) return m[1].startsWith(prefix) && !m[2].startsWith('..');

  if (path === '/api/files/token' && method === 'POST') return true;
  m = path.match(/^\/api\/files\/([^/]+)\//);
  if (m) {
    if (m[1].startsWith(prefix)) return true;
    let idx = await index(slug);
    if (!idx.ids.has(m[1])) idx = await index(slug, { refresh: true });
    return idx.ids.has(m[1]);
  }
  return false;
}

// Client filters/sorts (and realtime subscription options) may use @collection.<name> joins;
// only this project's collections are allowed there.
export function foreignCollectionRef(text, prefix) {
  for (const m of text.matchAll(/@collection\.([a-zA-Z0-9_]+)/g)) if (!m[1].startsWith(prefix)) return m[1];
  return null;
}

const decode = (text) => {
  try { return decodeURIComponent(text.replaceAll('+', ' ')); } catch { return text; }
};

// Looks for @collection refs to other projects in the query string and in realtime subscription
// topics (JSON body, each topic URL-encoded). Returns { foreign } or { invalid: true }.
export function checkForeignRefs(search, body, prefix) {
  let foreign = foreignCollectionRef(decode(search), prefix);
  if (body && !foreign) {
    let subscriptions;
    try { subscriptions = JSON.parse(body.toString('utf8')).subscriptions ?? []; } catch { subscriptions = null; }
    if (!Array.isArray(subscriptions)) return { invalid: true };
    for (const topic of subscriptions) foreign ??= foreignCollectionRef(decode(String(topic)), prefix);
  }
  return { foreign };
}

export async function tokenAllowed(slug, token, index = collectionIndex) {
  if (!token) return true;
  const collectionId = tokenCollectionId(token);
  if (!collectionId) return false;
  let idx = await index(slug);
  if (!idx.authIds.has(collectionId)) idx = await index(slug, { refresh: true });
  return idx.authIds.has(collectionId);
}

export async function proxyPocketBase(req, res, slug, url) {
  const path = url.pathname.slice('/pb'.length) || '/';
  if (!(await isAllowed(slug, req.method, path))) {
    return sendJson(res, 403, { status: 403, message: `Only this project's collections are reachable (names start with "${prefixFor(slug)}").` });
  }
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!(await tokenAllowed(slug, token)) || !(await tokenAllowed(slug, url.searchParams.get('token')))) {
    return sendJson(res, 401, { status: 401, message: 'Auth token was not issued by this project.' });
  }

  let body = null;
  if (path === '/api/realtime' && req.method === 'POST') body = await readBody(req, 256 * 1024);
  const check = checkForeignRefs(url.search, body, prefixFor(slug));
  if (check.invalid) return sendJson(res, 400, { status: 400, message: 'Invalid realtime request' });
  if (check.foreign) return sendJson(res, 403, { status: 403, message: `Cannot reference collection "${check.foreign}" from this project.` });

  const headers = { ...req.headers, host: pbUrl.host };
  delete headers.cookie;
  const upstream = http.request(
    { hostname: pbUrl.hostname, port: pbUrl.port, method: req.method, path: path + url.search, headers },
    (pbRes) => {
      res.writeHead(pbRes.statusCode, pbRes.headers);
      pbRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) sendJson(res, 502, { status: 502, message: 'PocketBase unavailable' });
    else res.end();
  });
  res.on('close', () => upstream.destroy());
  if (body) upstream.end(body);
  else req.pipe(upstream);
}
