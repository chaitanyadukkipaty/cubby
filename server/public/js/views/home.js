// Home: the agent activity timeline is the spine, opened by "What should your agent do next?". Beside it (above it on
// phones): who's on your apps now, views over 7 days, and your agents. A first-time user (no agent, no app) gets the
// connect steps instead. Only the signed-in user's own apps are shown here; friends' apps are on Explore.
import { h, ago, fmtCount, setupPrompt } from '../helpers.js';
import { monogram, needsAttention, nextPrompts } from '../feed.js';
import { sumSeries } from '../charts.js';
import { appPath } from '../routes.js';
import { state, api, rerender, SERVER } from '../session.js';
import { agentBadge, copy, copyChip, icon, pageHeader, toast } from '../ui.js';
import { setupCard } from './setup.js';
import { timeline } from './feed-ui.js';
import { sparkSvg } from './chart-ui.js';

const FEED_LIMIT = 60;

function firstRun(el) {
  const step = (n, now, ...body) => h('li', { class: `step${now ? ' now' : ''}` }, h('span', { class: 'step-n', 'aria-hidden': 'true' }, n), h('div', { class: 'step-body' }, ...body));
  el.replaceChildren(pageHeader('Home'),
    h('ol', { class: 'steps', 'aria-label': 'Get started' },
      step(1, true, setupCard()),
      step(2, false, h('p', {}, h('b', {}, 'Your agent asks you to approve'), ' — one link, one click.')),
      step(3, false, h('p', {}, h('b', {}, 'Then ask for an app')),
        h('div', { class: 'chips' }, nextPrompts({ apps: [], serverName: state.info.name }).map((p) => copyChip(p)))),
    ));
}

const sideCard = (title, extra, ...body) => h('section', { class: 'card side-card', 'aria-label': title },
  h('div', { class: 'side-card-h' }, h('h3', {}, title), extra ?? null), ...body);

function agentsCard(agents) {
  const connect = h('button', { type: 'button', class: 'sm', onclick: () => copy(setupPrompt(SERVER, state.info.name), 'Prompt copied') }, icon('copy'), agents.length ? 'Connect another agent' : 'Copy prompt for agent');
  return sideCard('Your agents', h('a', { href: '/agents', class: 'small' }, 'All'),
    agents.length
      ? h('ul', { class: 'side-list' }, agents.map((a) => h('li', {},
        agentBadge(monogram(a.tool || a.name)), h('a', { href: `/agents/${a.id}`, class: 'grow' }, a.name),
        h('span', { class: 'muted' }, a.last_used_at ? ago(a.last_used_at) : 'never'))))
      : h('p', { class: 'muted small' }, 'No agent connected yet.'),
    connect);
}

// Fills the summary cards once the metrics arrive (the feed draws first).
async function loadSummary(apps, activeCard, viewsCard, attention) {
  const [now, weekly, jobs] = await Promise.all([
    api('GET', '/api/metrics?range=24h'),
    Promise.all(apps.map((a) => api('GET', `/api/projects/${a.slug}/metrics?range=7d`).catch(() => null))),
    Promise.all(apps.filter((a) => a.jobs).map((a) => api('GET', `/api/projects/${a.slug}/jobs`).then((list) => list.map((j) => ({ ...j, app: a.slug })), () => []))),
  ]);
  const name = (slug) => apps.find((a) => a.slug === slug)?.name ?? slug;
  const total = now.reduce((n, m) => n + m.active_now, 0);
  activeCard.replaceChildren(h('div', { class: 'side-card-h' }, h('h3', {}, 'Active now'), h('b', { class: 'big' }, fmtCount(total))),
    h('ul', { class: 'side-list' }, now.map((m) => h('li', {},
      h('span', { class: `dot${m.active_now ? ' live' : ''}`, 'aria-hidden': 'true' }), h('a', { href: appPath(m.app), class: 'grow' }, name(m.app)),
      h('span', { class: 'num' }, m.active_now ? fmtCount(m.active_now) : '–')))));

  const days = sumSeries(weekly.filter(Boolean).map((r) => r.days), 'views').slice(-7);
  const views = days.reduce((n, d) => n + d.value, 0);
  viewsCard.replaceChildren(h('div', { class: 'side-card-h' }, h('h3', {}, 'Views · 7 days'), h('b', { class: 'big' }, fmtCount(views))),
    sparkSvg(days.map((d) => d.value), { w: 240, h: 40, label: `Views per day, last 7 days: ${days.map((d) => d.value).join(', ')}` }));

  const items = needsAttention({ jobs: jobs.flat(), metrics: now });
  attention.replaceChildren(...items.map((i) => h('div', { class: 'attention', role: 'group', 'aria-label': `${name(i.app)}: ${i.text}` },
    icon('alert'), h('span', { class: 'grow' }, h('a', { href: appPath(i.app) }, name(i.app)), ` ${i.text}`),
    h('button', { type: 'button', class: 'sm', onclick: () => copy(i.prompt, 'Fix-it prompt copied') }, icon('copy'), 'Copy fix-it prompt'))));
}

export async function renderHome(el) {
  el.replaceChildren(pageHeader('Home'), h('p', { class: 'muted' }, 'Loading…'));
  const [apps, keys, activity] = await Promise.all([api('GET', '/api/projects'), api('GET', '/api/agents'), api('GET', `/api/activity?limit=${FEED_LIMIT}`)]);
  const agents = keys.filter((k) => !k.manual);
  if (!agents.length && !apps.length) return firstRun(el);

  const activeCard = sideCard('Active now', null, h('p', { class: 'muted small' }, 'Loading…'));
  const viewsCard = sideCard('Views · 7 days', null, h('p', { class: 'muted small' }, 'Loading…'));
  const attention = h('div', { class: 'stack' });
  const feed = activity.length
    ? timeline(activity, { apps, agents, label: 'Agent activity', onChange: rerender })
    : h('div', { class: 'empty small' }, 'Nothing yet. What your agents do on your apps shows up here.');

  el.replaceChildren(
    pageHeader('Home', h('span', { class: 'muted' }, `${apps.length} app${apps.length === 1 ? '' : 's'} · ${agents.length} agent${agents.length === 1 ? '' : 's'}`)),
    h('div', { class: 'home' },
      h('aside', { class: 'home-side', 'aria-label': 'Summary' }, activeCard, viewsCard, agentsCard(agents)),
      h('div', { class: 'home-main' },
        h('section', { class: 'card next', 'aria-label': 'What should your agent do next?' },
          h('h3', {}, icon('sparkle'), 'What should your agent do next?'),
          h('div', { class: 'chips' }, nextPrompts({ apps, serverName: state.info.name }).map((p) => copyChip(p)))),
        attention,
        feed,
      )));
  if (apps.length) await loadSummary(apps, activeCard, viewsCard, attention).catch((ex) => toast(ex.message));
  else {
    activeCard.querySelector('p').textContent = 'No apps yet.';
    viewsCard.querySelector('p').textContent = 'No apps yet.';
  }
}
