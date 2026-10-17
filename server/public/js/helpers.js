// Pure helpers for the dashboard: no DOM state, no network, no imports. tests/unit/frontend-dashboard.test.js
// imports this module directly (h() only needs document.createElement at call time).

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`;

export function ago(date, now = Date.now()) {
  if (!date) return 'never';
  const s = (now - new Date(date.replace(' ', 'T')).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const maskToken = (t) => `${String(t).slice(0, 6)}${'•'.repeat(20)}`;
export const installCommand = (server) => `curl -fsSL ${server}/skill.sh | sh`;
const SKILL_REPO = 'chaitanyadukkipaty/cubby';
export const displayName = (name) => (typeof name === 'string' && name.trim()) || 'Cubby';

// What a user pastes into their agent. Stating the intent and the server up front (and letting the agent read the
// installer) is what keeps agents from flagging a bare `curl | sh` from an unknown domain as malicious.
export function setupPrompt(server, name) {
  const named = displayName(name) !== 'Cubby' ? `${displayName(name)} at ` : '';
  return `I'd like you to set up Cubby: ${named}${server}, a self-hosted server where you build and host web apps for me.\n`
    + `Install it as a skill if I have npm: npx skills add ${SKILL_REPO} --skill cubby -g\n`
    + `If not, do this instead: ${installCommand(server)}\n`
    + `After installing, read ~/.agents/skills/cubby/SKILL.md and follow its Setup to connect to ${server} `
    + `(you'll send me a link to approve), review the docs at ${server}/docs.md and ask me what I'd like to build.`;
}

export const tokenLoginCommand = (server) => `cubby login ${server} --token <token>`;
export const inviteText = (server, code, name) => `Join ${name ? displayName(name) : 'my Cubby server'}: ${server}\nSignup code: ${code}`;
export const connectHeading = (name) => `Connect your agent to ${name ? displayName(name) : 'this server'}?`;
export const isHttps = (url) => String(url).startsWith('https:');

// /connect?code=XXXX-XXXX → "XXXX-XXXX"; any other page or a blank code → null.
export function parseConnectCode(pathname, search) {
  if (pathname !== '/connect') return null;
  const code = (new URLSearchParams(search).get('code') || '').trim();
  return code || null;
}

export const apiErrorMessage = (status, data) => (data && typeof data.error === 'string' && data.error) || `Request failed (${status})`;

// "Cubby 0.1.1" for a release build; "Cubby 0.1.1 · development build abc1234" for anything else.
export function versionLabel(version) {
  const m = String(version || '').match(/^(\d+\.\d+\.\d+)-dev\+([0-9a-f]+)$/);
  return m ? `Cubby ${m[1]} · development build ${m[2]}` : `Cubby ${version || 'unknown version'}`;
}

export const UPGRADE_COMMAND = 'sudo cubby-server upgrade';

// What the Admin page says about updates, from /api/admin/overview's `update`.
export function updateNotice(u) {
  if (!u) return { kind: 'unknown', text: "Couldn't check for updates." };
  if (!u.enabled) {
    return u.reason === 'env'
      ? { kind: 'off', text: 'Update checks are turned off on the server (CUBBY_UPDATE_CHECK=0).' }
      : { kind: 'off', text: 'Update checks are off.' };
  }
  if (u.update_available) return { kind: 'available', text: `Update available: ${u.latest}`, command: UPGRADE_COMMAND, url: u.release_url || null };
  if (u.error && !u.latest) return { kind: 'unknown', text: "Couldn't reach GitHub to check for updates. Cubby will try again tomorrow." };
  if (!u.checked_at) return { kind: 'unknown', text: 'Checking for updates…' };
  return { kind: 'current', text: u.latest ? `You're on the latest release (${u.latest}).` : 'No releases published yet.' };
}

// Light or dark: a saved choice ('light' | 'dark') wins, otherwise the system's preference.
export const effectiveTheme = (saved, systemDark) => (saved === 'light' || saved === 'dark' ? saved : systemDark ? 'dark' : 'light');
export const toggledTheme = (saved, systemDark) => (effectiveTheme(saved, systemDark) === 'dark' ? 'light' : 'dark');

// A job's state at a glance, from /api/projects/:slug/jobs or /api/admin/jobs.
export function jobState(j) {
  if (j.paused) return { kind: 'muted', text: 'paused' };
  if (!j.last_run) return { kind: 'muted', text: 'not run yet' };
  const s = j.last_run.status;
  return { kind: s === 'ok' ? 'ok' : s === 'skipped' || s === 'running' ? 'muted' : 'danger', text: s === 'ok' ? 'ok' : s };
}
