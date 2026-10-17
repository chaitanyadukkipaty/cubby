// Signed out: the sign up / log in card. On /connect it explains that an agent is waiting for approval.
import { h, displayName } from '../helpers.js';
import { state, api, setToken, loadMe, rerender, VERSION } from '../session.js';
import { credit, httpBanner } from '../ui.js';

export function renderAuth(root, connectCode) {
  let mode = 'signup';
  const err = h('p', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'stack' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });

  function draw() {
    tabs.replaceChildren(
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(mode === 'signup'), onclick: () => { mode = 'signup'; draw(); } }, 'Sign up'),
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(mode === 'login'), onclick: () => { mode = 'login'; draw(); } }, 'Log in'),
    );
    form.replaceChildren(
      h('input', { name: 'email', type: 'email', placeholder: 'Email', required: true, autocomplete: 'email', 'aria-label': 'Email' }),
      h('input', { name: 'password', type: 'password', placeholder: 'Password (8+ characters)', required: true, minlength: 8, autocomplete: mode === 'signup' ? 'new-password' : 'current-password', 'aria-label': 'Password' }),
      mode === 'signup' && !state.info.open_signup
        ? h('input', { name: 'code', type: 'text', placeholder: 'Signup code from your admin', required: true, autocomplete: 'off', 'aria-label': 'Signup code' })
        : '', // native replaceChildren would render null as "null"
      err,
      h('button', { class: 'primary', type: 'submit' }, mode === 'signup' ? 'Create account' : 'Log in'),
    );
    err.textContent = '';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    err.textContent = '';
    try {
      const r = await api('POST', mode === 'signup' ? '/api/signup' : '/api/login', data);
      setToken(r.key);
      await loadMe();
      rerender();
    } catch (ex) { err.textContent = ex.message; }
  });
  draw();

  const name = displayName(state.info.name);
  const banner = httpBanner();
  root.replaceChildren(
    banner ? h('div', { class: 'hero-banner' }, banner) : '',
    h('section', { class: 'hero' },
      h('div', {},
        connectCode
          ? h('h1', {}, 'Connect your agent', h('br'), h('span', {}, `to ${name}.`))
          : h('h1', {}, 'Agents build it.', h('br'), h('span', {}, `${name} hosts it.`)),
        h('p', { class: 'muted lead' }, connectCode
          ? 'Sign up or log in, then approve the connection. Your agent is waiting and will carry on by itself.'
          : 'Describe an app to your AI agent and it gets built and hosted here — React on the front, a real database behind.'),
        h('p', { class: 'muted small', style: 'margin-top:16px' }, credit(), ` ${VERSION}`),
      ),
      h('div', { class: 'card' }, tabs, form),
    ),
  );
}
