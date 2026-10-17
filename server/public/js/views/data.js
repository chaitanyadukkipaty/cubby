// An app's data without deleting the app: the collections with their counts and sizes, clearing some of them (empty,
// drop, or records by filter or by the ticked samples) after a mandatory preview and a typed confirmation, and the
// snapshots each clear leaves, with restore (dry run first) and purge. Drawn on the app's Data tab for owners, and
// on Admin → Apps → Clear data for admins (who must give a reason when the app isn't theirs). The words and the rules
// for unlocking the destructive button live in js/data-view.js (pure, unit-tested).
import { h, ago, fmtBytes, fmtCount } from '../helpers.js';
import { adminClearNotice, clearGate, clearRequest, clearResultText, createdBefore, defaultSelection, previewModel, recordSummary, requestKey, restoreModel,
  restoreResultText, tooManyMatches } from '../data-view.js';
import { purgeRule } from '../admin-view.js';
import { appPath } from '../routes.js';
import { state, api } from '../session.js';
import { copyChip, icon, toast } from '../ui.js';

const FILTER_EXAMPLES = ['done = true', 'created < "2026-01-01 00:00:00"', 'title ~ "test"', 'owner = ""'];
const MODES = [
  ['empty', 'Empty the ticked collections', 'Deletes their records; fields and rules stay.'],
  ['drop', 'Drop the ticked collections', 'Deletes the collections too; the next deploy creates them again from schema.json.'],
  ['filter', 'Delete records of one collection', 'By a PocketBase filter, or tick sample records in the preview.'],
];

/** The owner's "data cleared by an admin" banner, with Dismiss. Null when there's nothing to say. */
export function adminClearBanner(a, { onDismiss }) {
  const n = adminClearNotice(a.admin_clear);
  if (!n) return null;
  return h('div', { class: 'banner notice', role: 'region', 'aria-label': n.title },
    h('div', { class: 'grow-wrap' }, h('b', {}, n.title), h('p', { class: 'small' }, n.text)),
    h('div', { class: 'row nowrap' },
      h('a', { class: 'btn', href: appPath(a.slug, 'data') }, 'Snapshots'),
      h('button', { type: 'button', class: 'sm', onclick: async () => {
        try { await api('DELETE', `/api/projects/${a.slug}/admin-clear`); toast('Dismissed'); onDismiss(); } catch (ex) { toast(ex.message); }
      } }, 'Dismiss')));
}

/**
 * Draws the Data panel of `slug` into `el`. `needsReason`: an admin clearing an app that isn't theirs. `flash` is a
 * result to show on top (the panel redraws itself after a clear or restore, with fresh counts).
 */
export async function renderData(el, { slug, needsReason = false, flash = null }) {
  el.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  const [cols, snaps] = await Promise.all([api('GET', `/api/projects/${slug}/data`), api('GET', `/api/snapshots?app=${slug}`)]);
  const again = (next) => renderData(el, { slug, needsReason, flash: next }).catch((ex) => toast(ex.message));
  el.replaceChildren(
    flash ? h('div', { class: 'card result', role: 'status', 'aria-label': 'Result' }, flash) : '',
    h('h3', {}, 'Collections'),
    cols.length ? clearForm(cols, { slug, needsReason, done: again }) : h('div', { class: 'empty' }, 'No collections yet. They come from cubby/schema.json on deploy.'),
    h('h3', {}, `Snapshots (${snaps.length})`),
    snapshotsTable(snaps, { done: again }),
  );
}

function clearForm(cols, { slug, needsReason, done }) {
  const s = { mode: 'empty', names: new Set(defaultSelection(cols)), collection: cols.find((c) => c.type !== 'auth')?.name ?? cols[0].name, filter: '', ids: [], allMatching: false, bigConfirmed: false, preview: null, previewedKey: null };
  const authCols = cols.filter((c) => c.type === 'auth');

  // --- What: the collections (ticked), the mode, and the filter ---
  const authNote = h('p', { class: 'warn small', hidden: true });
  const syncAuthNote = () => {
    const ticked = authCols.filter((c) => s.names.has(c.name));
    authNote.hidden = !(s.mode !== 'filter' && ticked.length);
    authNote.textContent = `${ticked.map((c) => c.name).join(', ')} holds the app's user accounts. A restore gives every account a new random password (PocketBase never hands out password hashes), so people have to be told theirs.`;
  };
  const table = h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'Collections' },
    h('thead', {}, h('tr', {}, h('th', {}, h('span', { class: 'sr-only' }, 'Clear')), h('th', {}, 'Collection'), h('th', { class: 'r' }, 'Records'), h('th', { class: 'r' }, 'Files'))),
    h('tbody', {}, cols.map((c) => h('tr', { 'aria-label': c.name },
      h('td', { class: 'check-cell' }, h('input', { type: 'checkbox', 'aria-label': `Clear ${c.name}`, checked: s.names.has(c.name), onchange: (e) => {
        if (e.target.checked) s.names.add(c.name); else s.names.delete(c.name);
        syncAuthNote(); update();
      } })),
      h('td', {}, h('span', { class: 'mono' }, c.name), c.type === 'auth' ? h('span', { class: 'badge', style: 'margin-left:6px' }, 'accounts') : null),
      h('td', { class: 'r num' }, fmtCount(c.records)), h('td', { class: 'r num muted' }, c.files_bytes ? fmtBytes(c.files_bytes) : '–'))))));

  const filterInput = h('input', { type: 'text', class: 'mono', 'aria-label': 'Filter', placeholder: 'done = true', autocomplete: 'off', spellcheck: 'false', oninput: (e) => { s.filter = e.target.value; s.ids = []; update(); } });
  const setFilter = (text) => { filterInput.value = s.filter = text; s.ids = []; update(); };
  const dateInput = h('input', { type: 'date', 'aria-label': 'Created before', onchange: (e) => { const f = createdBefore(e.target.value); if (f) setFilter(f); } });
  const collectionSelect = h('select', { 'aria-label': 'Collection to delete records from', onchange: (e) => { s.collection = e.target.value; s.ids = []; update(); } },
    cols.map((c) => h('option', { value: c.name, selected: c.name === s.collection }, c.name)));
  const filterBox = h('div', { class: 'card stack filter-box', hidden: true },
    h('label', { class: 'field' }, h('span', { class: 'small muted' }, 'Collection'), collectionSelect),
    h('label', { class: 'field' }, h('span', { class: 'small muted' }, 'PocketBase filter'), filterInput),
    h('div', { class: 'row small' }, h('span', { class: 'muted' }, 'Examples:'), FILTER_EXAMPLES.map((x) => h('button', { type: 'button', class: 'chip-copy', onclick: () => setFilter(x) }, h('span', { class: 'mono' }, x)))),
    h('label', { class: 'row small' }, h('span', { class: 'muted' }, 'Or everything created before'), dateInput));

  const modes = h('fieldset', { class: 'modes' }, h('legend', { class: 'sr-only' }, 'What to clear'), MODES.map(([value, label, hint]) => h('label', { class: 'mode' },
    h('input', { type: 'radio', name: `mode-${slug}`, value, checked: value === s.mode, onchange: () => {
      s.mode = value; filterBox.hidden = value !== 'filter'; table.classList.toggle('dim', value === 'filter'); syncAuthNote(); update();
    } }),
    h('span', {}, h('b', {}, label), h('span', { class: 'muted small' }, ` ${hint}`)))));

  // --- Preview (mandatory) ---
  const err = h('p', { class: 'error', role: 'alert' });
  const previewBox = h('div', { class: 'preview', role: 'region', 'aria-label': 'Preview', hidden: true });
  const previewBtn = h('button', { type: 'button', onclick: () => runPreview() }, 'Preview');

  // --- Confirm ---
  const reason = needsReason ? h('textarea', { 'aria-label': 'Reason (shown to the owner)', rows: 2, maxlength: 300, placeholder: 'Why? The owner sees this on their app and in their activity.', oninput: () => update() }) : null;
  const typed = h('input', { type: 'text', class: 'mono', 'aria-label': `Type ${slug} to confirm`, placeholder: slug, autocomplete: 'off', spellcheck: 'false', oninput: () => update() });
  const why = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const go = h('button', { type: 'button', class: 'danger solid', disabled: true, onclick: () => runClear() }, 'Delete');
  const confirmBox = h('div', { class: 'card stack danger-zone' },
    reason ? h('label', { class: 'field' }, h('span', { class: 'small' }, 'Reason (shown to the owner)'), reason) : null,
    h('label', { class: 'small' }, 'Type ', h('code', {}, slug), ' to confirm'),
    h('div', { class: 'row' }, typed, go), why);

  const request = () => clearRequest({
    scope: s.mode === 'filter' ? (s.ids.length ? 'ids' : 'filter') : 'collections', names: cols.map((c) => c.name).filter((n) => s.names.has(n)),
    drop: s.mode === 'drop', collection: s.collection, filter: s.filter, ids: s.ids, allMatching: s.allMatching, reason: reason?.value ?? '',
  });

  function update() {
    const r = request();
    previewBtn.disabled = Boolean(r.error);
    const gate = r.error ? { ok: false, why: r.error } : clearGate({ preview: s.preview, previewedKey: s.previewedKey, key: requestKey(r.body), typed: typed.value, slug, needsReason, reason: reason?.value ?? '', bigConfirmed: s.bigConfirmed });
    go.disabled = !gate.ok;
    why.textContent = gate.why ?? '';
    if (s.preview && s.previewedKey !== (r.body ? requestKey(r.body) : null)) previewBox.classList.add('stale');
    else previewBox.classList.remove('stale');
    go.replaceChildren(s.mode === 'drop' ? 'Drop collections' : s.mode === 'empty' ? 'Empty collections' : s.ids.length ? `Delete ${s.ids.length} ticked` : 'Delete matching records');
  }

  async function runPreview() {
    const r = request();
    if (r.error) return;
    err.textContent = '';
    previewBtn.disabled = true;
    try {
      const result = await api('POST', `/api/projects/${slug}/data/clear`, { ...r.body, dry_run: true });
      s.preview = previewModel(result);
      s.previewedKey = requestKey(r.body);
      drawPreview(s.preview, result);
    } catch (ex) {
      const n = tooManyMatches(ex.message);
      s.preview = null;
      if (n) drawTooMany(n); else { err.textContent = ex.message; previewBox.hidden = true; }
    }
    update();
  }

  function drawTooMany(n) {
    previewBox.hidden = false;
    previewBox.replaceChildren(h('div', { class: 'card stack' },
      h('p', {}, h('b', {}, `Matches ${fmtCount(n)} records, more than 10,000.`), ' Narrow the filter, or confirm you mean all of them.'),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', onchange: (e) => { s.allMatching = e.target.checked; s.bigConfirmed = e.target.checked; if (e.target.checked) runPreview(); } }), `Yes, all ${fmtCount(n)} records`)));
  }

  function drawPreview(p, result) {
    previewBox.hidden = false;
    const tickable = s.mode === 'filter' && !s.ids.length;
    const ticked = new Set();
    const onlyTicked = h('button', { type: 'button', class: 'sm', disabled: true, onclick: () => { s.ids = [...ticked]; runPreview(); } }, 'Preview only the ticked records');
    previewBox.replaceChildren(h('div', { class: 'card stack' },
      h('p', {}, h('b', {}, p.headline)),
      p.cascade.length ? h('ul', { class: 'small plain' }, p.cascade.map((c) => h('li', {}, c))) : null,
      ...p.warnings.map((w) => h('p', { class: 'warn small' }, w)),
      p.big ? h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: s.bigConfirmed, onchange: (e) => { s.bigConfirmed = e.target.checked; update(); } }), `Yes, all ${fmtCount(result.matches)} records`) : null,
      p.samples.length ? h('div', { class: 'table-wrap' }, h('table', { 'aria-label': 'Sample records' },
        h('caption', { class: 'muted small cap' }, `${p.samples.length === result.matches ? 'Every record' : `${p.samples.length} of them`}${tickable ? ' (tick some to delete only those)' : ''}`),
        h('thead', {}, h('tr', {}, tickable ? h('th', {}, h('span', { class: 'sr-only' }, 'Tick')) : null, h('th', {}, 'Id'), h('th', {}, 'Fields'))),
        h('tbody', {}, p.samples.map((r) => h('tr', {},
          tickable ? h('td', { class: 'check-cell' }, h('input', { type: 'checkbox', 'aria-label': `Only ${r.id}`, onchange: (e) => {
            if (e.target.checked) ticked.add(r.id); else ticked.delete(r.id);
            onlyTicked.disabled = !ticked.size;
          } })) : null,
          h('td', { class: 'mono nowrap' }, r.id), h('td', { class: 'small clip-wide' }, recordSummary(r))))))) : null,
      tickable && p.samples.length ? onlyTicked : null,
      s.ids.length ? h('button', { type: 'button', class: 'link', onclick: () => { s.ids = []; runPreview(); } }, 'Back to every matching record') : null,
      h('p', { class: 'muted small' }, 'A snapshot of everything deleted is kept for 7 days, so it can be restored.')));
  }

  async function runClear() {
    const r = request();
    if (r.error) return;
    go.disabled = true;
    try {
      const result = await api('POST', `/api/projects/${slug}/data/clear`, r.body);
      toast(result.snapshot ? `Snapshot ${result.snapshot.id} saved` : 'Nothing deleted');
      done(h('div', {}, h('p', {}, h('b', {}, clearResultText(result))), result.snapshot ? copyChip(result.snapshot.id, { what: 'Snapshot id copied', label: 'Copy snapshot id' }) : null));
    } catch (ex) { err.textContent = ex.message; update(); }
  }

  syncAuthNote();
  update();
  return h('div', { class: 'stack data-form' },
    table, authNote,
    h('h3', {}, 'What to clear'), modes, filterBox,
    h('div', { class: 'row' }, previewBtn, h('span', { class: 'muted small' }, 'Nothing is deleted until you confirm below.')), err, previewBox,
    h('h3', {}, 'Confirm'), confirmBox);
}

function snapshotsTable(snaps, { done }) {
  if (!snaps.length) return h('p', { class: 'muted small' }, 'No snapshots. Each clear keeps one for 7 days.');
  const panel = h('div', { class: 'restore', role: 'region', 'aria-label': 'Restore', hidden: true });
  const restore = async (snap, overwrite = false) => {
    panel.hidden = false;
    panel.replaceChildren(h('p', { class: 'muted small' }, 'Checking the snapshot against the app…'));
    try {
      const m = restoreModel(await api('POST', `/api/snapshots/${snap.id}/restore`, { dry_run: true, overwrite }));
      const go = h('button', { type: 'button', class: 'primary', disabled: Boolean(m.blocked), onclick: async () => {
        if (!confirm(`Restore ${snap.id}? ${m.headline}`)) return;
        go.disabled = true;
        try {
          const r = await api('POST', `/api/snapshots/${snap.id}/restore`, { overwrite });
          toast('Restored');
          done(h('div', { class: 'stack' }, h('p', {}, h('b', {}, restoreResultText(r))),
            r.accounts.length ? h('div', { class: 'table-wrap' }, h('p', { class: 'warn small' }, 'These accounts have new passwords. Tell each person theirs; it is not shown again.'),
              h('table', { 'aria-label': 'New passwords' }, h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', {}, 'New password'))),
                h('tbody', {}, r.accounts.map((a) => h('tr', {}, h('td', {}, a.email || a.id), h('td', { class: 'mono' }, a.password)))))) : null));
        } catch (ex) { toast(ex.message); go.disabled = false; }
      } }, `Restore ${snap.id}`);
      panel.replaceChildren(h('div', { class: 'card stack' },
        h('div', { class: 'spread' }, h('b', {}, `Restore ${snap.id}`), h('button', { type: 'button', class: 'link', onclick: () => { panel.hidden = true; } }, 'Close')),
        h('p', {}, m.headline),
        m.drift.length ? h('ul', { class: 'small plain' }, m.drift.map((d) => h('li', {}, d))) : h('p', { class: 'muted small' }, 'No schema changes since the snapshot.'),
        ...m.warnings.map((w) => h('p', { class: 'warn small' }, w)),
        m.blocked ? h('p', { class: 'error' }, m.blocked) : null,
        h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: overwrite, onchange: (e) => restore(snap, e.target.checked) }), 'Overwrite records that exist again (they are saved in a new snapshot first)'),
        h('div', { class: 'row' }, go)));
    } catch (ex) { panel.replaceChildren(h('p', { class: 'error' }, ex.message)); }
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'Snapshots' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Snapshot'), h('th', {}, 'What'), h('th', { class: 'hide-sm' }, 'By'), h('th', { class: 'hide-sm' }, 'Expires'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))),
      h('tbody', {}, snaps.map((snap) => {
        const rule = purgeRule(snap, state.me);
        return h('tr', { 'aria-label': snap.id },
          h('td', {}, h('span', { class: 'mono small' }, snap.id), h('div', { class: 'muted tiny' }, ago(snap.created))),
          h('td', { class: 'small' }, `${snap.mode} ${snap.collections.map((c) => c.name).join(', ')}`, h('div', { class: 'muted tiny' }, `${fmtCount(snap.records)} records${snap.files_bytes ? ` · ${fmtBytes(snap.files_bytes)} files` : ''}`)),
          h('td', { class: 'small hide-sm' }, snap.by ?? '–', snap.by_admin ? h('span', { class: 'badge', style: 'margin-left:6px' }, 'admin') : null, snap.reason ? h('div', { class: 'muted tiny' }, snap.reason) : null),
          h('td', { class: 'muted small hide-sm nowrap' }, snap.expires.slice(0, 10)),
          h('td', { class: 'actions' }, h('div', { class: 'row nowrap' },
            h('button', { type: 'button', class: 'sm', 'aria-label': `Restore ${snap.id}`, onclick: () => restore(snap) }, icon('undo'), 'Restore'),
            h('button', { type: 'button', class: 'sm danger', 'aria-label': `Purge ${snap.id}`, disabled: !rule.allowed, title: rule.why ?? 'Delete this snapshot now', onclick: async () => {
              if (!confirm(`Purge snapshot ${snap.id}? It can't be restored after this.`)) return;
              try { await api('DELETE', `/api/snapshots/${snap.id}`); toast(`Purged ${snap.id}`); done(null); } catch (ex) { toast(ex.message); }
            } }, 'Purge'))));
      })))),
    panel);
}
