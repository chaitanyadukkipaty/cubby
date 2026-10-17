// Home: connect an agent, then a summary of your apps. (The agent activity timeline comes later.)
import { h, ago } from '../helpers.js';
import { api } from '../session.js';
import { pageHeader } from '../ui.js';
import { setupCard } from './setup.js';
import { noAppsYet } from './apps.js';

function appsSummary(apps) {
  if (!apps.length) return noAppsYet();
  return h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'Your apps' },
    h('thead', {}, h('tr', {}, h('th', {}, 'App'), h('th', {}, 'Status'), h('th', {}, ''))),
    h('tbody', {}, apps.map((a) => h('tr', {},
      h('td', {}, h('a', { href: `/apps/${a.slug}` }, a.name), a.unlisted ? h('span', { class: 'badge', style: 'margin-left:6px' }, 'unlisted') : null),
      h('td', { class: 'muted' }, h('span', { class: `dot${a.current_deploy ? ' live' : ''}` }), a.current_deploy ? `Deployed ${ago(a.last_deployed)}` : 'Not deployed yet'),
      h('td', { style: 'text-align:right' }, a.current_deploy ? h('a', { href: a.url, target: '_blank', rel: 'noopener' }, 'Open ↗') : null),
    ))),
  ));
}

export async function renderHome(el) {
  const list = h('p', { class: 'muted' }, 'Loading…');
  el.replaceChildren(pageHeader('Home'), setupCard(),
    h('div', { class: 'sec-h' }, h('h3', {}, 'Your apps'), h('a', { href: '/apps' }, 'All apps →')),
    list);
  list.replaceWith(appsSummary(await api('GET', '/api/projects')));
}
