// Unit tests for the command palette's pure logic (server/public/js/palette.js): matching, ranking, the items a user
// gets and keyboard selection.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as p from '../../server/public/js/palette.js';
import { setupPrompt } from '../../server/public/js/helpers.js';

describe('fuzzyScore()', () => {
  test('a query that is not a subsequence of the text does not match', () => {
    assert.equal(p.fuzzyScore('xyz', 'Friend Polls'), null);
  });
  test('matching ignores case and spaces in the query', () => {
    assert.notEqual(p.fuzzyScore('FR po', 'Friend Polls'), null);
    assert.notEqual(p.fuzzyScore('frpo', 'friend polls'), null);
  });
  test('a prefix ranks above a word start, which ranks above letters scattered inside words', () => {
    const prefix = p.fuzzyScore('po', 'Polls');
    const wordStart = p.fuzzyScore('po', 'Friend Polls');
    const scattered = p.fuzzyScore('po', 'Explore apps');
    assert.ok(prefix > wordStart, `${prefix} > ${wordStart}`);
    assert.ok(wordStart > scattered, `${wordStart} > ${scattered}`);
  });
  test('the initials of words match well (fp → Friend Polls beats a scattered f…p)', () => {
    assert.ok(p.fuzzyScore('fp', 'Friend Polls') > p.fuzzyScore('fp', 'Info page'));
  });
  test('a shorter text ranks above a longer one with the same kind of match', () => {
    assert.ok(p.fuzzyScore('app', 'Apps') > p.fuzzyScore('app', 'Application settings'));
  });
});

describe('searchItems()', () => {
  const items = [
    { id: 'page:explore', label: 'Explore' },
    { id: 'app:polls', label: 'Friend Polls' },
    { id: 'page:apps', label: 'Apps' },
  ];
  test('an empty query keeps every item in its order', () => {
    assert.deepEqual(p.searchItems(items, '  ').map((i) => i.id), ['page:explore', 'app:polls', 'page:apps']);
  });
  test('drops items that do not match and puts the best match first', () => {
    assert.deepEqual(p.searchItems(items, 'po').map((i) => i.id), ['app:polls', 'page:explore']);
    assert.deepEqual(p.searchItems(items, 'ex').map((i) => i.id), ['page:explore']);
  });
  test('keywords match too, but a label match of the same quality ranks first', () => {
    const withKeywords = [
      { id: 'action:theme', label: 'Toggle theme', keywords: ['dark mode', 'light mode'] },
      { id: 'app:dark', label: 'Dark mode notes' },
    ];
    assert.deepEqual(p.searchItems(withKeywords, 'light').map((i) => i.id), ['action:theme']);
    assert.deepEqual(p.searchItems(withKeywords, 'dark').map((i) => i.id), ['app:dark', 'action:theme']);
  });
});

describe('paletteItems()', () => {
  const server = 'https://cubby.example.com';
  const base = { me: { email: 'a@b.c', is_admin: false }, apps: [], info: { name: 'Priya’s Cubby', features: ['jobs'] }, server };
  const pages = (items) => items.filter((i) => i.group === 'Pages').map((i) => [i.label, i.href]);

  test('every page a regular user can open, linked', () => {
    assert.deepEqual(pages(p.paletteItems(base)), [['Home', '/'], ['Apps', '/apps'], ['Agents', '/agents'], ['Explore', '/explore']]);
  });
  test('admins also get Admin', () => {
    assert.deepEqual(pages(p.paletteItems({ ...base, me: { ...base.me, is_admin: true } })).at(-1), ['Admin', '/admin']);
  });
  test('each of the user’s apps links to its page and can be found by its slug', () => {
    const apps = [{ slug: 'polls', name: 'Friend Polls' }, { slug: 'books', name: 'Book Club' }];
    const found = p.paletteItems({ ...base, apps }).filter((i) => i.group === 'Apps');
    assert.deepEqual(found.map((i) => [i.label, i.href]), [['Friend Polls', '/apps/polls'], ['Book Club', '/apps/books']]);
    assert.equal(p.searchItems(found, 'books')[0].href, '/apps/books');
  });
  test('actions: copy the setup prompt and common commands, switch theme, log out', () => {
    const actions = p.paletteItems(base).filter((i) => i.group === 'Actions');
    const prompt = actions.find((i) => i.label === 'Copy setup prompt for your agent');
    assert.deepEqual([prompt.action, prompt.text], ['copy', setupPrompt(server, base.info.name)]);
    assert.equal(actions.find((i) => i.text === 'cubby deploy')?.action, 'copy');
    assert.equal(actions.find((i) => i.action === 'theme')?.label, 'Switch theme');
    assert.equal(actions.find((i) => i.action === 'logout')?.label, 'Log out');
    assert.ok(actions.every((i) => !i.href));
  });
  test('`cubby metrics <app>` is offered per app only when the server advertises metrics', () => {
    const apps = [{ slug: 'polls', name: 'Friend Polls' }];
    const metrics = (info) => p.paletteItems({ ...base, apps, info }).filter((i) => /^cubby metrics/.test(i.text ?? '')).map((i) => i.text);
    assert.deepEqual(metrics(base.info), []);
    assert.deepEqual(metrics({ ...base.info, features: undefined }), []);
    assert.deepEqual(metrics({ ...base.info, features: ['jobs', 'metrics'] }), ['cubby metrics polls']);
  });
});

describe('moveActive()', () => {
  test('arrows move the highlight and wrap around the ends', () => {
    assert.equal(p.moveActive(0, 'ArrowDown', 3), 1);
    assert.equal(p.moveActive(2, 'ArrowDown', 3), 0);
    assert.equal(p.moveActive(0, 'ArrowUp', 3), 2);
  });
  test('other keys leave it alone (Home/End stay with the search field)', () => {
    assert.equal(p.moveActive(1, 'Home', 3), 1);
    assert.equal(p.moveActive(1, 'a', 3), 1);
  });
  test('with no results there is nothing to highlight', () => {
    assert.equal(p.moveActive(0, 'ArrowDown', 0), -1);
  });
});

test('shortcutLabel() shows ⌘K on Apple devices and Ctrl K elsewhere', () => {
  assert.equal(p.shortcutLabel('MacIntel'), '⌘K');
  assert.equal(p.shortcutLabel('iPad'), '⌘K');
  assert.equal(p.shortcutLabel('Win32'), 'Ctrl K');
  assert.equal(p.shortcutLabel(''), 'Ctrl K');
});

test('the palette module has no DOM state or network access', () => {
  const src = readFileSync(new URL('../../server/public/js/palette.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bfetch\(|localStorage|location\.|document\.|window\./);
});

describe('isPaletteShortcut()', () => {
  test('⌘K and Ctrl+K open it, in any case', () => {
    assert.ok(p.isPaletteShortcut({ key: 'k', metaKey: true }));
    assert.ok(p.isPaletteShortcut({ key: 'K', ctrlKey: true }));
  });
  test('a bare K, or K with Shift or Alt as well, does not', () => {
    assert.ok(!p.isPaletteShortcut({ key: 'k' }));
    assert.ok(!p.isPaletteShortcut({ key: 'k', metaKey: true, shiftKey: true }));
    assert.ok(!p.isPaletteShortcut({ key: 'k', ctrlKey: true, altKey: true }));
  });
});
