// Pure helpers for the CLI (no network, no process state), so they can be unit-tested directly.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, lstatSync, readlinkSync, symlinkSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export class CliError extends Error {
  constructor(message, details) { super(message); this.details = details; }
}

// `cubby login <url>`: bare hosts get https://. Choosing *which* server a command uses lives in servers.js.
export const normalizeServerArg = (url) => (/^https?:\/\//.test(url) ? url : `https://${url}`);

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function parseSchemaText(text, file) {
  try {
    return { schema: JSON.parse(text), hash: sha256(text) };
  } catch (e) {
    throw new CliError(`${file}: ${e.message}`);
  }
}

export function describeSchemaChanges(r) {
  const parts = ['created', 'updated'].filter((k) => r[k].length).map((k) => `${k}: ${r[k].join(', ')}`);
  let text = `Schema applied. ${parts.join(' | ') || 'No changes.'}`;
  if (r.kept.length) text += `\n  kept (not in schema.json, data preserved): ${r.kept.join(', ')}\n  delete with: cubby schema drop <name> --yes`;
  return text;
}

// "Priya's Cubby (https://…)": how a server is shown in CLI output.
export const serverLabel = (name, url) => (name ? `${name} (${url})` : url);

export function versionWarning(cliVersion, serverVersion, server) {
  if (!serverVersion || serverVersion === cliVersion) return null;
  return `warning: CLI ${cliVersion} differs from server ${serverVersion}. Update with: npm i -g ${server}/cli.tgz`;
}

export function deployParams({ message, unlisted, listed, description } = {}) {
  const params = new URLSearchParams();
  if (message) params.set('message', message);
  if (unlisted) params.set('unlisted', '1');
  if (listed) params.set('unlisted', '0');
  if (description) params.set('description', description);
  return params;
}

export const formatDeploys = (list) =>
  list.map((d) => `${d.current ? '*' : ' '} ${d.id}  ${d.created}  ${d.files} files  ${d.client ? `[${d.client}] ` : ''}${d.message}`).join('\n') || 'No deploys';

export const formatProjects = (list) =>
  list.map((p) => `${p.slug.padEnd(24)} ${p.url}${p.current_deploy ? '' : '  (not deployed)'}`).join('\n') || 'No projects yet';

export function formatBytes(n) {
  if (n === null || n === undefined) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return i ? `${n.toFixed(1)} ${units[i]}` : `${n} B`;
}

const STORAGE_ROWS = [
  ['database_bytes', 'Database'], ['uploads_bytes', 'Uploaded files'], ['sites_current_bytes', 'Current deploys'],
  ['sites_older_bytes', 'Older deploys (rollback)'], ['backups_bytes', 'Backups'], ['other_bytes', 'Other'],
];

export function formatStorage(s) {
  const row = (label, bytes) => `  ${label.padEnd(26)}${formatBytes(bytes).padStart(10)}`;
  const width = Math.max(4, ...s.apps.map((a) => a.slug.length)) + 2;
  return [
    `Storage (as of ${s.computed_at}, refreshed every 5 minutes)`,
    ...STORAGE_ROWS.map(([key, label]) => row(label, s.breakdown[key])),
    row('Total', s.data_bytes),
    `Disk: ${formatBytes(s.disk.free_bytes)} free of ${formatBytes(s.disk.total_bytes)}`,
    '',
    s.apps.length ? 'Apps:' : 'No apps yet',
    ...s.apps.map((a) => `  ${a.slug.padEnd(width)}${formatBytes(a.total_bytes).padStart(10)}  current ${formatBytes(a.current_deploy_bytes)} · older ${formatBytes(a.older_deploys_bytes)} · uploads ${formatBytes(a.uploads_bytes)}  ${a.owner ?? ''}`.trimEnd()),
  ].join('\n');
}

export function formatBackups(r) {
  const lines = r.backups.length
    ? [`Backups (newest first, ${r.keep} kept):`, ...r.backups.map((b) => `  ${b.date}  database ${formatBytes(b.db_bytes).padEnd(9)} sites ${formatBytes(b.sites_bytes).padEnd(9)} total ${formatBytes(b.total_bytes)}${b.complete ? '' : '  (incomplete)'}`)]
    : ['No backups yet.'];
  if (r.running) lines.push(`A backup is running (started ${r.running.started_at}).`);
  if (r.last && !r.last.ok) lines.push(`The last backup failed: ${r.last.error}`);
  lines.push('Restore one on the server with: sudo cubby-server restore <date>');
  return lines.join('\n');
}

export function formatError(err) {
  return `error: ${err.message}${err.details ? '\n  - ' + [].concat(err.details).join('\n  - ') : ''}`;
}

// Copies the app template, filling {{VARS}} and renaming _gitignore (npm strips .gitignore).
export function copyTemplate(src, dest, vars) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dest, entry === '_gitignore' ? '.gitignore' : entry);
    if (statSync(from).isDirectory()) copyTemplate(from, to, vars);
    else writeFileSync(to, readFileSync(from, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m));
  }
}

// Polls a browser-approval login until approved or expired. `poll`, `sleep` and `now` are injected.
export async function waitForApproval({ poll, expiresIn, interval = 2, sleep, now = Date.now }) {
  const deadline = now() + expiresIn * 1000;
  while (now() < deadline) {
    const r = await poll();
    if (r.status === 'approved') return r.token;
    await sleep(interval * 1000);
  }
  throw new CliError('Login link expired before it was approved. Run `cubby login` again.');
}

// --- Agent skill -------------------------------------------------------------------------------
// Same layout as `npx skills`: one canonical copy in ~/.agents/skills/cubby, symlinked into each
// installed agent's skills directory.
export function skillPaths(home) {
  return {
    skillHome: join(home, '.agents', 'skills', 'cubby'),
    agents: {
      'claude-code': join(home, '.claude'),
      codex: join(home, '.codex'),
      cursor: join(home, '.cursor'),
      opencode: join(home, '.config', 'opencode'),
    },
  };
}

export function skillLinks(home) {
  const { skillHome, agents } = skillPaths(home);
  return Object.entries(agents).map(([agent, root]) => {
    const link = join(root, 'skills', 'cubby');
    let state = 'agent not installed';
    if (existsSync(root)) {
      let st = null;
      try { st = lstatSync(link); } catch {}
      if (!st) state = 'not linked';
      else if (st.isSymbolicLink()) state = resolve(dirname(link), readlinkSync(link)) === skillHome ? 'linked' : 'other link';
      else state = 'separate copy';
    }
    return { agent, link, state, root };
  });
}

// The skill is server-neutral (one skill for every server you use); only its version is stamped.
// "0.1.2", "v0.1.2" or "0.1.2-dev+abc" → [0, 1, 2]; null for anything else.
export function versionCore(v) {
  const m = String(v ?? '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return m ? m.slice(1).map(Number) : null;
}

// Is version a strictly newer release than b? Compares X.Y.Z only; unparseable versions are never newer.
export function isNewerVersion(a, b) {
  const x = versionCore(a);
  const y = versionCore(b);
  if (!x) return false;
  if (!y) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// One skill serves every server, so it only ever moves forward: a skill from a newer CLI is never replaced
// by an older one (returns { kept } instead).
export function installSkill({ home, src, version }) {
  const { skillHome } = skillPaths(home);
  if (!existsSync(join(src, 'SKILL.md'))) throw new CliError('Skill files missing from this CLI install');
  const current = skillStatus(home);
  if (current.installed && isNewerVersion(current.version, version)) {
    return { path: skillHome, agents: [], version: current.version, kept: true };
  }
  rmSync(skillHome, { recursive: true, force: true });
  mkdirSync(dirname(skillHome), { recursive: true });
  cpSync(src, skillHome, { recursive: true });
  const skillFile = join(skillHome, 'SKILL.md');
  writeFileSync(skillFile, readFileSync(skillFile, 'utf8').replace(/\*\*Skill version: [^*]+\*\*/, `**Skill version: ${version}**`));
  const linked = [];
  for (const l of skillLinks(home)) {
    if (l.state === 'agent not installed' || l.state === 'separate copy') continue;
    mkdirSync(dirname(l.link), { recursive: true });
    if (l.state === 'other link') rmSync(l.link, { force: true });
    if (l.state !== 'linked') symlinkSync(skillHome, l.link, 'dir');
    linked.push(l.agent);
  }
  return { path: skillHome, agents: linked, version };
}

export function removeSkill(home) {
  const removed = [];
  for (const l of skillLinks(home)) if (l.state === 'linked') { rmSync(l.link, { force: true }); removed.push(l.agent); }
  rmSync(skillPaths(home).skillHome, { recursive: true, force: true });
  return { removed };
}

export function skillStatus(home) {
  const { skillHome } = skillPaths(home);
  const installed = existsSync(join(skillHome, 'SKILL.md'));
  const version = installed ? readFileSync(join(skillHome, 'SKILL.md'), 'utf8').match(/Skill version: ([^*]+)\*\*/)?.[1] : null;
  const links = skillLinks(home).map(({ agent, state }) => ({ agent, state }));
  return { installed, version, path: skillHome, links };
}

// --- Scheduled jobs --------------------------------------------------------------------------------
// One job per file in cubby/jobs/ (name = file name). Files starting with _ are shared helpers, not jobs.
export const JOB_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const JOB_EXT_RE = /\.(ts|mts|js|mjs)$/;

export function jobEntries(files) {
  const entries = {};
  const errors = [];
  for (const f of [...files].sort()) {
    if (!JOB_EXT_RE.test(f) || f.startsWith('_') || f.endsWith('.d.ts')) continue;
    const name = f.replace(JOB_EXT_RE, '');
    if (!JOB_NAME_RE.test(name) || name.length > 40) errors.push(`cubby/jobs/${f}: job file names use lowercase letters, digits and single hyphens (max 40)`);
    else if (entries[name]) errors.push(`cubby/jobs/${f}: another file is already job "${name}"`);
    else entries[name] = f;
  }
  if (errors.length) throw new CliError('Invalid jobs', errors);
  return entries;
}

// Read from the source, so the server knows each schedule without running any code.
export function jobSchedule(source, file) {
  const m = source.match(/^export\s+const\s+schedule\s*=\s*(['"`])([^'"`\n]+)\1/m);
  if (!m) throw new CliError(`${file}: add \`export const schedule = '0 9 * * *'\` (5-field cron, UTC)`);
  return m[2].trim();
}

// Bundles each job (with its npm dependencies) into one ESM file, using the app's own Vite.
// Run with `node --input-type=module -e` in the app folder, so `vite` resolves from its node_modules.
export const jobsBuildScript = (entries, outDir) => `
import { build } from 'vite';
await build({
  configFile: false, logLevel: 'warn', publicDir: false,
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: true, outDir: ${JSON.stringify(outDir)}, emptyOutDir: true, target: 'node20', minify: false, copyPublicDir: false,
    rollupOptions: { input: ${JSON.stringify(entries)}, output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' } },
  },
});`;

const duration = (ms) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

export const formatJobs = (list) =>
  list.map((j) => {
    const last = j.last_run ? `last: ${j.last_run.status} ${j.last_run.started} (${duration(j.last_run.duration_ms)})` : 'never run';
    return `${j.name.padEnd(24)} ${j.schedule.padEnd(16)} ${j.paused ? 'paused' : `next: ${j.next_run ?? 'never'}`}  ${last}`;
  }).join('\n') || 'No jobs. Add one in cubby/jobs/<name>.ts and deploy.';

export const formatRun = (r) => `${r.job} ${r.id}  ${r.status}  ${r.trigger}  ${r.started}  ${duration(r.duration_ms)}\n${r.log?.trimEnd() || '(no output)'}`;

export const formatEnv = (list) => list.map((e) => `${e.key.padEnd(32)} set ${e.updated}`).join('\n') || 'No secrets. Add one with: cubby env set NAME=value';

// `cubby env set NAME=value`
export function parseEnvAssignment(text) {
  const i = String(text ?? '').indexOf('=');
  if (i < 1) throw new CliError('Usage: cubby env set NAME=value, or cubby env set NAME --from-stdin');
  return { key: text.slice(0, i), value: text.slice(i + 1) };
}
