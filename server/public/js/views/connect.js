// /connect?code=XXXX-XXXX while signed in: approve a CLI/agent login.
import { h, connectHeading, connectAsker } from '../helpers.js';
import { state, api } from '../session.js';
import { httpBanner } from '../ui.js';

const panel = (...children) => h('section', { class: 'hero single' }, h('div', { class: 'card stack' }, ...children));

export async function renderConnect(root, code) {
  const status = h('p', { class: 'error', role: 'alert' });
  // Which agent is asking (sent with our token; anonymous callers aren't told). An expired code still renders,
  // and Approve then says it expired.
  const agent = await api('GET', `/api/device/${encodeURIComponent(code)}`).then((r) => r.agent, () => null);
  const asker = h('b', { 'aria-label': 'Requesting agent' }, connectAsker(agent));
  const done = () => {
    history.replaceState(null, '', '/');
    root.replaceChildren(panel(
      h('h2', {}, '✅ Agent connected'),
      h('p', { class: 'muted' }, 'You can close this tab and go back to your agent. It will carry on building.'),
      h('button', { onclick: () => { location.href = '/'; } }, 'Open dashboard'),
    ));
  };
  const banner = httpBanner();
  root.replaceChildren(
    banner ? h('div', { class: 'hero-banner' }, banner) : '',
    panel(
      h('h2', {}, connectHeading(state.info.name)),
      h('p', { class: 'muted' }, asker, ' to build and deploy apps as ', h('b', {}, state.me.email), '.'),
      h('p', {}, 'Check the code matches what your agent showed:'),
      h('code', { class: 'mono', style: 'display:block;font-size:24px;letter-spacing:.08em', 'aria-label': 'Connection code' }, code),
      status,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => {
          try { await api('POST', '/api/device/approve', { code }); done(); }
          catch (ex) { status.textContent = ex.message; }
        } }, 'Approve'),
        h('button', { onclick: () => { location.href = '/'; } }, 'Cancel'),
      ),
    ),
  );
}
