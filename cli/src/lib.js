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

// --- Agents: each `cubby login` becomes its own named key on the server ---
// The agent tool running this CLI, from the environment it sets.
export function detectTool(env) {
  const has = (prefix) => Object.keys(env).some((k) => k.startsWith(prefix) && env[k]);
  if (env.CLAUDECODE) return 'Claude Code';
  if (has('CODEX_')) return 'Codex';
  if (has('CURSOR_')) return 'Cursor';
  return 'Terminal';
}

// What `cubby login` tells the server about itself, so it can name the agent ("Claude Code · chaitanya-mbp").
// An explicit --client / CUBBY_CLIENT (the name recorded on deploys) wins over detection.
export const loginHint = ({ client, env, hostname }) => ({
  tool: client || env.CUBBY_CLIENT || detectTool(env),
  machine: hostname.replace(/\.local$/i, ''),
});

// "5 min ago" from a key's last_used_at (the server writes it at most once a minute, hence "just now").
export function lastSeen(at, now = Date.now()) {
  const t = Date.parse(at ?? '');
  if (Number.isNaN(t)) return 'never';
  const units = [['day', 86_400_000], ['hour', 3_600_000], ['min', 60_000]];
  for (const [unit, ms] of units) {
    const n = Math.floor((now - t) / ms);
    if (n >= 1) return `${n} ${unit}${n > 1 && unit !== 'min' ? 's' : ''} ago`;
  }
  return 'just now';
}

export function formatAgents(list, now = Date.now()) {
  if (!list.length) return 'No agents yet. Connect one with `cubby login <server-url>`.';
  const cols = [
    ['ID', (a) => a.id], ['NAME', (a) => a.name], ['TOOL', (a) => a.tool ?? '-'], ['MACHINE', (a) => a.machine ?? '-'],
    ['CREATED', (a) => String(a.created).slice(0, 10)],
  ];
  const widths = cols.map(([head, get]) => Math.max(head.length, ...list.map((a) => get(a).length)) + 2);
  const row = (mark, cells) => `${mark} ${cells.map((c, i) => c.padEnd(widths[i])).join('')}`;
  return [
    row(' ', cols.map(([head]) => head)) + 'LAST SEEN',
    ...list.map((a) => row(a.current ? '*' : ' ', cols.map(([, get]) => get(a))) + lastSeen(a.last_used_at, now)),
    '* = this agent. Rename one with `cubby agents rename <id> <name>`, revoke it with `cubby agents revoke <id> --yes`.',
  ].join('\n');
}

// --- Activity: who did what, newest first. `users` adds an email column (admins see everyone's) ---
export function formatActivity(list, { users = false } = {}) {
  if (!list.length) return 'No activity in the last 30 days';
  const cols = [
    (r) => String(r.at).replace('T', ' ').slice(0, 16),
    ...(users ? [(r) => r.user ?? '-'] : []),
    (r) => r.app ?? '-',
    (r) => r.agent?.name ?? 'dashboard',
  ];
  const widths = cols.map((get) => Math.max(...list.map((r) => get(r).length)) + 2);
  return list.map((r) => cols.map((get, i) => get(r).padEnd(widths[i])).join('') + r.summary).join('\n');
}

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
  ['sites_older_bytes', 'Older deploys (rollback)'], ['backups_bytes', 'Backups'], ['snapshots_bytes', 'Snapshots (data clears)'], ['other_bytes', 'Other'],
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
    ...s.apps.map((a) => `  ${a.slug.padEnd(width)}${formatBytes(a.total_bytes).padStart(10)}  current ${formatBytes(a.current_deploy_bytes)} · older ${formatBytes(a.older_deploys_bytes)} · uploads ${formatBytes(a.uploads_bytes)}${a.snapshots_bytes ? ` · snapshots ${formatBytes(a.snapshots_bytes)}` : ''}  ${a.owner ?? ''}`.trimEnd()),
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

// What a backup retention means (the server's `estimate` from GET /api/admin/backups).
export function formatRetention(e) {
  if (e.delete.length) return `the next nightly backup deletes ${e.delete.length} (${e.delete.join(', ')}), freeing ${formatBytes(e.frees_bytes)}`;
  const more = e.keep - e.backups;
  return more > 0 && e.adds_bytes ? `nothing is deleted; ${more} more nightly backups take about ${formatBytes(e.adds_bytes)}` : 'nothing is deleted';
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

const counts = (b) => `${String(b.views).padStart(6)} views  ${String(b.visitors).padStart(4)} visitors`;

// `cubby metrics <app>`: visitors are unique per UTC day, so each day is listed with its own count (and signups: the same days).
// Past a month, only the days with views or signups are listed.
export function formatMetrics(r) {
  const signups = new Map(r.accounts.days.map((d) => [d.start, d.signups]));
  const days = r.days.length > 31 ? r.days.filter((d) => d.views || signups.get(d.start)) : r.days;
  return [
    `${r.app}: ${r.views} views, ${r.visitors} visitors in the last ${r.range}`,
    `  Active now ${r.active_now}, peak ${r.peak_active}`,
    `  API: ${r.api_requests} requests, ${r.api_errors} errors (${(r.api_error_rate * 100).toFixed(1)}%)`,
    `  Accounts: ${r.accounts.total}, ${r.accounts.new} new`,
    ...(r.top_paths?.length ? [`  Top paths: ${r.top_paths.map((p) => `${p.path} ${p.views}`).join(' · ')}`] : []),
    ...(r.deploys ?? []).map((d) => `  Deploy ${String(d.created).replace('T', ' ').slice(0, 16)} ${d.id} ${d.message}`.trimEnd()),
    ...days.map((d) => `  ${d.start.slice(0, 10)} ${counts(d)}  ${String(signups.get(d.start)).padStart(4)} signups`),
  ].join('\n');
}

// `cubby metrics --all` (admins): every app summed, then the busiest.
export function formatAdminMetrics(r) {
  const width = Math.max(0, ...r.top_apps.map((a) => a.app.length));
  return [
    `All apps: ${r.views} views, ${r.visitors} visitors in the last ${r.range} (${r.apps} apps)`,
    `  Active now ${r.active_now}`,
    `  API: ${r.api_requests} requests, ${r.api_errors} errors (${(r.api_error_rate * 100).toFixed(1)}%)`,
    ...(r.top_apps.length ? ['Busiest apps:'] : []),
    ...r.top_apps.map((a) => `  ${a.app.padEnd(width)} ${counts(a)}  ${String(a.api_errors).padStart(4)} API errors  ${a.owner ?? ''}`.trimEnd()),
  ].join('\n');
}

// `cubby metrics`: every app of yours.
export function formatMetricsList(list) {
  if (!list.length) return 'No apps yet. Create one with `cubby init <app>`.';
  const width = Math.max(...list.map((a) => a.app.length));
  return [`Last ${list[0].range}`, ...list.map((a) => `  ${a.app.padEnd(width)} ${counts(a)}  ${String(a.active_now).padStart(3)} active  ${String(a.api_errors).padStart(4)} API errors`)].join('\n');
}

// --- Data: clearing and restoring an app's records ---
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// `cubby data list`
export function formatData(app, list) {
  if (!list.length) return `${app}: no collections yet`;
  const width = Math.max(...list.map((c) => c.name.length));
  return [
    `${app}: ${plural(list.length, 'collection')}`,
    ...list.map((c) => `  ${c.name.padEnd(width)}  ${c.type.padEnd(4)} ${String(c.records).padStart(6)} records  files ${formatBytes(c.files_bytes)}`),
  ].join('\n');
}

const cascadeLine = (c, would = false) => (c.deletes
  ? `  ${c.collection}: ${plural(c.records, 'record')} pointing at them ${would ? 'would be' : 'were'} deleted too (cascade on ${c.collection}.${c.field})`
  : `  ${c.collection}: ${plural(c.records, 'record')} ${would ? 'would lose' : 'lost'} their link (${c.collection}.${c.field})`);

// `cubby data clear`: what went, what went with it, and the snapshot to undo it.
export function formatClear(app, r) {
  const [first] = r.collections;
  if (!r.snapshot) return `Nothing in ${first.name} matches: nothing was deleted.`;
  const head = r.mode === 'filter' || r.mode === 'ids'
    ? `Deleted ${plural(first.records, 'record')} from ${first.name} in ${app}${r.mode === 'filter' ? ` (matching ${r.filter})` : ''}.${r.missing?.length ? ` Not found: ${r.missing.join(', ')}` : ''}`
    : `${r.mode === 'drop' ? 'Dropped' : 'Emptied'} ${r.collections.map((c) => `${c.name} (${plural(c.records, 'record')})`).join(', ')} in ${app}.`;
  return [
    head,
    ...r.cascade.map((c) => cascadeLine(c)),
    `Snapshot ${r.snapshot.id} keeps them until ${r.snapshot.expires.slice(0, 10)}. Undo with: cubby data restore ${r.snapshot.id}`,
    ...r.warnings.map((w) => `warning: ${w}`),
  ].join('\n');
}

// `cubby data clear --dry-run`: what a clear would delete (and up to 5 of the records), deleting nothing.
export function formatClearPreview(app, r) {
  const names = r.collections.map((c) => c.name).join(', ');
  const head = r.mode === 'filter' || r.mode === 'ids'
    ? `Dry run: ${r.matches} of ${plural(r.total, 'record')} in ${names} match${r.mode === 'filter' ? ` (${r.filter})` : ''}.`
    : `Dry run: ${r.mode === 'drop' ? 'dropping' : 'emptying'} ${names} deletes ${plural(r.matches, 'record')}.`;
  const sample = ({ collectionId, collectionName, ...rec }) => {
    const text = JSON.stringify(rec);
    return `  ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`;
  };
  return [
    `${head} Nothing was deleted.`,
    ...r.samples.map(sample),
    ...r.cascade.map((c) => cascadeLine(c, true)),
    ...r.warnings.map((w) => `warning: ${w}`),
  ].join('\n');
}

const stamp = (at) => String(at).replace('T', ' ').slice(0, 16);

// `cubby data snapshots`
export function formatSnapshots(list) {
  if (!list.length) return 'No snapshots. A data clear keeps one for 7 days.';
  return [
    ...list.map((s) => [
      s.id, s.app, stamp(s.created), `${s.mode} ${s.collections.map((c) => c.name).join(',')}`, `${plural(s.records, 'record')}${s.files ? '' : ' (no files)'}`,
      `by ${s.by ?? '?'}${s.by_admin ? ' (admin)' : ''}${s.reason ? `: ${s.reason}` : ''}`, `until ${s.expires.slice(0, 10)}`,
    ].join('  ')),
    'Restore one with: cubby data restore <id> [--dry-run]',
  ].join('\n');
}

// `cubby data restore`
export function formatRestore(r) {
  const counts = (c) => (r.dry_run
    ? [plural(c.records, 'record'), ...(c.existing ? [`${c.existing} already there${r.overwrite ? ' (replaced)' : ''}`] : [])]
    : [`${c.restored} restored`, ...(c.replaced ? [`${c.replaced} replaced`] : []), ...(c.existing - c.replaced ? [`${c.existing - c.replaced} already there`] : []), ...(c.failed ? [`${c.failed} failed`] : [])]);
  return [
    r.dry_run ? `Dry run of snapshot ${r.snapshot} (nothing changed):` : `Restored snapshot ${r.snapshot}:`,
    ...r.collections.map((c) => `  ${c.name}: ${counts(c).join(', ')}`),
    ...(r.recreated.length ? [`${r.dry_run ? 'Would recreate' : 'Recreated'}: ${r.recreated.join(', ')}`] : []),
    ...(r.skipped_fields.length ? [`Skipped fields (removed since): ${r.skipped_fields.join(', ')}`] : []),
    ...(r.refused_fields.length ? [`Refused (type changed): ${r.refused_fields.join('; ')}`] : []),
    ...(r.accounts.length ? ['New passwords (hand them out; they can change them in the app):', ...r.accounts.map((a) => `  ${a.collection}  ${a.email}  ${a.password}`)] : []),
    ...r.failures.map((f) => `Failed: ${f.collection} ${f.id}: ${f.error}`),
    ...(r.backup ? [`Replaced records were saved in snapshot ${r.backup.id} (until ${r.backup.expires.slice(0, 10)}).`] : []),
    ...r.warnings.map((w) => `warning: ${w}`),
  ].join('\n');
}

// `cubby env set NAME=value`
export function parseEnvAssignment(text) {
  const i = String(text ?? '').indexOf('=');
  if (i < 1) throw new CliError('Usage: cubby env set NAME=value, or cubby env set NAME --from-stdin');
  return { key: text.slice(0, i), value: text.slice(i + 1) };
}
