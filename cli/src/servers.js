// The servers you use, stored in ~/.cubby/config.json, and how a command picks one.
// config.json, cubby.json and the CUBBY_SERVER / CUBBY_TOKEN env vars are the contract shared by every
// CLI version (see AGENTS.md): change their shape only with a format bump and a migration here.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CliError } from './lib.js';

export const CONFIG_FORMAT = 1;
export const PROJECT_FORMAT = 1;

// The oldest Cubby server this CLI works with. Older servers' CLIs don't understand the multi-server config.
export const MIN_SERVER_VERSION = '0.1.1';

// null when a server version is supported, otherwise the one line to show. A server reporting the launcher's own
// version is always supported (it's the same code, e.g. a development build before the version bump).
export function unsupportedServer(version, { name, url, bundledVersion, min = MIN_SERVER_VERSION }) {
  if (version === bundledVersion) return null;
  const core = (v) => String(v).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]*)?$/)?.slice(1).map(Number);
  const v = core(version);
  const m = core(min);
  const older = v && (v[0] - m[0] || v[1] - m[1] || v[2] - m[2]) < 0;
  if (v && !older) return null;
  const who = name || url;
  return v
    ? `${who} runs Cubby ${version}, older than ${min}, the oldest this CLI supports. Ask its admin to upgrade (sudo cubby-server upgrade).`
    : `${who} reports an unrecognized Cubby version ("${version}"). Ask its admin to upgrade (sudo cubby-server upgrade).`;
}

export const normalizeUrl = (url) => {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`.toLowerCase();
};

// "https://cubby.example.com" → "cubby.example.com"; ports stay ("localhost:8080").
export const serverId = (url) => new URL(normalizeUrl(url)).host;

const emptyConfig = () => ({ format: CONFIG_FORMAT, default: null, servers: {} });

export const updateHint = (url) => `npm i -g ${url ? `${url}/cli.tgz` : '<server-url>/cli.tgz'}`;
export const tooNew = (what, format, url) =>
  new CliError(`${what} was written by a newer Cubby CLI (format ${format}). Update this one: ${updateHint(url)}`);

// Accepts every shape config.json has had: missing, the single-server 0.1.0 shape, and format 1.
// A newer format is refused, unless `lenient`: then the servers it lists are still used for reading (to resolve
// which server a command targets), but the config is marked `tooNew` and writeConfig refuses to touch it.
export function migrateConfig(raw, { lenient = false } = {}) {
  if (!raw || typeof raw !== 'object') return emptyConfig();
  if (raw.format === undefined) {
    const cfg = emptyConfig();
    if (raw.server) {
      const id = serverId(raw.server);
      cfg.servers[id] = { name: null, url: normalizeUrl(raw.server), email: raw.email ?? null, token: raw.token ?? null, version: null };
      cfg.default = id;
    }
    return cfg;
  }
  if (raw.format > CONFIG_FORMAT) {
    if (!lenient) throw tooNew('~/.cubby/config.json', raw.format);
    const servers = raw.servers && typeof raw.servers === 'object' ? { ...raw.servers } : {};
    return { format: raw.format, default: raw.default ?? null, servers, tooNew: true };
  }
  return { format: CONFIG_FORMAT, default: raw.default ?? null, servers: { ...(raw.servers ?? {}) } };
}

export function readConfig(file, { lenient = false } = {}) {
  if (!existsSync(file)) return emptyConfig();
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new CliError(`${file} is not valid JSON: ${e.message}`);
  }
  return migrateConfig(raw, { lenient });
}

// Atomic: a crash mid-write never leaves a half-written config (it holds tokens).
// A config in a newer format than this CLI understands is never rewritten (that would downgrade it).
export function writeConfig(file, cfg) {
  if (cfg.tooNew) throw tooNew('~/.cubby/config.json', cfg.format, cfg.servers[cfg.default]?.url);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...cfg, format: CONFIG_FORMAT }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

// Adds or updates a server; the first server added becomes the default.
export function upsertServer(cfg, { url, ...fields }) {
  const id = serverId(url);
  const prev = cfg.servers[id] ?? { name: null, email: null, token: null, version: null };
  const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  const servers = { ...cfg.servers, [id]: { ...prev, ...defined, url: normalizeUrl(url) } };
  return { cfg: { ...cfg, servers, default: cfg.default && servers[cfg.default] ? cfg.default : id }, id };
}

export function removeServer(cfg, id) {
  const servers = { ...cfg.servers };
  delete servers[id];
  const ids = Object.keys(servers);
  const def = cfg.default === id ? (ids.length === 1 ? ids[0] : null) : cfg.default;
  return { ...cfg, servers, default: def };
}

export const describeServer = (id, s) => `${s.name ?? id} (${s.url})`;
const known = (cfg) => Object.entries(cfg.servers).map(([id, s]) => describeServer(id, s)).join(', ') || 'none';

// A server by URL, id ("cubby.example.com") or name ("priya's cubby", case-insensitive).
export function findServer(cfg, query) {
  const q = String(query).trim();
  if (/^https?:\/\//i.test(q)) {
    const id = serverId(q);
    return cfg.servers[id] ? { id, server: cfg.servers[id] } : null;
  }
  if (cfg.servers[q.toLowerCase()]) return { id: q.toLowerCase(), server: cfg.servers[q.toLowerCase()] };
  const matches = Object.entries(cfg.servers).filter(([, s]) => s.name && s.name.toLowerCase() === q.toLowerCase());
  if (matches.length > 1) throw new CliError(`More than one server is called "${q}". Use its URL instead: ${matches.map(([id, s]) => describeServer(id, s)).join(', ')}`);
  return matches.length ? { id: matches[0][0], server: matches[0][1] } : null;
}

// Which server a command talks to: --server → CUBBY_SERVER → the app's cubby.json → default → the only one.
// Returns { url, id, server, source }; `server` is null for a URL you haven't logged in to yet.
export function resolveTarget(cfg, { flag, env, projectServer } = {}) {
  const pick = (value, source) => {
    const hit = findServer(cfg, value);
    if (hit) return { url: hit.server.url, id: hit.id, server: hit.server, source };
    if (/^https?:\/\//i.test(value)) return { url: normalizeUrl(value), id: serverId(value), server: null, source };
    throw new CliError(`No server called "${value}". Known servers: ${known(cfg)}. Add one with: cubby login <server-url>`);
  };
  if (flag) return pick(flag, 'flag');
  if (env) return pick(env, 'env');
  if (projectServer) return pick(projectServer, 'cubby.json');
  if (cfg.default && cfg.servers[cfg.default]) return { url: cfg.servers[cfg.default].url, id: cfg.default, server: cfg.servers[cfg.default], source: 'default' };
  const ids = Object.keys(cfg.servers);
  if (ids.length === 1) return { url: cfg.servers[ids[0]].url, id: ids[0], server: cfg.servers[ids[0]], source: 'only' };
  if (ids.length > 1) throw new CliError(`Several servers are set up and none is the default. Pass --server <name> or run \`cubby use <name>\`. Known servers: ${known(cfg)}`);
  throw new CliError('Not logged in. Run `cubby login <server-url>` (or `cubby login <server-url> --token <token>` with the token from the dashboard).');
}

// cubby.json: format is optional (0.1.0 apps have none); a newer format is refused.
export function readProject(file) {
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new CliError(`${file} is not valid JSON: ${e.message}`);
  }
  if (raw.format > PROJECT_FORMAT) throw tooNew('cubby.json', raw.format);
  return raw;
}

export const projectJson = (project, server) => ({ format: PROJECT_FORMAT, project, server });

export function listServers(cfg) {
  return Object.entries(cfg.servers).map(([id, s]) => ({
    id, name: s.name, url: s.url, email: s.email, version: s.version, logged_in: Boolean(s.token), default: cfg.default === id,
  }));
}

export const formatServers = (list) =>
  list.map((s) => `${s.default ? '*' : ' '} ${(s.name ?? s.id).padEnd(24)} ${s.url}  ${s.logged_in ? s.email ?? '' : '(not logged in)'}${s.version ? `  v${s.version}` : ''}`).join('\n')
  || 'No servers yet. Add one with: cubby login <server-url>';
