// Packs ../cli into an npm-installable tarball at startup, served at /cli.tgz,
// so every server hands out a CLI that matches its own version.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as tar from 'tar';
import { config } from './config.js';

const cliDir = resolve(import.meta.dirname, '../../cli');
let tarball = null;

export async function buildCliTarball() {
  const tmp = mkdtempSync(join(tmpdir(), 'cubby-cli-'));
  try {
    const pkgDir = join(tmp, 'package');
    for (const entry of ['src', 'template', 'skill']) cpSync(join(cliDir, entry), join(pkgDir, entry), { recursive: true });
    const pkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ ...pkg, version: config.version }, null, 2));
    const chunks = [];
    for await (const c of tar.c({ gzip: true, cwd: tmp, portable: true }, ['package'])) chunks.push(c);
    tarball = Buffer.concat(chunks);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export const cliTarball = () => tarball;

// The agent skill as served by this server. It's server-neutral; skill.sh registers the server separately.
export function skillMarkdown() {
  return readFileSync(join(cliDir, 'skill', 'cubby', 'SKILL.md'), 'utf8')
    .replace(/\*\*Skill version: [^*]+\*\*/, `**Skill version: ${config.version}**`);
}
