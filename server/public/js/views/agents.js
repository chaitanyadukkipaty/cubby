// /agents: the agents you connected (one per approved `cubby login`), renamed or revoked here, plus the manual token
// for scripts and CI. /agents/:id: what one agent did.
import { h, ago, setupPrompt } from '../helpers.js';
import { appsByAgent, monogram } from '../feed.js';
import { appPath } from '../routes.js';
import { state, api, rerender, SERVER } from '../session.js';
import { navigate } from '../router.js';
import { agentBadge, copy, icon, pageHeader, toast } from '../ui.js';
import { tokenCard } from './setup.js';
import { timeline } from './feed-ui.js';

const ACTIVITY_LIMIT = 200;

async function revoke(agent) {
  if (!confirm(`Revoke ${agent.name}? Its key stops working right away, so it can't change your apps until you connect it again.`)) return false;
  await api('DELETE', `/api/agents/${agent.id}`);
  toast(`Revoked ${agent.name}`);
  return true;
}

// The name, or a small form to rename it (Enter saves, Esc cancels).
function nameCell(agent, { onSaved }) {
  const cell = h('div', { class: 'name-cell' });
  const show = () => cell.replaceChildren(h('a', { href: `/agents/${agent.id}` }, agent.name));
  const edit = () => {
    const input = h('input', { type: 'text', value: agent.name, maxlength: 60, 'aria-label': `New name for ${agent.name}`, required: true });
    const form = h('form', { class: 'row rename', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api('PATCH', `/api/agents/${agent.id}`, { name: input.value });
        toast('Agent renamed');
        onSaved();
      } catch (ex) { toast(ex.message); }
    } }, input, h('button', { type: 'submit', class: 'sm' }, 'Save'), h('button', { type: 'button', class: 'sm', onclick: show }, 'Cancel'));
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); show(); cell.querySelector('a')?.focus(); } });
    cell.replaceChildren(form);
    input.select();
    input.focus();
  };
  show();
  return { cell, edit };
}

function agentsTable(agents, touched, apps) {
  const appName = (slug) => apps.find((a) => a.slug === slug)?.name ?? slug;
  return h('div', { class: 'card table-wrap' }, h('table', { 'aria-label': 'Your agents' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Agent'), h('th', { class: 'hide-sm' }, 'Machine'), h('th', { class: 'hide-sm' }, 'Apps'), h('th', {}, 'Last seen'), h('th', { class: 'hide-sm' }, 'Connected'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))),
    h('tbody', {}, agents.map((a) => {
      const name = nameCell(a, { onSaved: rerender });
      const apps = touched[a.id] ?? [];
      return h('tr', { 'aria-label': a.name },
        h('td', {}, h('div', { class: 'row nowrap' }, agentBadge(monogram(a.tool || a.name)), name.cell)),
        h('td', { class: 'muted hide-sm' }, a.machine || '–'),
        h('td', { class: 'hide-sm' }, apps.length ? apps.slice(0, 3).flatMap((s, i) => [i ? ', ' : '', h('a', { href: appPath(s) }, appName(s))]) : h('span', { class: 'muted' }, '–'),
          apps.length > 3 ? h('span', { class: 'muted' }, ` +${apps.length - 3}`) : null),
        h('td', { class: 'muted' }, a.last_used_at ? ago(a.last_used_at) : 'never'),
        h('td', { class: 'muted hide-sm' }, ago(a.created)),
        h('td', { class: 'actions' }, h('div', { class: 'row nowrap' },
          h('button', { type: 'button', class: 'sm', onclick: name.edit, 'aria-label': `Rename ${a.name}` }, 'Rename'),
          h('button', { type: 'button', class: 'sm danger', 'aria-label': `Revoke ${a.name}`, onclick: async () => { if (await revoke(a)) rerender(); } }, 'Revoke'))),
      );
    }))));
}

const connectButton = () => h('button', { type: 'button', class: 'primary', onclick: () => copy(setupPrompt(SERVER, state.info.name), 'Prompt copied') }, icon('copy'), 'Connect a new agent');

export async function renderAgents(el) {
  el.replaceChildren(pageHeader('Agents'), h('p', { class: 'muted' }, 'Loading…'));
  const [keys, activity, apps] = await Promise.all([api('GET', '/api/agents'), api('GET', `/api/activity?limit=${ACTIVITY_LIMIT}`), api('GET', '/api/projects')]);
  const agents = keys.filter((k) => !k.manual);
  const manual = keys.find((k) => k.manual);
  el.replaceChildren(
    pageHeader('Agents', h('span', { class: 'muted' }, String(agents.length)),
      h('div', { class: 'row page-actions' }, connectButton(), h('a', { class: 'btn', href: '#token', onclick: (e) => { e.preventDefault(); document.getElementById('token')?.scrollIntoView({ block: 'center' }); document.querySelector('#token button')?.focus(); } }, 'Create a token'))),
    h('p', { class: 'muted small' }, 'Each agent gets its own key when you approve its ', h('code', {}, 'cubby login'), '. Paste the prompt from ', h('b', {}, 'Connect a new agent'), ' into Claude Code, Codex, Cursor or OpenCode.'),
    agents.length ? agentsTable(agents, appsByAgent(activity), apps)
      : h('div', { class: 'empty' }, 'No agents yet. Copy the prompt with ', h('b', {}, 'Connect a new agent'), ' and paste it into your agent.'),
    h('h3', {}, 'Token for scripts and CI'),
    tokenCard({ lastUsed: manual?.last_used_at ?? null }),
  );
}

export async function renderAgent(el, { id }) {
  const back = h('a', { class: 'back', href: '/agents' }, '← Agents');
  el.replaceChildren(back, h('p', { class: 'muted' }, 'Loading…'));
  const [keys, apps] = await Promise.all([api('GET', '/api/agents'), api('GET', '/api/projects')]);
  const agent = keys.find((k) => k.id === id);
  if (!agent) return el.replaceChildren(back, pageHeader('Agent'), h('div', { class: 'empty' }, 'No such agent in your account. It may have been revoked.'));
  const activity = await api('GET', `/api/activity?limit=${ACTIVITY_LIMIT}&agent=${agent.manual ? 'dashboard' : agent.id}`);
  const name = nameCell(agent, { onSaved: rerender });
  const head = h('header', { class: 'page-h' }, agentBadge(monogram(agent.tool || agent.name)), h('h2', {}, agent.name),
    agent.manual ? null : h('div', { class: 'row page-actions' },
      h('button', { type: 'button', class: 'sm', onclick: () => { head.querySelector('h2').replaceChildren(name.cell); name.edit(); } }, 'Rename'),
      h('button', { type: 'button', class: 'sm danger', onclick: async () => { if (await revoke(agent)) navigate('/agents'); } }, 'Revoke')));
  el.replaceChildren(back, head,
    h('p', { class: 'muted small' }, [agent.tool, agent.machine && `on ${agent.machine}`].filter(Boolean).join(' ') || (agent.manual ? 'Your manual token, and changes made from the dashboard' : 'Agent'),
      ` · last seen ${agent.last_used_at ? ago(agent.last_used_at) : 'never'} · connected ${ago(agent.created)}`),
    h('h3', {}, 'Activity'),
    activity.length ? timeline(activity, { apps, agents: keys, label: `Activity of ${agent.name}`, onChange: rerender })
      : h('div', { class: 'empty small' }, `${agent.name} hasn't changed anything in the last 30 days.`));
}
