// Agents: a placeholder until connected agents are listed here.
import { h } from '../helpers.js';
import { pageHeader } from '../ui.js';

export function renderAgents(el) {
  el.replaceChildren(pageHeader('Agents'), h('div', { class: 'placeholder' },
    h('p', {}, 'The agents you connect will be listed here.'),
    h('p', { class: 'small' }, 'To connect one, copy the setup prompt from ', h('a', { href: '/' }, 'Home'), '.')));
}
