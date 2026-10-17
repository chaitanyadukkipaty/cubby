// The connect-your-agent card: the setup prompt to paste into an agent, and the token for scripts and CI.
import { h, displayName, maskToken, setupPrompt, tokenLoginCommand } from '../helpers.js';
import { state, api, setToken, rerender, SERVER } from '../session.js';
import { toast, copy, icon } from '../ui.js';

const APP_IDEAS = ['polls', 'chat', 'team tracker', 'booking', 'recipe', 'trivia', 'expense', 'quiz'];
const AGENTS = ['Claude Code', 'Codex', 'Cursor', 'OpenCode'];

// Cycles the highlighted word (fading out, swapping, fading back in) and stops once the card is re-rendered away.
// Reduced motion keeps the swap but drops the fade and slide (see the .chip CSS).
function rotate(el, words, ms = 1800) {
  let i = 0;
  const t = setInterval(() => {
    if (!el.isConnected) return clearInterval(t);
    el.classList.add('out');
    setTimeout(() => { el.textContent = words[(i = (i + 1) % words.length)]; el.classList.remove('out'); }, 250);
  }, ms);
}

export function setupCard() {
  const { me, info } = state;
  const prompt = setupPrompt(SERVER, info.name);
  let revealed = false;
  const tokenEl = h('code', { class: 'mono', 'aria-label': 'Your token', style: 'overflow-wrap:anywhere' });
  const draw = () => { tokenEl.textContent = revealed ? me.token : maskToken(me.token); };
  draw();
  const idea = h('span', { class: 'chip' }, APP_IDEAS[0]);
  rotate(idea, APP_IDEAS);
  return h('div', { class: 'card stack connect' },
    h('div', {},
      h('h2', { class: 'headline' }, 'A home for', h('br'), 'every ', idea, h('br'), 'app you build with your agent'),
      h('p', { class: 'lede' }, `Paste the prompt into your agent once. It installs the Cubby skill, sends you a link to approve, and builds on ${displayName(info.name)} from then on.`),
      h('button', { class: 'pill', onclick: () => copy(prompt, 'Prompt copied') }, 'Copy prompt for agent', icon('copy')),
      h('details', { class: 'small', style: 'margin-top:14px' },
        h('summary', { class: 'muted' }, 'See what the prompt says'),
        h('pre', { 'aria-label': 'Setup prompt', style: 'word-break:normal;overflow-wrap:anywhere' }, prompt)),
      h('p', { class: 'agents-label' }, 'Works with every agent'),
      h('div', { class: 'agents' }, ...AGENTS.map((a) => h('span', {}, a))),
    ),
    h('details', { class: 'small', style: 'border-top:1px solid var(--line);padding-top:12px' },
      h('summary', { class: 'muted' }, 'Token for scripts and CI'),
      h('div', { class: 'spread', style: 'margin-top:10px' },
        tokenEl,
        h('div', { class: 'row' },
          h('button', { onclick: () => { revealed = !revealed; draw(); } }, 'Reveal'),
          h('button', { onclick: () => copy(me.token, 'Token copied') }, 'Copy'),
          h('button', { class: 'danger', onclick: async () => {
            if (!confirm('Regenerate your token for scripts and CI? The old one stops working immediately. Agents you connected with cubby login have their own keys and stay connected (revoke one with cubby agents revoke).')) return;
            const r = await api('POST', '/api/token/regenerate');
            setToken(r.token);
            me.token = r.token;
            toast('New token created');
            rerender();
          } }, 'Regenerate'),
        ),
      ),
      h('p', { class: 'muted', style: 'margin-top:8px' }, 'Use with ', h('code', {}, tokenLoginCommand(SERVER)), ' or the CUBBY_TOKEN environment variable.'),
    ),
  );
}
