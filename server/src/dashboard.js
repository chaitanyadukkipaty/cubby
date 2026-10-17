// The dashboard: an HTML shell (server/public/index.html) plus a stylesheet and ES modules, served as-is (no build).
// Everything is read once at boot, so requests never touch the filesystem. Asset URLs carry a hash of all the files,
// so they can be cached forever and a new server version never mixes old and new modules.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';

const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const typeOf = (name) => TYPES[name.slice(name.lastIndexOf('.'))];

export async function loadDashboard(dir) {
  const shell = await readFile(join(dir, 'index.html'), 'utf8');
  const names = (await readdir(dir, { recursive: true })).map((n) => n.split(sep).join('/')).filter(typeOf).sort();
  const files = new Map();
  const hasher = createHash('sha256').update(shell);
  for (const name of names) {
    const body = await readFile(join(dir, name));
    files.set(name, { type: typeOf(name), body });
    hasher.update(`\0${name}\0`).update(body);
  }
  const prefix = `/static/${hasher.digest('hex').slice(0, 12)}`;
  return {
    prefix,
    page: ({ publicUrl, version }) => shell.replaceAll('{{ASSETS}}', prefix).replaceAll('{{PUBLIC_URL}}', publicUrl).replaceAll('{{VERSION}}', version),
    /** The file at this URL path, or null. Only names read at boot match, so there is no path to traverse. */
    asset: (pathname) => (pathname.startsWith(`${prefix}/`) && files.get(pathname.slice(prefix.length + 1))) || null,
  };
}
