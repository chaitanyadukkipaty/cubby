// The agent activity timeline: one line per event, grouped by day, with Roll back on live deploys and a fix-it
// prompt on failures. What each line says lives in js/feed.js (pure, unit-tested); this file draws it.
import { h, ago, parseDate } from '../helpers.js';
import { feedEntries, fixItPrompt, groupByDay, rollbackTarget } from '../feed.js';
import { api } from '../session.js';
import { agentBadge, copy, icon, toast } from '../ui.js';

/** Rolls `slug` back to the deploy before `deployId`, after a confirm. Resolves true if it rolled back. */
export async function rollBack(slug, deployId) {
  if (!confirm(`Roll back ${slug}? The deploy before this one goes live again. Data and secrets stay as they are.`)) return false;
  const target = rollbackTarget(await api('GET', `/api/projects/${slug}/deploys`), deployId);
  if (!target) { toast('There is no earlier deploy to roll back to'); return false; }
  await api('POST', `/api/projects/${slug}/rollback`, { deploy: target.id });
  toast(`Rolled back ${slug}`);
  return true;
}

const when = (at) => h('time', { datetime: parseDate(at).toISOString(), title: parseDate(at).toLocaleString() }, ago(at));

function line(e, { showApp, onChange }) {
  const actions = [];
  if (e.rollback) {
    actions.push(h('button', { type: 'button', class: 'sm', onclick: async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try { if (await rollBack(e.app.slug, e.deployId)) return onChange(); } catch (ex) { toast(ex.message); }
      btn.disabled = false;
    } }, icon('undo'), 'Roll back'));
  }
  if (e.kind === 'failed') {
    actions.push(h('button', { type: 'button', class: 'sm', onclick: () => copy(fixItPrompt({ kind: 'job', app: e.app?.slug, job: e.job, status: e.status }), 'Fix-it prompt copied') },
      icon('copy'), 'Copy fix-it prompt'));
  }
  const appLink = e.app ? (e.app.href ? h('a', { href: e.app.href }, e.app.name) : h('span', {}, e.app.name)) : null;
  // "Codex deployed Book Club · 9 files", or "Codex Added secret KEY · Book Club" for anything else.
  const what = e.verb
    ? [` ${e.verb} `, showApp && appLink ? appLink : 'it', e.detail ? h('span', { class: 'muted' }, ` · ${e.detail}`) : null]
    : [` ${e.text}`, showApp && appLink ? h('span', { class: 'muted' }, ' · ', appLink) : null];
  return h('li', { class: `ev${e.kind === 'failed' ? ' failed' : ''}`, title: e.text },
    agentBadge(e.actor.mono),
    h('div', { class: 'ev-body' },
      h('span', { class: 'ev-text' },
        e.actor.href ? h('a', { class: 'ev-who', href: e.actor.href }, e.actor.name) : h('b', { class: 'ev-who' }, e.actor.name),
        ...what),
      actions.length ? h('span', { class: 'ev-actions' }, ...actions) : null),
    when(e.at));
}

/**
 * Activity rows (GET /api/activity) as a timeline. `apps` and `agents` name things and decide what can be rolled
 * back; `onChange` runs after a rollback (to redraw).
 */
export function timeline(rows, { apps = [], agents = [], showApp = true, onChange = () => {}, label = 'Activity' } = {}) {
  const entries = feedEntries(rows, { apps, agents });
  return h('div', { class: 'feed', role: 'region', 'aria-label': label },
    ...groupByDay(entries).map((g) => h('section', { class: 'feed-day', 'aria-label': g.label },
      h('h4', {}, g.label),
      h('ol', {}, g.rows.map((e) => line(e, { showApp, onChange }))))));
}
