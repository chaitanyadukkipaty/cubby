// Pure request logic (no I/O): routing, validation and view shaping. Unit-tested in isolation.
import { SLUG_RE, RESERVED_SLUGS, prefixFor } from './config.js';
import { HttpError } from './http.js';

export const isLoopback = (ip) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip ?? '');

export function appSlugFromHost(host, baseDomain) {
  const suffix = `.${baseDomain}`;
  if (!host?.endsWith(suffix)) return null;
  const sub = host.slice(0, -suffix.length);
  return SLUG_RE.test(sub) ? sub : null;
}

export const appUrl = (slug, publicUrl, baseDomain) => `${new URL(publicUrl).protocol}//${slug}.${baseDomain}`;

export const projectView = (p, { publicUrl, baseDomain }) => ({
  id: p.id, slug: p.slug, name: p.name, description: p.description || '', url: appUrl(p.slug, publicUrl, baseDomain), prefix: prefixFor(p.slug),
  unlisted: Boolean(p.unlisted), current_deploy: p.current_deploy || null, last_deployed: p.last_deployed || null,
  schema_hash: p.schema_hash || null, created: p.created,
  ...(p.expand?.owner && { owner: p.expand.owner.email }),
});

// Gallery entries hide internals that only the owner needs.
export const galleryView = ({ prefix, schema_hash, current_deploy, ...p }) => p;

export function checkNewSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length < 3 || slug.length > 40) {
    throw new HttpError(400, 'App name must be 3-40 chars: lowercase letters, digits and single hyphens, starting with a letter');
  }
  if (RESERVED_SLUGS.has(slug)) throw new HttpError(409, `"${slug}" is reserved`);
}

export function projectPatch({ unlisted, description, name } = {}) {
  const patch = {};
  if (typeof unlisted === 'boolean') patch.unlisted = unlisted;
  if (typeof description === 'string') patch.description = description.slice(0, 300);
  if (typeof name === 'string' && name.trim()) patch.name = name.trim().slice(0, 100);
  return patch;
}

export function deployPatch(searchParams) {
  const patch = {};
  if (searchParams.has('unlisted')) patch.unlisted = searchParams.get('unlisted') === '1';
  if (searchParams.has('description')) patch.description = searchParams.get('description').slice(0, 300);
  return patch;
}

export const deployClient = (header) => String(header ?? '').slice(0, 60);

export function settingsPatch(body = {}, newCode) {
  const patch = {};
  if (typeof body.open_signup === 'boolean') patch.open_signup = body.open_signup;
  if (body.rotate_code) patch.signup_code = newCode();
  for (const key of ['max_apps_per_user', 'max_deploy_mb']) {
    if (body[key] !== undefined) {
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new HttpError(400, `${key} must be a whole number between 1 and 10000`);
      patch[key] = n;
    }
  }
  return patch;
}

export const settingsView = (s) => ({ signup_code: s.signup_code, open_signup: s.open_signup, max_apps_per_user: s.max_apps_per_user, max_deploy_mb: s.max_deploy_mb });

// Signup rules that don't need the database: required fields, password length, signup code.
export function checkSignup({ email, password, code } = {}, settings) {
  if (!email || !password) throw new HttpError(400, 'Email and password are required');
  if (String(password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (!settings.open_signup && String(code ?? '').trim().toLowerCase() !== settings.signup_code) {
    throw new HttpError(403, 'Invalid signup code. Ask the server admin for it.');
  }
}

export function compileRoutes(defs) {
  return defs.map(([method, pattern, access, handler]) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    return { method, re, keys, handler, access };
  });
}

export function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    const m = pathname.match(route.re);
    if (!m || route.method !== method) continue;
    return { route, params: Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

// Live docs for agents (the skill tells them to read this first): server facts + the app guide.
export function renderDocs({ guide, settings: s, publicUrl, baseDomain, version, keepDeploys }) {
  const scheme = new URL(publicUrl).protocol;
  const body = guide
    .replace(/^# .*\n/, '')
    .replaceAll('{{SLUG}}', '<app>')
    .replaceAll('{{PREFIX}}', '<app_with_underscores>__')
    .replaceAll('{{URL}}', `${scheme}//<app>.${baseDomain}`);
  return `# Cubby server docs

Server: ${publicUrl}
Version: ${version}
Apps are served at: ${scheme}//<app>.${baseDomain}
HTTPS: ${scheme === 'https:' ? 'yes' : 'no (plain HTTP: do not describe apps as secure)'}
Signup: ${s.open_signup ? 'open' : 'requires a signup code from the server admin'}

## Limits

- Apps per user: ${s.max_apps_per_user}
- Max deploy size (built dist/): ${s.max_deploy_mb} MB
- Deploys kept per app (for rollback): ${keepDeploys}

## CLI

Install or update: \`npm i -g ${publicUrl}/cli.tgz\` (Node.js 20+)
Log in: \`cubby login ${publicUrl} --token <token from the dashboard>\`
Agent skill: installed by \`cubby login\`, or \`cubby skill install\`

# Building apps
${body}`;
}
