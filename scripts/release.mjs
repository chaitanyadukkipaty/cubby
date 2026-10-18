// Release tooling. Versioning rule (see CONTRIBUTING.md "Releases"): normal releases bump PATCH; only a major
// change, decided by the maintainer, bumps MINOR; 1.0.0 when the maintainer declares Cubby stable.
//
//   node scripts/release.mjs bump [patch]                   prepare a release PR: next patch version
//   node scripts/release.mjs bump minor|major --major-change  only when the maintainer decided on a major change
//   node scripts/release.mjs bump X.Y.Z [--major-change]    explicit version
//   node scripts/release.mjs plan --tags <file> --releases <file> --notes <file>
//       used by .github/workflows/release.yml: decides whether main's version needs a tag and/or a release
//   node scripts/release.mjs verify --sha <sha> --tree <tree> --head-tree <tree> --prs <file> --checks <file>
//       used by release.yml: may this commit be released on the strength of its PR's CI run? (see verifyTested)
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const parse = (v) => {
  const m = String(v).match(VERSION_RE);
  if (!m) throw new Error(`"${v}" is not a release version (X.Y.Z)`);
  return m.slice(1).map(Number);
};

// The body of "## [X.Y.Z] …" up to the next "## [" heading; null when missing or empty.
export function changelogSection(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').replace(/\n\[[^\]]+\]: .*$/gm, '').trim();
  return body || null;
}

// What the release workflow should do for the version on main.
export function planRelease({ version, tags, releases, changelog }) {
  parse(version);
  const tag = `v${version}`;
  const tagged = tags.includes(tag);
  const published = releases.includes(tag);
  if (tagged && published) return { action: 'skip', tag, reason: `${tag} is already released` };
  const notes = changelogSection(changelog, version);
  if (!notes) throw new Error(`CHANGELOG.md has no "## [${version}]" section with entries; a release PR must add one`);
  return { action: tagged ? 'publish' : 'release', tag, notes };
}

// The next version under the versioning rule.
export function nextVersion(current, kind = 'patch', { majorChange = false } = {}) {
  const [maj, min, pat] = parse(current);
  let next;
  if (kind === 'patch') next = `${maj}.${min}.${pat + 1}`;
  else if (kind === 'minor') next = `${maj}.${min + 1}.0`;
  else if (kind === 'major') next = `${maj + 1}.0.0`;
  else next = kind;
  const [a, b, c] = parse(next);
  const ordered = a !== maj ? a > maj : b !== min ? b > min : c > pat;
  if (!ordered) throw new Error(`${next} is not newer than ${current}`);
  const isPatch = a === maj && b === min;
  if (!isPatch && !majorChange) {
    throw new Error(`${next} bumps the minor or major version. Normal releases bump the patch only (${maj}.${min}.${pat + 1}); `
      + 'a minor/major bump is the maintainer\'s decision for a major change: pass --major-change once they have decided.');
  }
  return next;
}

// Moves the [Unreleased] entries under a new version heading.
export function moveUnreleased(changelog, version, date) {
  const marker = '## [Unreleased]';
  const at = changelog.indexOf(marker);
  if (at === -1) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  if (changelog.includes(`## [${version}]`)) throw new Error(`CHANGELOG.md already has a ${version} section`);
  const after = at + marker.length;
  const nextHeading = changelog.indexOf('\n## [', after);
  const entries = changelog.slice(after, nextHeading === -1 ? undefined : nextHeading).trim();
  if (!entries) throw new Error('Nothing under [Unreleased] to release');
  const rest = nextHeading === -1 ? '' : changelog.slice(nextHeading);
  return `${changelog.slice(0, after)}\n\n## [${version}] - ${date}\n\n${entries}\n${rest}`;
}

function setVersion(file, version) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

// The CI jobs main's branch protection requires (.github/workflows/ci.yml; a unit test keeps them equal).
export const REQUIRED_CHECKS = ['Unit tests', 'Integration tests and coverage', 'End-to-end tests (Chromium)'];

// A release PR has already passed CI, and main only takes squash merges of up-to-date PRs, so the merge commit has
// exactly the tree CI tested on the PR's head. Release on that run instead of testing the same code again on main,
// but only when it provably holds: `sha` is the merge of a PR into main, its tree equals the PR head's, and the newest
// run of every required check on that head succeeded. `prs` is GitHub's commits/<sha>/pulls; `checks` the head's
// check runs.
export function verifyTested({ sha, tree, headTree, prs, checks }) {
  const pr = prs.find((p) => p.merged_at && p.merge_commit_sha === sha && p.base?.ref === 'main');
  if (!pr) return { ok: false, reason: `${sha} isn't the merge of a pull request into main, so no CI run covers it` };
  if (!tree || tree !== headTree) return { ok: false, reason: `the code on main differs from what CI tested on #${pr.number} (was the PR behind main?)` };
  const head = pr.head.sha;
  const problems = REQUIRED_CHECKS.map((name) => {
    const runs = checks.filter((c) => c.name === name && c.head_sha === head).sort((a, b) => b.id - a.id);
    if (!runs.length) return `${name}: missing`;
    const { status, conclusion } = runs[0];
    return status !== 'completed' ? `${name}: ${status}` : conclusion === 'success' ? null : `${name}: ${conclusion}`;
  }).filter(Boolean);
  if (problems.length) return { ok: false, reason: `CI on #${pr.number} didn't pass (${problems.join('; ')})` };
  return { ok: true, pr: pr.number, head };
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i === -1 ? null : rest[i + 1];
  };
  // --root points at another checkout (tests run this against a temp repo).
  const root = resolve(flag('--root') ?? resolve(import.meta.dirname, '..'));
  if (cmd === 'bump') {
    const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    const kind = rest.find((a, i) => !a.startsWith('--') && !['--date', '--root'].includes(rest[i - 1])) ?? 'patch';
    const version = nextVersion(current, kind, { majorChange: rest.includes('--major-change') });
    const date = flag('--date') ?? new Date().toISOString().slice(0, 10);
    const changelogPath = join(root, 'CHANGELOG.md');
    writeFileSync(changelogPath, moveUnreleased(readFileSync(changelogPath, 'utf8'), version, date));
    // The root version is the product version; the CLI's package.json carries it too so the in-repo CLI
    // matches a server built from the same checkout.
    setVersion(join(root, 'package.json'), version);
    setVersion(join(root, 'cli', 'package.json'), version);
    if (!rest.includes('--skip-lock')) {
      execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: root, stdio: 'inherit' });
    }
    console.log(`Prepared v${version}. Open a release PR from release/v${version}; merging it publishes the release.`);
    return;
  }
  if (cmd === 'plan') {
    const read = (f) => (f ? readFileSync(f, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : []);
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    const plan = planRelease({
      version,
      tags: read(flag('--tags')),
      releases: read(flag('--releases')),
      changelog: readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
    });
    if (plan.notes && flag('--notes')) writeFileSync(flag('--notes'), `${plan.notes}\n`);
    console.log(plan.reason ?? `${plan.action} ${plan.tag}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `action=${plan.action}\ntag=${plan.tag}\n`);
    return;
  }
  if (cmd === 'verify') {
    // --checks is `gh api --paginate --jq '.check_runs[]'`: one JSON object per line.
    const lines = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const result = verifyTested({
      sha: flag('--sha'), tree: flag('--tree'), headTree: flag('--head-tree'),
      prs: JSON.parse(readFileSync(flag('--prs'), 'utf8')), checks: lines(flag('--checks')),
    });
    if (!result.ok) throw new Error(`${result.reason}. Not releasing; see CONTRIBUTING.md "Releases".`);
    console.log(`CI passed on #${result.pr} (${result.head}) with the same code: releasing without running it again.`);
    return;
  }
  throw new Error('usage: release.mjs bump [patch|minor|major|X.Y.Z] [--major-change] [--date YYYY-MM-DD] [--skip-lock] | plan --tags f --releases f --notes f  (both take --root dir)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
