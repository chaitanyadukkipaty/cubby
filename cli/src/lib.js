// Pure helpers for the CLI (no network, no process state), so they can be unit-tested directly.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, lstatSync, readlinkSync, symlinkSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export class CliError extends Error {
  constructor(message, details) { super(message); this.details = details; }
}

export const DEFAULT_SERVER = 'http://localhost:8080';

// The server you logged in to wins over cubby.json, so `cubby-server set-domain` only needs a re-login.
export function resolveServerUrl({ flag, env, globalServer, projectServer } = {}) {
  return (flag || env || globalServer || projectServer || DEFAULT_SERVER).replace(/\/$/, '');
}

// `cubby login <url>`: bare hosts get https://.
export const normalizeServerArg = (url) => (/^https?:\/\//.test(url) ? url : `https://${url}`);

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function parseSchemaText(text, file) {
  try {
    return { schema: JSON.parse(text), hash: sha256(text) };
  } catch (e) {
    throw new CliError(`${file}: ${e.message}`);
  }
}

export function describeSchemaChanges(r) {
  const parts = ['created', 'updated'].filter((k) => r[k].length).map((k) => `${k}: ${r[k].join(', ')}`);
  let text = `Schema applied. ${parts.join(' | ') || 'No changes.'}`;
  if (r.kept.length) text += `\n  kept (not in schema.json, data preserved): ${r.kept.join(', ')}\n  delete with: cubby schema drop <name> --yes`;
  return text;
}

// "Priya's Cubby (https://…)": how a server is shown in CLI output.
export const serverLabel = (name, url) => (name ? `${name} (${url})` : url);

export function versionWarning(cliVersion, serverVersion, server) {
  if (!serverVersion || serverVersion === cliVersion) return null;
  return `warning: CLI ${cliVersion} differs from server ${serverVersion}. Update with: npm i -g ${server}/cli.tgz`;
}

export function deployParams({ message, unlisted, listed, description } = {}) {
  const params = new URLSearchParams();
  if (message) params.set('message', message);
  if (unlisted) params.set('unlisted', '1');
  if (listed) params.set('unlisted', '0');
  if (description) params.set('description', description);
  return params;
}

export const formatDeploys = (list) =>
  list.map((d) => `${d.current ? '*' : ' '} ${d.id}  ${d.created}  ${d.files} files  ${d.client ? `[${d.client}] ` : ''}${d.message}`).join('\n') || 'No deploys';

export const formatProjects = (list) =>
  list.map((p) => `${p.slug.padEnd(24)} ${p.url}${p.current_deploy ? '' : '  (not deployed)'}`).join('\n') || 'No projects yet';

export function formatError(err) {
  return `error: ${err.message}${err.details ? '\n  - ' + [].concat(err.details).join('\n  - ') : ''}`;
}

// Copies the app template, filling {{VARS}} and renaming _gitignore (npm strips .gitignore).
export function copyTemplate(src, dest, vars) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dest, entry === '_gitignore' ? '.gitignore' : entry);
    if (statSync(from).isDirectory()) copyTemplate(from, to, vars);
    else writeFileSync(to, readFileSync(from, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m));
  }
}

// Polls a browser-approval login until approved or expired. `poll`, `sleep` and `now` are injected.
export async function waitForApproval({ poll, expiresIn, interval = 2, sleep, now = Date.now }) {
  const deadline = now() + expiresIn * 1000;
  while (now() < deadline) {
    const r = await poll();
    if (r.status === 'approved') return r.token;
    await sleep(interval * 1000);
  }
  throw new CliError('Login link expired before it was approved. Run `cubby login` again.');
}

// --- Agent skill -------------------------------------------------------------------------------
// Same layout as `npx skills`: one canonical copy in ~/.agents/skills/cubby, symlinked into each
// installed agent's skills directory.
export function skillPaths(home) {
  return {
    skillHome: join(home, '.agents', 'skills', 'cubby'),
    agents: {
      'claude-code': join(home, '.claude'),
      codex: join(home, '.codex'),
      cursor: join(home, '.cursor'),
      opencode: join(home, '.config', 'opencode'),
    },
  };
}

export function skillLinks(home) {
  const { skillHome, agents } = skillPaths(home);
  return Object.entries(agents).map(([agent, root]) => {
    const link = join(root, 'skills', 'cubby');
    let state = 'agent not installed';
    if (existsSync(root)) {
      let st = null;
      try { st = lstatSync(link); } catch {}
      if (!st) state = 'not linked';
      else if (st.isSymbolicLink()) state = resolve(dirname(link), readlinkSync(link)) === skillHome ? 'linked' : 'other link';
      else state = 'separate copy';
    }
    return { agent, link, state, root };
  });
}

export function installSkill({ home, src, version, server }) {
  const { skillHome } = skillPaths(home);
  if (!existsSync(join(src, 'SKILL.md'))) throw new CliError('Skill files missing from this CLI install');
  rmSync(skillHome, { recursive: true, force: true });
  mkdirSync(dirname(skillHome), { recursive: true });
  cpSync(src, skillHome, { recursive: true });
  // Keep the advertised skill version in step with this CLI.
  const skillFile = join(skillHome, 'SKILL.md');
  writeFileSync(skillFile, readFileSync(skillFile, 'utf8')
    .replace(/\*\*Skill version: [^*]+\*\*/, `**Skill version: ${version}**`)
    .replaceAll('{{SERVER}}', server));
  const linked = [];
  for (const l of skillLinks(home)) {
    if (l.state === 'agent not installed' || l.state === 'separate copy') continue;
    mkdirSync(dirname(l.link), { recursive: true });
    if (l.state === 'other link') rmSync(l.link, { force: true });
    if (l.state !== 'linked') symlinkSync(skillHome, l.link, 'dir');
    linked.push(l.agent);
  }
  return { path: skillHome, agents: linked, version };
}

export function removeSkill(home) {
  const removed = [];
  for (const l of skillLinks(home)) if (l.state === 'linked') { rmSync(l.link, { force: true }); removed.push(l.agent); }
  rmSync(skillPaths(home).skillHome, { recursive: true, force: true });
  return { removed };
}

export function skillStatus(home) {
  const { skillHome } = skillPaths(home);
  const installed = existsSync(join(skillHome, 'SKILL.md'));
  const version = installed ? readFileSync(join(skillHome, 'SKILL.md'), 'utf8').match(/Skill version: ([^*]+)\*\*/)?.[1] : null;
  const links = skillLinks(home).map(({ agent, state }) => ({ agent, state }));
  return { installed, version, path: skillHome, links };
}
