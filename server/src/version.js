// What version this server reports (and stamps into /cli.tgz). Two servers must never report the same version
// while running different code, because the CLI launcher picks a CLI by version string:
//   - a build of the exact release tag vX.Y.Z (matching package.json)  →  "X.Y.Z"
//   - any other build with a known commit                                 →  "X.Y.Z-dev+<shortsha>"
//   - no build information at all                                        →  "X.Y.Z"
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function computeVersion({ pkgVersion, override, commit, tag }) {
  if (override) return override;
  if (tag && tag === `v${pkgVersion}`) return pkgVersion;
  if (commit) return `${pkgVersion}-dev+${commit}`;
  return pkgVersion;
}

// Build information comes from the environment when the build provided it (the Docker image always sets
// CUBBY_COMMIT and CUBBY_TAG, possibly empty), otherwise from the git checkout the server runs from.
export function buildInfo(env, root, git = runGit) {
  if (env.CUBBY_COMMIT !== undefined || env.CUBBY_TAG !== undefined) {
    return { commit: env.CUBBY_COMMIT || null, tag: env.CUBBY_TAG || null };
  }
  if (!existsSync(join(root, '.git'))) return { commit: null, tag: null };
  const commit = git(root, ['rev-parse', '--short=7', 'HEAD']);
  const tags = git(root, ['tag', '--points-at', 'HEAD', '--list', 'v*']);
  return { commit: commit || null, tag: tags ? tags.split('\n')[0].trim() : null };
}

function runGit(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// [major, minor, patch] of a version or release tag ("v0.1.2", "0.1.2-dev+abc1234"); null if it isn't one.
export function versionCore(v) {
  const m = String(v ?? '').trim().replace(/^v/, '').match(SEMVER);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareCores(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

// Is the latest release newer than what's running? Dev builds compare by their X.Y.Z base: a build of main
// after the 0.1.1 release reports 0.1.1-dev+…, which is not behind 0.1.1.
export function isUpdateAvailable(current, latestTag) {
  const a = versionCore(current);
  const b = versionCore(latestTag);
  return Boolean(a && b && compareCores(b, a) > 0);
}
