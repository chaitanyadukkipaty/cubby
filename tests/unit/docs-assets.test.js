// README.md and docs/index.html link screenshots with ?v=<content hash> so caches pick up new images.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

test('docs asset links carry current content hashes', () => {
  const r = spawnSync(process.execPath, ['scripts/stamp-assets.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('README and docs site use the same image versions', () => {
  const versions = (text) => Object.fromEntries([...text.matchAll(/assets\/([\w.-]+\.(?:png|svg))\?v=([0-9a-f]+)/g)].map((m) => [m[1], m[2]]));
  const readme = versions(readFileSync(resolve(root, 'README.md'), 'utf8'));
  const docs = versions(readFileSync(resolve(root, 'docs/index.html'), 'utf8'));
  for (const [name, v] of Object.entries(readme)) if (name in docs) assert.equal(docs[name], v, name);
  assert.ok(Object.keys(readme).length >= 5, 'README should show the screenshots');
});
