// Pure request logic (no I/O): routing, validation and view shaping. Unit-tested in isolation.
import { SLUG_RE, RESERVED_SLUGS, prefixFor, config } from './config.js';
import { HttpError } from './http.js';

// What this server supports beyond the basics, in /api/info (dashboards and newer CLIs check it).
export const FEATURES = ['jobs', 'metrics'];

export const isLoopback = (ip) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip ?? '');

export function appSlugFromHost(host, baseDomain) {
  const suffix = `.${baseDomain}`;
  if (!host?.endsWith(suffix)) return null;
  const sub = host.slice(0, -suffix.length);
  return SLUG_RE.test(sub) ? sub : null;
}

export const appUrl = (slug, publicUrl, baseDomain) => `${new URL(publicUrl).protocol}//${slug}.${baseDomain}`;

export const projectView = (p, { publicUrl, baseDomain }) => ({
  id: p.id, slug: p.slug, name: p.name, description: p.description || '', url: appUrl(p.slug, publicUrl, baseDomain), prefix: prefixFor(p.slug),
  unlisted: Boolean(p.unlisted), current_deploy: p.current_deploy || null, last_deployed: p.last_deployed || null,
  schema_hash: p.schema_hash || null, created: p.created,
  ...(p.expand?.owner && { owner: p.expand.owner.email }),
});

// Gallery entries hide internals that only the owner needs.
export const galleryView = ({ prefix, schema_hash, current_deploy, ...p }) => p;

export function checkNewSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length < 3 || slug.length > 40) {
    throw new HttpError(400, 'App name must be 3-40 chars: lowercase letters, digits and single hyphens, starting with a letter');
  }
  if (RESERVED_SLUGS.has(slug)) throw new HttpError(409, `"${slug}" is reserved`);
}

export function projectPatch({ unlisted, description, name } = {}) {
  const patch = {};
  if (typeof unlisted === 'boolean') patch.unlisted = unlisted;
  if (typeof description === 'string') patch.description = description.slice(0, 300);
  if (typeof name === 'string' && name.trim()) patch.name = name.trim().slice(0, 100);
  return patch;
}

export function deployPatch(searchParams) {
  const patch = {};
  if (searchParams.has('unlisted')) patch.unlisted = searchParams.get('unlisted') === '1';
  if (searchParams.has('description')) patch.description = searchParams.get('description').slice(0, 300);
  return patch;
}

export const deployClient = (header) => String(header ?? '').slice(0, 60);

// --- Agents: one API key per approved `cubby login` ---
// What a CLI says about itself when it starts a device login. Older CLIs send nothing, so every part is optional.
const hintText = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
// 40 + " · " + 57 = 100, the key label's limit.
export const agentHint = (body) => ({ tool: hintText(body?.tool, 40), machine: hintText(body?.machine, 57) });

// "Claude Code · chaitanya-mbp"; "Agent · 2026-10-17" when the CLI sent no hint.
export function agentName({ tool, machine } = {}, now = Date.now()) {
  if (tool && machine) return `${tool} · ${machine}`;
  return tool || `Agent · ${machine || new Date(now).toISOString().slice(0, 10)}`;
}

// A name someone gives an agent with `cubby agents rename`.
export const AGENT_NAME_MAX = 60;
export function agentLabel(name) {
  const clean = hintText(name, Infinity);
  if (!clean || clean.length > AGENT_NAME_MAX) throw new HttpError(400, `Agent name must be 1-${AGENT_NAME_MAX} characters`);
  return clean;
}

// When a key was last used is written at most once per interval per key, so requests don't each cost a DB write.
// In memory, like the rate limiter: Cubby runs one server process.
export function touchThrottle(intervalMs) {
  const last = new Map(); // keyId -> ms of the last recorded use
  return {
    due(keyId, now) {
      if (now - (last.get(keyId) ?? -Infinity) < intervalMs) return false;
      last.set(keyId, now);
      return true;
    },
    forget: (keyId) => last.delete(keyId),
  };
}

// Keys from before agents (and the dashboard's own) have no kind: they're the user's manual token.
export const isAgentKey = (k) => k.kind === 'agent';
export const MANUAL_TOKEN_NAME = 'Manual token';

// Never includes the key itself.
export const agentView = (k, currentKeyId) => ({
  id: k.id,
  name: isAgentKey(k) ? k.label : MANUAL_TOKEN_NAME,
  tool: k.tool || null,
  machine: k.machine || null,
  manual: !isAgentKey(k),
  current: k.id === currentKeyId,
  created: k.created,
  last_used_at: k.last_used || null,
});

// --- Activity log: one row per mutation, attributed to the agent key that made it ---
// `actor.agent` is { id, name } for an agent's key, null for the manual token (the dashboard).
export const activityRow = (actor, { action, app = '', summary = '' }, now = new Date()) => ({
  user: actor.id,
  agent: actor.agent?.id ?? '',
  agent_name: actor.agent?.name ?? '',
  app,
  action,
  summary: String(summary).slice(0, 300),
  at: now.toISOString(),
});

export const ACTIVITY_LIMIT = { default: 50, max: 500 };
export const ACTIVITY_DAYS = 30;
// Rows before this are pruned. PocketBase's own date format ("2026-10-17 09:30:00.000Z"), so it compares cleanly.
export const activityCutoff = (now) => new Date(now.getTime() - ACTIVITY_DAYS * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ');

// The PocketBase filter for listing activity. A user sees only rows they made (their apps and agents);
// `all` (admins, /api/admin/activity) drops that. agent=dashboard means the manual token.
export function activityQuery(user, { app, agent, limit } = {}, { all = false } = {}) {
  const parts = [];
  const params = {};
  const add = (text, key, value) => (parts.push(text), (params[key] = value));
  if (!all) add('user = {:u}', 'u', user.id);
  if (app) add('app = {:app}', 'app', String(app));
  if (agent) add('agent = {:agent}', 'agent', agent === 'dashboard' ? '' : String(agent));
  const n = Number.parseInt(limit, 10);
  return {
    filter: { text: parts.join(' && '), params },
    limit: Number.isFinite(n) ? Math.min(Math.max(n, 1), ACTIVITY_LIMIT.max) : ACTIVITY_LIMIT.default,
  };
}

// "Pushed schema: created notes; kept notes.body" from applySchema's changes.
export function schemaSummary({ created = [], updated = [], kept = [] }) {
  const parts = [['created', created], ['updated', updated], ['kept', kept]]
    .filter(([, list]) => list.length).map(([verb, list]) => `${verb} ${list.join(', ')}`);
  return `Pushed schema: ${parts.join('; ') || 'no changes'}`;
}

// "Emptied polls — 1,204 records · snapshot … until 2026-10-24" from a data clear's result.
export function clearSummary({ mode, collections, filter, snapshot }) {
  const n = collections.reduce((sum, c) => sum + c.records, 0);
  const records = `${n.toLocaleString('en-US')} record${n === 1 ? '' : 's'}`;
  const names = collections.map((c) => c.name).join(', ');
  const what = mode === 'filter' ? `Deleted ${records} from ${names} matching ${filter}`
    : mode === 'ids' ? `Deleted ${records} from ${names} by id`
    : `${mode === 'drop' ? 'Dropped' : 'Emptied'} ${names} — ${records}`;
  return `${what} · snapshot ${snapshot.id} until ${snapshot.expires.slice(0, 10)}`;
}

// "Restored 43 records from snapshot … (2 already there, 3 accounts with new passwords)" from a restore's result.
export function restoreSummary({ snapshot, collections, accounts }) {
  const sum = (f) => collections.reduce((n, c) => n + c[f], 0);
  const n = sum('restored');
  const notes = [
    ...(sum('replaced') ? [`${sum('replaced')} replaced`] : []),
    ...(sum('existing') - sum('replaced') > 0 ? [`${sum('existing') - sum('replaced')} already there`] : []),
    ...(sum('failed') ? [`${sum('failed')} failed`] : []),
    ...(accounts.length ? [`${accounts.length} accounts with new passwords`] : []),
  ];
  return `Restored ${n} record${n === 1 ? '' : 's'} from snapshot ${snapshot}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

// A snapshot as `cubby data snapshots` lists it. `records` counts what cascaded with it too.
export const snapshotView = (m) => ({
  id: m.id, app: m.app, created: m.created, expires: m.expires, by: m.by?.email ?? null, by_admin: Boolean(m.by?.admin),
  reason: m.reason || '', mode: m.mode, collections: m.collections.map((c) => ({ name: c.name, records: c.records })),
  records: [...m.collections, ...(m.cascade ?? [])].reduce((n, c) => n + c.records, 0), files: m.files, files_bytes: m.files_bytes,
});

// 'Made "x" unlisted, renamed it to "X"' — what an owner's PATCH changed.
export function patchSummary(slug, patch) {
  const parts = [];
  if ('unlisted' in patch) parts.push(patch.unlisted ? 'made it unlisted' : 'listed it in the gallery');
  if ('name' in patch) parts.push(`renamed it to "${patch.name}"`);
  if ('description' in patch) parts.push('changed its description');
  return `Updated "${slug}": ${parts.join(', ')}`;
}

export const activityView = (r) => ({
  id: r.id,
  at: r.at,
  user: r.expand?.user?.email ?? null,
  via: r.agent ? 'agent' : 'dashboard',
  agent: r.agent ? { id: r.agent, name: r.agent_name } : null,
  app: r.app || null,
  action: r.action,
  summary: r.summary,
});

// Each server has a display name ("Priya's Cubby"), shown to friends and agents.
export const SERVER_NAME_MAX = 60;

export function checkServerName(name) {
  const trimmed = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!trimmed || trimmed.length > SERVER_NAME_MAX || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new HttpError(400, `Server name must be 1-${SERVER_NAME_MAX} characters`);
  }
  return trimmed;
}

// Default for a fresh install: "<local part of the admin email>'s Cubby".
export function defaultServerName(adminEmail) {
  const local = String(adminEmail ?? '').split('@')[0].trim();
  return local ? `${local}'s Cubby`.slice(0, SERVER_NAME_MAX) : 'Cubby';
}

// First boot: CUBBY_SERVER_NAME if valid, else the default from the admin email.
export function initialServerName(envName, adminEmail) {
  const fallback = defaultServerName(adminEmail);
  if (!envName) return { name: fallback, ignored: false };
  try {
    return { name: checkServerName(envName), ignored: false };
  } catch {
    return { name: fallback, ignored: true };
  }
}

// Servers created before names existed have none stored.
export const serverName = (s) => s?.server_name || 'Cubby';

// /skill.sh: the URL goes into a double-quoted shell string, the name into a quoted heredoc as a JSON literal,
// so neither can break out into shell code.
export const renderSkillInstaller = (template, { publicUrl, name }) =>
  template.replaceAll('{{PUBLIC_URL}}', publicUrl).replaceAll('{{SERVER_NAME_JSON}}', JSON.stringify(name));

// The dashboard's root URL as agents see it: curl and agents' fetch tools don't send a browser user agent, so they get
// the setup steps as plain text instead of an empty single-page app. The repo matches SKILL_REPO in public/index.html.
export const isBrowser = (userAgent) => /^Mozilla\//.test(String(userAgent ?? ''));
export const agentLanding = ({ publicUrl, name }) => `${name} is a Cubby server: build and host full-stack web apps
(React + Tailwind, a database, user accounts, file uploads, realtime) with your AI agent.
${publicUrl}

Set up:

  npx skills add chaitanyadukkipaty/cubby --skill cubby -g

If npm isn't available:

  curl -fsSL ${publicUrl}/skill.sh | sh

Then read ~/.agents/skills/cubby/SKILL.md and follow its Setup to connect to ${publicUrl}
(the user approves one link in their browser).

Docs:  ${publicUrl}/docs.md
`;

export function settingsPatch(body = {}, newCode) {
  const patch = {};
  if (body.server_name !== undefined) patch.server_name = checkServerName(body.server_name);
  if (typeof body.open_signup === 'boolean') patch.open_signup = body.open_signup;
  if (typeof body.update_check === 'boolean') patch.update_check_off = !body.update_check;
  if (typeof body.jobs === 'boolean') patch.jobs_off = !body.jobs;
  if (body.job_timeout_s !== undefined) {
    const n = Number(body.job_timeout_s);
    if (!Number.isInteger(n) || n < JOB_TIMEOUT_MIN || n > JOB_TIMEOUT_MAX) throw new HttpError(400, `job_timeout_s must be a whole number between ${JOB_TIMEOUT_MIN} and ${JOB_TIMEOUT_MAX}`);
    patch.job_timeout_s = n;
  }
  if (body.backup_keep !== undefined) {
    const n = Number(body.backup_keep);
    if (!Number.isInteger(n) || n < BACKUP_KEEP_MIN || n > BACKUP_KEEP_MAX) throw new HttpError(400, `backup_keep must be a whole number between ${BACKUP_KEEP_MIN} and ${BACKUP_KEEP_MAX}`);
    patch.backup_keep = n;
  }
  if (body.rotate_code) patch.signup_code = newCode();
  for (const key of ['max_apps_per_user', 'max_deploy_mb']) {
    if (body[key] !== undefined) {
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new HttpError(400, `${key} must be a whole number between 1 and 10000`);
      patch[key] = n;
    }
  }
  return patch;
}

// Seconds a job may run. The cap stays under fetch's default 300s headers timeout, which `cubby jobs run` waits on.
export const JOB_TIMEOUT_DEFAULT = 60;
export const JOB_TIMEOUT_MIN = 5;
export const JOB_TIMEOUT_MAX = 290;
export const jobTimeout = (s) => s?.job_timeout_s || JOB_TIMEOUT_DEFAULT;

// Nightly backups kept. Seeded from BACKUP_KEEP on first boot; 0 (rows from before the setting) means BACKUP_KEEP.
export const BACKUP_KEEP_MIN = 1;
export const BACKUP_KEEP_MAX = 90;
// 1–90 like the API accepts; BACKUP_KEEP is seeded unchecked, and 0 or less would prune every backup.
export const backupKeep = (s, fallback = config.backups.keep) => {
  const n = Math.trunc(s?.backup_keep || fallback);
  return Number.isFinite(n) ? Math.min(90, Math.max(1, n)) : 1;
};

export const settingsView = (s) => ({
  server_name: serverName(s), signup_code: s.signup_code, open_signup: s.open_signup, max_apps_per_user: s.max_apps_per_user,
  max_deploy_mb: s.max_deploy_mb, update_check: !s.update_check_off, jobs: !s.jobs_off, job_timeout_s: jobTimeout(s),
  backup_keep: backupKeep(s),
});

// Signup rules that don't need the database: required fields, password length, signup code.
export function checkSignup({ email, password, code } = {}, settings) {
  if (!email || !password) throw new HttpError(400, 'Email and password are required');
  if (String(password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (!settings.open_signup && String(code ?? '').trim().toLowerCase() !== settings.signup_code) {
    throw new HttpError(403, 'Invalid signup code. Ask the server admin for it.');
  }
}

export function compileRoutes(defs) {
  return defs.map(([method, pattern, access, handler]) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    return { method, re, keys, handler, access };
  });
}

export function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    const m = pathname.match(route.re);
    if (!m || route.method !== method) continue;
    return { route, params: Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

// Live docs for agents (the skill tells them to read this first): server facts + the app guide.
export function renderDocs({ guide, settings: s, publicUrl, baseDomain, version, keepDeploys, commands }) {
  const scheme = new URL(publicUrl).protocol;
  const body = guide
    .replace(/^# .*\n/, '')
    .replaceAll('{{SLUG}}', '<app>')
    .replaceAll('{{PREFIX}}', '<app_with_underscores>__')
    .replaceAll('{{URL}}', `${scheme}//<app>.${baseDomain}`);
  return `# ${serverName(s)}: Cubby server docs

Server name: ${serverName(s)}
Server: ${publicUrl}
Version: ${version}
Apps are served at: ${scheme}//<app>.${baseDomain}
HTTPS: ${scheme === 'https:' ? 'yes' : 'no (plain HTTP: do not describe apps as secure)'}
Signup: ${s.open_signup ? 'open' : 'requires a signup code from the server admin'}

## Limits

- Apps per user: ${s.max_apps_per_user}
- Max deploy size (built dist/): ${s.max_deploy_mb} MB
- Deploys kept per app (for rollback): ${keepDeploys}

## CLI

Install or update: \`npm i -g ${publicUrl}/cli.tgz\` (Node.js 20+)
Log in: \`cubby login ${publicUrl}\` (approve in the browser), or \`--token <token from the dashboard>\`
Agent skill: installed by \`cubby login\`, or \`cubby skill install\`
The CLI always matches the server it talks to; in an app folder, the server in cubby.json.

## Commands on this server (Cubby ${version})

${commands || '(see `cubby help`)'}

# Building apps
${body}`;
}
