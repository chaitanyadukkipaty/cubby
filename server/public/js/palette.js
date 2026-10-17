// The command palette's logic: matching and ranking, the items a user gets, keyboard selection. Pure (no DOM, no
// network), so tests/unit/frontend-palette.test.js imports it directly; js/command-palette.js draws it.
import { navItems } from './routes.js';
import { setupPrompt } from './helpers.js';

const WORD_START = 8; // a letter that starts a word ("p" in "Friend Polls")
const PREFIX = 6; // on top of WORD_START, for the very first letter of the text
const RUN = 4; // a letter right after the previous match ("po" in "Polls")

const isWordStart = (t, j) => j === 0 || !/[a-z0-9]/i.test(t[j - 1]) || (/[a-z]/.test(t[j - 1]) && /[A-Z]/.test(t[j]));

/**
 * How well `query` matches `text`, or null when its letters don't appear in order. Higher is better: letters that
 * start words, a match at the very start and unbroken runs score extra; a longer text costs a little.
 */
export function fuzzyScore(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const lower = text.toLowerCase();
  // best[j]: the best score with the query so far matched and its last letter at text[j] (-Infinity: impossible).
  let best = null;
  for (const ch of q) {
    const next = new Array(lower.length).fill(-Infinity);
    let before = -Infinity; // max of best[k] for k < j - 1 (a gap before j)
    for (let j = 0; j < lower.length; j++) {
      if (lower[j] === ch) {
        const bonus = 1 + (isWordStart(text, j) ? WORD_START : 0) + (j === 0 ? PREFIX : 0);
        const from = best ? Math.max(before, j > 0 ? best[j - 1] + RUN : -Infinity) : 0;
        next[j] = from + bonus;
      }
      if (best && j > 0) before = Math.max(before, best[j - 1]);
    }
    best = next;
  }
  if (!best) return 0;
  const top = Math.max(-Infinity, ...best);
  return top === -Infinity ? null : top - text.length / 100;
}

const KEYWORD = 3; // what a keyword match costs against the same match on the label

function itemScore(query, { label, keywords = [] }) {
  const scores = [fuzzyScore(query, label), ...keywords.map((k) => {
    const s = fuzzyScore(query, k);
    return s === null ? null : s - KEYWORD;
  })].filter((s) => s !== null);
  return scores.length ? Math.max(...scores) : null;
}

/** The items matching `query`, best first (ties keep their order); an empty query keeps them all. */
export function searchItems(items, query) {
  if (!query.trim()) return items;
  return items.map((item, i) => ({ item, i, score: itemScore(query, item) }))
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.item);
}

/**
 * What the palette offers this user: every page they can open, each of their apps, and actions.
 * Pages and apps carry an `href`; actions carry `action` ('copy' with `text` and a `done` toast).
 */
export function paletteItems({ me, apps = [], info = {}, server }) {
  const command = (text, keywords = []) => ({ id: `copy:${text}`, group: 'Actions', label: `Copy ${text}`, icon: 'copy', action: 'copy', text, done: 'Command copied', keywords });
  const metrics = Array.isArray(info.features) && info.features.includes('metrics');
  return [
    ...navItems(me, null).map((n) => ({ id: `page:${n.href}`, group: 'Pages', label: n.label, icon: n.icon, href: n.href })),
    ...apps.map((a) => ({ id: `app:${a.slug}`, group: 'Apps', label: a.name, hint: a.slug, keywords: [a.slug], icon: 'apps', href: `/apps/${a.slug}` })),
    { id: 'copy:prompt', group: 'Actions', label: 'Copy setup prompt for your agent', icon: 'copy', action: 'copy', text: setupPrompt(server, info.name), done: 'Prompt copied', keywords: ['connect agent', 'install skill'] },
    command('cubby deploy', ['publish ship']),
    command(`cubby login ${server}`),
    ...(metrics ? apps.map((a) => command(`cubby metrics ${a.slug}`, [a.name])) : []),
    { id: 'theme', group: 'Actions', label: 'Switch theme', icon: 'moon', action: 'theme', keywords: ['dark mode', 'light mode'] },
    { id: 'logout', group: 'Actions', label: 'Log out', icon: 'logout', action: 'logout', keywords: ['sign out'] },
  ];
}

/** The highlighted row after an arrow key in the palette (-1: no rows). Arrows wrap around the ends. */
export function moveActive(index, key, count) {
  if (!count) return -1;
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  return index;
}

/** How the shortcut is written on this platform (`navigator.platform`). */
export const shortcutLabel = (platform) => (/Mac|iPhone|iPad|iPod/.test(platform || '') ? '⌘K' : 'Ctrl K');

/** ⌘K or Ctrl+K (a modifier is required, so typing a "k" in a field never opens it). */
export const isPaletteShortcut = (e) => Boolean((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key?.toLowerCase() === 'k');
