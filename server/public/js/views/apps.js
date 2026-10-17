// /apps: the signed-in user's apps, one row each with who's on it now, a 7-day views sparkline and who deployed it
// last. /apps/:slug[/<tab>]: one app, with Overview (charts), Activity, Deploys, Jobs, Env and Settings tabs; the tab
// is in the path so a reload or a shared link keeps it.
import { h, ago, fmtBytes, fmtCount, jobState } from '../helpers.js';
import { emptyPrompt, lastDeployers, monogram } from '../feed.js';
import { chartBuckets, deployMarkers, timeTicks } from '../charts.js';
import { RANGES, chartSummary, kpis, rangeFrom, topPathRows } from '../app-view.js';
import { APP_TABS, appPath } from '../routes.js';
import { api, rerender } from '../session.js';
import { navigate } from '../router.js';
import { agentBadge, askAgent, copy, icon, pageHeader, toast } from '../ui.js';
import { timeline } from './feed-ui.js';
import { sparkSvg, timeChart } from './chart-ui.js';

export const noAppsYet = () => h('div', { class: 'empty' }, 'No apps yet. Run ', h('code', {}, 'cubby init my-app'), ' to create one.');

const byLine = (actor) => (actor ? [' by ', agentBadge(actor.mono), ' ', actor.href ? h('a', { href: actor.href }, actor.name) : actor.name] : []);

// ---------- /apps ----------

export async function renderApps(el) {
  const list = h('p', { class: 'muted' }, 'Loading…');
  const header = pageHeader('Apps');
  el.replaceChildren(header, list);
  const [apps, activity, keys] = await Promise.all([api('GET', '/api/projects'), api('GET', '/api/activity?limit=200'), api('GET', '/api/agents')]);
  header.append(h('span', { class: 'muted' }, String(apps.length)));
  if (!apps.length) return list.replaceWith(noAppsYet());
  const deployers = lastDeployers(activity, keys);
  const cells = new Map(); // slug → { active, views }
  list.replaceWith(h('div', { class: 'card table-wrap' }, h('table', { class: 'apps-table', 'aria-label': 'Your apps' },
    h('thead', {}, h('tr', {}, h('th', {}, 'App'), h('th', { class: 'r' }, 'Active now'), h('th', {}, 'Views · 7 days'), h('th', { class: 'hide-sm' }, 'Last deploy'), h('th', { class: 'hide-sm' }, h('span', { class: 'sr-only' }, 'Open')))),
    h('tbody', {}, apps.map((a) => {
      const active = h('td', { class: 'r num muted' }, '…');
      const views = h('td', { class: 'views-cell' }, h('span', { class: 'muted' }, '…'));
      cells.set(a.slug, { active, views });
      return h('tr', { 'aria-label': a.name },
        h('td', {}, h('a', { class: 'app-name', href: appPath(a.slug) }, a.name), a.unlisted ? h('span', { class: 'badge', style: 'margin-left:6px' }, 'unlisted') : null,
          a.description ? h('div', { class: 'muted small clip' }, a.description) : null),
        active, views,
        h('td', { class: 'muted hide-sm', 'data-col': 'deploy' }, a.current_deploy ? [`Deployed ${ago(a.last_deployed)}`, ...byLine(deployers[a.slug])] : 'Not deployed yet'),
        h('td', { class: 'r hide-sm' }, a.current_deploy ? h('a', { href: a.url, target: '_blank', rel: 'noopener', 'aria-label': `Open ${a.name}` }, 'Open ↗') : null));
    })))));
  // Metrics fill in once they arrive.
  await Promise.all(apps.map(async (a) => {
    const c = cells.get(a.slug);
    try {
      const m = await api('GET', `/api/projects/${a.slug}/metrics?range=7d`);
      c.active.replaceChildren(m.active_now ? h('span', { class: 'live-n' }, h('span', { class: 'dot live', 'aria-hidden': 'true' }), fmtCount(m.active_now)) : '–');
      const days = m.days.slice(-7).map((d) => d.views);
      c.views.replaceChildren(h('span', { class: 'num' }, fmtCount(m.views)), sparkSvg(days, { w: 96, h: 22, label: `${a.name} views per day: ${days.join(', ')}` }));
    } catch { c.active.textContent = '–'; c.views.textContent = '–'; }
  }));
}

// ---------- /apps/:slug ----------

const TAB_LABELS = { overview: 'Overview', activity: 'Activity', deploys: 'Deploys', jobs: 'Jobs', env: 'Env', settings: 'Settings' };

function tabsNav(a, tab, counts) {
  return h('nav', { class: 'app-tabs', 'aria-label': 'App sections' }, APP_TABS.map((t) => h('a', { href: appPath(a.slug, t), 'aria-current': t === tab ? 'page' : false },
    TAB_LABELS[t], counts[t] != null ? h('span', { class: 'count' }, String(counts[t])) : null)));
}

const empty = (text, tab, a) => h('div', { class: 'empty' }, h('p', {}, text), askAgent(emptyPrompt(tab, a)));

async function overviewTab(a, body) {
  const range = rangeFrom(location.search);
  const [m, deploys] = await Promise.all([api('GET', `/api/projects/${a.slug}/metrics?range=${range}`), api('GET', `/api/projects/${a.slug}/deploys`)]);
  const { buckets, domain } = chartBuckets(m, range);
  const markers = deployMarkers(deploys, domain, 1000);
  const ticks = timeTicks(domain, range, 1000);
  const common = { buckets, domain, markers, ticks, range };
  const strip = h('div', { class: 'kpis', role: 'list', 'aria-label': 'Key numbers' }, kpis(m, range).map((k) => h('div', { role: 'listitem', class: k.alert ? 'alert' : null },
    h('span', { class: 'muted small' }, k.label), h('b', { class: 'num' }, k.value), k.sub ? h('span', { class: 'muted small' }, k.sub) : null)));
  const ranges = h('div', { class: 'seg', role: 'group', 'aria-label': 'Range' }, RANGES.map((r) => h('a', { href: `${appPath(a.slug)}?range=${r}`, 'aria-current': r === range ? 'true' : false }, r)));
  const paths = topPathRows(m);
  const chartsList = [
    timeChart({ ...common, id: 'c-views', title: 'Views', total: fmtCount(m.views), field: 'views', summary: chartSummary('Views', buckets, 'views', range) }),
    range === '24h'
      ? h('section', { class: 'chart note' }, h('div', { class: 'chart-h' }, h('h4', {}, 'Unique visitors'), h('b', { class: 'num' }, fmtCount(m.visitors))),
        h('p', { class: 'muted small' }, 'Visitors are counted per day, so the chart shows for 7 and 30 days. ', h('a', { href: `${appPath(a.slug)}?range=7d` }, 'Show 7 days')))
      : timeChart({ ...common, id: 'c-visitors', title: 'Unique visitors', sub: 'per day', total: fmtCount(m.visitors), field: 'visitors', summary: chartSummary('Unique visitors', buckets, 'visitors', range) }),
    timeChart({ ...common, id: 'c-active', title: 'Peak active visitors', sub: `now ${fmtCount(m.active_now)}`, total: fmtCount(m.peak_active), field: 'peak', summary: chartSummary('Peak active visitors', buckets, 'peak', range, { total: false }) }),
    timeChart({ ...common, id: 'c-errors', kind: 'bar', title: 'API errors', sub: 'server errors from /pb', total: fmtCount(m.api_errors), field: 'errors', summary: chartSummary('API errors', buckets, 'errors', range) }),
  ];
  const pathsSection = paths ? [h('h3', {}, 'Top paths'), paths.length
    ? h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'Top paths' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Path'), h('th', { class: 'r' }, 'Views'))),
      h('tbody', {}, paths.map((p) => h('tr', {}, h('td', {}, h('div', { class: 'path-bar', style: `--share:${(p.share * 100).toFixed(1)}%` }, h('span', { class: 'mono' }, p.path))), h('td', { class: 'r num' }, fmtCount(p.views)))))))
    : h('p', { class: 'muted small' }, 'No page views in this range yet.')] : [];
  body.replaceChildren(...[
    h('div', { class: 'spread overview-h' }, h('p', { class: 'muted small' }, 'Every chart shares one time axis; dashed lines are deploys.'), ranges),
    strip,
    a.current_deploy || m.views ? null : empty('Nothing to chart yet: this app has no deploy.', 'overview', a),
    h('div', { class: 'charts' }, chartsList),
    ...pathsSection,
  ].filter(Boolean));
}

async function activityTab(a, body) {
  const [rows, keys, apps] = await Promise.all([api('GET', `/api/activity?app=${a.slug}&limit=200`), api('GET', '/api/agents'), api('GET', '/api/projects')]);
  body.replaceChildren(rows.length ? timeline(rows, { apps, agents: keys, showApp: false, label: `Activity of ${a.name}`, onChange: rerender })
    : empty('No changes in the last 30 days.', 'activity', a));
}

async function rollTo(a, d, label) {
  if (!confirm(`Make ${label} of ${a.slug} live again? Data and secrets stay as they are.`)) return;
  await api('POST', `/api/projects/${a.slug}/rollback`, { deploy: d.id });
  toast(`Rolled back ${a.slug} to ${label}`);
  rerender();
}

async function deploysTab(a, body) {
  const deploys = await api('GET', `/api/projects/${a.slug}/deploys`);
  if (!deploys.length) return body.replaceChildren(empty('No deploys yet.', 'deploys', a));
  body.replaceChildren(
    h('p', { class: 'muted small' }, 'Rolling back serves an earlier deploy again, with the jobs it shipped. Data and secrets are not rolled back.'),
    h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'Deploys' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Deploy'), h('th', {}, 'Message'), h('th', { class: 'hide-sm' }, 'From'), h('th', { class: 'hide-sm r' }, 'Size'), h('th', {}, 'When'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))),
      h('tbody', {}, deploys.map((d, i) => {
        const label = `v${deploys.length - i}`;
        return h('tr', { 'aria-label': label },
          h('td', { class: 'nowrap' }, h('b', { class: 'mono' }, label), ' ', d.current ? h('span', { class: 'badge ok' }, 'live') : null, h('div', { class: 'muted mono tiny' }, d.id)),
          h('td', {}, d.message || h('span', { class: 'muted' }, '–')),
          h('td', { class: 'muted hide-sm' }, d.client || '–'),
          h('td', { class: 'muted hide-sm r' }, `${d.files} files · ${fmtBytes(d.bytes)}`),
          h('td', { class: 'muted nowrap' }, ago(d.created)),
          h('td', { class: 'r' }, d.current ? null : h('button', { type: 'button', class: 'sm', 'aria-label': `Roll back to ${label}`, onclick: () => rollTo(a, d, label).catch((ex) => toast(ex.message)) }, icon('undo'), 'Roll back to this')));
      })))));
}

async function jobsTab(a, body) {
  const draw = async () => {
    const jobs = await api('GET', `/api/projects/${a.slug}/jobs`);
    if (!jobs.length) return body.replaceChildren(empty('No scheduled jobs. Jobs live in cubby/jobs/ and ship with each deploy.', 'jobs', a));
    body.replaceChildren(h('div', { class: 'stack' }, jobs.map((j) => {
      const st = jobState(j);
      const log = h('pre', { hidden: true });
      return h('div', { class: 'card stack small job', role: 'group', 'aria-label': `Job ${j.name}` },
        h('div', {}, h('b', { class: 'mono' }, j.name), ' ', h('span', { class: `badge ${st.kind}` }, st.text)),
        h('p', { class: 'muted' }, h('span', { class: 'mono' }, j.schedule), ' UTC · ', j.last_run ? `last run ${ago(j.last_run.started)}` : 'never run',
          j.next_run ? ` · next ${new Date(j.next_run).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : ''),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'sm', onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              const r = await api('POST', `/api/projects/${a.slug}/jobs/${j.name}/run`);
              toast(`${j.name}: ${r.status}`);
              await draw();
            } catch (ex) { toast(ex.message); btn.disabled = false; }
          } }, 'Run now'),
          h('button', { type: 'button', class: 'sm', onclick: async () => {
            await api('PATCH', `/api/projects/${a.slug}/jobs/${j.name}`, { paused: !j.paused });
            toast(j.paused ? `${j.name} resumed` : `${j.name} paused`);
            await draw();
          } }, j.paused ? 'Resume' : 'Pause'),
          j.last_run ? h('button', { type: 'button', class: 'link', onclick: async () => {
            if (log.hidden) log.textContent = (await api('GET', `/api/projects/${a.slug}/jobs/${j.name}/runs?limit=1`))[0]?.log || '(no output)';
            log.hidden = !log.hidden;
          } }, 'Last log') : null),
        log);
    })));
  };
  await draw();
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

async function envTab(a, body) {
  const vars = await api('GET', `/api/projects/${a.slug}/env`);
  const err = h('p', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'env-form', onsubmit: async (e) => {
    e.preventDefault();
    const { key, value } = Object.fromEntries(new FormData(form));
    err.textContent = '';
    if (!ENV_NAME.test(key)) { err.textContent = 'Names are UPPER_CASE letters, digits and underscores.'; return; }
    const exists = vars.some((v) => v.key === key);
    if (exists && !confirm(`Replace the value of ${key}? The old value can't be recovered.`)) return;
    try {
      await api('PUT', `/api/projects/${a.slug}/env/${key}`, { value });
      toast(`${exists ? 'Changed' : 'Added'} ${key}`);
      rerender();
    } catch (ex) { err.textContent = ex.message; }
  } },
    h('label', {}, h('span', { class: 'small muted' }, 'Name'), h('input', { type: 'text', name: 'key', required: true, placeholder: 'RESEND_API_KEY', autocomplete: 'off', spellcheck: 'false', class: 'mono' })),
    h('label', {}, h('span', { class: 'small muted' }, 'Value'), h('input', { type: 'password', name: 'value', required: true, autocomplete: 'new-password' })),
    h('button', { type: 'submit', class: 'primary' }, 'Save secret'));
  body.replaceChildren(
    h('p', { class: 'muted small' }, 'Secrets for this app\'s jobs, read as ', h('code', {}, 'env.NAME'), '. Values are encrypted and never shown again, here or anywhere else.'),
    vars.length ? h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'Secrets' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Value'), h('th', {}, 'Updated'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))),
      h('tbody', {}, vars.map((v) => h('tr', { 'aria-label': v.key },
        h('td', { class: 'mono' }, v.key), h('td', { class: 'muted' }, '•••• hidden'), h('td', { class: 'muted' }, ago(v.updated)),
        h('td', { class: 'r' }, h('button', { type: 'button', class: 'sm danger', 'aria-label': `Unset ${v.key}`, onclick: async () => {
          if (!confirm(`Unset ${v.key}? Jobs that read it get undefined from their next run.`)) return;
          try { await api('DELETE', `/api/projects/${a.slug}/env/${v.key}`); toast(`Removed ${v.key}`); rerender(); } catch (ex) { toast(ex.message); }
        } }, 'Unset')))))))
      : empty('No secrets yet.', 'env', a),
    h('h3', {}, 'Add or change a secret'),
    h('div', { class: 'card' }, form, err));
}

function settingsTab(a, body) {
  const confirmInput = h('input', { type: 'text', 'aria-label': `Type ${a.slug} to confirm`, placeholder: a.slug, autocomplete: 'off', spellcheck: 'false', class: 'mono' });
  const del = h('button', { type: 'button', class: 'danger', disabled: true, onclick: async () => {
    try {
      await api('DELETE', `/api/projects/${a.slug}`);
      toast(`Deleted ${a.slug}`);
      navigate('/apps');
    } catch (ex) { toast(ex.message); }
  } }, 'Delete this app');
  confirmInput.addEventListener('input', () => { del.disabled = confirmInput.value.trim() !== a.slug; });
  body.replaceChildren(
    h('h3', {}, 'Visibility'),
    h('div', { class: 'card' }, h('label', { class: 'check small' },
      h('input', { type: 'checkbox', checked: !a.unlisted, onchange: async (e) => {
        try {
          await api('PATCH', `/api/projects/${a.slug}`, { unlisted: !e.target.checked });
          toast(e.target.checked ? 'Shown in gallery' : 'Hidden from gallery');
        } catch (ex) { toast(ex.message); e.target.checked = !e.target.checked; }
      } }),
      'Show in gallery (Explore), for everyone on this server')),
    h('h3', {}, 'Delete'),
    h('div', { class: 'card stack danger-zone' },
      h('p', { class: 'small' }, `This deletes ${a.slug}, all its data, files, secrets and every deploy. It can't be undone.`),
      h('label', { class: 'small' }, 'Type ', h('code', {}, a.slug), ' to confirm'),
      h('div', { class: 'row' }, confirmInput, del)));
}

const TABS = { overview: overviewTab, activity: activityTab, deploys: deploysTab, jobs: jobsTab, env: envTab, settings: settingsTab };

export async function renderApp(el, { slug, tab = 'overview' }) {
  const back = h('a', { class: 'back', href: '/apps' }, '← Apps');
  el.replaceChildren(back, h('p', { class: 'muted' }, 'Loading…'));
  const [apps, activity, keys] = await Promise.all([api('GET', '/api/projects'), api('GET', `/api/activity?app=${slug}&limit=50`), api('GET', '/api/agents')]);
  const a = apps.find((p) => p.slug === slug);
  if (!a) return el.replaceChildren(back, pageHeader(slug), h('div', { class: 'empty' }, `You don't have an app called ${slug}.`));
  const by = lastDeployers(activity, keys)[slug];
  const body = h('div', { class: 'tab-body', role: 'region', 'aria-label': TAB_LABELS[tab] }, h('p', { class: 'muted' }, 'Loading…'));
  el.replaceChildren(back,
    h('header', { class: 'page-h app-h' },
      h('span', { class: `dot${a.current_deploy ? ' live' : ''}`, 'aria-hidden': 'true' }), h('h2', {}, a.name),
      a.unlisted ? h('span', { class: 'badge' }, 'unlisted') : null,
      h('div', { class: 'row page-actions' }, a.current_deploy ? h('a', { class: 'btn', href: a.url, target: '_blank', rel: 'noopener' }, icon('external'), 'Open') : null)),
    h('p', { class: 'app-meta muted small' },
      h('span', { class: 'mono' }, a.url.replace(/^https?:\/\//, '')),
      h('button', { type: 'button', class: 'icon tiny-btn', 'aria-label': 'Copy app URL', title: 'Copy app URL', onclick: () => copy(a.url, 'URL copied') }, icon('copy')),
      a.current_deploy ? [' · Deployed ', ago(a.last_deployed), ...byLine(by)] : ' · Not deployed yet'),
    tabsNav(a, tab, { jobs: a.jobs || null }),
    body);
  // On phones the tab bar scrolls sideways: keep the current tab in view.
  el.querySelector('.app-tabs [aria-current=page]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  await TABS[tab](a, body);
}
