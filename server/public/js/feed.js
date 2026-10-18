// The agent activity feed's view model: who did what, grouped by day, which entries offer Roll back, and the fixed
// prompt templates ("What should your agent do next?", "Copy fix-it prompt"). Pure (no DOM, no network), so
// tests/unit/frontend-feed.test.js imports it directly; views/feed-ui.js draws it.
import { displayName, fmtPct, parseDate, shortDate } from './helpers.js';
import { appPath } from './routes.js';

const TOOLS = { 'claude code': 'CC', codex: 'CX', cursor: 'CU', opencode: 'OC' };

/** Two letters for an agent's badge: the usual ones for known tools, else the initials of its first two words. */
export function monogram(name) {
  const tool = String(name ?? '').split(' · ')[0].trim();
  if (TOOLS[tool.toLowerCase()]) return TOOLS[tool.toLowerCase()];
  const words = tool.split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** "Today", "Yesterday" or a short date ("Oct 11"; "Dec 30, 2025" in another year), in local time. */
export function dayLabel(date, now = new Date()) {
  const d = parseDate(date);
  if (dayKey(d) === dayKey(now)) return 'Today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return 'Yesterday';
  return shortDate(d, now);
}

/** Rows (newest first, each with `at`) as [{ label, rows }], one group per local day. */
export function groupByDay(rows, now = new Date()) {
  const groups = [];
  for (const row of rows) {
    const label = dayLabel(row.at, now);
    if (groups.at(-1)?.label === label) groups.at(-1).rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

/** The deploy that "Roll back" on `deployId` restores: the one just before it (deploys are newest first), or null. */
export function rollbackTarget(deploys, deployId) {
  const i = deploys.findIndex((d) => d.id === deployId);
  return i >= 0 ? deploys[i + 1] ?? null : null;
}

function actorOf(row, agents) {
  if (row.via === 'admin') return { name: 'Admin', mono: 'AD', href: null };
  if (row.via !== 'agent' || !row.agent) return { name: 'Dashboard', mono: 'DB', href: null };
  const known = agents.find((a) => a.id === row.agent.id);
  if (!known) return { name: row.agent.name, mono: monogram(row.agent.name), href: null };
  return { name: known.name, mono: monogram(known.tool || known.name), href: `/agents/${known.id}` };
}

function appOf(slug, apps) {
  if (!slug) return null;
  const app = apps.find((a) => a.slug === slug);
  return app ? { slug, name: app.name, href: appPath(slug) } : { slug, name: slug, href: null };
}

/**
 * One line of the feed from a GET /api/activity row. `apps` are the user's own (GET /api/projects), `agents` theirs
 * (GET /api/agents). `rollback` is offered on the deploy that's live now, so a click restores the one before it.
 */
export function feedEntry(row, { apps = [], agents = [] } = {}) {
  const entry = { id: row.id, at: row.at, actor: actorOf(row, agents), app: appOf(row.app, apps), text: row.summary, kind: 'other', rollback: false };
  if (row.action === 'deploy') {
    entry.kind = 'deploy';
    const { deploy, files } = deployDetails(row);
    entry.deployId = deploy;
    entry.verb = 'deployed';
    entry.detail = files != null ? `${files} file${files === 1 ? '' : 's'}` : '';
    const app = apps.find((a) => a.slug === row.app);
    entry.rollback = Boolean(app && entry.deployId && app.current_deploy === entry.deployId);
  } else if (row.action === 'rollback') {
    Object.assign(entry, { kind: 'rollback', verb: 'rolled back', detail: 'to an earlier deploy' });
  } else if (row.action === 'job.run') {
    const { job, status } = jobRunDetails(row);
    if (job && (status === 'error' || status === 'timeout')) Object.assign(entry, { kind: 'failed', job, status });
  }
  return entry;
}

// Rows carry structured `meta` since the activity log gained it; older rows only have the summary text
// ("Deployed <id> (N files)", `Ran job "x" now (status)`), which is parsed as a fallback.
function deployDetails({ meta, summary }) {
  if (meta?.deploy) return { deploy: meta.deploy, files: Number.isInteger(meta.files) ? meta.files : null };
  const m = String(summary ?? '').match(/^Deployed (\S+)(?: \((\d+) files?\))?/);
  return { deploy: m?.[1] ?? null, files: m?.[2] ? Number(m[2]) : null };
}

function jobRunDetails({ meta, summary }) {
  if (meta?.job) return { job: meta.job, status: meta.status ?? null };
  const m = String(summary ?? '').match(/^Ran job "([^"]+)" now \((\w+)\)$/);
  return { job: m?.[1] ?? null, status: m?.[2] ?? null };
}

/** Feed entries for rows (newest first). Only an app's newest deploy in the feed can offer Roll back. */
export function feedEntries(rows, ctx) {
  const seen = new Set();
  return rows.map((r) => {
    const e = feedEntry(r, ctx);
    if (e.kind === 'deploy' && e.app) {
      if (seen.has(e.app.slug)) e.rollback = false;
      seen.add(e.app.slug);
    }
    return e;
  });
}

/** { slug: actor } — who made each app's latest deploy, from activity rows (newest first). */
export function lastDeployers(rows, agents = []) {
  const out = {};
  for (const r of rows) if (r.action === 'deploy' && r.app && !(r.app in out)) out[r.app] = actorOf(r, agents);
  return out;
}

/** { agentId | 'dashboard': [slug, …] } — the apps each agent changed, most recent first. */
export function appsByAgent(rows) {
  const out = {};
  for (const r of rows) {
    if (!r.app || r.via === 'admin') continue;
    const key = r.via === 'agent' && r.agent ? r.agent.id : 'dashboard';
    const list = (out[key] ??= []);
    if (!list.includes(r.app)) list.push(r.app);
  }
  return out;
}

// --- Prompt templates. Fixed sentences filled in with names: prompts are never generated. ---

const byLastDeploy = (apps) => apps.filter((a) => a.last_deployed).sort((a, b) => parseDate(b.last_deployed) - parseDate(a.last_deployed));

/** "What should your agent do next?": ideas that build on the most recently deployed app, then a new app. */
export function nextPrompts({ apps = [], serverName } = {}) {
  const server = displayName(serverName);
  const fresh = `Build a shared grocery list for my flatmates and host it on ${server}.`;
  const latest = byLastDeploy(apps)[0];
  if (!latest) return [`Build me a polls app for my friends and host it on ${server}.`, fresh];
  return [
    `Add a dark mode toggle to ${latest.name} and redeploy it on ${server}.`,
    `Look at this week's numbers for ${latest.name} with cubby metrics and suggest one improvement.`,
    `Add a scheduled job to ${latest.name} that emails everyone a weekly summary every Monday at 9am.`,
    fresh,
  ];
}

/** What to paste into the agent when something broke: a failed job, or API errors. */
export function fixItPrompt(p) {
  if (p.kind === 'job') {
    return `The scheduled job "${p.job}" of my Cubby app ${p.app} failed (${p.status}). Read its recent logs with \`cubby jobs logs ${p.job}\` `
      + 'in the app folder, find the cause, fix it and redeploy.';
  }
  return `My Cubby app ${p.app} had ${p.errors} API errors (${fmtPct(p.rate)} of requests) in the last ${p.range}. `
    + `Check \`cubby metrics ${p.app}\` and \`cubby deploys\`, find what changed, fix the cause and redeploy.`;
}

const EMPTY_PROMPTS = {
  overview: (n) => `Add a landing page to ${n} that explains what it does, and redeploy it.`,
  activity: (n) => `Make one small improvement to ${n} and deploy it.`,
  deploys: (n) => `Build the first version of ${n} and deploy it.`,
  jobs: (n) => `Add a scheduled job to ${n} that cleans up old data every night at 2am.`,
  env: (n) => `Tell me which secrets ${n} needs (API keys for its jobs) and set them with cubby env set.`,
};

/** The "Ask your agent:" suggestion for an app page tab that has nothing to show yet. */
export const emptyPrompt = (tab, app) => (EMPTY_PROMPTS[tab] ?? EMPTY_PROMPTS.activity)(app.name);

// An app needs a look when at least this many API requests failed, at this rate or more.
const ERROR_COUNT = 5;
const ERROR_RATE = 0.05;

/**
 * What's broken across the user's apps, each with a fix-it prompt: scheduled jobs whose last run failed (paused ones
 * aside) and apps with many API errors. `jobs` carry their `app`; `metrics` are GET /api/metrics rows. First, apps
 * (GET /api/projects) whose data an admin cleared: those link to the Data tab (to restore) instead of a prompt.
 */
export function needsAttention({ apps = [], jobs = [], metrics = [] } = {}) {
  const items = apps.filter((a) => a.admin_clear).map((a) => ({
    app: a.slug, kind: 'admin_clear', text: `had data cleared by an admin (${a.admin_clear.by}): ${a.admin_clear.reason}`, prompt: null, href: appPath(a.slug, 'data'),
  }));
  for (const j of jobs) {
    const status = j.last_run?.status;
    if (j.paused || (status !== 'error' && status !== 'timeout')) continue;
    items.push({ app: j.app, kind: 'job', text: `Job ${j.name} failed (${status})`, prompt: fixItPrompt({ kind: 'job', app: j.app, job: j.name, status }) });
  }
  for (const m of metrics) {
    if (m.api_errors < ERROR_COUNT || m.api_error_rate < ERROR_RATE) continue;
    const range = m.range || '24h';
    items.push({ app: m.app, kind: 'errors', text: `${m.api_errors} API errors in the last ${range} (${fmtPct(m.api_error_rate)} of requests)`,
      prompt: fixItPrompt({ kind: 'errors', app: m.app, errors: m.api_errors, rate: m.api_error_rate, range }) });
  }
  return items;
}
