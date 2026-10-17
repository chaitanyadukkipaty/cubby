// Activity log: who did what, through which agent. One small row per mutation; reads are never logged.
import { admin } from './pb.js';
import * as logic from './logic.js';

const rows = () => admin.collection('cubby_activity');

// Strictly increasing timestamps, so actions in the same millisecond still list in the order they happened.
let lastAt = 0;
const nextAt = () => new Date((lastAt = Math.max(Date.now(), lastAt + 1)));

// Records one action by `actor` (an authenticated user from auth.authenticate, or { id, agent }).
// Never throws: a failed log must never fail the action it describes.
export async function recordActivity(actor, { action, app = '', summary = '', meta = null }) {
  try {
    await rows().create(logic.activityRow(actor, { action, app, summary, meta }, nextAt()));
  } catch (err) {
    console.error(`activity log failed (${action}):`, err.message);
  }
}

// `all` is for admins only (the route checks). `col` is injectable for tests.
export async function listActivity(user, params, opts, col = rows()) {
  const { filter, limit } = logic.activityQuery(user, params, opts);
  const list = await col.getList(1, limit, { filter: admin.filter(filter.text, filter.params), sort: '-at', expand: 'user', skipTotal: true });
  return list.items.map(logic.activityView);
}

// Deletes rows older than 30 days. Part of the nightly maintenance (backups.runMaintenance).
export async function pruneActivity(now = new Date(), col = rows()) {
  const filter = admin.filter('at < {:cutoff}', { cutoff: logic.activityCutoff(now) });
  let deleted = 0;
  for (;;) {
    const { items } = await col.getList(1, 200, { filter, fields: 'id', skipTotal: true });
    if (!items.length) return deleted;
    for (const r of items) await col.delete(r.id);
    deleted += items.length;
  }
}
