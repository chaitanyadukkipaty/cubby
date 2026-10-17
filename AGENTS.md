# AGENTS.md

Traps that aren't obvious from reading the code. For workflow (branches, commits, tests, docs), follow CONTRIBUTING.md.

## Tenant isolation (one shared PocketBase)

- App `my-app` owns collections `my_app__*` (`prefixFor`, server/src/config.js). The scheme is only unambiguous because
  slugs can't contain `_` or `__` and collection names can't contain `__`. Don't loosen `SLUG_RE` or the `__` check in
  server/src/schema.js.
- Anything new reachable under `<app>/pb/*` must pass all three proxy checks in server/src/proxy.js: the path allowlist
  (`isAllowed`), the token's `collectionId` belonging to this app (`tokenAllowed`), and no foreign `@collection.` refs
  (`checkForeignRefs`). Check refs on *decoded* text: realtime topics are JSON-escaped (`\u0040`) and URL-encoded.
- `/api/files/<id>/…` arrives with a collection **id**, not a name (the SDK uses `record.collectionId`). Prefix checks
  alone reject legit file URLs; resolve ids through the collection index.
- Platform collections (`users`, `cubby_*`) keep every API rule `null`. The `/pb` proxy is the only thing between them
  and the internet if a rule is ever opened.
- Rules written by agents use unprefixed `@collection.x`; the server rewrites them. Don't make clients prefix them:
  PocketBase rejects `@collection` in client filters for non-superusers anyway.

## Scheduled jobs (server/src/jobs.js, job-runner.js, job-sandbox.js)

- A job's PocketBase access never leaves the server process: the child sends requests over IPC and
  `forwardJobRequest` checks them (`jobRequestAllowed`: this app's `/records` and files only, plus
  `checkForeignRefs`) before forwarding as superuser. Treat every IPC message as untrusted (job code can call
  `process.send`). Never hand the child a token, and never widen the allowlist to collection, batch or auth routes:
  as superuser they'd reach other apps and platform collections.
- The Node permission model doesn't restrict the network, so job-sandbox.js patches `net.Socket#connect` (with a
  filtered `lookup`) to refuse loopback and private addresses before job code loads. Keep new connection paths
  going through it; PocketBase listens on 0.0.0.0 inside the container.
- The child may read only server/src, server/package.json, the PocketBase SDK and its job folder, all as real paths
  (macOS tmp dirs are symlinks). Keep job-runner.js and job-sandbox.js free of imports beyond Node built-ins, and
  never put secrets under server/src.
- V8 can't write coverage under the permission model, so job-runner.js never shows in coverage; test the logic in
  job-sandbox.js in-process (tests/unit/job-sandbox.test.js).
- Job code lives at `sites/<app>/jobs-<deployId>/`, beside the site, never inside it: createDeploy moves
  `__cubby_jobs/` out before the deploy goes live. Backups must include `secrets/` (the key for `cubby env`
  values) together with the database, or restored secrets can't be decrypted.
- The scheduler is in-process and per-minute (single server process, like the rest of the in-memory state). Missed
  minutes are skipped on purpose, and `cubby jobs run` waits on the HTTP response, which is why the time limit is
  capped under fetch's 300s headers timeout.

## Schema changes must never lose data

- Push is non-destructive on purpose: fields/collections missing from `schema.json` are kept and reported as `kept`.
  Only `dropFromSchema` deletes. Don't "sync" by removing what's absent.
- PocketBase identifies fields by `id`, not name. Always send existing ids (`mergeFieldIds`) or an update can turn into
  drop + create. System fields must be kept on every update.
- Type changes are refused by design; don't add a coercing migration.
- `users` only ever gains fields (`ensureFields`, server/src/pb.js). Changing an existing platform field there needs an
  explicit migration; other platform collections are upserted in full.
- `cubby deploy` decides whether to push by comparing the sha256 of the local file with `cubby_projects.schema_hash`.
  Schema edits made outside the CLI (PocketBase UI) aren't detected; `schema drop` clears the hash to force a push.

## Request routing and trust

- One process serves the dashboard, API and every app; routing is by `Host` (`appSlugFromHost`). The dev header
  `x-cubby-project` is honored **only** for `/pb/*` and `/__cubby/*` on the root host. Never widen it.
- `X-Forwarded-For` is trusted only from loopback (`clientIp`, server/src/http.js), because Caddy in the container
  overwrites untrusted values. Integration tests rely on this to spread requests across fake IPs and dodge the
  10/min signup+login limiter; don't "fix" flaky auth tests by weakening `clientIp` or the limiter.
- `/_internal/tls-check` must stay loopback-only: it decides which hostnames Caddy requests certificates for.
- IP mode is HTTP-only by design: sslip.io isn't on the Public Suffix List, so Let's Encrypt rate limits are shared
  worldwide. Don't add TLS for sslip hosts.

## State that lives in memory

- Device-login codes, rate-limit counters and the settings row (`getSettings` cache) are per-process. Cubby assumes one
  server process; anything multi-process needs shared storage first. Settings edited directly in PocketBase aren't seen
  until restart; go through `updateSettings`.
- App metrics (server/src/metrics.js) count in memory and add to `cubby_metrics` buckets on each flush (every 60s,
  before each metrics read, and on SIGTERM via `onShutdown`). Flushes must stay serialized, or two can create the
  same bucket. The visitor salt lives only in memory and rotates per UTC day; never persist it or store raw IPs.
- `/cli.tgz` is packed once at boot from `cli/` (src, template, skill) and stamped with the version the server
  reports (`config.version`), not `cli/package.json`'s. CLI, template or skill edits need a server restart to be served.

## Tokens and secrets

- API tokens are stored in plain text on purpose (the dashboard shows them again) next to a sha256 `key_hash` used for
  lookup. Look tokens up by hash, never by the plain column.
- install.sh deletes `CUBBY_ADMIN_PASSWORD` from the env file after first boot, and `bootstrap` only *creates* the admin.
  Changing admin credentials via env later does nothing; use `cubby-server reset-password`.
- The same goes for every first-boot setting (`CUBBY_SIGNUP_CODE`, `CUBBY_SERVER_NAME`, `MAX_*`): `bootstrap` only reads
  them when the settings row doesn't exist yet. After that, change them through the Admin tab / `/api/admin/settings`.

## Contracts between files that change together

- Skill text: keep the exact `**Skill version: X**` marker in cli/skill/cubby/SKILL.md; server/src/cli-dist.js and
  cli/src/lib.js stamp it and `skill status` parses it. The skill is server-neutral on purpose (one skill, many
  servers): don't put a server URL or `{{…}}` placeholder back in. Servers are registered by `/skill.sh` and
  `cubby login` in `~/.cubby/config.json`.
- Backups are named `cubby-YYYY-MM-DD.zip` / `sites-YYYY-MM-DD.tar.gz` (server/src/backups.js); docker/cubby-server
  parses those names for `backups` and `restore`.
- In the container PocketBase listens on `PB_LISTEN=0.0.0.0:8090` but is published only to host loopback
  (`-p 127.0.0.1:8090:8090`). Don't change the publish to `8090:8090`: it would expose the PocketBase admin UI.
- The template's `<script src="/__cubby/config.js">` must stay a classic script before `main.tsx`: the file only
  exists at runtime (served per app), so Vite must not try to bundle it. Its "can't be bundled without type=module"
  warning is expected.
- The dashboard's pure helpers live between the `BEGIN/END PURE HELPERS` markers in server/public/index.html; unit
  tests load that block in a `vm`. Keep them pure (no DOM, no globals defined later) and inside the markers.

## Version skew between servers (the launcher)

- The rule: the CLI always matches the server it's talking to; in an app folder, the server in cubby.json. The
  global `cubby` bin is cli/src/launcher.js: every command in `SERVER_COMMANDS` (login, signup, whoami, help and all
  app commands) runs the CLI of the target server's version, downloaded into `~/.cubby/cli/<version>/`; only
  `LOCAL_COMMANDS` (servers, use, logout, skill, version) run in the launcher. Never pick a CLI by "newest". A new
  command must be put in one of the two sets deliberately (a unit test checks the classes).
- The oldest supported server is `MIN_SERVER_VERSION` (cli/src/servers.js, 0.1.1, defined only there). The launcher
  refuses older or unparseable server versions with one line asking the admin to upgrade; a server reporting the
  launcher's own version always passes (same code, e.g. before a release bump). Raising the minimum is a maintainer
  decision, like a minor bump.
- Config compatibility: every CLI from 0.1.1 on reads config `format` 1. Changing the shape of `config.json` or
  `cubby.json` needs a format bump plus a migration in the readers of every supported CLI version (and `/skill.sh`);
  readers refuse unknown newer formats with a clear message instead of guessing.
- Matched CLIs read and write the real `~/.cubby/config.json` themselves, so every CLI version must understand the
  current config format. The launcher pins app commands with `CUBBY_SERVER` (the server it resolved) and sets
  `CUBBY_LAUNCHED` so the child never dispatches again. Changing `config.json` or `cubby.json` shape means bumping
  `format` and adding a migration in cli/src/servers.js and `/skill.sh` (which edits config.json itself). A newer
  format is read leniently (to find servers) but never rewritten: `writeConfig` refuses it.
- New commands and flags go in the command table (cli/src/commands.js), which drives `cubby help --json` and each
  server's `/docs.md`. Never add them to SKILL.md: one skill serves every server version, so it may only name the
  frozen core in cli/skill/core-commands.json (tests/unit/skill-core.test.js enforces it). Agents discover
  anything else with `cubby help --json`, which answers for the server they target.
- The installed skill only moves forward: the launcher refreshes it from a newer CLI before running it, and neither
  `installSkill` nor `/skill.sh` ever installs an older one.
- Cached CLIs get a `node_modules` symlink to the launcher's own, so the CLI's runtime dependencies are shared
  across versions. Keep them few and backward compatible (today only `tar`).
- `cubby.json` pins an app to its server URL and is never rewritten to follow another server; moving an app is an
  explicit `cubby link <app> --server <url>`.
- `CUBBY_VERSION_OVERRIDE` makes a server report and stamp another version. It exists for two-version tests; don't
  use it to paper over a real mismatch.

## Tests

- Start servers only through tests/helpers/server.js (free ports, temp data dirs). Never point tests at a running dev
  server or the Docker container.
- `fetch()` silently drops `Host`; use `hostRequest` for `<app>.localhost` routing.
- c8 collects child-process coverage only if the server exits cleanly. Its SIGTERM handler is registered only when
  `PB_SPAWN=1` (server/src/pb.js), so keep that in tests.

## Versions and releases

- Never bump the version in a feature PR. Normal releases bump PATCH (0.1.1 → 0.1.2); MINOR/MAJOR only when the
  maintainer decided on a major change (`scripts/release.mjs bump` refuses without `--major-change`). Only release PRs
  (`release/vX.Y.Z`, made with `node scripts/release.mjs bump`) change versions; they bump root and
  cli/package.json together (a unit test checks they match the lockfile).
- Never push, move or delete `v*` tags: a ruleset blocks it, and the Release workflow is the only thing that creates
  them (over SSH with the `RELEASE_DEPLOY_KEY` deploy key). It tags when main's version has no tag and refuses if
  CHANGELOG.md has no section for that version.
- The reported version must differ whenever the code differs: `X.Y.Z` only for a build of tag `vX.Y.Z`, otherwise
  `X.Y.Z-dev+<sha>` (server/src/version.js). The launcher picks CLIs by this string, so don't "simplify" it to
  package.json. Docker builds get the commit/tag via `CUBBY_COMMIT`/`CUBBY_TAG` build args from `cubby-server`;
  tests set both to `''` (= unknown, plain version) in tests/helpers/server.js.
- The daily release check (server/src/updates.js) is the only outbound request Cubby itself makes (app jobs make
  their own). Tests must never reach GitHub: the helper sets `CUBBY_UPDATE_CHECK=0`; tests that need it point `CUBBY_UPDATE_URL` at a local stub.
- docker/ref.sh is sourced by both install.sh (downloaded from main when piped) and cubby-server, so it must stay
  compatible with older checkouts' callers. cubby-server runs everything inside `main()` and replaces itself by
  rename at the end of `upgrade`; keep both, or an upgrade can edit the script bash is executing.
- Shell-script tests run real bash with fake `docker`/`curl`/`git` first on `PATH`. When building those envs, put
  the fake `PATH` *after* spreading `process.env`, or the real docker runs (and can touch a real `cubby` container).

## Git and pull requests

- Coverage thresholds live in `.c8rc.json` (unit + integration) and `.c8rc.unit.json` (unit only), and CI fails
  below them. Never lower them, and don't exclude files from `include` to dodge them; add tests. After raising
  coverage, run `npm run coverage && npm run coverage:unit && npm run coverage:ratchet` and commit the new thresholds.

- A feature PR isn't done until `README.md` and `docs/index.html` tell its story, not just list it: update the
  opening example, step-by-step instructions, diagrams and status lists, and retake `docs/assets/*.png` when the UI
  changes (they're static and go stale silently), then run `npm run docs:stamp`: image links carry a `?v=<hash>` that
  a unit test checks, so caches serve the new files. Grep both files for the old behavior. Past feature PRs that only
  added a table row had to be followed by a separate README rewrite.

- `main` is protected: no direct pushes (admins included), PRs need the three CI checks (Unit tests,
  Integration tests and coverage, End-to-end tests (Chromium)) passing on an up-to-date branch,
  and merges are squash-only. Never try to push to `main` or disable protection to get a change in; open a PR.
- Stacked PRs: once the base PR is squash-merged, the stacked branch still carries the base's original commits and
  conflicts. Rebase only its own commits: `git rebase --onto origin/main <last-commit-of-base> <branch>`, then
  `git push --force-with-lease`. Don't merge `main` into it (linear history is required).
- Commit with the repo-local git identity; never pass `--author` or change `user.email`. Merging with `gh` should
  pass `--author-email` explicitly, or GitHub records the account's default email.

## Naming and CLI shape

- The project was renamed from "Hatch" because Python's `hatch` CLI owns that command. The old name must not
  reappear anywhere, including env vars, headers (`x-cubby-*`) and collection names.
- Every CLI command must work non-interactively and support `--json`; destructive commands require `--yes` instead
  of prompting. Agents are the primary users of the CLI.
