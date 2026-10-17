// /admin[/<tab>]: the whole server. Overview (server-wide numbers, views chart, busiest apps and agents, disk),
// Users, Apps (old deploys, clear data, delete), Agents (seen across every user), Jobs, Settings (name, invites,
// limits, backup retention) and Storage (disk bar, per-app sizes, backups, snapshots). The tab is in the path so a
// reload keeps it; /admin/apps/<slug> is an admin clearing data of any app. Words and numbers come from
// js/admin-view.js (pure, unit-tested).
import { h, ago, fmtBytes, fmtCount, displayName, inviteText, jobState, updateNotice, versionLabel } from '../helpers.js';
import { activeAgents, backupDelete, diskBar, overviewKpis, purgeRule, restoreCommand, retentionText } from '../admin-view.js';
import { chartBuckets, timeTicks } from '../charts.js';
import { chartSummary } from '../app-view.js';
import { monogram } from '../feed.js';
import { ADMIN_TABS, adminPath, appPath } from '../routes.js';
import { state, api, rerender, SERVER } from '../session.js';
import { agentBadge, toast, copy, copyChip, pageHeader } from '../ui.js';
import { timeChart } from './chart-ui.js';
import { renderData } from './data.js';

const TAB_LABELS = { overview: 'Overview', users: 'Users', apps: 'Apps', agents: 'Agents', jobs: 'Jobs', settings: 'Settings', storage: 'Storage' };
const ACTIVITY_LIMIT = 500;

const kpiStrip = (items, label) => h('div', { class: `kpis n${items.length}`, role: 'list', 'aria-label': label }, items.map((k) => h('div', { role: 'listitem', class: k.alert ? 'alert' : null },
  h('span', { class: 'muted small' }, k.label), h('b', { class: 'num' }, k.value), k.sub ? h('span', { class: 'muted small' }, k.sub) : null)));
const save = (patch, done) => api('PATCH', '/api/admin/settings', patch).then((r) => { toast(done); return r; });
const sectionH = (title, link) => h('div', { class: 'sec-h' }, h('h3', {}, title), link ?? null);

// ---------- Overview ----------

function updateCard(update, s) {
  const n = updateNotice(update);
  return h('div', { class: 'card stack', role: 'region', 'aria-label': 'Updates' },
    h('div', { class: 'spread' },
      h('div', {}, n.kind === 'available' ? h('span', { class: 'badge accent' }, 'update') : null, ' ', h('b', {}, n.text)),
      n.url ? h('a', { href: n.url, target: '_blank', rel: 'noopener' }, 'Release notes ↗') : null),
    n.command ? h('div', {},
      h('p', { class: 'muted small' }, 'Run this on the server (a backup is taken first; data is kept):'),
      h('pre', {}, n.command),
      h('button', { onclick: () => copy(n.command, 'Command copied') }, 'Copy command')) : null,
    update?.reason === 'env' ? null : h('label', { class: 'check small' },
      h('input', { type: 'checkbox', checked: s.update_check, onchange: async (e) => {
        await save({ update_check: e.target.checked }, e.target.checked ? 'Update checks on' : 'Update checks off');
        rerender();
      } }),
      'Check for new Cubby releases once a day (asks GitHub; the only request Cubby itself makes)'));
}

function barEl(segments, label) {
  return h('div', { class: 'disk-bar', role: 'img', 'aria-label': label },
    segments.map((s) => h('span', { class: `seg-${s.key}`, style: `width:${(s.share * 100).toFixed(2)}%`, title: `${s.label}: ${fmtBytes(s.bytes)}` })));
}
const barLabel = (segments) => `Disk: ${segments.map((s) => `${s.label} ${fmtBytes(s.bytes)}`).join(', ')}`;
const legend = (segments) => h('ul', { class: 'legend' }, segments.map((s) => h('li', {}, h('span', { class: `sw seg-${s.key}`, 'aria-hidden': 'true' }), s.label, h('b', { class: 'num' }, fmtBytes(s.bytes)))));

async function overviewTab(body, { overview }) {
  const [m, activity] = await Promise.all([api('GET', '/api/admin/metrics?range=7d'), api('GET', `/api/admin/activity?limit=${ACTIVITY_LIMIT}`)]);
  const srv = overview.server;
  const { buckets, domain } = chartBuckets({ hours: m.hours ?? [], days: m.days ?? [] }, '7d');
  const agents = activeAgents(activity, { limit: 5 });
  const disk = h('div', { class: 'card stack' }, h('p', { class: 'muted small' }, 'Measuring…'));
  body.replaceChildren(
    kpiStrip(overviewKpis(m, srv), 'Server numbers'),
    h('div', { class: 'charts' }, timeChart({ id: 'c-admin-views', title: 'Views', sub: 'every app, per day', total: fmtCount(m.views), field: 'views', buckets, domain, markers: [], ticks: timeTicks(domain, '7d', 1000), range: '7d', summary: chartSummary('Views', buckets, 'views', '7d') })),
    h('div', { class: 'two-col' },
      h('section', { 'aria-label': 'Top apps' }, sectionH('Top apps · 7 days', h('a', { href: adminPath('apps') }, 'All apps')),
        m.top_apps.length ? h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'Top apps by views' },
          h('thead', {}, h('tr', {}, h('th', {}, 'App'), h('th', { class: 'hide-sm' }, 'Owner'), h('th', { class: 'r' }, 'Views'), h('th', { class: 'r' }, 'Now'))),
          h('tbody', {}, m.top_apps.slice(0, 5).map((a) => h('tr', {}, h('td', { class: 'mono' }, a.app), h('td', { class: 'muted hide-sm' }, a.owner ?? '–'),
            h('td', { class: 'r num' }, fmtCount(a.views)), h('td', { class: 'r num muted' }, a.active_now ? fmtCount(a.active_now) : '–'))))))
          : h('p', { class: 'muted small' }, 'No apps yet.')),
      h('section', { 'aria-label': 'Most active agents' }, sectionH('Most active agents · 30 days', h('a', { href: adminPath('agents') }, 'All agents')),
        agents.length ? h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'Most active agents' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Agent'), h('th', { class: 'hide-sm' }, 'Owner'), h('th', { class: 'r' }, 'Changes'))),
          h('tbody', {}, agents.map((a) => h('tr', {}, h('td', {}, h('div', { class: 'row nowrap' }, agentBadge(monogram(a.name)), a.name)), h('td', { class: 'muted hide-sm' }, a.user ?? '–'), h('td', { class: 'r num' }, fmtCount(a.actions)))))))
          : h('p', { class: 'muted small' }, 'No agent has changed anything in the last 30 days.'))),
    sectionH('Disk', h('a', { href: adminPath('storage') }, 'Storage')), disk,
    sectionH('Server'),
    h('div', { class: 'stack' }, updateCard(overview.update, overview.settings), h('div', { class: 'card small stack' },
      h('p', {}, `${versionLabel(srv.version)} · ${srv.public_url} · ${srv.https ? 'HTTPS' : 'HTTP only'}`),
      h('p', { class: 'muted' }, 'The database dashboard is reachable from the server only: ', h('code', {}, 'ssh -L 8090:127.0.0.1:8090 <server>'), ' then open http://localhost:8090/_/'))),
  );
  // The storage scan walks the data folder; it fills in when done.
  const storage = await api('GET', '/api/admin/storage');
  const segments = diskBar(storage);
  disk.replaceChildren(h('div', { class: 'spread' }, h('b', {}, `Cubby uses ${fmtBytes(storage.data_bytes)}`), h('span', { class: 'muted small' }, `${fmtBytes(storage.disk.free_bytes)} free of ${fmtBytes(storage.disk.total_bytes)}`)),
    barEl(segments, barLabel(segments)), legend(segments));
}

// ---------- Users ----------

async function usersTab(body) {
  const users = await api('GET', '/api/admin/users');
  body.replaceChildren(h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'Users' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Email'), h('th', { class: 'r' }, 'Apps'), h('th', { class: 'r hide-sm' }, 'Disk'), h('th', { class: 'hide-sm' }, 'Joined'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))),
    h('tbody', {}, users.map((u) => h('tr', {},
      h('td', {}, u.email, ' ', u.is_admin ? h('span', { class: 'badge accent' }, 'admin') : null, u.disabled ? h('span', { class: 'badge' }, 'disabled') : null),
      h('td', { class: 'r num' }, u.apps), h('td', { class: 'r num hide-sm' }, fmtBytes(u.disk_bytes)), h('td', { class: 'muted hide-sm' }, ago(u.created)),
      h('td', { class: 'actions' }, u.id === state.me.id ? null : h('div', { class: 'row nowrap' },
        h('button', { type: 'button', class: 'sm', onclick: async () => {
          await api('PATCH', `/api/admin/users/${u.id}`, { disabled: !u.disabled });
          toast(u.disabled ? 'User enabled' : 'User disabled — their apps stay online');
          rerender();
        } }, u.disabled ? 'Enable' : 'Disable'),
        h('button', { type: 'button', class: 'sm danger', onclick: async () => {
          if (prompt(`Delete ${u.email} and all ${u.apps} of their apps? Type their email to confirm:`) !== u.email) return;
          await api('DELETE', `/api/admin/users/${u.id}`);
          toast('User deleted');
          rerender();
        } }, 'Delete')))))))));
}

// ---------- Apps ----------

function deploysPanel(a, cell) {
  const draw = (deploys) => {
    const older = deploys.filter((d) => !d.current);
    cell.replaceChildren(h('div', { class: 'stack small' },
      h('div', { class: 'spread' }, h('span', { class: 'muted' }, older.length ? `${older.length} older deploy${older.length === 1 ? '' : 's'}, kept for rollback (${fmtBytes(older.reduce((n, d) => n + d.bytes, 0))} uploaded)` : 'No older deploys: only the live one.'),
        older.length ? h('button', { type: 'button', class: 'sm danger', onclick: async () => {
          if (!confirm(`Delete all ${older.length} older deploys of ${a.slug}? The live deploy stays; rolling back to these is no longer possible.`)) return;
          try { const r = await api('POST', `/api/admin/apps/${a.slug}/deploys/prune`, { keep: 0 }); toast(`Deleted ${r.deleted.length} deploys, freed ${fmtBytes(r.freed_bytes)}`); draw(r.deploys); } catch (ex) { toast(ex.message); }
        } }, 'Delete all older') : null),
      older.length ? h('table', { 'aria-label': `Older deploys of ${a.slug}` }, h('tbody', {}, older.map((d) => h('tr', {},
        h('td', { class: 'mono' }, d.id), h('td', { class: 'muted' }, d.message || '–'), h('td', { class: 'muted nowrap' }, ago(d.created)), h('td', { class: 'r num muted hide-sm' }, fmtBytes(d.bytes)),
        h('td', { class: 'actions' }, h('button', { type: 'button', class: 'sm danger', 'aria-label': `Delete deploy ${d.id}`, onclick: async () => {
          if (!confirm(`Delete deploy ${d.id} of ${a.slug}?`)) return;
          try { const r = await api('DELETE', `/api/admin/apps/${a.slug}/deploys/${d.id}`); toast(`Deleted ${d.id}, freed ${fmtBytes(r.freed_bytes)}`); draw(r.deploys); } catch (ex) { toast(ex.message); }
        } }, 'Delete')))))) : null));
  };
  cell.replaceChildren(h('p', { class: 'muted small' }, 'Loading…'));
  api('GET', `/api/admin/apps/${a.slug}/deploys`).then(draw, (ex) => toast(ex.message));
}

async function appsTab(body, { slug }) {
  const apps = await api('GET', '/api/admin/apps');
  if (slug) return appData(body, apps.find((a) => a.slug === slug), slug);
  if (!apps.length) return body.replaceChildren(h('div', { class: 'empty' }, 'No apps yet.'));
  body.replaceChildren(h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'All apps' },
    h('thead', {}, h('tr', {}, h('th', {}, 'App'), h('th', { class: 'hide-sm' }, 'Owner'), h('th', { class: 'r' }, 'Disk'), h('th', { class: 'hide-sm' }, 'Last deploy'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))),
    h('tbody', {}, apps.sort((a, b) => b.disk_bytes - a.disk_bytes).flatMap((a) => {
      const detail = h('td', { colspan: 5 });
      const detailRow = h('tr', { class: 'detail', hidden: true }, detail);
      const toggle = h('button', { type: 'button', class: 'sm', 'aria-expanded': 'false', onclick: () => {
        const open = detailRow.hidden;
        detailRow.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) deploysPanel(a, detail);
      } }, 'Deploys');
      return [h('tr', {},
        h('td', {}, h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.slug), a.unlisted ? h('span', { class: 'badge', style: 'margin-left:6px' }, 'unlisted') : null,
          h('div', { class: 'muted tiny show-sm' }, a.owner)),
        h('td', { class: 'muted hide-sm' }, a.owner), h('td', { class: 'r num' }, fmtBytes(a.disk_bytes)), h('td', { class: 'muted hide-sm' }, ago(a.last_deployed)),
        h('td', { class: 'actions' }, h('div', { class: 'row nowrap' }, toggle,
          h('a', { class: 'btn sm', href: adminPath('apps', a.slug) }, 'Clear data'),
          h('button', { type: 'button', class: 'sm danger', onclick: async () => {
            if (prompt(`Delete ${a.slug} (owned by ${a.owner}), its data and deploys? Type the app name to confirm:`) !== a.slug) return;
            await api('DELETE', `/api/admin/apps/${a.slug}`);
            toast(`Deleted ${a.slug}`);
            rerender();
          } }, 'Delete')))), detailRow];
    })))));
}

async function appData(body, a, slug) {
  const back = h('a', { class: 'back', href: adminPath('apps') }, '← All apps');
  if (!a) return body.replaceChildren(back, h('div', { class: 'empty' }, `There's no app called ${slug}.`));
  const mine = a.owner === state.me.email;
  const panel = h('div');
  body.replaceChildren(back,
    h('div', { class: 'page-h' }, h('h2', { class: 'mono' }, a.slug), h('span', { class: 'muted' }, `owned by ${a.owner}`),
      mine ? h('a', { class: 'page-actions', href: appPath(a.slug, 'data') }, 'Open your Data tab') : null),
    mine ? null : h('p', { class: 'muted small' }, `This app isn't yours: clearing its data needs a reason. ${a.owner} sees it on their app and in their activity, with the snapshot to restore.`),
    panel);
  await renderData(panel, { slug: a.slug, needsReason: !mine });
}

// ---------- Agents ----------

async function agentsTab(body) {
  const activity = await api('GET', `/api/admin/activity?limit=${ACTIVITY_LIMIT}`);
  const agents = activeAgents(activity);
  body.replaceChildren(
    h('p', { class: 'muted small' }, 'Agents that changed something in the last 30 days, across every user. Owners rename and revoke their agents on their own Agents page; disabling a user stops all of theirs.'),
    agents.length ? h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'Agents on this server' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Agent'), h('th', {}, 'Owner'), h('th', { class: 'r' }, 'Changes'), h('th', { class: 'hide-sm' }, 'Apps'), h('th', {}, 'Last seen'))),
      h('tbody', {}, agents.map((a) => h('tr', { 'aria-label': a.name },
        h('td', {}, h('div', { class: 'row nowrap' }, agentBadge(monogram(a.name)), h('b', {}, a.name))),
        h('td', { class: 'muted' }, a.user ?? '–'), h('td', { class: 'r num' }, fmtCount(a.actions)),
        h('td', { class: 'mono small hide-sm' }, a.apps.slice(0, 3).join(', '), a.apps.length > 3 ? h('span', { class: 'muted' }, ` +${a.apps.length - 3}`) : null),
        h('td', { class: 'muted nowrap' }, ago(a.last)))))))
      : h('div', { class: 'empty' }, 'No agent has changed anything in the last 30 days.'));
}

// ---------- Jobs ----------

async function jobsTab(body, { overview }) {
  const s = overview.settings;
  const jobs = await api('GET', '/api/admin/jobs');
  body.replaceChildren(
    h('h3', {}, `Scheduled jobs (${jobs.length})`),
    h('div', { class: 'card stack' },
      h('label', { class: 'check small' },
        h('input', { type: 'checkbox', checked: s.jobs, onchange: async (e) => {
          await save({ jobs: e.target.checked }, e.target.checked ? 'Jobs will run on schedule' : 'All jobs stopped');
          rerender();
        } }),
        'Run scheduled jobs (turn off to stop every app\'s jobs at once)'),
      h('form', { class: 'row', onsubmit: async (e) => {
        e.preventDefault();
        try { await save({ job_timeout_s: Number(new FormData(e.target).get('job_timeout_s')) }, 'Time limit saved'); } catch (ex) { toast(ex.message); }
      } },
        h('label', { class: 'small' }, 'Time limit per run (seconds)', h('input', { type: 'number', name: 'job_timeout_s', min: 5, max: 290, value: s.job_timeout_s, style: 'width:110px;display:block' })),
        h('button', { type: 'submit', style: 'align-self:flex-end' }, 'Save'))),
    jobs.length ? h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'Jobs' },
      h('thead', {}, h('tr', {}, h('th', {}, 'App'), h('th', {}, 'Job'), h('th', { class: 'hide-sm' }, 'Schedule (UTC)'), h('th', {}, 'Last run'))),
      h('tbody', {}, jobs.map((j) => {
        const st = jobState(j);
        return h('tr', {},
          h('td', {}, j.app, h('div', { class: 'muted small' }, j.owner)), h('td', { class: 'mono' }, j.name), h('td', { class: 'mono hide-sm' }, j.schedule),
          h('td', {}, h('span', { class: `badge ${st.kind}` }, st.text), ' ', h('span', { class: 'muted small' }, j.last_run ? ago(j.last_run.started) : '')));
      }))))
      : h('p', { class: 'muted small' }, 'No app has jobs yet. Apps add them in cubby/jobs/.'));
}

// ---------- Settings ----------

function retentionCard(s) {
  const estimate = h('p', { class: 'small', 'aria-live': 'polite' }, '…');
  const input = h('input', { type: 'number', name: 'backup_keep', min: 1, max: 90, value: s.backup_keep, style: 'width:110px;display:block' });
  let last = null;
  let timer;
  const check = async () => {
    const keep = Number(input.value);
    if (!Number.isInteger(keep) || keep < 1 || keep > 90) { estimate.textContent = 'Keep between 1 and 90 nightly backups.'; return null; }
    try {
      last = (await api('GET', `/api/admin/backups?keep=${keep}`)).estimate;
      const t = retentionText(last);
      estimate.className = `small${t.kind === 'frees' ? ' warn' : ''}`;
      estimate.textContent = t.text;
    } catch (ex) { estimate.textContent = ex.message; }
    return last;
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(check, 250); });
  check();
  return h('div', { class: 'card stack' },
    h('p', { class: 'muted small' }, 'A backup runs every night (the database and every site). Older ones are deleted as whole pairs; restore one with ', h('code', {}, 'sudo cubby-server restore <date>'), '.'),
    h('form', { class: 'row', onsubmit: async (e) => {
      e.preventDefault();
      const est = await check();
      if (!est) return;
      if (est.delete.length && !confirm(`${retentionText(est).text} Save?`)) return;
      try { await save({ backup_keep: Number(input.value) }, 'Backup retention saved'); } catch (ex) { toast(ex.message); }
    } },
      h('label', { class: 'small' }, 'Nightly backups to keep', input),
      h('button', { type: 'submit', style: 'align-self:flex-end' }, 'Save retention')),
    estimate);
}

async function settingsTab(body, { overview }) {
  const s = overview.settings;
  const invite = inviteText(SERVER, s.signup_code, s.server_name);
  const nameForm = h('form', { class: 'row', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await save({ server_name: new FormData(e.target).get('server_name') }, 'Server name saved');
      state.info.name = r.server_name;
      document.title = displayName(state.info.name);
      rerender();
    } catch (ex) { toast(ex.message); }
  } },
    h('input', { type: 'text', name: 'server_name', value: s.server_name, maxlength: 60, required: true, 'aria-label': 'Server name', style: 'flex:1;min-width:0' }),
    h('button', { type: 'submit' }, 'Save name'));
  const limitsForm = h('form', { class: 'row', onsubmit: async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    try { await save({ max_apps_per_user: Number(d.max_apps_per_user), max_deploy_mb: Number(d.max_deploy_mb) }, 'Limits saved'); } catch (ex) { toast(ex.message); }
  } },
    h('label', { class: 'small' }, 'Apps per user', h('input', { type: 'number', name: 'max_apps_per_user', min: 1, value: s.max_apps_per_user, style: 'width:110px;display:block' })),
    h('label', { class: 'small' }, 'Max deploy (MB)', h('input', { type: 'number', name: 'max_deploy_mb', min: 1, value: s.max_deploy_mb, style: 'width:110px;display:block' })),
    h('button', { type: 'submit', style: 'align-self:flex-end' }, 'Save limits'));
  body.replaceChildren(
    h('h3', {}, 'Server name'),
    h('div', { class: 'card stack' }, h('p', { class: 'muted small' }, 'Shown to everyone on the dashboard, the sign-in page and when connecting an agent.'), nameForm),
    h('h3', {}, 'Invite people'),
    h('div', { class: 'card stack' },
      h('div', { class: 'spread' },
        h('div', {}, h('span', { class: 'muted small' }, 'Signup code '), h('code', { class: 'mono', style: 'font-size:15px', 'aria-label': 'Current signup code' }, s.signup_code)),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => copy(invite, 'Invite copied') }, 'Copy invite'),
          h('button', { onclick: async () => {
            if (!confirm('Rotate the signup code? The current code stops working for new signups.')) return;
            await save({ rotate_code: true }, 'New code generated');
            rerender();
          } }, 'Rotate code'))),
      h('label', { class: 'check small' },
        h('input', { type: 'checkbox', checked: s.open_signup, onchange: (e) => save({ open_signup: e.target.checked }, e.target.checked ? 'Anyone with the URL can sign up' : 'Signup code required') }),
        'Open signup (no code needed — anyone with the URL can join)')),
    h('h3', {}, 'Limits'),
    h('div', { class: 'card' }, limitsForm),
    h('h3', {}, 'Backups'),
    retentionCard(s));
}

// ---------- Storage ----------

async function storageTab(body) {
  const [storage, b] = await Promise.all([api('GET', '/api/admin/storage'), api('GET', '/api/admin/backups')]);
  const segments = diskBar(storage);
  const withSnaps = storage.apps.filter((a) => a.snapshots_bytes > 0);
  const snaps = (await Promise.all(withSnaps.map((a) => api('GET', `/api/snapshots?app=${a.slug}`).catch(() => [])))).flat().sort((x, y) => (x.created < y.created ? 1 : -1));
  const running = b.running;

  const backUp = h('button', { type: 'button', class: 'primary', disabled: Boolean(running), onclick: async () => {
    backUp.disabled = true;
    try {
      await api('POST', '/api/admin/backups');
      toast('Backup started');
      await waitForBackup();
      toast('Backup done');
    } catch (ex) { toast(ex.message); }
    rerender();
  } }, running ? 'Backing up…' : 'Back up now');

  body.replaceChildren(
    h('div', { class: 'card stack' },
      h('div', { class: 'spread' }, h('b', {}, `Cubby uses ${fmtBytes(storage.data_bytes)}`),
        h('span', { class: 'muted small' }, `${fmtBytes(storage.disk.free_bytes)} free of ${fmtBytes(storage.disk.total_bytes)} · measured ${ago(storage.computed_at)}`)),
      barEl(segments, barLabel(segments)), legend(segments)),

    sectionH(`Backups (${b.backups.length})`),
    h('div', { class: 'card stack', role: 'region', 'aria-label': 'Backups' },
      h('div', { class: 'spread' },
        h('p', { class: 'muted small' }, `Nightly, keeping ${b.keep} (`, h('a', { href: adminPath('settings') }, 'change'), `). ${b.last ? `Last ${b.last.ok ? 'finished' : 'failed'} ${ago(b.last.finished_at)}${b.last.error ? `: ${b.last.error}` : ''}.` : ''}`),
        backUp),
      b.backups.length ? h('div', { class: 'table-wrap' }, h('table', { 'aria-label': 'Backup list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', { class: 'r hide-sm' }, 'Database'), h('th', { class: 'r hide-sm' }, 'Sites'), h('th', { class: 'r' }, 'Total'), h('th', { class: 'hide-sm' }, 'Restore on the server'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))),
        h('tbody', {}, b.backups.map((x, i) => h('tr', { 'aria-label': x.date },
          h('td', { class: 'nowrap' }, h('span', { class: 'mono' }, x.date), i === 0 ? h('span', { class: 'badge ok', style: 'margin-left:6px' }, 'newest') : null, x.complete ? null : h('span', { class: 'badge danger', style: 'margin-left:6px' }, 'half')),
          h('td', { class: 'r num muted hide-sm' }, x.db_bytes === null ? '–' : fmtBytes(x.db_bytes)), h('td', { class: 'r num muted hide-sm' }, x.sites_bytes === null ? '–' : fmtBytes(x.sites_bytes)),
          h('td', { class: 'r num' }, fmtBytes(x.total_bytes)),
          h('td', { class: 'hide-sm' }, copyChip(restoreCommand(x.date), { what: 'Command copied', label: 'Copy restore command' })),
          h('td', { class: 'actions' }, h('button', { type: 'button', class: 'sm danger', 'aria-label': `Delete backup ${x.date}`, disabled: Boolean(running), onclick: async () => {
            const g = backupDelete(b.backups, x.date, { running: Boolean(running) });
            if (g.blocked) return toast(g.blocked);
            if (!confirm(g.confirm)) return;
            try {
              const r = await api('DELETE', `/api/admin/backups/${x.date}${g.leaveNone ? '?leave_none=1' : ''}`);
              toast(`Deleted backup ${x.date}, freed ${fmtBytes(x.total_bytes)}`);
              if (r.warning) setTimeout(() => toast(r.warning), 1900);
              rerender();
            } catch (ex) { toast(ex.message); }
          } }, 'Delete')))))))
        : h('p', { class: 'muted small' }, 'No backups yet. The first runs tonight, or now with Back up now.'),
      b.backups.length ? h('p', { class: 'muted small show-sm' }, 'Restore with ', h('code', {}, 'sudo cubby-server restore <date>'), ' on the server.') : null),

    sectionH('Apps by size'),
    storage.apps.length ? h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'Apps by size' },
      h('thead', {}, h('tr', {}, h('th', {}, 'App'), h('th', { class: 'r hide-sm' }, 'Live deploy'), h('th', { class: 'r' }, 'Old deploys'), h('th', { class: 'r hide-sm' }, 'Uploads'), h('th', { class: 'r hide-sm' }, 'Snapshots'), h('th', { class: 'r' }, 'Total'))),
      h('tbody', {}, storage.apps.map((a) => h('tr', {},
        h('td', {}, h('a', { href: adminPath('apps'), class: 'mono' }, a.slug), h('div', { class: 'muted tiny' }, a.owner ?? '')),
        h('td', { class: 'r num muted hide-sm' }, fmtBytes(a.current_deploy_bytes)), h('td', { class: 'r num muted' }, fmtBytes(a.older_deploys_bytes)),
        h('td', { class: 'r num muted hide-sm' }, fmtBytes(a.uploads_bytes)), h('td', { class: 'r num muted hide-sm' }, fmtBytes(a.snapshots_bytes)),
        h('td', { class: 'r num' }, h('b', {}, fmtBytes(a.total_bytes))))))))
      : h('p', { class: 'muted small' }, 'No apps yet.'),
    h('p', { class: 'muted small' }, 'Old deploys are kept for rollback; delete them per app under ', h('a', { href: adminPath('apps') }, 'Apps → Deploys'), '.'),

    sectionH(`Snapshots (${snaps.length})`),
    h('p', { class: 'muted small' }, 'Kept 7 days after each data clear, so the owner can restore. Purging frees the space now.'),
    snaps.length ? h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'All snapshots' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Snapshot'), h('th', {}, 'App'), h('th', { class: 'hide-sm' }, 'By'), h('th', { class: 'r hide-sm' }, 'Records'), h('th', { class: 'hide-sm' }, 'Expires'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))),
      h('tbody', {}, snaps.map((x) => h('tr', { 'aria-label': x.id },
        h('td', {}, h('span', { class: 'mono small' }, x.id)), h('td', { class: 'mono' }, x.app),
        h('td', { class: 'small hide-sm' }, x.by ?? '–', x.by_admin ? h('span', { class: 'badge', style: 'margin-left:6px' }, 'admin') : null),
        h('td', { class: 'r num hide-sm' }, fmtCount(x.records)), h('td', { class: 'muted hide-sm nowrap' }, x.expires.slice(0, 10)),
        h('td', { class: 'actions' }, h('button', { type: 'button', class: 'sm danger', 'aria-label': `Purge ${x.id}`, disabled: !purgeRule(x, state.me).allowed, onclick: async () => {
          if (!confirm(`Purge snapshot ${x.id} of ${x.app}? Its owner can't restore it after this.`)) return;
          try { await api('DELETE', `/api/snapshots/${x.id}`); toast(`Purged ${x.id}`); rerender(); } catch (ex) { toast(ex.message); }
        } }, 'Purge')))))))
      : h('p', { class: 'muted small' }, 'No snapshots.'),
  );
}

async function waitForBackup() {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const b = await api('GET', '/api/admin/backups');
    if (!b.running) {
      if (b.last && !b.last.ok) throw new Error(`Backup failed: ${b.last.error}`);
      return;
    }
  }
}

const TABS = { overview: overviewTab, users: usersTab, apps: appsTab, agents: agentsTab, jobs: jobsTab, settings: settingsTab, storage: storageTab };

export async function renderAdmin(el, route) {
  const tab = route?.tab ?? 'overview';
  const body = h('div', { class: 'tab-body', role: 'region', 'aria-label': TAB_LABELS[tab] }, h('p', { class: 'muted' }, 'Loading…'));
  const header = pageHeader('Admin');
  el.replaceChildren(header,
    h('nav', { class: 'app-tabs', 'aria-label': 'Admin sections' }, ADMIN_TABS.map((t) => h('a', { href: adminPath(t), 'aria-current': t === tab ? 'page' : false }, TAB_LABELS[t]))),
    body);
  el.querySelector('.app-tabs [aria-current=page]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  const overview = await api('GET', '/api/admin/overview');
  header.append(h('span', { class: 'muted' }, overview.server.public_url));
  await TABS[tab](body, { overview, slug: route?.slug });
}
