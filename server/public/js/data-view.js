// The app Data tab's view model: what's ticked, the request the form makes, the mandatory preview, when the
// destructive button unlocks, restore drift and the admin-clear banner. Pure (no DOM, no network), so
// tests/unit/frontend-data-view.test.js imports it directly; views/data.js draws the tab.
import { fmtBytes, fmtCount } from './helpers.js';

const plural = (n, word) => `${fmtCount(n)} ${word}${n === 1 ? '' : 's'}`;
const list = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
// Same as MAX_MATCHES in server/src/data.js: more needs all_matching.
export const MAX_MATCHES = 10_000;

/** The collections ticked at first: all but the app's user accounts (restoring them means new random passwords). */
export const defaultSelection = (collections) => collections.filter((c) => c.type !== 'auth').map((c) => c.name);

/** The "created before" shortcut: a YYYY-MM-DD date as a PocketBase filter on `created` (UTC midnight), else null. */
export const createdBefore = (date) => (/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) ? `created < "${date} 00:00:00.000Z"` : null);

/**
 * The body of POST /api/projects/:slug/data/clear from the form: `scope` is 'collections' (`names`, `drop`),
 * 'filter' (`collection`, `filter`) or 'ids' (`collection`, `ids`); plus `allMatching` and an admin's `reason`.
 * Returns { body } or { error } (what to fill in first).
 */
export function clearRequest({ scope, names = [], drop = false, collection, filter = '', ids = [], allMatching = false, reason = '' }) {
  let body;
  if (scope === 'collections') {
    if (!names.length) return { error: 'Tick at least one collection.' };
    body = { collections: [...names], ...(drop && { drop: true }) };
  } else {
    if (!collection) return { error: 'Pick the collection to delete records from.' };
    if (scope === 'ids') {
      if (!ids.length) return { error: 'Tick the records to delete.' };
      body = { collection, ids: [...ids] };
    } else {
      if (!filter.trim()) return { error: 'Write a filter, or pick a date.' };
      body = { collection, filter: filter.trim() };
    }
  }
  if (allMatching) body.all_matching = true;
  if (reason.trim()) body.reason = reason.trim();
  return { body };
}

/**
 * What a dry run (POST …/data/clear with dry_run) found, in words: the headline ("Matches 12 of 40 records in tasks."),
 * the cascade lines, what `blocked` it (required relations left empty: the server refuses those), the warnings and
 * samples, whether `nothing` matches and whether it's `big` (over 10,000).
 */
export function previewModel(r) {
  const names = r.collections.map((c) => c.name);
  const files = r.files_bytes ? `, plus ${fmtBytes(r.files_bytes)} of uploaded files` : '';
  let headline;
  if (r.mode === 'filter' || r.mode === 'ids') {
    headline = `Matches ${fmtCount(r.matches)} of ${plural(r.total, 'record')} in ${names[0]}${files}.`;
    if (r.missing?.length) headline += ` ${fmtCount(r.missing.length)} of the ticked records ${r.missing.length === 1 ? 'is' : 'are'} gone already.`;
  } else if (r.wipe) headline = `Wipes the database: drops ${list(names)}, ${plural(r.matches, 'record')}${files}.`;
  else if (r.mode === 'drop') headline = `Drops ${list(names)} (the collection${names.length > 1 ? 's' : ''}, ${names.length > 1 ? 'their' : 'its'} fields and rules): ${plural(r.matches, 'record')}${files}.`;
  else headline = `Empties ${list(names)}: ${plural(r.matches, 'record')}${files}.`;
  const cascade = (r.cascade ?? []).filter((c) => c.records > 0).map((c) => (c.deletes
    ? `${plural(c.records, 'record')} of ${c.collection} go${c.records === 1 ? 'es' : ''} too: their ${c.field} relation deletes on cascade.`
    : `${plural(c.records, 'record')} of ${c.collection} lose${c.records === 1 ? 's its' : ' their'} ${c.field} reference.`));
  return { headline, cascade, blocked: r.blocked ?? [], warnings: r.warnings ?? [], samples: r.samples ?? [], nothing: r.matches === 0, big: r.matches > MAX_MATCHES };
}

/** The match count in the server's refusal of a filter or ids over 10,000 matches (409), or null for another error. */
export function tooManyMatches(message) {
  const m = String(message ?? '').match(/matches (\d+) records, more than \d+/);
  return m ? Number(m[1]) : null;
}

/** Which request a preview was of. The reason doesn't change what's deleted, so it isn't part of it. */
export const requestKey = ({ reason, ...body }) => JSON.stringify(body);

/**
 * Whether the destructive button unlocks: a preview of the request as it is now (`previewedKey` = `key`) that
 * matches something, the extra tick for over 10,000 records, an admin's reason, and the app name typed.
 */
export function clearGate({ preview, previewedKey, key, typed = '', slug, needsReason = false, reason = '', bigConfirmed = false }) {
  const no = (why) => ({ ok: false, why });
  if (!preview || previewedKey !== key) return no("Preview first: the delete button unlocks once you've seen what goes.");
  if (preview.blocked?.length) return no('PocketBase would refuse this: see what blocks it above.');
  if (preview.nothing) return no('Nothing matches, so there is nothing to delete.');
  if (preview.big && !bigConfirmed) return no('Over 10,000 records: tick the box to confirm.');
  if (needsReason && !reason.trim()) return no('Give a reason: the owner sees it.');
  if (typed.trim() !== slug) return no(`Type ${slug} to confirm.`);
  return { ok: true, why: null };
}

const SYSTEM = new Set(['id', 'collectionId', 'collectionName', 'created', 'updated', 'expand']);
const cut = (text, n = 40) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const show = (value) => (Array.isArray(value) ? value.join(', ') : value && typeof value === 'object' ? JSON.stringify(value) : String(value));

const sum = (rows, field) => rows.reduce((n, r) => n + (r[field] ?? 0), 0);

/**
 * A restore's dry run (POST /api/snapshots/:id/restore with dry_run) in words: the headline, the schema drift since
 * the snapshot, and `blocked` when fields changed type (the server refuses those restores).
 */
export function restoreModel(r) {
  const records = sum(r.collections, 'records');
  const existing = sum(r.collections, 'existing');
  const into = `into ${list(r.collections.map((c) => c.name))}`;
  const headline = !existing ? `Restores ${plural(records, 'record')} ${into}.`
    : r.overwrite ? `Restores ${plural(records, 'record')} ${into}. ${fmtCount(existing)} that exist again ${existing === 1 ? 'is' : 'are'} replaced (saved in a new snapshot first).`
      : `Restores ${fmtCount(records - existing)} of ${plural(records, 'record')} ${into}. ${fmtCount(existing)} exist${existing === 1 ? 's' : ''} again and ${existing === 1 ? 'is' : 'are'} skipped (tick Overwrite to replace them).`;
  const drift = [
    ...r.recreated.map((name) => `${name} was dropped: it is created again.`),
    ...r.skipped_fields.map((f) => `${f} was removed since: its values are skipped.`),
  ];
  const blocked = r.refused_fields.length ? `Can't restore: ${r.refused_fields.join('; ')}. Drop or rename those fields, then preview again.` : null;
  return { headline, drift, blocked, warnings: r.warnings ?? [] };
}

/** "Restored 38 records from s1 (2 already there)." from a restore's result. */
export function restoreResultText({ snapshot, collections, links = [], accounts = [] }) {
  const replaced = sum(collections, 'replaced');
  const relinked = sum(links, 'relinked');
  const there = sum(collections, 'existing') - replaced;
  const failed = sum(collections, 'failed');
  const notes = [
    ...(replaced ? [`${fmtCount(replaced)} replaced`] : []),
    ...(there > 0 ? [`${fmtCount(there)} already there`] : []),
    ...(failed ? [`${fmtCount(failed)} failed`] : []),
    ...(relinked ? [`${plural(relinked, 'record')} relinked`] : []),
    ...(accounts.length ? [accounts.length === 1 ? '1 account with a new password' : `${fmtCount(accounts.length)} accounts with new passwords`] : []),
  ];
  return `Restored ${plural(sum(collections, 'restored'), 'record')} from ${snapshot}${notes.length ? ` (${notes.join(', ')})` : ''}.`;
}

/** What a clear did, and the snapshot that can undo it. */
export function clearResultText(r) {
  if (!r.snapshot) return 'Nothing matched, so nothing was deleted.';
  const n = sum(r.collections, 'records');
  return `Deleted ${plural(n, 'record')}. Snapshot ${r.snapshot.id} can bring ${n === 1 ? 'it' : 'them'} back until ${r.snapshot.expires.slice(0, 10)}.`;
}

/** The owner's banner from the app's `admin_clear` flag (null when there's none to show). */
export const adminClearNotice = (flag) => (flag ? { title: 'An admin cleared data of this app', text: flag.summary, snapshot: flag.snapshot } : null);

/** A sample record's own fields on one line ("title: Buy milk · done: false"), each value cut short. */
export function recordSummary(record) {
  const parts = Object.entries(record)
    .filter(([k, value]) => !SYSTEM.has(k) && value !== '' && value != null && !(Array.isArray(value) && !value.length))
    .map(([k, value]) => `${k}: ${cut(show(value))}`);
  return parts.length ? parts.join(' · ') : '(no fields)';
}
