// The ⌘K / Ctrl+K command palette: a modal combobox over the pages, the user's apps and a few actions. What it
// offers, how it ranks and how the arrows move live in js/palette.js (pure, unit-tested); this file draws it.
import { h } from './helpers.js';
import { isPaletteShortcut, moveActive, paletteItems, searchItems, shortcutLabel } from './palette.js';
import { SERVER, api, logout, state } from './session.js';
import { navigate } from './router.js';
import { toggleTheme } from './theme.js';
import { copy, icon, toast } from './ui.js';

export const SHORTCUT = shortcutLabel(navigator.platform);

let open = null; // { close } while the palette is showing

function run(item) {
  if (item.href) return navigate(item.href);
  if (item.action === 'copy') return copy(item.text, item.done);
  if (item.action === 'theme') return toggleTheme();
  if (item.action === 'logout') return logout();
}

/** Opens the palette (no-op if it is already open or nobody is signed in). Focus returns where it was on close. */
export function openPalette() {
  if (open || !state.me) return;
  const returnTo = document.activeElement;
  let items = paletteItems({ me: state.me, info: state.info, server: SERVER });
  let shown = [];
  let active = 0;

  const listbox = h('div', { id: 'palette-list', role: 'listbox', 'aria-label': 'Results', class: 'palette-list' });
  const input = h('input', {
    type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list',
    'aria-label': 'Search pages, apps and actions', placeholder: 'Search pages, apps and actions…', autocomplete: 'off', spellcheck: 'false',
  });
  const dialog = h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
    h('div', { class: 'palette-search' }, icon('search'), input, h('kbd', {}, 'Esc')), listbox);
  const backdrop = h('div', { class: 'palette-backdrop' }, dialog);

  const highlight = () => {
    listbox.querySelectorAll('[role=option]').forEach((el, i) => {
      el.setAttribute('aria-selected', String(i === active));
      if (i === active) el.scrollIntoView?.({ block: 'nearest' });
    });
    if (active >= 0) input.setAttribute('aria-activedescendant', `palette-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const draw = () => {
    shown = searchItems(items, input.value);
    active = shown.length ? 0 : -1;
    const opts = shown.map((item, i) => h('div', { id: `palette-opt-${i}`, role: 'option', class: 'opt', 'aria-selected': 'false',
      onmousemove: () => { if (active !== i) { active = i; highlight(); } },
      onclick: () => choose(item) },
    icon(item.icon), h('span', { class: 'label' }, item.label), item.hint ? h('span', { class: 'hint mono' }, item.hint) : null));
    if (!shown.length) listbox.replaceChildren(h('div', { class: 'palette-empty', role: 'presentation' }, 'No results'));
    // Ranked results are one list; with no query, the items are shown under their group (Pages, Apps, Actions).
    else if (input.value.trim()) listbox.replaceChildren(...opts);
    else {
      const groups = new Map();
      opts.forEach((opt, i) => groups.set(shown[i].group, [...(groups.get(shown[i].group) ?? []), opt]));
      listbox.replaceChildren(...[...groups].map(([name, rows]) => h('div', { role: 'group', 'aria-label': name },
        h('div', { class: 'group-h', role: 'presentation' }, name), rows)));
    }
    highlight();
  };

  const close = () => {
    backdrop.remove();
    open = null;
    if (returnTo?.isConnected) returnTo.focus();
  };

  const choose = (item) => {
    close();
    Promise.resolve(run(item)).catch((ex) => toast(ex.message));
  };

  input.addEventListener('input', draw);
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return close(); }
    if (e.key === 'Tab') return e.preventDefault(); // the search field is the only stop: focus stays in the dialog
    if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) choose(shown[active]); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = moveActive(active, e.key, shown.length);
      highlight();
    }
  });
  // Clicking a row must not steal focus from the field; clicking outside the dialog closes it.
  dialog.addEventListener('mousedown', (e) => { if (e.target !== input) e.preventDefault(); });
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });

  open = { close };
  document.body.append(backdrop);
  draw();
  input.focus();

  // The user's apps arrive a moment later; keep what they've typed and redraw.
  api('GET', '/api/projects').then((apps) => {
    if (open?.close !== close) return;
    items = paletteItems({ me: state.me, apps, info: state.info, server: SERVER });
    draw();
  }).catch(() => {});
}

/** Listens for ⌘K / Ctrl+K anywhere on the page (the modifier makes it safe inside fields too). */
export function installPalette() {
  document.addEventListener('keydown', (e) => {
    if (!isPaletteShortcut(e)) return;
    e.preventDefault();
    if (open) open.close();
    else openPalette();
  });
}

/** The sidebar's "Search ⌘K" button. */
export const paletteButton = () => h('button', { type: 'button', class: 'palette-hint', onclick: openPalette, 'aria-label': 'Search', title: `Search (${SHORTCUT})`, 'aria-keyshortcuts': 'Meta+K Control+K' },
  icon('search'), h('span', { class: 'label' }, 'Search'), h('kbd', {}, SHORTCUT));
