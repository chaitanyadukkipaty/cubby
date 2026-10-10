// Adds/refreshes a content-hash query (?v=<hash>) on every docs/assets image link in README.md and docs/index.html,
// so browsers and GitHub's image cache fetch updated screenshots immediately.
//   node scripts/stamp-assets.mjs          rewrite links in place
//   node scripts/stamp-assets.mjs --check  exit 1 if any link is stale (used in CI)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = [
  { file: 'README.md', prefix: 'docs/assets/' },
  { file: 'docs/index.html', prefix: 'assets/' },
];
const check = process.argv.includes('--check');
const hashOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8);

let stale = [];
for (const { file, prefix } of files) {
  const path = join(root, file);
  const before = readFileSync(path, 'utf8');
  const re = new RegExp(`(${prefix.replace('/', '\\/')}([\\w.-]+\\.(?:png|jpe?g|svg|gif|webp)))(\\?v=[0-9a-f]+)?`, 'g');
  const after = before.replace(re, (match, link, name) => {
    const asset = join(root, 'docs/assets', name);
    if (!existsSync(asset)) throw new Error(`${file} references missing asset docs/assets/${name}`);
    const stamped = `${link}?v=${hashOf(asset)}`;
    if (stamped !== match) stale.push(`${file}: ${name}`);
    return stamped;
  });
  if (!check && after !== before) writeFileSync(path, after);
}
if (check && stale.length) {
  console.error(`Stale asset links (run \`node scripts/stamp-assets.mjs\`):\n  ${[...new Set(stale)].join('\n  ')}`);
  process.exit(1);
}
console.log(check ? 'Asset links are up to date.' : `Stamped ${stale.length} asset link(s).`);
