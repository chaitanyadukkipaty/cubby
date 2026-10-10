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
- `/cli.tgz` is packed once at boot from `cli/` (src, template, skill) and stamped with the **root** package.json
  version. CLI, template or skill edits need a server restart to be served; `cli/package.json`'s version is ignored.

## Tokens and secrets

- API tokens are stored in plain text on purpose (the dashboard shows them again) next to a sha256 `key_hash` used for
  lookup. Look tokens up by hash, never by the plain column.
- install.sh deletes `CUBBY_ADMIN_PASSWORD` from the env file after first boot, and `bootstrap` only *creates* the admin.
  Changing admin credentials via env later does nothing; use `cubby-server reset-password`.

## Contracts between files that change together

- Skill text: keep the exact `**Skill version: X**` and `{{SERVER}}` markers in cli/skill/cubby/SKILL.md. They're
  rewritten by both server/src/cli-dist.js (served copy) and cli/src/lib.js (installed copy, also parsed by
  `skill status`). `npx skills` copies keep the literal `{{SERVER}}`, so the skill text must handle it.
- Backups are named `cubby-YYYY-MM-DD.zip` / `sites-YYYY-MM-DD.tar.gz` (server/src/backups.js); docker/cubby-server
  parses those names for `backups` and `restore`.
- In the container PocketBase listens on `PB_LISTEN=0.0.0.0:8090` but is published only to host loopback
  (`-p 127.0.0.1:8090:8090`). Don't change the publish to `8090:8090`: it would expose the PocketBase admin UI.
- The template's `<script src="/__cubby/config.js">` must stay a classic script before `main.tsx`: the file only
  exists at runtime (served per app), so Vite must not try to bundle it. Its "can't be bundled without type=module"
  warning is expected.
- The dashboard's pure helpers live between the `BEGIN/END PURE HELPERS` markers in server/public/index.html; unit
  tests load that block in a `vm`. Keep them pure (no DOM, no globals defined later) and inside the markers.

## Tests

- Start servers only through tests/helpers/server.js (free ports, temp data dirs). Never point tests at a running dev
  server or the Docker container.
- `fetch()` silently drops `Host`; use `hostRequest` for `<app>.localhost` routing.
- c8 collects child-process coverage only if the server exits cleanly. Its SIGTERM handler is registered only when
  `PB_SPAWN=1` (server/src/pb.js), so keep that in tests.

## Naming and CLI shape

- The project was renamed from "Hatch" because Python's `hatch` CLI owns that command. The old name must not
  reappear anywhere, including env vars, headers (`x-cubby-*`) and collection names.
- Every CLI command must work non-interactively and support `--json`; destructive commands require `--yes` instead
  of prompting. Agents are the primary users of the CLI.
