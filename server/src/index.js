import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFile, statfs } from 'node:fs/promises';
import { config, SLUG_RE, prefixFor } from './config.js';
import { HttpError, sendJson, readJson, readBody, rateLimiter, clientIp } from './http.js';
import { admin, startPocketBase, onShutdown } from './pb.js';
import { signup, login, authenticate, regenerateToken, listAgents, renameAgent, revokeAgent } from './auth.js';
import { applySchema, readSchema, dropFromSchema, projectCollections, deleteCollections } from './schema.js';
import { createDeploy, listDeploys, oldDeploys, deleteDeploys, rollback, removeSite, serveSite, sendPage, appDiskUsage, dirSize } from './sites.js';
import { proxyPocketBase } from './proxy.js';
import { bootstrap, getSettings, updateSettings, newSignupCode } from './settings.js';
import { scheduleBackups, createBackupRunner, runMaintenance } from './backups.js';
import { scanStorage, createTtlCache, listBackups, checkBackupDelete, planRetention, deleteBackup } from './storage.js';
import { listJobs, runNow, jobRuns, setPaused, allJobs, scheduleJobs, recoverRuns, deployJobs } from './jobs.js';
import { listEnv, setEnv, unsetEnv } from './secrets.js';
import { createMetrics, pocketbaseStore, countsAsView, isPerson, parseRange, metricsClock, appAccounts, summarizeMetrics, appMetricsRow } from './metrics.js';
import { buildCliTarball, cliTarball, skillMarkdown } from './cli-dist.js';
import { startDevice, deviceInfo, approveDevice, pollDevice } from './device.js';
import * as logic from './logic.js';
import { recordActivity, listActivity } from './activity.js';
import { listData, clearData, oneAtATime } from './data.js';
import { removeAppSnapshots, listSnapshots, findSnapshot, removeSnapshot } from './snapshots.js';
import { restoreSnapshot } from './restore.js';
import { loadDashboard } from './dashboard.js';
import { matchRoute } from '../public/js/routes.js';
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
  await removeAppSnapshots(config.dataDir, project.slug);
  await admin.collection('cubby_projects').delete(project.id);
}

function requireAdmin(user) {
  if (!user.is_admin) throw new HttpError(403, 'Admins only');
}

// Page views, visitors, active now and /pb health per app: counted in memory, flushed to cubby_metrics every minute.
const metrics = createMetrics({ store: pocketbaseStore(admin), now: metricsClock(process.env.CUBBY_TEST_CLOCK_FILE) });

// After a clear that deleted something (`note` is added when it stopped early): like `cubby schema drop` (and a wipe),
// a drop makes the next deploy push schema.json again; an admin's clear flags the app for its owner; it's logged.
async function clearDone(user, project, actor, result, reason, note = '') {
  const patch = result.mode === 'drop' ? { schema_hash: '' } : {};
  if (actor.admin) patch.admin_clear = logic.adminClearFlag(user, result, reason);
  if (Object.keys(patch).length) await admin.collection('cubby_projects').update(project.id, patch);
  storageCache.clear();
  const slug = project.slug;
  if (actor.admin) {
    const summary = logic.adminClearSummary(user, result, reason) + note;
    await recordActivity(user, { action: 'admin.data.clear', app: slug, summary });
    await recordActivity({ id: project.owner }, { action: 'admin.data.clear', app: slug, summary });
  } else {
    await recordActivity(user, { action: 'data.clear', app: slug, summary: logic.clearSummary(result) + note });
  }
}

// Owners see their apps' metrics; admins see any app's.
async function appForOwnerOrAdmin(user, slug) {
  if (!user.is_admin) return ownedProject(user, slug);
  const project = await findProject(slug);
  if (!project) throw new HttpError(404, `App "${slug}" not found`);
  return project;
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
  ['GET', '/api/me', 'user', async (req, user) => ({ ...user, key: undefined, keyId: undefined, agent: undefined, token: user.key })],
  ['GET', '/api/agents', 'user', async (req, user) => listAgents(user)],
  ['PATCH', '/api/agents/:id', 'user', async (req, user, { id }) => renameAgent(user, id, (await readJson(req)).name)],
  ['DELETE', '/api/agents/:id', 'user', async (req, user, { id }) => revokeAgent(user, id)],
  ['GET', '/api/activity', 'user', async (req, user, params, url) => listActivity(user, Object.fromEntries(url.searchParams))],
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
    const project = await admin.collection('cubby_projects').create({ slug, name: name || slug, description: description ?? '', owner: user.id });
    await recordActivity(user, { action: 'app.create', app: slug, summary: `Created app "${slug}"` });
    return projectView(project);
  }],
  ['GET', '/api/projects/:slug', 'user', async (req, user, { slug }) => projectView(await ownedProject(user, slug))],
  ['PATCH', '/api/projects/:slug', 'user', async (req, user, { slug }) => {
    const project = await ownedProject(user, slug);
    const patch = logic.projectPatch(await readJson(req));
    const updated = await admin.collection('cubby_projects').update(project.id, patch);
    if (Object.keys(patch).length) await recordActivity(user, { action: 'app.update', app: slug, summary: logic.patchSummary(slug, patch) });
    return projectView(updated);
  }],
  ['DELETE', '/api/projects/:slug', 'user', async (req, user, { slug }) => {
    await removeProject(await ownedProject(user, slug));
    await recordActivity(user, { action: 'app.delete', app: slug, summary: `Deleted app "${slug}"` });
    return { ok: true };
  }],

  ['GET', '/api/projects/:slug/schema', 'user', async (req, user, { slug }) => (await ownedProject(user, slug), readSchema(slug))],
  ['PUT', '/api/projects/:slug/schema', 'user', async (req, user, { slug }) => {
    const project = await ownedProject(user, slug);
    const body = await readJson(req, 2 * 1024 * 1024);
    const changes = await oneAtATime(slug, () => applySchema(slug, body));
    if (typeof body.hash === 'string') await admin.collection('cubby_projects').update(project.id, { schema_hash: body.hash });
    await recordActivity(user, { action: 'schema.push', app: slug, summary: logic.schemaSummary(changes) });
    return changes;
  }],
  ['DELETE', '/api/projects/:slug/schema/:target', 'user', async (req, user, { slug, target }) => {
    const project = await ownedProject(user, slug);
    const result = await oneAtATime(slug, () => dropFromSchema(slug, target));
    await admin.collection('cubby_projects').update(project.id, { schema_hash: '' });
    await recordActivity(user, { action: 'schema.drop', app: slug, summary: `Dropped ${target} and its data` });
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
    await recordActivity(user, { action: 'deploy', app: slug, summary: `Deployed ${deploy.id} (${deploy.files} files)`, meta: { deploy: deploy.id, files: deploy.files } });
    return { ...deploy, url: appUrl(slug) };
  }],
  ['POST', '/api/projects/:slug/rollback', 'user', async (req, user, { slug }) => {
    const project = await ownedProject(user, slug);
    const { deploy } = await readJson(req);
    await rollback(project, deploy);
    await recordActivity(user, { action: 'rollback', app: slug, summary: `Rolled back to ${deploy}`, meta: { deploy } });
    return { ok: true, current_deploy: deploy, url: appUrl(slug) };
  }],

  ['GET', '/api/projects/:slug/jobs', 'user', async (req, user, { slug }) => listJobs(await ownedProject(user, slug))],
  ['POST', '/api/projects/:slug/jobs/:name/run', 'user', async (req, user, { slug, name }) => {
    const run = await runNow(await ownedProject(user, slug), name);
    await recordActivity(user, { action: 'job.run', app: slug, summary: `Ran job "${name}" now (${run.status})`, meta: { job: name, status: run.status } });
    return run;
  }],
  ['GET', '/api/projects/:slug/jobs/:name/runs', 'user', async (req, user, { slug, name }, url) => (
    jobRuns(await ownedProject(user, slug), name, { limit: url.searchParams.get('limit'), id: url.searchParams.get('run') })
  )],
  ['PATCH', '/api/projects/:slug/jobs/:name', 'user', async (req, user, { slug, name }) => {
    const project = await ownedProject(user, slug);
    const { paused } = await readJson(req);
    if (typeof paused !== 'boolean') throw new HttpError(400, 'Body must be { "paused": true | false }');
    const result = await setPaused(project, name, paused);
    await recordActivity(user, { action: paused ? 'job.pause' : 'job.resume', app: slug, summary: `${paused ? 'Paused' : 'Resumed'} job "${name}"`, meta: { job: name } });
    return result;
  }],

  ['GET', '/api/projects/:slug/env', 'user', async (req, user, { slug }) => listEnv(await ownedProject(user, slug))],
  // The activity log gets the key name only: secret values must never be logged.
  ['PUT', '/api/projects/:slug/env/:key', 'user', async (req, user, { slug, key }) => {
    const result = await setEnv(await ownedProject(user, slug), key, (await readJson(req, 64 * 1024)).value);
    await recordActivity(user, { action: 'env.set', app: slug, summary: `${result.created ? 'Added' : 'Changed'} secret ${key}` });
    return result;
  }],
  ['DELETE', '/api/projects/:slug/env/:key', 'user', async (req, user, { slug, key }) => {
    const result = await unsetEnv(await ownedProject(user, slug), key);
    await recordActivity(user, { action: 'env.unset', app: slug, summary: `Removed secret ${key}` });
    return result;
  }],

  ['GET', '/api/projects/:slug/metrics', 'user', async (req, user, { slug }, url) => {
    const range = url.searchParams.get('range') || '24h';
    const hours = parseRange(range);
    const project = await appForOwnerOrAdmin(user, slug);
    const report = (await metrics.report([project.id], hours))[project.id];
    const accounts = await appAccounts(admin, prefixFor(project.slug), Date.parse(report.from), Date.parse(report.to));
    // Deploy markers: the deploys still kept (the last 10) that went out in the range.
    const deploys = (await admin.collection('cubby_deploys').getFullList({
      filter: admin.filter('project = {:p} && created >= {:from}', { p: project.id, from: new Date(report.from) }), sort: 'created',
    })).map((d) => ({ id: d.id, created: d.created, message: d.message }));
    return { app: project.slug, range, ...report, accounts, deploys };
  }],
  ['GET', '/api/metrics', 'user', async (req, user, params, url) => {
    const range = url.searchParams.get('range') || '24h';
    const hours = parseRange(range);
    const list = await admin.collection('cubby_projects').getFullList({ filter: admin.filter('owner = {:u}', { u: user.id }), sort: 'slug' });
    const report = await metrics.report(list.map((p) => p.id), hours);
    return list.map((p) => appMetricsRow(p, range, report[p.id]));
  }],

  // Data: what's in an app's collections, and clearing it (after a snapshot). Owners for their apps; admins any app.
  ['GET', '/api/projects/:slug/data', 'user', async (req, user, { slug }) => (
    listData((await appForOwnerOrAdmin(user, slug)).slug, { pb: admin, dataDir: config.dataDir })
  )],
  ['POST', '/api/projects/:slug/data/clear', 'user', async (req, user, { slug }) => {
    const project = await appForOwnerOrAdmin(user, slug);
    const body = await readJson(req);
    const actor = { id: user.id, email: user.email, admin: project.owner !== user.id };
    // An admin clearing someone else's app must say why: the owner is told (activity, and a flag for the dashboard).
    const reason = body.dry_run ? '' : logic.clearReason(user, project, body.reason);
    let result;
    try {
      result = await oneAtATime(project.slug, () => clearData(project.slug, body, { pb: admin, dataDir: config.dataDir, project, actor, reason }));
    } catch (err) {
      // PocketBase refused partway (something changed meanwhile): what was deleted is in the snapshot, and logged.
      if (err.cleared) await clearDone(user, project, actor, err.cleared, reason, ` Stopped early: ${err.message}`);
      throw err;
    }
    if (!result.snapshot) return result; // a dry run, or nothing matched: nothing changed
    await clearDone(user, project, actor, result, reason);
    return result;
  }],
  // The owner dismisses the "data cleared by admin" banner.
  ['DELETE', '/api/projects/:slug/admin-clear', 'user', async (req, user, { slug }) => {
    const project = await ownedProject(user, slug);
    await admin.collection('cubby_projects').update(project.id, { admin_clear: null });
    return { ok: true };
  }],

  // Snapshots of data clears: of one app (?app=), or of all your apps.
  ['GET', '/api/snapshots', 'user', async (req, user, params, url) => {
    const app = url.searchParams.get('app');
    const slugs = app ? [(await appForOwnerOrAdmin(user, app)).slug]
      : (await admin.collection('cubby_projects').getFullList({ filter: admin.filter('owner = {:u}', { u: user.id }), fields: 'slug' })).map((p) => p.slug);
    return (await listSnapshots(config.dataDir, slugs)).map(logic.snapshotView);
  }],
  ['POST', '/api/snapshots/:id/restore', 'user', async (req, user, { id }) => {
    const snap = await findSnapshot(config.dataDir, id);
    const project = await appForOwnerOrAdmin(user, snap.meta.app);
    const { overwrite, dry_run } = await readJson(req);
    const actor = { id: user.id, email: user.email, admin: project.owner !== user.id };
    const result = await oneAtATime(project.slug, () => restoreSnapshot(snap, { overwrite: Boolean(overwrite), dry_run: Boolean(dry_run) }, { pb: admin, dataDir: config.dataDir, project, actor }));
    if (dry_run) return result;
    storageCache.clear();
    await recordActivity(user, { action: 'data.restore', app: project.slug, summary: logic.restoreSummary(result) });
    return result;
  }],
  // Deletes a snapshot before it expires. Owners can't purge one an admin made; admins can purge any.
  ['DELETE', '/api/snapshots/:id', 'user', async (req, user, { id }) => {
    const snap = await findSnapshot(config.dataDir, id);
    const project = await appForOwnerOrAdmin(user, snap.meta.app);
    logic.checkPurge(user, snap.meta);
    await removeSnapshot(snap.dir);
    storageCache.clear();
    await recordActivity(user, { action: 'data.purge', app: project.slug, summary: `Purged snapshot ${id}` });
    return { ok: true, purged: id };
  }],

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
    await recordActivity(user, { action: u.disabled ? 'admin.user.disable' : 'admin.user.enable', summary: `${u.disabled ? 'Disabled' : 'Enabled'} user ${u.email}` });
    return { id: u.id, disabled: u.disabled };
  }],
  ['DELETE', '/api/admin/users/:id', 'admin', async (req, user, { id }) => {
    if (id === user.id) throw new HttpError(400, "You can't delete your own account");
    const target = await admin.collection('users').getOne(id).catch(orNotFound('User'));
    const projects = await admin.collection('cubby_projects').getFullList({ filter: admin.filter('owner = {:u}', { u: id }) });
    for (const p of projects) await removeProject(p);
    await admin.collection('users').delete(id);
    const apps = projects.map((p) => p.slug).join(', ');
    await recordActivity(user, { action: 'admin.user.delete', summary: `Deleted user ${target.email}${apps ? ` and their apps: ${apps}` : ''}` });
    return { ok: true, deleted_apps: projects.map((p) => p.slug) };
  }],
  ['GET', '/api/admin/apps', 'admin', async () => {
    const projects = await admin.collection('cubby_projects').getFullList({ sort: '-created', expand: 'owner' });
    const usage = await appUsage(projects);
    return projects.map((p) => ({ ...projectView(p), disk_bytes: usage.get(p.slug) ?? 0 }));
  }],
  ['GET', '/api/admin/jobs', 'admin', async () => allJobs()],
  // Every app's numbers summed, with the busiest apps (by views).
  ['GET', '/api/admin/metrics', 'admin', async (req, user, params, url) => {
    const range = url.searchParams.get('range') || '24h';
    const hours = parseRange(range);
    const list = await admin.collection('cubby_projects').getFullList({ sort: 'slug', expand: 'owner' });
    return { range, ...summarizeMetrics(list, await metrics.report(list.map((p) => p.id), hours)) };
  }],
  ['GET', '/api/admin/storage', 'admin', async () => storageCache.get(computeStorage)],
  // `estimate`: what the next nightly prune deletes (whole pairs) and frees, for the setting or a ?keep=N to preview.
  ['GET', '/api/admin/backups', 'admin', async (req, user, params, url) => {
    const keep = logic.backupKeep(await getSettings());
    const asked = url.searchParams.get('keep');
    const list = await listBackups(admin, config.dataDir);
    const estimate = planRetention(list, asked === null ? keep : logic.settingsPatch({ backup_keep: asked }).backup_keep);
    return { backups: list, ...backups.state(), keep, estimate };
  }],
  ['POST', '/api/admin/backups', 'admin', async (req, user) => {
    const { promise, ...run } = backups.start();
    promise.catch((err) => console.error('backup failed:', err.message));
    await recordActivity(user, { action: 'admin.backup.create', summary: `Started a backup (${run.date})` });
    return { started: true, ...run };
  }],
  // Always both files of the pair. The only backup needs ?leave_none=1. Restore stays `cubby-server restore`.
  ['DELETE', '/api/admin/backups/:date', 'admin', async (req, user, { date }, url) => {
    const list = await listBackups(admin, config.dataDir);
    const { warning } = checkBackupDelete(list, date, { leaveNone: url.searchParams.get('leave_none') === '1', running: Boolean(backups.state().running) });
    const files = await deleteBackup(admin, config.dataDir, list.find((b) => b.date === date));
    storageCache.clear();
    await recordActivity(user, { action: 'admin.backup.delete', summary: `Deleted backup ${date}` });
    return { ok: true, deleted: date, files, warning };
  }],
  ['GET', '/api/admin/activity', 'admin', async (req, user, params, url) => listActivity(user, Object.fromEntries(url.searchParams), { all: true })],
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
    const project = await adminProject(slug);
    const owner = await admin.collection('users').getOne(project.owner).catch(() => null);
    await removeProject(project);
    await recordActivity(user, { action: 'admin.app.delete', app: slug, summary: `Deleted app "${slug}" (owned by ${owner?.email ?? 'unknown'})` });
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
// Every backup (nightly or "Back up now") is the nightly maintenance: prune old activity, then back up.
const backups = createBackupRunner({ run: () => runMaintenance().finally(() => storageCache.clear()) });
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
  if (url.pathname.startsWith('/pb/')) {
    // Counted around the proxy, never changing what it decides. A realtime stream counts when it ends.
    if (isPerson(req.headers)) metrics.seen(project.id, { ip: clientIp(req), ua: req.headers['user-agent'] });
    res.once('close', () => metrics.apiResponse(project.id, res.statusCode));
    return proxyPocketBase(req, res, slug, url);
  }
  if (url.pathname === '/__cubby/config.js') {
    const cfg = { project: slug, prefix: prefixFor(slug), pbUrl: '/pb' };
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(`window.__CUBBY__=${JSON.stringify(cfg)};`);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendPage(res, 405, 'Method not allowed');
  const page = await serveSite(req, res, project, url.pathname);
  if (page && countsAsView(req)) metrics.record(project.id, { ip: clientIp(req), ua: req.headers['user-agent'], path: url.pathname });
}

// Caddy asks before issuing an on-demand certificate; only the root domain and real apps qualify.
async function tlsCheck(req, res, url) {
  if (!logic.isLoopback(req.socket.remoteAddress)) return sendPage(res, 404, 'Not found');
  const domain = url.searchParams.get('domain') ?? '';
  const ok = domain === config.baseDomain || Boolean(appSlugFromHost(domain) && (await findProject(appSlugFromHost(domain))));
  res.writeHead(ok ? 200 : 404);
  res.end();
}

const dashboard = await loadDashboard(fileURLToPath(new URL('../public/', import.meta.url)));
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
    // Every dashboard page (/, /apps/:slug, /admin, …) is the same shell; the browser's router draws the page.
    if (matchRoute(url.pathname) && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', vary: 'User-Agent' });
      return res.end(dashboard.page({ publicUrl: config.publicUrl, version: config.version }));
    }
    const asset = req.method === 'GET' && dashboard.asset(url.pathname);
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'content-length': asset.body.length, 'cache-control': 'public, max-age=31536000, immutable' });
      return res.end(asset.body);
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
metrics.start();
onShutdown(() => metrics.flush());
scheduleUpdateChecks({ checker: updates, isEnabled: updatesOn });
server.listen(config.port, () => {
  console.log(`cubby ${config.version} on ${config.publicUrl}`);
  console.log(`apps served at ${new URL(config.publicUrl).protocol}//<app>.${config.baseDomain}`);
});
