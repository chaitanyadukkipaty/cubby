#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import * as tar from 'tar';
import {
  CliError, resolveServerUrl, normalizeServerArg, parseSchemaText, describeSchemaChanges, versionWarning,
  deployParams, formatDeploys, formatProjects, formatError, copyTemplate, waitForApproval,
  installSkill as installSkillAt, removeSkill, skillStatus,
} from './lib.js';

const HELP = `cubby — build and host apps (Vite + React + Tailwind + PocketBase)

Account
  cubby login <server-url>                      approve in the browser (link is printed)
      --no-wait  print the link and exit;  then: cubby login --wait
  cubby login <server-url> --token <token>      token from the dashboard (CI)
  cubby signup <server-url> --email <e> --password <p> --code <signup-code>
  cubby whoami | logout
  cubby skill install | remove | status          agent skill (installed by login)

Projects
  cubby init <slug> [--dir <path>] [--name <n>] [--no-install]
  cubby link <slug>                             attach current dir to an existing project
  cubby projects                                list your projects
  cubby info                                    current project details
  cubby delete <slug> --yes                     delete project, data and deploys

Backend (PocketBase)
  cubby schema push [--file cubby/schema.json]  never deletes anything
  cubby schema pull [--file cubby/schema.json]
  cubby schema drop <collection>[.<field>] --yes   deletes it and its data

Hosting
  cubby deploy [-m <message>] [--unlisted|--listed] [--no-build] [--dir dist]
                                                pushes schema if changed, builds, uploads
  cubby deploys                                 list deploys
  cubby rollback <deploy-id>

Global flags: --json (machine-readable output), --server <url>, --client <agent-name>
Env: CUBBY_TOKEN (your token), CUBBY_SERVER (server URL), CUBBY_CLIENT (agent name)`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: 'string' }, password: { type: 'string' }, server: { type: 'string' },
    dir: { type: 'string' }, name: { type: 'string' }, file: { type: 'string' }, message: { type: 'string', short: 'm' },
    token: { type: 'string' }, code: { type: 'string' }, client: { type: 'string' }, 'no-skill': { type: 'boolean' }, wait: { type: 'boolean' }, 'no-wait': { type: 'boolean' },
    'no-install': { type: 'boolean' }, 'no-build': { type: 'boolean' }, unlisted: { type: 'boolean' }, listed: { type: 'boolean' },
    yes: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});

const CLI_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const TEMPLATE_DIR = new URL('../template/', import.meta.url).pathname;
const GLOBAL_DIR = join(homedir(), '.cubby');
const GLOBAL_CONFIG = join(GLOBAL_DIR, 'config.json');
const PROJECT_CONFIG = 'cubby.json';

const readJsonFile = (p, fallback = {}) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const writeJsonFile = (p, data) => writeFileSync(p, JSON.stringify(data, null, 2) + '\n');

const globalConfig = () => readJsonFile(GLOBAL_CONFIG);
const projectConfig = () => readJsonFile(resolve(PROJECT_CONFIG), null);
// The server you logged in to wins over cubby.json, so `cubby-server set-domain` only needs a re-login.
const serverUrl = () => resolveServerUrl({
  flag: flags.server, env: process.env.CUBBY_SERVER, globalServer: globalConfig().server, projectServer: projectConfig()?.server,
});

function out(human, data) {
  if (flags.json) console.log(JSON.stringify(data ?? { ok: true }, null, 2));
  else console.log(human);
}

async function api(method, path, { body, raw, contentType, auth = true } = {}) {
  const headers = {};
  if (auth) {
    const token = process.env.CUBBY_TOKEN || globalConfig().token;
    if (!token) throw new CliError('Not logged in. Run `cubby login <server-url> --token <token>` (copy the token from the server dashboard).');
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
  if (!res.ok) throw new CliError(data.error || `HTTP ${res.status}`, data.details);
  return data;
}

let warned = false;
function warnVersion(serverVersion) {
  const msg = warned ? null : versionWarning(CLI_VERSION, serverVersion, serverUrl());
  if (!msg) return;
  warned = true;
  console.error(msg);
}

function requireProject() {
  const cfg = projectConfig();
  if (!cfg?.project) throw new CliError(`No ${PROJECT_CONFIG} here. Run \`cubby init <slug>\` or \`cubby link <slug>\`.`);
  if (cfg.server !== serverUrl()) writeJsonFile(resolve(PROJECT_CONFIG), { ...cfg, server: serverUrl() }); // used by vite dev proxy
  return cfg.project;
}

function saveSession(token, email) {
  mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
  writeJsonFile(GLOBAL_CONFIG, { server: serverUrl(), token, email });
}

// `cubby login <url>` / `cubby signup <url>`: the positional URL wins over other sources.
function useServerArg(url) {
  if (url) flags.server = normalizeServerArg(url);
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
const installSkill = () => installSkillAt({ home: homedir(), src: SKILL_SRC, version: CLI_VERSION, server: serverUrl() });

const commands = {
  async signup(url) {
    useServerArg(url);
    const r = await api('POST', '/api/signup', { auth: false, body: { email: flags.email, password: flags.password, code: flags.code } });
    saveSession(r.key, r.user.email);
    out(`Signed up as ${r.user.email} on ${serverUrl()}`, { user: r.user, server: serverUrl() });
  },
  async login(url) {
    useServerArg(url);
    const finish = async (token) => {
      process.env.CUBBY_TOKEN = token;
      const me = await api('GET', '/api/me');
      saveSession(token, me.email);
      const skill = flags['no-skill'] ? null : installSkill();
      out(
        `Logged in as ${me.email} on ${serverUrl()}${skill ? `\nInstalled the cubby skill for: ${skill.agents.join(', ') || 'no agents found (copy is in ~/.agents/skills/cubby)'}` : ''}`,
        { status: 'logged_in', email: me.email, server: serverUrl(), skill },
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
      flags.server = device.server;
    } else {
      if (flags.wait) throw new CliError('No login in progress. Run `cubby login <server-url> --no-wait` first.');
      device = { ...(await api('POST', '/api/device/start', { auth: false })), server: serverUrl() };
      mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(PENDING, JSON.stringify(device), { mode: 0o600 });
      const msg = `Open this link to approve this login (sign up there if you're new):\n  ${device.verify_url}\n  code: ${device.user_code}`;
      if (flags['no-wait']) {
        return out(`${msg}\nThen run: cubby login --wait`, { status: 'approval_required', verify_url: device.verify_url, user_code: device.user_code, expires_in: device.expires_in, next: 'cubby login --wait' });
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
    rmSync(GLOBAL_CONFIG, { force: true });
    out('Logged out');
  },
  async skill(sub) {
    if (sub === 'install') {
      const r = installSkill();
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
  async whoami() {
    const me = await api('GET', '/api/me');
    out(`${me.email}${me.is_admin ? ' (admin)' : ''} @ ${serverUrl()}`, { email: me.email, is_admin: me.is_admin, server: serverUrl() });
  },

  async init(slug) {
    if (!slug) throw new CliError('Usage: cubby init <slug>');
    const dir = resolve(flags.dir ?? slug);
    if (existsSync(dir) && readdirSync(dir).length) throw new CliError(`${dir} is not empty`);
    const project = await api('POST', '/api/projects', { body: { slug, name: flags.name } });
    copyTemplate(TEMPLATE_DIR, dir, { SLUG: slug, PREFIX: project.prefix, SERVER: serverUrl(), URL: project.url });
    writeJsonFile(join(dir, PROJECT_CONFIG), { project: slug, server: serverUrl() });
    if (!flags['no-install']) run('npm', ['install', '--no-audit', '--no-fund'], dir);
    out(
      `Created ${slug} in ./${relative(process.cwd(), dir)}\n  url:  ${project.url}\n  next: cd ${relative(process.cwd(), dir)} && cubby schema push && cubby deploy`,
      { ...project, dir },
    );
  },
  async link(slug) {
    const project = await api('GET', `/api/projects/${encodeURIComponent(slug)}`);
    writeJsonFile(resolve(PROJECT_CONFIG), { project: slug, server: serverUrl() });
    out(`Linked ${process.cwd()} to ${slug}`, project);
  },
  async projects() {
    const list = await api('GET', '/api/projects');
    out(formatProjects(list), list);
  },
  async info() {
    const p = await api('GET', `/api/projects/${requireProject()}`);
    out(`${p.slug}\n  url:     ${p.url}\n  prefix:  ${p.prefix}\n  deploy:  ${p.current_deploy ?? 'none'}`, p);
  },
  async delete(slug) {
    if (!slug) throw new CliError('Usage: cubby delete <slug> --yes');
    if (!flags.yes) throw new CliError(`This permanently deletes ${slug}, its data and deploys. Re-run with --yes.`);
    await api('DELETE', `/api/projects/${encodeURIComponent(slug)}`);
    out(`Deleted ${slug}`);
  },

  async schema(sub, target) {
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
      if (!target) throw new CliError('Usage: cubby schema drop <collection>[.<field>] --yes');
      if (!flags.yes) throw new CliError(`This permanently deletes ${target} and its data. Re-run with --yes.`);
      await api('DELETE', `/api/projects/${slug}/schema/${encodeURIComponent(target)}`);
      return out(`Dropped ${target}. Remove it from cubby/schema.json too, or the next push recreates it (empty).`, { dropped: target });
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
    // 3. Upload.
    const chunks = [];
    for await (const chunk of tar.c({ gzip: true, cwd: dist, portable: true }, ['.'])) chunks.push(chunk);
    const params = deployParams({ ...flags, description: readJsonFile(resolve('package.json')).description });
    const d = await api('POST', `/api/projects/${slug}/deploys?${params}`, { raw: Buffer.concat(chunks), contentType: 'application/gzip' });
    out(`Deployed ${d.id} (${d.files} files, ${(d.bytes / 1024).toFixed(0)} KB)\n  ${d.url}`, d);
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
};

const [cmd, ...rest] = positionals;
if (!cmd || flags.help || !commands[cmd]) {
  console.log(HELP);
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
