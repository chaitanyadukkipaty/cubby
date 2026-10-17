// Small pieces of UI shared by the views: toasts, copying, icons, the credit line and the plain-HTTP warning.
import { h } from './helpers.js';
import { state } from './session.js';

export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 1800);
}

export async function copy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(what); }
  catch { toast('Copy failed — select the text manually'); }
}

const PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  agents: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  explore: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  admin: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
};

/** An inline icon (static markup from PATHS, never user data). */
export function icon(name) {
  const span = h('span', { 'aria-hidden': 'true', style: 'display:inline-flex' });
  span.innerHTML = `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`;
  return span;
}

export function logo() {
  const span = h('span', { class: 'mark', 'aria-hidden': 'true' });
  span.innerHTML = '<svg viewBox="0 0 32 32" width="24" height="24"><rect width="32" height="32" rx="8" fill="var(--accent)"/><circle cx="16" cy="17" r="7" fill="var(--accent-fg)"/></svg>';
  return span;
}

// The server's own name leads; Cubby is credited quietly.
export const credit = () => h('span', { class: 'muted small credit' }, 'runs on ', h('a', { href: 'https://github.com/chaitanyadukkipaty/cubby', target: '_blank', rel: 'noopener' }, 'Cubby'));

export function httpBanner() {
  return state.info.https ? null : h('div', { class: 'banner' },
    h('b', {}, '⚠ '), 'This server runs on plain HTTP, so passwords and tokens are not encrypted in transit. ',
    'Ask the admin to add a domain to enable HTTPS.');
}

/** A prompt or command to paste somewhere, in monospace with a copy button (the whole chip copies). */
export function copyChip(text, { what = 'Prompt copied', label = 'Copy prompt' } = {}) {
  return h('button', { type: 'button', class: 'chip-copy', title: label, 'aria-label': `${label}: ${text}`, onclick: () => copy(text, what) },
    h('span', { class: 'mono' }, text), icon('copy'));
}

/** An "Ask your agent:" box: what to paste into the agent when there's nothing to show yet. */
export const askAgent = (text) => h('div', { class: 'ask' }, h('span', { class: 'ask-h' }, 'Ask your agent:'), copyChip(text));

/** An agent's two-letter badge (decorative; the name is always next to it). */
export const agentBadge = (mono) => h('span', { class: 'mono-badge', 'aria-hidden': 'true' }, mono);

/** A page's title row: heading plus optional extras (counts, actions). */
export const pageHeader = (title, ...extra) => h('header', { class: 'page-h' }, h('h2', {}, title), ...extra);
