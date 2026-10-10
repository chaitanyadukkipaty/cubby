#!/usr/bin/env node
// The global `cubby` command. Rule: the CLI that runs a command always matches the version of the server that
// command talks to (in an app folder, the server in its cubby.json). The bundled CLI runs when versions match;
// otherwise a copy of that server's /cli.tgz, cached in ~/.cubby/cli/<version>/, runs instead. Purely local
// commands (servers, use, logout, skill, version) run here.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as tar from 'tar';
import { readConfig, writeConfig, resolveTarget, readProject, serverId, normalizeUrl, updateHint, unsupportedServer } from './servers.js';
import { installSkill, skillStatus, isNewerVersion, normalizeServerArg } from './lib.js';

export const BUNDLED_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const BUNDLED_SKILL = fileURLToPath(new URL('../skill/cubby/', import.meta.url));
export const VERSION_TTL_MS = 10 * 60 * 1000;

// Commands that talk to a server run the CLI matching that server's version.
export const SERVER_COMMANDS = new Set(['login', 'signup', 'whoami', 'help', 'init', 'link', 'projects', 'info', 'delete', 'schema', 'deploy', 'deploys', 'rollback']);
// Commands that name their server as their argument ("cubby login <url>").
export const ACCOUNT_COMMANDS = new Set(['login', 'signup']);
// Purely local: always run here. `version` is answered by the launcher itself.
export const LOCAL_COMMANDS = new Set(['servers', 'use', 'logout', 'skill', 'version']);
// Commands that write config.json: refused when it's in a newer format than this launcher understands.
export const CONFIG_WRITERS = new Set(['login', 'signup', 'logout', 'use']);

// Minimal argv reading: the command, the word right after it, --server, and the flags the launcher cares about.
export function parseLaunchArgs(argv) {
  let command = null;
  let arg = null;
  let server;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server') { server = argv[++i]; continue; }
    if (a.startsWith('--server=')) { server = a.slice('--server='.length); continue; }
    if (a.startsWith('-')) continue;
    if (!command) command = a;
    else if (arg === null && argv[i - 1] === command) arg = a;
  }
  return { command, arg, server, json: argv.includes('--json'), noWait: argv.includes('--no-wait'), wait: argv.includes('--wait') };
}

export const cachedVersion = (server, now, ttl = VERSION_TTL_MS) =>
  server?.version && server.version_checked_at && now - server.version_checked_at < ttl ? server.version : null;

export const cliRoot = (home) => join(home, '.cubby', 'cli');
export const cliPackage = (home, version) => join(cliRoot(home), version, 'package');
export const cliEntry = (home, version) => join(cliPackage(home, version), 'src', 'index.js');
// Which server a two-step browser login (--no-wait, then --wait) is for, so both steps run the same CLI version.
export const pendingFile = (home) => join(home, '.cubby', 'launcher-pending-login.json');

// The node_modules directory the launcher's own dependencies resolve from; cached CLIs share it.
export function sharedNodeModules() {
  let dir = dirname(fileURLToPath(import.meta.resolve('tar')));
  while (basename(dir) !== 'node_modules') {
    const up = dirname(dir);
    if (up === dir) throw new Error('could not locate node_modules for tar');
    dir = up;
  }
  return dir;
}

// Downloads a server's CLI into ~/.cubby/cli/<version>/ via a temp dir + rename, so a crash or a
// concurrent run never leaves a half-installed copy. Returns the version actually installed.
export async function installCli({ home, url, download, nodeModules }) {
  const tgz = await download(`${url}/cli.tgz`);
  const root = cliRoot(home);
  mkdirSync(root, { recursive: true });
  const tmp = join(root, `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(tmp);
  try {
    await pipeline(Readable.from(tgz), tar.x({ cwd: tmp, strict: true }));
    const pkg = JSON.parse(readFileSync(join(tmp, 'package', 'package.json'), 'utf8'));
    if (!existsSync(join(tmp, 'package', 'src', 'index.js'))) throw new Error('cli.tgz has no src/index.js');
    symlinkSync(nodeModules, join(tmp, 'package', 'node_modules'), 'dir');
    const final = join(root, pkg.version);
    if (existsSync(final)) rmSync(tmp, { recursive: true, force: true }); // another run got there first
    else renameSync(tmp, final);
    return pkg.version;
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

const semverKey = (v) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? p.padStart(8, '0') : p)).join('.');
export const cachedVersions = (home) =>
  existsSync(cliRoot(home)) ? readdirSync(cliRoot(home)).filter((v) => !v.startsWith('.') && existsSync(cliEntry(home, v))).sort((a, b) => semverKey(b).localeCompare(semverKey(a))) : [];

// Which server the command targets: login/signup name it as their argument, `login --wait` continues the login
// started by `login --no-wait`, everything else follows resolveTarget (--server, CUBBY_SERVER, cubby.json, default).
export function launchTarget(cfg, args, { env, cwd, home }) {
  const { command, arg, server: flag, wait } = args;
  const byUrl = (url) => ({ url, id: serverId(url), server: cfg.servers[serverId(url)] ?? null, source: 'argument' });
  if (ACCOUNT_COMMANDS.has(command)) {
    if (arg) return byUrl(normalizeUrl(normalizeServerArg(arg)));
    if (command === 'login' && wait && existsSync(pendingFile(home))) return byUrl(JSON.parse(readFileSync(pendingFile(home), 'utf8')).url);
  }
  const project = readProject(resolve(cwd, 'cubby.json'));
  return resolveTarget(cfg, { flag, env: env.CUBBY_SERVER, projectServer: project?.server });
}

// Decides which CLI runs. All I/O comes in through `deps` so every branch is unit-testable.
export async function plan(argv, deps) {
  const { home, env, cwd, now, fetchVersion, download, nodeModules, bundledVersion = BUNDLED_VERSION } = deps;
  const args = parseLaunchArgs(argv);
  const { command } = args;
  // Already inside a matched CLI, or nothing server-specific to decide.
  if (env.CUBBY_LAUNCHED || !command || !SERVER_COMMANDS.has(command)) return { run: 'bundled' };

  const configFile = join(home, '.cubby', 'config.json');
  const cfg = readConfig(configFile, { lenient: true });
  if (cfg.tooNew && CONFIG_WRITERS.has(command)) {
    return { run: 'refuse', message: `~/.cubby/config.json was written by a newer Cubby CLI. Update this one first: ${updateHint(Object.values(cfg.servers)[0]?.url)}` };
  }
  let target;
  try {
    target = launchTarget(cfg, args, { env, cwd, home });
  } catch {
    return { run: 'bundled' }; // let the CLI report the problem in its usual way
  }

  const notes = [];
  let version = cachedVersion(target.server, now());
  if (!version) {
    try {
      version = await fetchVersion(target.url);
      if (target.server && !cfg.tooNew) {
        cfg.servers[target.id] = { ...target.server, version, version_checked_at: now() };
        writeConfig(configFile, cfg);
      }
    } catch {
      version = target.server?.version ?? null;
      if (version && version !== bundledVersion) notes.push(`note: can't reach ${target.url}; using the cached CLI for its last known version ${version}`);
    }
  }
  if (!version || version === bundledVersion) return { run: 'bundled', notes, version: bundledVersion, target };
  const unsupported = unsupportedServer(version, { name: target.server?.name, url: target.url, bundledVersion });
  if (unsupported) return { run: 'refuse', message: unsupported, notes };

  if (!existsSync(cliEntry(home, version))) {
    try {
      version = await installCli({ home, url: target.url, download, nodeModules });
    } catch (err) {
      notes.push(`note: couldn't fetch the CLI for ${target.url} (v${version}): ${err.message}; using the bundled v${bundledVersion}`);
      return { run: 'bundled', notes, version: bundledVersion, target };
    }
  }
  // CUBBY_LAUNCHED stops the matched CLI from dispatching again. For app commands it also gets the server the
  // launcher resolved, so both pick the same one; login/signup keep naming theirs.
  const childEnv = { ...env, CUBBY_LAUNCHED: '1', ...(!ACCOUNT_COMMANDS.has(command) && { CUBBY_SERVER: target.url }) };
  return {
    run: 'cached', version, entry: cliEntry(home, version), args: argv, env: childEnv, notes, target,
    skillSrc: join(cliPackage(home, version), 'skill', 'cubby'),
  };
}

// The skill only moves forward: refresh it from the CLI that's about to run if that one is newer, never older.
// Nothing happens when the skill isn't installed (logging in installs it).
export function refreshSkill({ home, version, src }) {
  const st = skillStatus(home);
  if (!st.installed || !existsSync(join(src, 'SKILL.md')) || !isNewerVersion(version, st.version)) return null;
  return installSkill({ home, src, version });
}

// `cubby version`: which CLI runs for the target server, and the server's version. Local; never fails hard.
export async function versionReport(argv, deps) {
  const { home, env, cwd, fetchInfo, bundledVersion = BUNDLED_VERSION } = deps;
  const cfg = readConfig(join(home, '.cubby', 'config.json'), { lenient: true });
  let target = null;
  try {
    target = launchTarget(cfg, parseLaunchArgs(argv), { env, cwd, home });
  } catch {}
  const info = target ? await fetchInfo(target.url).catch(() => null) : null;
  const serverVersion = info?.version ?? null;
  const cli = serverVersion ?? target?.server?.version ?? bundledVersion;
  return { cli, launcher: bundledVersion, server: target?.url ?? null, server_name: info?.name ?? target?.server?.name ?? null, server_version: serverVersion };
}

export async function fetchInfo(url) {
  const res = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchVersion(url) {
  const info = await fetchInfo(url);
  if (!info.version) throw new Error('no version');
  return info.version;
}

export async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function main(argv = process.argv.slice(2)) {
  const home = homedir();
  const deps = { home, env: process.env, cwd: process.cwd(), now: Date.now, fetchVersion, fetchInfo, download, nodeModules: sharedNodeModules() };
  const args = parseLaunchArgs(argv);

  if (args.command === 'version' && !process.env.CUBBY_LAUNCHED) {
    const r = await versionReport(argv, deps);
    const where = r.server ? `${r.server_name ? `${r.server_name} (${r.server})` : r.server} ${r.server_version ? `v${r.server_version}` : '(unreachable)'}` : 'none';
    console.log(args.json ? JSON.stringify(r, null, 2) : `cubby CLI ${r.cli} (launcher ${r.launcher})\nserver: ${where}`);
    return;
  }

  const p = await plan(argv, deps);
  for (const n of p.notes ?? []) console.error(n);
  if (p.run === 'refuse') {
    console.error(`error: ${p.message}`);
    process.exit(1);
  }
  if (!process.env.CUBBY_LAUNCHED) {
    refreshSkill({ home, version: p.run === 'cached' ? p.version : BUNDLED_VERSION, src: p.run === 'cached' ? p.skillSrc : BUNDLED_SKILL });
  }
  if (args.command === 'login' && p.target) {
    if (args.noWait) {
      mkdirSync(dirname(pendingFile(home)), { recursive: true, mode: 0o700 });
      writeFileSync(pendingFile(home), JSON.stringify({ url: p.target.url }), { mode: 0o600 });
    } else {
      rmSync(pendingFile(home), { force: true });
    }
  }
  if (p.run === 'bundled') return import('./index.js');
  const r = spawnSync(process.execPath, [p.entry, ...p.args], { stdio: 'inherit', env: p.env });
  process.exit(r.status ?? 1);
}

// npm installs the bin as a symlink, so compare real paths.
const isEntry = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isEntry()) await main();
