import http from 'node:http';
import { readFile, statfs } from 'node:fs/promises';
import { config, SLUG_RE, prefixFor } from './config.js';
import { HttpError, sendJson, readJson, readBody, rateLimiter } from './http.js';
import { admin, startPocketBase } from './pb.js';
import { signup, login, authenticate, regenerateToken, listAgents } from './auth.js';
import { applySchema, readSchema, dropFromSchema, projectCollections, deleteCollections } from './schema.js';
import { createDeploy, listDeploys, oldDeploys, deleteDeploys, rollback, removeSite, serveSite, sendPage, appDiskUsage, dirSize } from './sites.js';
import { proxyPocketBase } from './proxy.js';
import { bootstrap, getSettings, updateSettings, newSignupCode } from './settings.js';
import { scheduleBackups, createBackupRunner, runBackup } from './backups.js';
import { scanStorage, createTtlCache, listBackups, checkBackupDelete, planRetention, deleteBackup } from './storage.js';
import { listJobs, runNow, jobRuns, setPaused, allJobs, scheduleJobs, recoverRuns, deployJobs } from './jobs.js';
import { listEnv, setEnv, unsetEnv } from './secrets.js';
import { buildCliTarball, cliTarball, skillMarkdown } from './cli-dist.js';
import { startDevice, deviceInfo, approveDevice, pollDevice } from './device.js';
import * as logic from './logic.js';
import { commandsMarkdown } from '../../cli/src/commands.js';
import { createUpdateChecker, fetchLatestRelease, scheduleUpdateChecks, updateView } from './updates.js';

const updates = createUpdateChecker({ current: config.version, fetchLatest: () => fetchLatestRelease(config.updates.url) });
const updatesOn = async () => config.updates.enabled && !(await getSettings()).update_check_off;

const appUrl = (slug) => logic.appUrl(slug, config.publicUrl, config.baseDomain);
const projectView = (p) => logic.projectView(p, config);

// PocketBase "not found" becomes a 404 instead of an internal error.
const orNotFound = (what) => (err) => {
  if (err?.status === 404) throw new HttpError(404, `${what} not found`);
  throw err;
};

async function findProject(slug) {
  if (!SLUG_RE.test(slug)) return null;
  return admin.collection('cubby_projects').getFirstListItem(admin.filter('slug = {:s}', { s: slug })).catch(() => null);
}

// Only the owner may change an app. Admins can delete apps, but only through /api/admin.
async function ownedProject(user, slug) {
  const project = await findProject(slug);
  if (!project || project.owner !== user.id) throw new HttpError(404, `App "${slug}" not found in your account`);
  return project;
}

async function removeProject(project) {
  await deleteCollections(await projectCollections(project.slug));
  await removeSite(project.slug);
  await admin.collection('cubby_projects').delete(project.id);
}

function requireAdmin(user) {
  if (!user.is_admin) throw new HttpError(403, 'Admins only');
}

const authLimit = rateLimiter(10, 60_000);
const deviceLimit = rateLimiter(20, 60_000);

// --- Control plane API (on the root domain) -------------------------------------------------

const routes = [
  ['GET', '/api/info', 'public', async () => {
    const s = await getSettings();
    return { name: logic.serverName(s), version: config.version, commit: config.commit, open_signup: Boolean(s.open_signup), https: config.publicUrl.startsWith('https'), base_domain: config.baseDomain, features: logic.FEATURES };
  }],
  ['POST', '/api/signup', 'public', async (req) => (authLimit(req), signup(await readJson(req)))],
  ['POST', '/api/login', 'public', async (req) => (authLimit(req), login(await readJson(req)))],
  ['POST', '/api/device/start', 'public', async (req) => (deviceLimit(req), startDevice(config.publicUrl, Date.now(), logic.agentHint(await readJson(req, 4096))))],
  ['POST', '/api/device/poll', 'public', async (req) => pollDevice((await readJson(req)).device_id)],
  ['GET', '/api/device/:code', 'optional', async (req, user, { code }) => deviceInfo(code, Date.now(), user)],
  ['POST', '/api/device/approve', 'user', async (req, user) => approveDevice(user, (await readJson(req)).code)],
  ['GET', '/api/me', 'user', async (req, user) => ({ ...user, key: undefined, keyId: undefined, token: user.key })],
  ['GET', '/api/agents', 'user', async (req, user) => listAgents(user)],
  ['POST', '/api/token/regenerate', 'user', async (req, user) => ({ token: await regenerateToken(user.id) })],

  ['GET', '/api/projects', 'user', async (req, user) => {
    const list = await admin.collection('cubby_projects').getFullList({ filter: admin.filter('owner = {:u}', { u: user.id }), sort: '-created' });
    return Promise.all(list.map(async (p) => ({ ...projectView(p), jobs: (await deployJobs(p.slug, p.current_deploy)).length })));
  }],
  ['POST', '/api/projects', 'user', async (req, user) => {
    const { slug, name, description } = await readJson(req);
    logic.checkNewSlug(slug);
    const { max_apps_per_user } = await getSettings();
    const count = (await admin.collection('cubby_projects').getList(1, 1, { filter: admin.filter('owner = {:u}', { u: user.id }) })).totalItems;
    if (count >= max_apps_per_user) throw new HttpError(403, `You've reached the limit of ${max_apps_per_user} apps. Delete one or ask the admin.`);
    if (await findProject(slug)) throw new HttpError(409, `"${slug}" is taken`);
    return projectView(await admin.collection('cubby_projects').create({ slug, name: name || slug, description: description ?? '', owner: user.id }));
  }],
  ['GET', '/api/projects/:slug', 'user', async (req, user, { slug }) => projectView(await ownedProject(user, slug))],
  ['PATCH', '/api/projects/:slug', 'user', async (req, user, { slug }) => {
    const project = await ownedProject(user, slug);
    const patch = logic.projectPatch(await readJson(req));
    return projectView(await admin.collection('cubby_projects').update(project.id, patch));
  }],
  ['DELETE', '/api/projects/:slug', 'user', async (req, user, { slug }) => (await removeProject(await ownedProject(user, slug)), { ok: true })],

  ['GET', '/api/projects/:slug/schema', 'user', async (req, user, { slug }) => (await ownedProject(user, slug), readSchema(slug))],
  ['PUT', '/api/projects/:slug/schema', 'user', async (req, user, { slug }) => {
    const project = await ownedProject(user, slug);
    const body = await readJson(req, 2 * 1024 * 1024);
    const changes = await applySchema(slug, body);
    if (typeof body.hash === 'string') await admin.collection('cubby_projects').update(project.id, { schema_hash: body.hash });
    return changes;
  }],
  ['DELETE', '/api/projects/:slug/schema/:target', 'user', async (req, user, { slug, target }) => {
    const project = await ownedProject(user, slug);
    const result = await dropFromSchema(slug, target);
    await admin.collection('cubby_projects').update(project.id, { schema_hash: '' });
    return result;
  }],

  ['GET', '/api/projects/:slug/deploys', 'user', async (req, user, { slug }) => listDeploys(await ownedProject(user, slug))],
  ['POST', '/api/projects/:slug/deploys', 'user', async (req, user, { slug }, url) => {
    const project = await ownedProject(user, slug);
    const { max_deploy_mb } = await getSettings();
    const body = await readBody(req, max_deploy_mb * 1024 * 1024);
    const deploy = await createDeploy(project, body, url.searchParams.get('message') ?? '', logic.deployClient(req.headers['x-cubby-client']));
    const patch = logic.deployPatch(url.searchParams);
    if (Object.keys(patch).length) await admin.collection('cubby_projects').update(project.id, patch);
    return { ...deploy, url: appUrl(slug) };
  }],
  ['POST', '/api/projects/:slug/rollback', 'user', async (req, user, { slug }) => {
    const project = await ownedProject(user, slug);
    const { deploy } = await readJson(req);
    await rollback(project, deploy);
    return { ok: true, current_deploy: deploy, url: appUrl(slug) };
  }],

  ['GET', '/api/projects/:slug/jobs', 'user', async (req, user, { slug }) => listJobs(await ownedProject(user, slug))],
  ['POST', '/api/projects/:slug/jobs/:name/run', 'user', async (req, user, { slug, name }) => runNow(await ownedProject(user, slug), name)],
  ['GET', '/api/projects/:slug/jobs/:name/runs', 'user', async (req, user, { slug, name }, url) => (
    jobRuns(await ownedProject(user, slug), name, { limit: url.searchParams.get('limit'), id: url.searchParams.get('run') })
  )],
  ['PATCH', '/api/projects/:slug/jobs/:name', 'user', async (req, user, { slug, name }) => {
    const project = await ownedProject(user, slug);
    const { paused } = await readJson(req);
    if (typeof paused !== 'boolean') throw new HttpError(400, 'Body must be { "paused": true | false }');
    return setPaused(project, name, paused);
  }],

  ['GET', '/api/projects/:slug/env', 'user', async (req, user, { slug }) => listEnv(await ownedProject(user, slug))],
  ['PUT', '/api/projects/:slug/env/:key', 'user', async (req, user, { slug, key }) => setEnv(await ownedProject(user, slug), key, (await readJson(req, 64 * 1024)).value)],
  ['DELETE', '/api/projects/:slug/env/:key', 'user', async (req, user, { slug, key }) => unsetEnv(await ownedProject(user, slug), key)],

  ['GET', '/api/gallery', 'user', async () => {
    const list = await admin.collection('cubby_projects').getFullList({ filter: 'unlisted = false && current_deploy != ""', sort: '-last_deployed', expand: 'owner' });
    return list.map(projectView).map(logic.galleryView);
  }],

  // --- Admin ---
  ['GET', '/api/admin/overview', 'admin', async () => {
    const s = await getSettings();
    const fs = await statfs(config.dataDir);
    const [users, apps] = await Promise.all([
      admin.collection('users').getList(1, 1),
      admin.collection('cubby_projects').getList(1, 1),
    ]);
    return {
      settings: logic.settingsView(s),
      invite: `${config.publicUrl}  (signup code: ${s.signup_code})`,
      server: {
        version: config.version, commit: config.commit, public_url: config.publicUrl, https: config.publicUrl.startsWith('https'),
        data_bytes: await dirSize(config.dataDir), disk_free_bytes: fs.bavail * fs.bsize, disk_total_bytes: fs.blocks * fs.bsize,
        users: users.totalItems, apps: apps.totalItems,
      },
      update: updateView({ envEnabled: config.updates.enabled, settingEnabled: !s.update_check_off, checker: updates }),
    };
  }],
  ['PATCH', '/api/admin/settings', 'admin', async (req) => {
    const patch = logic.settingsPatch(await readJson(req), newSignupCode);
    const s = await updateSettings(patch);
    // Turning the check (back) on asks GitHub right away, so the admin sees a current answer.
    if (patch.update_check_off === false && config.updates.enabled) await updates.check({ force: true });
    return logic.settingsView(s);
  }],
  ['GET', '/api/admin/users', 'admin', async () => {
    const [users, projects] = await Promise.all([
      admin.collection('users').getFullList({ sort: 'created' }),
      admin.collection('cubby_projects').getFullList(),
    ]);
    const usage = await appUsage(projects);
    return users.map((u) => {
      const mine = projects.filter((p) => p.owner === u.id);
      return {
        id: u.id, email: u.email, is_admin: Boolean(u.is_admin), disabled: Boolean(u.disabled), created: u.created,
        apps: mine.length, disk_bytes: mine.reduce((sum, p) => sum + (usage.get(p.slug) ?? 0), 0),
      };
    });
  }],
  ['PATCH', '/api/admin/users/:id', 'admin', async (req, user, { id }) => {
    if (id === user.id) throw new HttpError(400, "You can't disable your own account");
    const { disabled } = await readJson(req);
    const u = await admin.collection('users').update(id, { disabled: Boolean(disabled) }).catch(orNotFound('User'));
    return { id: u.id, disabled: u.disabled };
  }],
  ['DELETE', '/api/admin/users/:id', 'admin', async (req, user, { id }) => {
    if (id === user.id) throw new HttpError(400, "You can't delete your own account");
    await admin.collection('users').getOne(id).catch(orNotFound('User'));
    const projects = await admin.collection('cubby_projects').getFullList({ filter: admin.filter('owner = {:u}', { u: id }) });
    for (const p of projects) await removeProject(p);
    await admin.collection('users').delete(id);
    return { ok: true, deleted_apps: projects.map((p) => p.slug) };
  }],
  ['GET', '/api/admin/apps', 'admin', async () => {
    const projects = await admin.collection('cubby_projects').getFullList({ sort: '-created', expand: 'owner' });
    const usage = await appUsage(projects);
    return projects.map((p) => ({ ...projectView(p), disk_bytes: usage.get(p.slug) ?? 0 }));
  }],
  ['GET', '/api/admin/jobs', 'admin', async () => allJobs()],
  ['GET', '/api/admin/storage', 'admin', async () => storageCache.get(computeStorage)],
  // `estimate`: what the next nightly prune deletes (whole pairs) and frees, for the setting or a ?keep=N to preview.
  ['GET', '/api/admin/backups', 'admin', async (req, user, params, url) => {
    const keep = logic.backupKeep(await getSettings());
    const asked = url.searchParams.get('keep');
    const list = await listBackups(admin, config.dataDir);
    const estimate = planRetention(list, asked === null ? keep : logic.settingsPatch({ backup_keep: asked }).backup_keep);
    return { backups: list, ...backups.state(), keep, estimate };
  }],
  ['POST', '/api/admin/backups', 'admin', async () => {
    const { promise, ...run } = backups.start();
    promise.catch((err) => console.error('backup failed:', err.message));
    return { started: true, ...run };
  }],
  // Always both files of the pair. The only backup needs ?leave_none=1. Restore stays `cubby-server restore`.
  ['DELETE', '/api/admin/backups/:date', 'admin', async (req, user, { date }, url) => {
    const list = await listBackups(admin, config.dataDir);
    const { warning } = checkBackupDelete(list, date, { leaveNone: url.searchParams.get('leave_none') === '1', running: Boolean(backups.state().running) });
    const files = await deleteBackup(admin, config.dataDir, list.find((b) => b.date === date));
    storageCache.clear();
    return { ok: true, deleted: date, files, warning };
  }],
  // Older deploys of any app (kept for rollback), oldest first; never the current one.
  ['GET', '/api/admin/apps/:slug/deploys', 'admin', async (req, user, { slug }) => listDeploys(await adminProject(slug))],
  ['POST', '/api/admin/apps/:slug/deploys/prune', 'admin', async (req, user, { slug }) => {
    const project = await adminProject(slug);
    return removeDeploys(project, oldDeploys(await listDeploys(project), { keep: (await readJson(req)).keep ?? 0 }));
  }],
  ['DELETE', '/api/admin/apps/:slug/deploys/:id', 'admin', async (req, user, { slug, id }) => {
    const project = await adminProject(slug);
    return removeDeploys(project, oldDeploys(await listDeploys(project), { id }));
  }],
  ['DELETE', '/api/admin/apps/:slug', 'admin', async (req, user, { slug }) => {
    await removeProject(await adminProject(slug));
    return { ok: true };
  }],
];
const compiledRoutes = logic.compileRoutes(routes);

async function adminProject(slug) {
  const project = await findProject(slug);
  if (!project) throw new HttpError(404, `App "${slug}" not found`);
  return project;
}

async function removeDeploys(project, picked) {
  const freed = await deleteDeploys(project, picked);
  if (picked.length) storageCache.clear();
  return { ok: true, deleted: picked.map((d) => d.id), freed_bytes: freed, deploys: await listDeploys(project) };
}

// Storage breakdown for admins: computed on demand (a full size scan), cached for 5 minutes, never stored.
const storageCache = createTtlCache(5 * 60_000);
// One backup at a time, whether started by an admin or the nightly schedule. A finished backup changes the
// breakdown, so it drops the cached one. (`cubby-server backup` runs in another process and isn't guarded.)
const backups = createBackupRunner({ run: () => runBackup().finally(() => storageCache.clear()) });
async function computeStorage() {
  const [projects, cols, fs] = await Promise.all([
    admin.collection('cubby_projects').getFullList({ expand: 'owner' }),
    admin.collections.getFullList({ batch: 500 }),
    statfs(config.dataDir),
  ]);
  const apps = projects.map((p) => ({
    slug: p.slug, owner: p.expand?.owner?.email ?? null, current_deploy: p.current_deploy,
    collectionIds: cols.filter((c) => c.name.startsWith(prefixFor(p.slug))).map((c) => c.id),
  }));
  return {
    computed_at: new Date().toISOString(),
    disk: { total_bytes: fs.blocks * fs.bsize, free_bytes: fs.bavail * fs.bsize },
    ...(await scanStorage(config.dataDir, apps)),
  };
}

async function appUsage(projects) {
  const cols = await admin.collections.getFullList({ batch: 500 });
  const usage = new Map();
  for (const p of projects) {
    const prefix = prefixFor(p.slug);
    usage.set(p.slug, await appDiskUsage(p.slug, cols.filter((c) => c.name.startsWith(prefix)).map((c) => c.id)));
  }
  return usage;
}

async function handleApi(req, res, url) {
  const match = logic.matchRoute(compiledRoutes, req.method, url.pathname);
  if (!match) throw new HttpError(404, 'Not found');
  const { route, params } = match;
  // 'optional' routes answer everyone but tell a signed-in user more; a bad token there is just anonymous.
  const user = route.access === 'public' ? null
    : route.access === 'optional' ? await authenticate(req).catch(() => null)
    : await authenticate(req);
  if (route.access === 'admin') requireAdmin(user);
  return sendJson(res, 200, await route.handler(req, user, params, url));
}

// --- Request routing ----------------------------------------------------------------------

const appSlugFromHost = (host) => logic.appSlugFromHost(host, config.baseDomain);

async function handleApp(req, res, slug, url) {
  const project = await findProject(slug);
  if (!project) return sendPage(res, 404, 'No app here', `Nothing is deployed at <b>${slug}</b>.`);
  if (url.pathname.startsWith('/pb/')) return proxyPocketBase(req, res, slug, url);
  if (url.pathname === '/__cubby/config.js') {
    const cfg = { project: slug, prefix: prefixFor(slug), pbUrl: '/pb' };
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(`window.__CUBBY__=${JSON.stringify(cfg)};`);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendPage(res, 405, 'Method not allowed');
  return serveSite(req, res, project, url.pathname);
}

// Caddy asks before issuing an on-demand certificate; only the root domain and real apps qualify.
async function tlsCheck(req, res, url) {
  if (!logic.isLoopback(req.socket.remoteAddress)) return sendPage(res, 404, 'Not found');
  const domain = url.searchParams.get('domain') ?? '';
  const ok = domain === config.baseDomain || Boolean(appSlugFromHost(domain) && (await findProject(appSlugFromHost(domain))));
  res.writeHead(ok ? 200 : 404);
  res.end();
}

const dashboard = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const skillInstaller = await readFile(new URL('../public/skill.sh', import.meta.url), 'utf8');
const agentsGuide = await readFile(new URL('../../cli/template/AGENTS.md', import.meta.url), 'utf8');

const docsMarkdown = async () => logic.renderDocs({
  guide: agentsGuide, settings: await getSettings(), publicUrl: config.publicUrl,
  baseDomain: config.baseDomain, version: config.version, keepDeploys: config.keepDeploys,
  // Same table as this server's `cubby help`, so docs and CLI can't drift.
  commands: commandsMarkdown(),
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('x-cubby-version', config.version);
  try {
    // Local `vite dev` proxies /pb and /__cubby to the root domain with this header.
    const hostSlug = appSlugFromHost(req.headers.host);
    const devSlug = req.headers['x-cubby-project'];
    if (hostSlug) return await handleApp(req, res, hostSlug, url);
    if (devSlug && (url.pathname.startsWith('/pb/') || url.pathname.startsWith('/__cubby/'))) return await handleApp(req, res, devSlug, url);

    if (url.pathname === '/_internal/tls-check') return await tlsCheck(req, res, url);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/docs.md' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(await docsMarkdown());
    }
    if (url.pathname === '/cli.tgz' && cliTarball()) {
      res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': cliTarball().length });
      return res.end(cliTarball());
    }
    if (url.pathname === '/skill.md' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(skillMarkdown());
    }
    if (url.pathname === '/skill.sh' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(logic.renderSkillInstaller(skillInstaller, { publicUrl: config.publicUrl, name: logic.serverName(await getSettings()) }));
    }
    if (url.pathname === '/' && req.method === 'GET' && !logic.isBrowser(req.headers['user-agent'])) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', vary: 'User-Agent' });
      return res.end(logic.agentLanding({ publicUrl: config.publicUrl, name: logic.serverName(await getSettings()) }));
    }
    if ((url.pathname === '/' || url.pathname === '/connect') && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', vary: 'User-Agent' });
      return res.end(dashboard.replaceAll('{{PUBLIC_URL}}', config.publicUrl).replaceAll('{{VERSION}}', config.version));
    }
    sendPage(res, 404, 'Not found');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal error' : err.message, details: err.details });
    else res.end();
  }
});

await startPocketBase();
await bootstrap();
await buildCliTarball();
scheduleBackups({ run: async () => backups.start().promise });
await recoverRuns();
scheduleJobs();
scheduleUpdateChecks({ checker: updates, isEnabled: updatesOn });
server.listen(config.port, () => {
  console.log(`cubby ${config.version} on ${config.publicUrl}`);
  console.log(`apps served at ${new URL(config.publicUrl).protocol}//<app>.${config.baseDomain}`);
});
