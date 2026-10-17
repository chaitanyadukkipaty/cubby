// Explore: everyone's listed apps on this server.
import { h, ago, displayName } from '../helpers.js';
import { state, api } from '../session.js';
import { pageHeader } from '../ui.js';

export async function renderExplore(el) {
  const body = h('p', { class: 'muted' }, 'Loading…');
  el.replaceChildren(pageHeader('Explore', h('span', { class: 'muted' }, `Everyone's apps on ${displayName(state.info.name)}`)), body);
  const apps = await api('GET', '/api/gallery');
  if (!apps.length) return body.replaceWith(h('div', { class: 'empty' }, 'Nobody has shipped anything yet. Be the first.'));
  body.replaceWith(h('div', { class: 'grid' }, apps.map((a) => h('article', { class: 'card app stack', 'aria-label': a.name },
    h('div', {},
      h('h2', {}, a.name),
      a.description ? h('p', { class: 'muted small' }, a.description) : null,
      h('p', { class: 'meta' }, `by ${a.owner} · ${ago(a.last_deployed)}`),
    ),
    h('a', { href: a.url, target: '_blank', rel: 'noopener' }, 'Open ↗'),
  ))));
}
