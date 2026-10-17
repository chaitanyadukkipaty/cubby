// Light/dark: follows the system until the toggle saves a choice (localStorage, which may be unavailable).
// index.html applies a saved choice before first paint; this module keeps it in sync afterwards.
import { h, effectiveTheme, toggledTheme } from './helpers.js';
import { icon } from './ui.js';

const KEY = 'cubby_theme';
const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
let saved = null;
try { saved = localStorage.getItem(KEY); } catch {}

const current = () => effectiveTheme(saved, systemDark());

function apply() {
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  else delete document.documentElement.dataset.theme;
}

/** A button that flips the theme and remembers the choice. */
export function themeButton() {
  const btn = h('button', { type: 'button', class: 'icon' });
  const draw = () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    btn.setAttribute('aria-label', `Switch to ${next} theme`);
    btn.title = `Switch to ${next} theme`;
    btn.replaceChildren(icon(next === 'dark' ? 'moon' : 'sun'));
  };
  btn.addEventListener('click', () => {
    saved = toggledTheme(saved, systemDark());
    try { localStorage.setItem(KEY, saved); } catch {}
    apply();
    draw();
  });
  draw();
  return btn;
}

apply();
