// The dashboard's two palettes (server/public/app.css) meet WCAG AA: 4.5:1 for text, 3:1 for the lines and dots that
// carry meaning (chart lines, deploy markers, the live dot). Both dark blocks (system and toggle) must stay the same.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../server/public/app.css', import.meta.url), 'utf8');

// The first `selector { … }` block's custom properties.
function tokens(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no ${selector} block`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const palettes = { light: tokens(':root'), dark: tokens(':root[data-theme=dark]') };

test('the system dark palette and the toggled one are the same', () => {
  assert.deepEqual(tokens(':root:not([data-theme=light])'), palettes.dark);
});

for (const [name, t] of Object.entries(palettes)) {
  describe(`${name} palette`, () => {
    const surfaces = ['card', 'bg', 'side'];
    test('text: body, muted, links, statuses on every surface, and labels on the accent', () => {
      for (const fg of ['fg', 'muted', 'accent', 'danger', 'ok', 'warn']) {
        for (const bg of surfaces) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `--${fg} on --${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}:1`);
      }
      assert.ok(ratio(t['muted'], t['code']) >= 4.5, `--muted on --code: ${ratio(t.muted, t.code).toFixed(2)}:1`);
      assert.ok(ratio(t['accent-fg'], t['accent']) >= 4.5, `--accent-fg on --accent: ${ratio(t['accent-fg'], t.accent).toFixed(2)}:1`);
    });
    test('graphics: chart lines, deploy markers and status dots', () => {
      for (const fg of ['faint', 'accent', 'ok', 'danger']) {
        for (const bg of surfaces) assert.ok(ratio(t[fg], t[bg]) >= 3, `--${fg} on --${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}:1`);
      }
    });
  });
}

test('chart axis labels and palette hints are text, so they use --muted, never --faint', () => {
  for (const sel of ['.ymax', '.palette .opt .hint']) {
    const rule = css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
    assert.match(rule, /color: var\(--muted\)/, sel);
  }
});
