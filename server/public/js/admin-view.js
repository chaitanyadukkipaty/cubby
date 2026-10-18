// The admin page's view model: the disk bar, backup guards, the retention estimate, the most active agents and who
// may purge a snapshot. Pure (no DOM, no network), so tests/unit/frontend-admin-view.test.js imports it directly;
// views/admin.js draws the page.
import { fmtBytes, fmtCount, fmtPct } from './helpers.js';

const CATEGORIES = [
  ['database', 'Database', 'database_bytes'],
  ['uploads', 'Uploads', 'uploads_bytes'],
  ['current', 'Current deploys', 'sites_current_bytes'],
  ['older', 'Old deploys', 'sites_older_bytes'],
  ['backups', 'Backups', 'backups_bytes'],
  ['snapshots', 'Snapshots', 'snapshots_bytes'],
  ['other', 'Other Cubby files', 'other_bytes'],
];

/**
 * The Storage tab's disk bar from GET /api/admin/storage: [{ key, label, bytes, share }], Cubby's categories, then
 * what else uses the disk and the free space, as shares of the whole disk (of Cubby's data if the size is unknown).
 */
export function diskBar({ disk = {}, data_bytes = 0, breakdown = {} }) {
  const total = disk.total_bytes || 0;
  const free = disk.free_bytes || 0;
  const segments = CATEGORIES.map(([key, label, field]) => ({ key, label, bytes: breakdown[field] ?? 0 }));
  if (total) {
    segments.push({ key: 'system', label: 'Not Cubby', bytes: Math.max(0, total - free - data_bytes) });
    segments.push({ key: 'free', label: 'Free', bytes: free });
  }
  const whole = total || data_bytes || 1;
  return segments.filter((s) => s.bytes > 0).map((s) => ({ ...s, share: s.bytes / whole }));
}

/**
 * What deleting the backup of `date` from `backups` (newest first) asks first, mirroring the server's guards: the
 * only backup needs `leaveNone` (?leave_none=1), the newest says which one becomes the latest, and nothing is
 * deleted while a backup runs (`blocked`).
 */
export function backupDelete(backups, date, { running = false } = {}) {
  const i = backups.findIndex((b) => b.date === date);
  const files = `Both files go (cubby-${date}.zip and sites-${date}.tar.gz), freeing ${fmtBytes(backups[i]?.total_bytes ?? 0)}.`;
  const only = backups.length === 1;
  const confirm = only ? `Delete ${date}, the only backup? Nothing is left to restore until the next one runs. ${files}`
    : i === 0 ? `Delete the newest backup (${date})? The latest one to restore becomes ${backups[1].date}. ${files}`
      : `Delete the backup of ${date}? ${files}`;
  return { blocked: running ? 'A backup is running. Try again when it finishes.' : null, leaveNone: only, confirm };
}

/** Restoring a backup is a server command (it replaces every app's data), never a dashboard button. */
export const restoreCommand = (date) => `sudo cubby-server restore ${date}`;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One sentence on what a backup retention (GET /api/admin/backups?keep=N's `estimate`) means for the disk. */
export function retentionText({ keep, backups, delete: gone = [], frees_bytes = 0, adds_bytes = 0 }) {
  if (gone.length) return { kind: 'frees', text: `Keeping ${keep} deletes ${plural(gone.length, 'backup')} at the next nightly run (${gone.join(', ')}), freeing ${fmtBytes(frees_bytes)}.` };
  if (adds_bytes > 0) return { kind: 'adds', text: `Keeping ${keep} takes about ${fmtBytes(adds_bytes)} more once ${keep - backups} more nightly backups exist.` };
  return { kind: 'same', text: `Keeping ${keep} changes nothing now: there ${backups === 1 ? 'is' : 'are'} ${plural(backups, 'backup')}.` };
}

/**
 * Agents seen in GET /api/admin/activity (newest first), across every user: [{ id, name, user, actions, apps, last }],
 * the busiest first. There's no list of every agent for admins; activity is what an agent did in the last 30 days.
 */
export function activeAgents(rows, { limit = Infinity } = {}) {
  const byId = new Map();
  for (const r of rows) {
    if (r.via !== 'agent' || !r.agent) continue;
    const a = byId.get(r.agent.id) ?? byId.set(r.agent.id, { id: r.agent.id, name: r.agent.name, user: r.user, actions: 0, apps: new Map(), last: r.at }).get(r.agent.id);
    a.actions++;
    if (r.app) a.apps.set(r.app, (a.apps.get(r.app) ?? 0) + 1);
  }
  return [...byId.values()]
    .map((a) => ({ ...a, apps: [...a.apps].sort((x, y) => y[1] - x[1]).map(([slug]) => slug) }))
    .sort((a, b) => b.actions - a.actions || (a.last < b.last ? 1 : -1))
    .slice(0, limit);
}

/** Whether `me` may purge a snapshot (GET /api/snapshots row): owners can't purge one an admin made (the server agrees). */
export const purgeRule = (snap, me) => (snap.by_admin && !me?.is_admin
  ? { allowed: false, why: 'Made by an admin: only an admin can purge it. You can still restore it.' }
  : { allowed: true, why: null });

/** The Overview's KPI strip, from GET /api/admin/metrics?range=7d and /api/admin/overview's `server`. */
export function overviewKpis(m, server) {
  return [
    { label: 'Users', value: fmtCount(server.users), sub: `${fmtCount(server.apps)} app${server.apps === 1 ? '' : 's'}` },
    { label: 'Views', value: fmtCount(m.views), sub: 'last 7 days, every app' },
    { label: 'Visitors', value: fmtCount(m.visitors), sub: 'per app and day' },
    { label: 'Active now', value: fmtCount(m.active_now), sub: 'last 5 minutes' },
    m.api_requests
      ? { label: 'API error rate', value: fmtPct(m.api_error_rate), sub: `${fmtCount(m.api_errors)} of ${fmtCount(m.api_requests)} requests` }
      : { label: 'API error rate', value: '–', sub: 'no API requests' },
    { label: 'Disk free', value: fmtBytes(server.disk_free_bytes), sub: `of ${fmtBytes(server.disk_total_bytes)}`, alert: server.disk_free_bytes < server.disk_total_bytes * 0.1 },
  ];
}

// ---------- Security (GET /api/admin/bans) ----------

/** fail2ban runs on the host, so only the server can turn it on. */
export const FAIL2BAN_ENABLE = 'sudo cubby-server fail2ban enable';

/** When a ban in force lifts by itself: "lifts in 8 min", or "until unbanned" for a permanent one. */
export function banExpiry(b, now = Date.now()) {
  if (!b.expires_at) return 'until unbanned';
  const min = Math.floor((Date.parse(b.expires_at) - now) / 60_000);
  if (min < 1) return 'lifts in under a minute';
  if (min < 60) return `lifts in ${min} min`;
  if (min < 48 * 60) return `lifts in ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
  return `lifts in ${Math.floor(min / (24 * 60))} days`;
}

/** The apps a scanner swept (the paths it asked for are listed apart), or null when there's nothing to say. */
export function banSweep(b) {
  if (!b.hosts?.length) return null;
  return b.hosts.length === 1 ? `Swept ${b.hosts[0]}` : `Swept ${b.hosts.length} apps: ${b.hosts.join(', ')}`;
}

/** An IP banned before (in the last 90 days) is worth a second look. */
export const seenBefore = (n) => (!n ? null : n === 1 ? 'banned once before' : `banned ${n} times before`);

/** How a past ban ended, from its `unbanned_by` ("expired", "admin <email>", or done on the server). */
export function banOutcome(b) {
  const by = b.unbanned_by;
  if (!by || by === 'expired') return 'Expired';
  return by.startsWith('admin ') ? `Unbanned by ${by.slice(6)}` : `Unbanned ${by}`;
}

export const unbanConfirm = (b) => `Unban ${b.ip} (${b.reason})? It can reach every app on this server again right away.`;

// The labels of the settings form, for the server's messages, which name the field key ("job_timeout_s must be …").
const SETTING_LABELS = { max_apps_per_user: 'Apps per user', max_deploy_mb: 'Max deploy (MB)', job_timeout_s: 'Time limit per run (seconds)', backup_keep: 'Nightly backups to keep' };

/** A settings error as the admin reads it: "Apps per user must be …" instead of "max_apps_per_user must be …". */
export function settingsError(message) {
  if (!message) return 'Saving failed';
  const key = Object.keys(SETTING_LABELS).find((k) => message.startsWith(`${k} `));
  return key ? SETTING_LABELS[key] + message.slice(key.length) : message;
}
