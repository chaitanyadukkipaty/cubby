#!/usr/bin/env node
// The cubby CLI. Normally started by launcher.js, which picks the CLI version that matches the server.
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve, relative } from 'node:path';
import * as tar from 'tar';
import {
  CliError, normalizeServerArg, parseSchemaText, describeSchemaChanges, versionWarning,
  deployParams, formatDeploys, formatProjects, formatError, copyTemplate, waitForApproval, serverLabel,
  installSkill as installSkillAt, removeSkill, skillStatus,
  jobEntries, jobSchedule, jobsBuildScript, formatJobs, formatRun, formatEnv, parseEnvAssignment,
  formatStorage, formatBackups, formatBytes, formatRetention, loginHint, formatAgents, formatActivity, formatMetrics, formatMetricsList, formatAdminMetrics, formatData, formatClear, formatClearPreview, formatSnapshots, formatRestore,
} from './lib.js';
import {
  readConfig, writeConfig, upsertServer, removeServer, findServer, resolveTarget, readProject, projectJson,
  listServers, formatServers, describeServer,
} from './servers.js';
import { helpJson, helpText } from './commands.js';

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: 'string' }, password: { type: 'string' }, server: { type: 'string' },
    dir: { type: 'string' }, name: { type: 'string' }, file: { type: 'string' }, message: { type: 'string', short: 'm' },
    token: { type: 'string' }, code: { type: 'string' }, client: { type: 'string' }, 'no-skill': { type: 'boolean' }, wait: { type: 'boolean' }, 'no-wait': { type: 'boolean' },
    'no-install': { type: 'boolean' }, 'no-build': { type: 'boolean' }, unlisted: { type: 'boolean' }, listed: { type: 'boolean' },
    yes: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, all: { type: 'boolean' },
    run: { type: 'string' }, limit: { type: 'string' }, agent: { type: 'string' }, 'from-stdin': { type: 'boolean' }, 'leave-none': { type: 'boolean' },
    keep: { type: 'string' }, range: { type: 'string' },
    collections: { type: 'string' }, drop: { type: 'boolean' }, reason: { type: 'string' },
    collection: { type: 'string' }, filter: { type: 'string' }, ids: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'all-matching': { type: 'boolean' }, overwrite: { type: 'boolean' }, wipe: { type: 'boolean' },
  },
});

const CLI_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const TEMPLATE_DIR = new URL('../template/', import.meta.url).pathname;
const GLOBAL_DIR = join(homedir(), '.cubby');
const GLOBAL_CONFIG = join(GLOBAL_DIR, 'config.json');
const PROJECT_CONFIG = 'cubby.json';

const readJsonFile = (p, fallback = {}) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const writeJsonFile = (p, data) => writeFileSync(p, JSON.stringify(data, null, 2) + '\n');

// Lenient: a config written by a newer CLI can still be read to find servers; writes to it are refused.
// Under the launcher (CUBBY_LAUNCHED), HOME is a per-server sandbox, so this never sees the real config.
const config = () => readConfig(GLOBAL_CONFIG, { lenient: true });
const projectConfig = () => readProject(resolve(PROJECT_CONFIG));

// The server this command talks to (see resolveTarget for the order).
let targetCache;
function target() {
  targetCache ??= resolveTarget(config(), { flag: flags.server, env: process.env.CUBBY_SERVER, projectServer: projectConfig()?.server });
  return targetCache;
}
const serverUrl = () => target().url;

function out(human, data) {
  if (flags.json) console.log(JSON.stringify(data ?? { ok: true }, null, 2));
  else console.log(human);
}

async function api(method, path, { body, raw, contentType, auth = true } = {}) {
  const headers = {};
  if (auth) {
    const token = process.env.CUBBY_TOKEN || target().server?.token;
    if (!token) throw new CliError(`Not logged in to ${serverUrl()}. Run \`cubby login ${serverUrl()}\`.`);
    headers.authorization = `Bearer ${token}`;
  }
  const client = flags.client || process.env.CUBBY_CLIENT;
  if (client) headers['x-cubby-client'] = client;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (raw) headers['content-type'] = contentType;
  let res;
  try {
    res = await fetch(serverUrl() + path, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  } catch (err) {
    throw new CliError(`Cannot reach ${serverUrl()}: ${err.cause?.code ?? err.message}`);
  }
  warnVersion(res.headers.get('x-cubby-version'));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new CliError(data.error || `HTTP ${res.status}`, data.details), { status: res.status });
  return data;
}

// The server's /api/info (display name, version), fetched once per command.
let infoCache;
const serverInfo = () => (infoCache ??= api('GET', '/api/info', { auth: false }).catch(() => ({})));
const serverName = async () => (await serverInfo()).name ?? null;
const where = async () => serverLabel(await serverName(), serverUrl());

let warned = false;
function warnVersion(serverVersion) {
  // Under the launcher, a mismatch can only mean the server upgraded mid-command; don't nag.
  const msg = warned || process.env.CUBBY_LAUNCHED ? null : versionWarning(CLI_VERSION, serverVersion, serverUrl());
  if (!msg) return;
  warned = true;
  console.error(msg);
}

// cubby.json pins an app to its server; it is never rewritten to point somewhere else.
function requireProject() {
  const cfg = projectConfig();
  if (!cfg?.project) throw new CliError(`No ${PROJECT_CONFIG} here. Run \`cubby init <slug>\` or \`cubby link <slug>\`.`);
  const t = target();
  if (!t.server?.token && !process.env.CUBBY_TOKEN && t.source === 'cubby.json') {
    throw new CliError(`This app lives on ${cfg.server} (cubby.json), and you're not logged in there. Run \`cubby login ${cfg.server}\`. If the server moved, run \`cubby link ${cfg.project} --server <new-url>\`.`);
  }
  return cfg.project;
}

async function saveSession(token, email) {
  const info = await serverInfo();
  const { cfg } = upsertServer(config(), {
    url: serverUrl(), token, email, name: info.name ?? null, version: info.version ?? null,
    version_checked_at: info.version ? Date.now() : undefined,
  });
  writeConfig(GLOBAL_CONFIG, cfg);
}

// `cubby login <url>` / `cubby signup <url>`: the positional URL wins over other sources.
function useServerArg(url) {
  if (url) {
    flags.server = normalizeServerArg(url);
    targetCache = undefined;
  }
}

// Bundles cubby/jobs/* into <dist>/__cubby_jobs/ with jobs.json (names and schedules), which the deploy carries.
function buildJobs(dist) {
  const src = resolve('cubby/jobs');
  if (!existsSync(src)) return;
  const entries = jobEntries(readdirSync(src));
  if (!Object.keys(entries).length) return;
  const jobs = Object.entries(entries).map(([name, file]) => ({ name, schedule: jobSchedule(readFileSync(join(src, file), 'utf8'), `cubby/jobs/${file}`) }));
  const out = join(dist, '__cubby_jobs');
  const input = Object.fromEntries(Object.entries(entries).map(([name, file]) => [name, join(src, file)]));
  run(process.execPath, ['--input-type=module', '-e', jobsBuildScript(input, out)], process.cwd());
  writeJsonFile(join(out, 'jobs.json'), { format: 1, jobs });
}

function readSchemaFile(file) {
  if (!existsSync(file)) return null;
  return parseSchemaText(readFileSync(file, 'utf8'), file);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: flags.json ? ['ignore', 'ignore', 'inherit'] : 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new CliError(`\`${cmd} ${args.join(' ')}\` failed`);
}

// --- Agent skill (logic in lib.js) ------------------------------------------------------------
const SKILL_SRC = new URL('../skill/cubby/', import.meta.url).pathname;
const installSkill = () => installSkillAt({ home: homedir(), src: SKILL_SRC, version: CLI_VERSION });

const commands = {
  async signup(url) {
    useServerArg(url);
    const r = await api('POST', '/api/signup', { auth: false, body: { email: flags.email, password: flags.password, code: flags.code } });
    await saveSession(r.key, r.user.email);
    out(`Signed up as ${r.user.email} on ${await where()}`, { user: r.user, server: serverUrl(), server_name: await serverName() });
  },
  async login(url) {
    useServerArg(url);
    const finish = async (token) => {
      process.env.CUBBY_TOKEN = token;
      const me = await api('GET', '/api/me');
      await saveSession(token, me.email);
      const skill = flags['no-skill'] ? null : installSkill();
      out(
        `Logged in as ${me.email} on ${await where()}${skill && !skill.kept ? `\nInstalled the cubby skill for: ${skill.agents.join(', ') || 'no agents found (copy is in ~/.agents/skills/cubby)'}` : ''}`,
        { status: 'logged_in', email: me.email, server: serverUrl(), server_name: await serverName(), skill },
      );
    };
    if (flags.token) return finish(flags.token);
    if (flags.email && flags.password) {
      const r = await api('POST', '/api/login', { auth: false, body: { email: flags.email, password: flags.password } });
      return finish(r.key);
    }

    // Browser approval. `--no-wait` / `--wait` split it in two so an agent can show the link first.
    const PENDING = join(GLOBAL_DIR, 'pending-login.json');
    let device;
    if (flags.wait && existsSync(PENDING)) {
      device = readJsonFile(PENDING);
      useServerArg(device.server);
    } else {
      if (flags.wait) throw new CliError('No login in progress. Run `cubby login <server-url> --no-wait` first.');
      // The hint names this agent on the approval page and in `cubby agents`.
      const hint = loginHint({ client: flags.client, env: process.env, hostname: hostname() });
      device = { ...(await api('POST', '/api/device/start', { auth: false, body: hint })), server: serverUrl() };
      mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(PENDING, JSON.stringify(device), { mode: 0o600 });
      const msg = `Open this link to approve this login (sign up there if you're new):\n  ${device.verify_url}\n  code: ${device.user_code}`;
      if (flags['no-wait']) {
        return out(`${msg}\nThen run: cubby login --wait`, { status: 'approval_required', verify_url: device.verify_url, user_code: device.user_code, expires_in: device.expires_in, server_name: await serverName(), next: 'cubby login --wait' });
      }
      console.error(msg);
      console.error('Waiting for approval…');
    }
    try {
      const token = await waitForApproval({
        poll: () => api('POST', '/api/device/poll', { auth: false, body: { device_id: device.device_id } }),
        expiresIn: device.expires_in,
        interval: device.interval ?? 2,
        sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      });
      rmSync(PENDING, { force: true });
      return finish(token);
    } catch (err) {
      rmSync(PENDING, { force: true });
      throw err;
    }
  },
  async logout() {
    if (flags.all) {
      rmSync(GLOBAL_CONFIG, { force: true });
      return out('Logged out of every server', { removed: 'all' });
    }
    const cfg = config();
    const hit = flags.server ? findServer(cfg, flags.server) : (() => { const t = target(); return t.server ? { id: t.id, server: t.server } : null; })();
    if (!hit) throw new CliError(`Not logged in to ${flags.server ?? serverUrl()}.`);
    writeConfig(GLOBAL_CONFIG, removeServer(cfg, hit.id));
    out(`Logged out of ${describeServer(hit.id, hit.server)}`, { removed: hit.id });
  },
  async servers() {
    const list = listServers(config());
    out(formatServers(list), list);
  },
  async use(query) {
    if (!query) throw new CliError('Usage: cubby use <name|url>');
    const cfg = config();
    const hit = findServer(cfg, query);
    if (!hit) throw new CliError(`No server called "${query}". See \`cubby servers\`, or add it with \`cubby login <server-url>\`.`);
    writeConfig(GLOBAL_CONFIG, { ...cfg, default: hit.id });
    out(`Default server: ${describeServer(hit.id, hit.server)}`, { default: hit.id });
  },
  async version() {
    const info = await serverInfo();
    out(`cubby CLI ${CLI_VERSION}\nserver: ${await where()} ${info.version ? `v${info.version}` : '(unreachable)'}`, { cli: CLI_VERSION, server: serverUrl(), server_name: info.name ?? null, server_version: info.version ?? null });
  },
  async skill(sub) {
    if (sub === 'install') {
      const r = installSkill();
      if (r.kept) return out(`Kept the installed cubby skill ${r.version}: it's newer than this CLI's (${CLI_VERSION}).`, r);
      return out(`Installed cubby skill ${r.version} to ${r.path}\n  linked for: ${r.agents.join(', ') || 'no agents found'}`, r);
    }
    if (sub === 'remove') {
      const { removed } = removeSkill(homedir());
      return out(`Removed cubby skill${removed.length ? ` (unlinked from ${removed.join(', ')})` : ''}`, { removed });
    }
    if (sub === 'status' || !sub) {
      const st = skillStatus(homedir());
      return out(
        `cubby skill: ${st.installed ? `${st.version} at ${st.path}` : 'not installed (run: cubby skill install)'}\n` + st.links.map((l) => `  ${l.agent.padEnd(12)} ${l.state}`).join('\n'),
        st,
      );
    }
    throw new CliError('Usage: cubby skill install|remove|status');
  },
  async help(name) {
    const data = helpJson(CLI_VERSION, name);
    if (!data) throw new CliError(`No command "${name}". Run \`cubby help\` for the list.`);
    out(name ? `${data.command.usage}\n  ${data.command.summary}` : helpText(CLI_VERSION), data);
  },
  async whoami() {
    const me = await api('GET', '/api/me');
    out(`${me.email}${me.is_admin ? ' (admin)' : ''} @ ${await where()}`, { email: me.email, is_admin: me.is_admin, server: serverUrl(), server_name: await serverName() });
  },
  async agents(sub, id, ...nameWords) {
    const usage = 'Usage: cubby agents [rename <id> <name> | revoke <id> --yes]';
    if (!sub || sub === 'list') {
      const list = await api('GET', '/api/agents');
      return out(formatAgents(list), list);
    }
    if (sub === 'rename') {
      const name = nameWords.join(' ');
      if (!id || !name) throw new CliError('Usage: cubby agents rename <id> <name>');
      const r = await api('PATCH', `/api/agents/${encodeURIComponent(id)}`, { body: { name } });
      return out(`Renamed ${id} to "${r.name}"`, r);
    }
    if (sub === 'revoke') {
      if (!id) throw new CliError('Usage: cubby agents revoke <id> --yes');
      if (!flags.yes) throw new CliError(`This revokes agent ${id}: its key stops working at once and it has to \`cubby login\` again. Re-run with --yes.`);
      const name = (await api('GET', '/api/agents')).find((a) => a.id === id)?.name ?? id;
      const r = await api('DELETE', `/api/agents/${encodeURIComponent(id)}`);
      // Revoking this agent's own key: forget it here, like `cubby logout`, so later commands say to log in.
      const t = target();
      const loggedOut = Boolean(r.current && t.server?.token && !process.env.CUBBY_TOKEN);
      if (loggedOut) writeConfig(GLOBAL_CONFIG, removeServer(config(), t.id));
      const human = r.current
        ? `Revoked ${name} (this agent).${loggedOut ? ` Logged out of ${describeServer(t.id, t.server)}.` : ''}`
        : `Revoked ${name}. It can't use this server until it runs \`cubby login\` again.`;
      return out(human, { ...r, logged_out: loggedOut });
    }
    throw new CliError(usage);
  },
  // Your actions (admins: everyone's, with --all), newest first. --agent <id> or --agent dashboard.
  async activity(app) {
    const q = new URLSearchParams();
    if (app) q.set('app', app);
    if (flags.agent) q.set('agent', flags.agent);
    if (flags.limit) q.set('limit', flags.limit);
    const list = await api('GET', `${flags.all ? '/api/admin/activity' : '/api/activity'}?${q}`);
    out(formatActivity(list, { users: Boolean(flags.all) }), list);
  },

  async init(slug) {
    if (!slug) throw new CliError('Usage: cubby init <slug>');
    const dir = resolve(flags.dir ?? slug);
    if (existsSync(dir) && readdirSync(dir).length) throw new CliError(`${dir} is not empty`);
    const project = await api('POST', '/api/projects', { body: { slug, name: flags.name } });
    copyTemplate(TEMPLATE_DIR, dir, { SLUG: slug, PREFIX: project.prefix, SERVER: serverUrl(), URL: project.url });
    writeJsonFile(join(dir, PROJECT_CONFIG), projectJson(slug, serverUrl()));
    if (!flags['no-install']) run('npm', ['install', '--no-audit', '--no-fund'], dir);
    out(
      `Created ${slug} on ${await where()} in ./${relative(process.cwd(), dir)}\n  url:  ${project.url}\n  next: cd ${relative(process.cwd(), dir)} && cubby schema push && cubby deploy`,
      { ...project, dir, server: serverUrl(), server_name: await serverName() },
    );
  },
  async link(slug) {
    if (!slug) throw new CliError('Usage: cubby link <slug> [--server <name|url>]');
    const project = await api('GET', `/api/projects/${encodeURIComponent(slug)}`);
    writeJsonFile(resolve(PROJECT_CONFIG), projectJson(slug, serverUrl()));
    out(`Linked ${process.cwd()} to ${slug} on ${await where()}`, { ...project, server: serverUrl() });
  },
  async projects() {
    const list = await api('GET', '/api/projects');
    out(formatProjects(list), list);
  },
  async info() {
    const p = await api('GET', `/api/projects/${requireProject()}`);
    const notice = p.admin_clear ? `\n  notice:  ${p.admin_clear.summary}` : '';
    out(`${p.slug}\n  server:  ${await where()}\n  url:     ${p.url}\n  prefix:  ${p.prefix}\n  deploy:  ${p.current_deploy ?? 'none'}${notice}`, { ...p, server: serverUrl() });
  },
  async delete(slug) {
    if (!slug) throw new CliError('Usage: cubby delete <slug> --yes');
    if (!flags.yes) throw new CliError(`This permanently deletes ${slug}, its data and deploys. Re-run with --yes.`);
    await api('DELETE', `/api/projects/${encodeURIComponent(slug)}`);
    out(`Deleted ${slug}`);
  },

  async schema(sub, targetName) {
    const slug = requireProject();
    const file = resolve(flags.file ?? 'cubby/schema.json');
    if (sub === 'push') {
      const local = readSchemaFile(file);
      if (!local) throw new CliError(`${file} not found`);
      const r = await api('PUT', `/api/projects/${slug}/schema`, { body: { ...local.schema, hash: local.hash } });
      return out(describeSchemaChanges(r), r);
    }
    if (sub === 'pull') {
      const schema = await api('GET', `/api/projects/${slug}/schema`);
      mkdirSync(resolve(file, '..'), { recursive: true });
      writeJsonFile(file, schema);
      return out(`Wrote ${relative(process.cwd(), file)} (${schema.collections.length} collections)`, schema);
    }
    if (sub === 'drop') {
      if (!targetName) throw new CliError('Usage: cubby schema drop <collection>[.<field>] --yes');
      if (!flags.yes) throw new CliError(`This permanently deletes ${targetName} and its data. Re-run with --yes.`);
      await api('DELETE', `/api/projects/${slug}/schema/${encodeURIComponent(targetName)}`);
      return out(`Dropped ${targetName}. Remove it from cubby/schema.json too, or the next push recreates it (empty).`, { dropped: targetName });
    }
    throw new CliError('Usage: cubby schema push|pull|drop');
  },

  async deploy() {
    const slug = requireProject();
    // 1. Schema first, so new code never runs against a backend that lacks its collections.
    const local = readSchemaFile(resolve(flags.file ?? 'cubby/schema.json'));
    if (local) {
      const project = await api('GET', `/api/projects/${slug}`);
      if (project.schema_hash !== local.hash) {
        const r = await api('PUT', `/api/projects/${slug}/schema`, { body: { ...local.schema, hash: local.hash } });
        if (!flags.json) console.log(describeSchemaChanges(r));
      }
    }
    // 2. Build.
    if (!flags['no-build']) run('npm', ['run', 'build'], process.cwd());
    const dist = resolve(flags.dir ?? 'dist');
    if (!existsSync(join(dist, 'index.html'))) throw new CliError(`${dist}/index.html not found — did the build succeed?`);
    if (!flags['no-build']) buildJobs(dist);
    // 3. Upload.
    const chunks = [];
    for await (const chunk of tar.c({ gzip: true, cwd: dist, portable: true }, ['.'])) chunks.push(chunk);
    const params = deployParams({ ...flags, description: readJsonFile(resolve('package.json')).description });
    const d = await api('POST', `/api/projects/${slug}/deploys?${params}`, { raw: Buffer.concat(chunks), contentType: 'application/gzip' });
    const jobs = d.jobs?.length ? `\n  jobs: ${d.jobs.join(', ')} (see \`cubby jobs\`)` : '';
    out(`Deployed ${d.id} to ${await where()} (${d.files} files, ${(d.bytes / 1024).toFixed(0)} KB)\n  ${d.url}${jobs}`, { ...d, server: serverUrl(), server_name: await serverName() });
  },
  async deploys() {
    const list = await api('GET', `/api/projects/${requireProject()}/deploys`);
    out(formatDeploys(list), list);
  },
  async rollback(id) {
    if (!id) throw new CliError('Usage: cubby rollback <deploy-id>');
    const r = await api('POST', `/api/projects/${requireProject()}/rollback`, { body: { deploy: id } });
    out(`Now serving ${id} at ${r.url}`, r);
  },

  async metrics(slug) {
    const query = flags.range ? `?${new URLSearchParams({ range: flags.range })}` : '';
    if (flags.all) {
      const r = await api('GET', `/api/admin/metrics${query}`).catch(async (err) => {
        if (err.status === 403) throw new CliError(`\`cubby metrics --all\` is for admins only. You're logged in to ${await where()} as a regular user.`);
        throw err;
      });
      return out(formatAdminMetrics(r), r);
    }
    if (!slug) {
      const list = await api('GET', `/api/metrics${query}`);
      return out(formatMetricsList(list), list);
    }
    const r = await api('GET', `/api/projects/${encodeURIComponent(slug)}/metrics${query}`);
    out(formatMetrics(r), r);
  },

  // An app's data: list collections, clear them (a snapshot is kept for 7 days). The app is the argument or cubby.json.
  async data(sub, appArg) {
    if (sub === 'restore') {
      const id = appArg;
      if (!id) throw new CliError('Usage: cubby data restore <snapshot-id> [--overwrite --yes] [--dry-run]');
      if (flags.overwrite && !flags.yes && !flags['dry-run']) throw new CliError(`--overwrite replaces records that exist again with the snapshot's versions (the current ones are saved in a new snapshot first). Re-run with --yes, or see what it does with --dry-run.`);
      const r = await api('POST', `/api/snapshots/${encodeURIComponent(id)}/restore`, { body: { overwrite: Boolean(flags.overwrite), dry_run: Boolean(flags['dry-run']) } });
      return out(formatRestore(r), r);
    }
    if (sub === 'purge') {
      const id = appArg;
      if (!id) throw new CliError('Usage: cubby data purge <snapshot-id> --yes');
      if (!flags.yes) throw new CliError(`This deletes snapshot ${id} now: what it holds can't be restored any more. Re-run with --yes.`);
      const r = await api('DELETE', `/api/snapshots/${encodeURIComponent(id)}`);
      return out(`Purged snapshot ${id}`, r);
    }
    if (sub === 'snapshots') {
      const app = appArg ?? projectConfig()?.project;
      const list = await api('GET', `/api/snapshots${app ? `?${new URLSearchParams({ app })}` : ''}`);
      return out(formatSnapshots(list), list);
    }
    const app = appArg ?? requireProject();
    const base = `/api/projects/${encodeURIComponent(app)}/data`;
    if (!sub || sub === 'list') {
      const list = await api('GET', base);
      return out(formatData(app, list), list);
    }
    if (sub === 'clear') {
      const list = (v) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const body = flags.wipe ? { wipe: true }
        : flags.collection ? { collection: flags.collection, ...(flags.ids !== undefined ? { ids: list(flags.ids) } : { filter: flags.filter }), all_matching: Boolean(flags['all-matching']) }
        : { collections: list(flags.collections), drop: Boolean(flags.drop) };
      if (body.collections && !body.collections.length) throw new CliError(DATA_USAGE);
      if (flags.reason) body.reason = flags.reason;
      // Without --yes (or with --dry-run) it only previews: what matches, a few of the records, what cascades.
      if (flags['dry-run'] || !flags.yes) {
        const preview = await api('POST', `${base}/clear`, { body: { ...body, dry_run: true } });
        if (flags['dry-run']) return out(formatClearPreview(app, preview), preview);
        const what = flags.wipe ? `drops every collection (${preview.matches} records)`
          : flags.collection ? `deletes ${preview.matches} records from ${flags.collection}`
          : `${flags.drop ? 'drops' : 'empties'} ${body.collections.join(', ')}${flags.drop ? ' (the collections themselves go too)' : ''}`;
        throw new CliError(`This ${what} in ${app}. A snapshot keeps them for 7 days (\`cubby data restore\`). Re-run with --yes.`, formatClearPreview(app, preview).split('\n').slice(1));
      }
      const r = await api('POST', `${base}/clear`, { body });
      return out(formatClear(app, r), r);
    }
    throw new CliError(DATA_USAGE);
  },

  async jobs(sub, name) {
    const base = `/api/projects/${requireProject()}/jobs`;
    if (!sub || sub === 'list') {
      const list = await api('GET', base);
      return out(formatJobs(list), list);
    }
    if (!['run', 'logs', 'pause', 'resume'].includes(sub)) throw new CliError('Usage: cubby jobs [run|logs|pause|resume <job>]');
    if (!name) throw new CliError(`Usage: cubby jobs ${sub} <job>`);
    const job = `${base}/${encodeURIComponent(name)}`;
    if (sub === 'run') {
      const r = await api('POST', `${job}/run`);
      out(formatRun(r), r);
      if (r.status !== 'ok') process.exitCode = 1;
      return;
    }
    if (sub === 'logs') {
      const params = new URLSearchParams();
      if (flags.limit) params.set('limit', flags.limit);
      if (flags.run) params.set('run', flags.run);
      const list = await api('GET', `${job}/runs?${params}`);
      return out(list.map(formatRun).join('\n\n') || `No runs of ${name} yet`, list);
    }
    const r = await api('PATCH', job, { body: { paused: sub === 'pause' } });
    out(`${name} ${r.paused ? 'paused: it won\'t run until `cubby jobs resume`' : 'resumed'}`, r);
  },

  async env(sub, arg) {
    const base = `/api/projects/${requireProject()}/env`;
    if (!sub || sub === 'list') {
      const list = await api('GET', base);
      return out(formatEnv(list), list);
    }
    if (sub === 'set') {
      // --from-stdin keeps the value out of shell history and process lists.
      const { key, value } = flags['from-stdin'] ? { key: arg, value: readFileSync(0, 'utf8').replace(/\r?\n$/, '') } : parseEnvAssignment(arg);
      const r = await api('PUT', `${base}/${encodeURIComponent(key ?? '')}`, { body: { value } });
      return out(`Set ${r.key}. Jobs read it as env.${r.key}; the value won't be shown again.`, r);
    }
    if (sub === 'unset') {
      if (!arg) throw new CliError('Usage: cubby env unset NAME --yes');
      if (!flags.yes) throw new CliError(`This deletes the secret ${arg}; its value can't be recovered. Re-run with --yes.`);
      const r = await api('DELETE', `${base}/${encodeURIComponent(arg)}`);
      return out(`Removed ${arg}`, r);
    }
    throw new CliError('Usage: cubby env list | set NAME=value | set NAME --from-stdin | unset NAME --yes');
  },

  // Server administration: needs an admin account on the target server.
  async admin(sub, action, arg, arg2) {
    const call = (method, path, opts) => api(method, path, opts).catch(async (err) => {
      if (err.status === 403) throw new CliError(`\`cubby admin\` needs an admin account. You're logged in to ${await where()} as a regular user.`);
      throw err;
    });
    if (sub === 'storage') {
      const s = await call('GET', '/api/admin/storage');
      return out(formatStorage(s), s);
    }
    if (sub === 'backups' && (!action || action === 'list')) {
      const r = await call('GET', '/api/admin/backups');
      return out(formatBackups(r), r);
    }
    if (sub === 'backups' && action === 'create') {
      const started = await call('POST', '/api/admin/backups');
      if (flags['no-wait']) return out(`Backup ${started.date} started. Check on it with: cubby admin backups`, { status: 'started', ...started });
      if (!flags.json) console.error(`Backing up (started ${started.started_at})…`);
      let r;
      do {
        await new Promise((res) => setTimeout(res, 500));
        r = await call('GET', '/api/admin/backups');
      } while (r.running?.started_at === started.started_at);
      if (r.last?.started_at === started.started_at && !r.last.ok) throw new CliError(`The backup failed: ${r.last.error}`);
      const backup = r.backups.find((b) => b.date === started.date);
      return out(`Backed up ${backup.date}: database ${formatBytes(backup.db_bytes)}, sites ${formatBytes(backup.sites_bytes)}`, { status: 'done', backup, run: r.last });
    }
    if (sub === 'backups' && action === 'delete' && arg) {
      if (!flags.yes) throw new CliError(`This permanently deletes the backup from ${arg} (its database and sites files). Re-run with --yes.`);
      const r = await call('DELETE', `/api/admin/backups/${encodeURIComponent(arg)}${flags['leave-none'] ? '?leave_none=1' : ''}`);
      if (r.warning && !flags.json) console.error(`warning: ${r.warning}`);
      return out(`Deleted the backup from ${arg} (${r.files.join(', ')})`, r);
    }
    if (sub === 'backups' && action === 'keep' && arg) {
      // Lowering it deletes backups at the next nightly run, so that needs --yes (raising it never does).
      const preview = (await call('GET', `/api/admin/backups?keep=${encodeURIComponent(arg)}`)).estimate;
      const n = preview.delete.length;
      if (n && !flags.yes) throw new CliError(`Keeping ${preview.keep} deletes ${n} backup${n === 1 ? '' : 's'} (${preview.delete.join(', ')}) at the next nightly backup, freeing ${formatBytes(preview.frees_bytes)}. Re-run with --yes.`);
      await call('PATCH', '/api/admin/settings', { body: { backup_keep: preview.keep } });
      const r = await call('GET', '/api/admin/backups');
      return out(`Keeping the newest ${r.keep} backup${r.keep === 1 ? '' : 's'}: ${formatRetention(r.estimate)}.`, { keep: r.keep, estimate: r.estimate });
    }
    if (sub === 'deploys' && action) {
      const base = `/api/admin/apps/${encodeURIComponent(action)}/deploys`;
      if (!arg || arg === 'list') {
        const list = await call('GET', base);
        return out(formatDeploys(list), list);
      }
      if (arg === 'prune' || (arg === 'delete' && arg2)) {
        const what = arg === 'prune' ? `every older deploy of ${action}${flags.keep ? ` but the newest ${flags.keep}` : ''}` : `deploy ${arg2} of ${action}`;
        if (!flags.yes) throw new CliError(`This permanently deletes ${what} (it can't be rolled back to). The current deploy is never deleted. Re-run with --yes.`);
        const r = arg === 'prune'
          ? await call('POST', `${base}/prune`, { body: { keep: flags.keep === undefined ? 0 : Number(flags.keep) } })
          : await call('DELETE', `${base}/${encodeURIComponent(arg2)}`);
        const n = r.deleted.length;
        return out(`Deleted ${n} older deploy${n === 1 ? '' : 's'} of ${action}, freeing ${formatBytes(r.freed_bytes)}. ${r.deploys.length} left for rollback (current included).`, r);
      }
    }
    throw new CliError(ADMIN_USAGE);
  },
};

const DATA_USAGE = 'Usage: cubby data list [app] | clear [app] (--collections a,b [--drop] | --collection c (--filter "<filter>" | --ids a,b) [--all-matching]) [--dry-run] --yes | clear [app] --wipe --yes | snapshots [app] | restore <snapshot-id> [--overwrite --yes] [--dry-run] | purge <snapshot-id> --yes';
const ADMIN_USAGE = 'Usage: cubby admin storage | backups [create [--no-wait] | delete <YYYY-MM-DD> --yes [--leave-none] | keep <n> [--yes]] | deploys <app> [prune [--keep <n>] --yes | delete <deploy-id> --yes]';

const [cmd, ...rest] = positionals;
if (!cmd || flags.help || !commands[cmd]) {
  console.log(helpText(CLI_VERSION));
  process.exit(cmd && !flags.help ? 1 : 0);
}
try {
  await commands[cmd](...rest);
} catch (err) {
  if (!(err instanceof CliError)) throw err;
  if (flags.json) console.log(JSON.stringify({ error: err.message, details: err.details }, null, 2));
  else console.error(formatError(err));
  process.exit(1);
}
