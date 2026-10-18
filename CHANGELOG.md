# Changelog

All notable changes to Cubby are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Scanner and brute-force bans with fail2ban. The installer sets it up on the host (`--no-fail2ban` skips it) with two
  jails: `cubby-probe` bans IPs that ask for scanner paths (`/.env`, `/.git/config`, `*.php`, `/wp-login.php` …) 5
  times in 10 minutes, and `cubby-ratelimit` bans IPs that hit the login limit 30 times; bans start at 10 minutes and
  double for repeat offenders. They block Cubby's web ports only (in Docker's `DOCKER-USER` chain); SSH keeps
  fail2ban's own jail. Caddy writes the access log fail2ban reads only while it's on, without headers or `?token=`,
  and keeps it 7 days. Existing servers turn it on with `sudo cubby-server fail2ban enable` (upgrades say so once);
  `fail2ban status`, `unban <ip>` and `disable` manage it.
- **Admin → Security** lists current bans (why, when, until, the hosts and paths each IP swept) with **Unban**, and 90
  days of ban history. Agents get the same with `cubby admin bans` and `cubby admin bans unban <ip> --yes`; every unban
  shows in the activity log.

### Fixed

- Paths with a part starting with a dot (`/.env`, `/.aws/credentials`, `/admin/.env`) are a 404 instead of the app's
  page, so vulnerability scans no longer show up as page views or tell scanners a file exists. `/.well-known/` is
  still served.
- **Admin → Apps** no longer shows a stray "null" when an admin opens the data panel of an app they own.

## [0.1.5] - 2026-10-18

### Added

- Dashboard Home is now your agents' activity timeline: one line per change, grouped by day, with the agent's badge
  and the app. The live deploy has **Roll back** (with a confirm), and a failed job gets **Copy fix-it prompt**.
  "What should your agent do next?" offers prompts to copy, and a summary column (above the timeline on phones)
  shows who's on your apps now, views over 7 days and your agents. Failed jobs and apps with many API errors are
  flagged at the top. A new user with no agent and no app gets three connect steps instead.
- The dashboard's **Agents** page lists your agents with their machine, the apps they touched and when they were last
  seen; rename one inline or revoke it (its key stops working at once). **Connect a new agent** copies the setup
  prompt, and the token for scripts and CI moved here from Home. `/agents/<id>` shows what one agent did.
- Each app has a page in the dashboard, `/apps/<app>[/<tab>]`, with tabs that keep their place on reload (and scroll
  sideways on phones). **Overview** has a KPI strip (active now, views, visitors, API error rate, accounts) and
  hand-drawn charts of views, unique visitors, active visitors and API errors over 24 hours, 7 or 30 days, sharing one
  time axis with every deploy drawn through them; each has a text summary and a table fallback, and top paths show
  when the server reports them. **Activity**, **Deploys** (roll back to any kept deploy), **Jobs**, **Env** (secrets
  by name; values are never shown) and **Settings** (gallery visibility, delete after typing the app's name) follow.
  Empty tabs suggest what to ask your agent. The **Apps** list became a table with active visitors, a 7-day views
  sparkline and who deployed each app last.
- The dashboard's **Admin** page has tabs with their own links (`/admin/<tab>`, kept on reload): **Overview**
  (server-wide users, views, visitors, active now, API error rate and free disk; every app's views charted over 7
  days; the top apps by views; the most active agents across all users; the disk at a glance; updates), **Users**,
  **Apps** (each app's older deploys, listed and deleted one by one or all at once; the live one never), **Agents**
  (every agent that changed something in the last 30 days, with its owner), **Jobs**, **Settings** (name, invites,
  limits, and how many nightly backups to keep with what that would delete and free, or add, before saving) and
  **Storage** (a disk bar by category, apps by size, backups with Back up now, Delete with the newest and only-backup
  guards and a copyable `sudo cubby-server restore <date>`, and data-clear snapshots with Purge).
  `/api/admin/metrics` now also returns every app's hours and days summed, for the Overview chart.
- Each app has a **Data** tab (`/apps/<app>/data`): its collections with record counts and uploaded file sizes (the
  app's user accounts unticked, with the new-passwords warning when ticked); Empty, Drop, or delete records of one
  collection by a filter (with examples and a "created before" date); a mandatory preview (matches N of M, up to five
  records to tick and delete only those, cascades, what blocks it, an extra tick above 10,000 records) that goes
  stale when the form changes; the app's name typed to confirm; then the snapshot it saved. Snapshots are listed with
  Restore (dry run first, with schema drift and Overwrite) and Purge (not for an admin's snapshot, unless you're an
  admin; one whose uploads were over the cap says they weren't kept).
- Admins clear any app's data from **Admin → Apps → Clear data** (`/admin/apps/<app>`), with a required reason. The
  owner sees a banner on the app's page and an item at the top of Home, linking to the snapshots, until they dismiss it.
- Scheduled jobs. An app can run code on a cron schedule (UTC): one file per job in `cubby/jobs/`, bundled with its
  npm dependencies by `cubby deploy` and rolled back with the deploy. Each run is a sandboxed Node.js process (no
  access to the server's files, environment, processes or local network) whose database client reaches only that
  app's records, as admin. `cubby jobs` lists jobs; `cubby jobs run <job>` runs one now and prints its log;
  `cubby jobs logs` and `cubby jobs pause|resume` do what they say. A job never overlaps itself, and missed runs are
  skipped.
- App secrets for jobs: `cubby env set NAME=value` (or `--from-stdin`), `cubby env list`, `cubby env unset NAME --yes`.
  Values are encrypted with a server key in `DATA_DIR/secrets`, which nightly backups now include.
- The dashboard lists an app's jobs on its card, with Run now, Pause and the last log. The Admin tab lists every
  app's jobs and has a switch to stop them all and a time limit per run (60 seconds by default).
- `/api/info` lists optional server features (`features: ["jobs"]`).
- Admin storage and backups from the CLI, the first `cubby admin` commands. `cubby admin storage` shows where the disk
  goes (database, uploaded files, current deploys, older deploys kept for rollback, backups, free disk) and per app,
  measured on demand and reused for 5 minutes. `cubby admin backups` lists backups by date with their database and
  sites sizes; `create` backs up now (one at a time, shared with the nightly run); `delete <date> --yes` removes both
  files of the pair, warns when it was the newest, and refuses the only backup without `--leave-none`. Restore stays
  `sudo cubby-server restore <date>`. Non-admins get a clear error. API: `GET /api/admin/storage`,
  `GET|POST /api/admin/backups`, `DELETE /api/admin/backups/<date>[?leave_none=1]`.
- How many nightly backups to keep is now a server setting (1 to 90), seeded from `BACKUP_KEEP` on first boot only;
  existing servers keep using `BACKUP_KEEP` (7 if unset) until it's changed. `cubby admin backups keep <n>` sets it
  and says what the next nightly prune deletes and frees (or roughly how much more disk it takes); lowering it needs
  `--yes`. API: `backup_keep` in `PATCH /api/admin/settings`; `GET /api/admin/backups[?keep=N]` returns an `estimate`.
- Admins can delete older deploys of any app, never the one it serves: `cubby admin deploys <app>` lists them,
  `prune [--keep <n>] --yes` deletes them oldest first (sparing the newest n), `delete <id> --yes` deletes one. Their
  jobs folders go too and they leave the app's rollback list. API: `GET /api/admin/apps/<app>/deploys`,
  `POST /api/admin/apps/<app>/deploys/prune`, `DELETE /api/admin/apps/<app>/deploys/<id>`.
- Every approved `cubby login` becomes its own named agent with its own key, instead of handing out your one token.
  The CLI tells the server which agent tool it runs under (Claude Code, Codex, Cursor, otherwise "Terminal";
  `--client` overrides it) and the machine's name, so agents are named like "Claude Code · chaitanya-mbp". Logins
  from older CLIs still work and get a dated name ("Agent · 2026-10-17"). Once you sign in, the approval page says which agent is
  asking. `cubby agents` (and `GET /api/agents`) lists your agents and marks the current one; the dashboard's token,
  and tokens from before this release, show up as "Manual token" and keep working. API keys gain an empty `scopes`
  field, reserved for limiting keys later.
- Rename and revoke agents one at a time: `cubby agents rename <id> <name>` and `cubby agents revoke <id> --yes`
  (`PATCH` / `DELETE /api/agents/:id`). A revoked key gets 401 on its next request while your other agents keep
  working; an agent may revoke itself, which logs it out like `cubby logout`. You can only see and change your own
  agents. `cubby agents` shows each agent's ID and when it was last seen.
- An activity log of who changed what: app create, update and delete, deploys (deploy id and file count),
  rollbacks, schema pushes (created, updated and kept) and drops, secrets set and removed (key names only, never
  values), jobs run now, paused and resumed, agent logins, and admin actions on users, apps and backups
  (`cubby admin backups create|delete`). Each entry names the agent that made it, or "dashboard" for the dashboard
  and the manual token. Reads aren't logged. `cubby activity [app] [--agent <id>|dashboard] [--limit n]` (and
  `GET /api/activity`) shows your own entries; admins see everyone's with `--all` (`GET /api/admin/activity`).
  Entries older than 30 days are pruned before every backup (nightly, `cubby admin backups create` and
  `cubby-server backup`). An app's entries outlive the app until they age out; deleting a user deletes theirs.
  Stored in a new platform collection, `cubby_activity`, closed to apps like the others. Entries also carry a small
  structured `meta` where it helps (deploys `{ deploy, files }`, rollbacks `{ deploy }`, job runs `{ job, status }`,
  job pause and resume `{ job }`; otherwise `null`, and never a secret value), so the dashboard doesn't have to parse
  the summary text.
- Page views and unique visitors per app, counted by the server as it serves an app's pages: no script in the app,
  no cookies. Assets, `/pb` calls, HEAD requests, prefetches and obvious bots don't count. A visitor is a hash of IP
  address and browser with a salt that lives only in memory and changes every UTC day; IPs are never stored. Counts
  are flushed to the database every minute (and on shutdown): views per hour, views and visitors per UTC day.
  `cubby metrics <app>` shows one app, `cubby metrics` all of yours, `--range` up to 1y (default 24h). Owners see
  their apps; admins see any. `/api/info` lists `metrics` in `features`.
- Live and backend metrics in `cubby metrics`: active now (visitors seen on a page or a `/pb` call in the last 5
  minutes, in memory only, no heartbeat) and its peak per hour; `/pb` API requests and 5xx errors per hour with the
  error rate; and the app's accounts with signups per day, read from PocketBase when asked. `cubby metrics` without
  an app also shows each app's active now and API errors.
- Top paths, deploy markers, a year of history and admin totals in `cubby metrics`. Each UTC day keeps its 10 most
  viewed paths (query strings dropped, cut at 200 characters; the rest is "other"), stored as a small `paths` field
  on the day row. Reports list the top paths and the deploys in the range. The nightly maintenance folds hourly rows
  older than 30 days into their day (API counts summed, peak kept) and deletes days older than a year; `--range` now
  goes up to `1y` (by hour up to 30 days, by day beyond) and takes `1h`. `cubby metrics --all` and
  `GET /api/admin/metrics` sum every app with the 10 busiest, for admins (others get a clear error). The app guide
  (`AGENTS.md`) tells agents to check `cubby metrics <app> --range 1h` for errors after deploying.
- Clear an app's data without deleting the app. `cubby data list [app]` shows its collections with record counts
  and uploaded file sizes; `cubby data clear [app] --collections a,b [--drop] --yes` empties them (keeping fields and
  rules) or drops them (which clears the schema hash, so the next deploy pushes `schema.json`). Before anything is
  deleted, Cubby works out what PocketBase deletes along with it (cascades however many hops away, self-relations and
  relations holding several ids included) and what only loses a link, and writes a snapshot to
  `DATA_DIR/snapshots/<app>/<id>/`: schema, deleted records as JSON lines, the unlinked records as they were, and the
  uploaded files of everything deleted, cascades included, when they total 100 MB or less (otherwise a warning says
  they can't be restored). A required relation that doesn't cascade and would be left pointing at nothing blocks the
  clear: the preview names it and the clear is refused with a 409 before anything is snapshotted or deleted.
  Emptying collections with no records changes nothing. Clears, restores and schema changes of one app run one at a
  time. Snapshots are kept 7 days (pruned by the nightly maintenance),
  deleted with the app, and listed as their own category in `cubby admin storage`. The app's users collection is only
  cleared when named, with a warning about passwords. Owners or admins only; each clear is in the activity log. API:
  `GET /api/projects/<app>/data`, `POST /api/projects/<app>/data/clear`.
- Delete only some records: `cubby data clear [app] --collection c --filter "<PocketBase filter>"` or `--ids a,b`.
  Only the matched records (with their files, within the cap) and what cascades from them are snapshotted.
  `--dry-run` (and any clear without `--yes`) reports "matches N of M", 5 sample rows, cascades and what blocks
  the clear, deleting nothing. More than 10,000 matches are refused without `--all-matching`. Filters run as superuser, so they pass
  the proxy's `checkForeignRefs` (plus a check on back-relations) and only ever target the app's own collection.
- Undo a clear: `cubby data snapshots [app]` lists snapshots (who, why, what, counts, expiry) and
  `cubby data restore <id> [--overwrite --yes] [--dry-run]` brings one back. Restores are additive: records keep
  their ids and existing ids are skipped, so restoring twice is harmless; `--overwrite` replaces them after
  snapshotting the versions it replaces. Dropped collections are recreated from the snapshot's schema (a wipe's
  too, with or without records), fields removed since are skipped, and fields whose type changed refuse the
  restore; `--dry-run` runs the same checks and reports all of it. Links between restored records come back too,
  even when collections point at each other, and records that stayed but lost a link get the removed ids back
  (in place, keeping ids added since; a single relation only while it's empty).
  Checked against the bundled PocketBase (0.40): a superuser can't read password hashes, and writing one back
  just sets it as a new password, so restored accounts get new random passwords, which the restore lists. Files
  come back under new names and `created`/`updated` are new. API: `GET /api/snapshots[?app=]`,
  `POST /api/snapshots/<id>/restore`.
- Admin data clears are never silent. An admin clearing someone else's app must give `--reason`; the owner gets an
  activity entry naming the admin and the reason, and the app an `admin_clear` flag (for the dashboard's banner,
  shown by `cubby info`) until the owner dismisses it with `DELETE /api/projects/<app>/admin-clear`. `--wipe` drops
  every collection after one snapshot and clears the schema hash, so the next `cubby deploy` recreates them. Owners
  can restore any snapshot of their app but can't purge an admin's; admins can restore and purge any
  (`cubby data purge <id> --yes`, `DELETE /api/snapshots/<id>`).
- A command palette in the dashboard: ⌘K (Ctrl+K), or Search in the sidebar, jumps to a page or one of your apps
  and copies the setup prompt or a common command (`cubby deploy`, `cubby login`), switches theme or logs out.
  Fuzzy search, fully keyboard-driven.

### Changed

- `cubby rollback` restores the jobs a deploy shipped, not just the frontend.
- Regenerate on the dashboard replaces only the manual token (for scripts and CI). Agents keep their own keys; revoke
  them one at a time with `cubby agents revoke`.
- A key's last use is now written at most once a minute instead of on every request.
- `GET /api/metrics` (and `cubby metrics --json` without an app) gives each app its views and visitors per UTC day
  (`days: [{ start, views, visitors }]`). The dashboard's Home and Apps list draw every app's 7-day views from that
  one request instead of asking each app for its full report.

### Fixed

- Backup retention deleted database zips and sites tarballs separately, so a day missing one file could leave half
  pairs behind. It now deletes whole pairs by date.
- A backup on a server with no deploys and no secrets yet failed (`no paths specified to add to archive`); it now
  writes an empty sites tarball so every backup is a whole pair.
- The dashboard has a sidebar (a bottom bar on phones) and its own page per link: Home (`/`, the setup prompt and
  your apps), Apps (`/apps`, and `/apps/<app>` for one app), Agents (`/agents`, a placeholder for now), Explore
  (`/explore`, everyone's apps, formerly the gallery tab) and Admin (`/admin`). Links can be bookmarked and survive a
  reload; signing in from a deep link lands on that page. A crisp light theme and a near-black dark theme follow the
  system, and a toggle under your email overrides it (remembered in the browser).
- The dashboard is now an HTML shell, a stylesheet and ES modules served with hashed URLs (still no build step and
  no dependencies), instead of one HTML file.
- Bad CLI flags such as `--bogus` or `--limit -1` print one error line (JSON with `--json`) and exit 1, instead of
  a stack trace. `--client` and `CUBBY_CLIENT` names beyond Latin-1 (emoji, CJK) work instead of failing every
  command with "Cannot reach"; older CLIs keep working.
- The API answers 400 instead of 500 for a `null` or non-object JSON body and for a bad `%`-escape in the path;
  array bodies are no longer taken as `{}`. Size limits under 1 MB are named in KB ("Body exceeds 64 KB limit")
  instead of "0MB".
- A stale dashboard tab no longer signs out a fresh session another tab started.
- An admin's data clear shows to the app's owner as the admin's (`via: "admin"`, "Admin" in the feed and CLI), not
  as the owner's dashboard. An admin deleting an app's older deploys is now in both their logs, with the deploy ids.
- Metrics: visitors and top paths are per UTC day, so reports carry `days_from`, and `cubby metrics` says "visitors
  since <day> 00:00 UTC" when the range starts mid-day. Accounts a data restore brings back no longer count as
  signups.
- Backups: a second backup the same day replaces the day's pair only once the new one is complete, and a failed
  sites/secrets tarball fails the backup instead of being ignored.
- Data: `cubby data clear --ids` applies the 10,000 limit to the records that match; a restore warns about new
  passwords only when it creates accounts; a filter PocketBase rejects says which names aren't fields (listing the
  collection's) instead of "Something went wrong"; not-found errors cut ids and names longer than 40 characters.
- Dashboard on phones: pages start right under the top bar, nothing scrolls sideways (long names, paths and the app
  header wrap or truncate; top paths keep Views visible), snapshot Restore and Purge fit, and the live dot stays on
  the title's line.
- Dashboard: text and chart graphics meet WCAG AA contrast in both themes (a darker orange accent and green,
  readable chart axes). The docs site uses the new accent too.
- Dashboard: an unknown page shows "Page not found" (status 404) with links back; an unsupported `?range=` is
  corrected in the URL; the Deploys tab's From names the agent that deployed, else the CLI's client name; deploys
  made close together share one chart label ("v1–v4"); agents sharing a name are told apart by tool and machine.
- Dashboard: failed admin and job actions show their error instead of failing silently; settings errors name the
  field by its label, and number fields are checked before saving; sign up and log in send one request at a time;
  the theme button follows system theme changes; the token's Reveal turns into Hide.

### Security

- Realtime subscriptions through an app's `/pb` are now limited to that app's own collections.
- Agent keys can no longer regenerate the manual token, so a revoked agent can't keep a full-access token. A
  device-login link can be approved only once. Agent names drop bidi overrides and other invisible format
  characters.
- Data-clear filters and scheduled jobs' record queries can't filter or sort on accounts' password hashes or token
  keys (they run as superuser).

## [0.1.4] - 2026-10-17

### Added

- The server's root URL answers agents and curl (anything without a browser user agent) with the setup steps as plain
  text, so "set up Cubby from https://your-server" works without the dashboard. Browsers still get the dashboard.

### Changed

- The dashboard's connect card is redesigned around one "Copy prompt for agent" button: a prompt to paste into your
  agent instead of a bare `curl … | sh` command, which agents rightly flagged as suspicious. The prompt names the
  server, installs the skill with `npx skills add chaitanyadukkipaty/cubby --skill cubby -g` (or the server's
  `/skill.sh` without npm) and has the agent connect, so the server becomes your default. `/skill.sh` keeps working
  as before.
- The skill takes the server URL from the user's message when the CLI isn't installed yet.

## [0.1.3] - 2026-10-17

### Fixed

- The dashboard's Log in tab (and Sign up, when signup is open) no longer shows a stray "null" under the password
  field.

## [0.1.2] - 2026-10-16

### Added

- IP-only installs work when port 80 is taken. The installer names what holds the port and offers a free one (or
  take one with `--http-port`); it becomes part of the URL, like `http://203-0-113-5.sslip.io:8080`. `--pb-port` does
  the same for the PocketBase admin port (8090), and IP mode no longer publishes 443.

### Changed

- The installer, `cubby-server rebuild`/`upgrade` and `set-domain` check the ports they need first and refuse, naming
  the process or container holding one, instead of failing in `docker run`. A domain needs 80 and 443.

## [0.1.1] - 2026-10-10

### Added

- Each server has a display name, like "Priya's Cubby". The installer asks for it (or set `CUBBY_SERVER_NAME` on
  first boot), admins can rename it in the Admin tab, and it's shown on the dashboard, the sign-in and agent-approval
  pages, `/api/info`, `/docs.md` and in CLI output, with a "runs on Cubby" credit.
- One CLI and one agent skill for several servers. `~/.cubby/config.json` keeps a named list of servers;
  `cubby servers`, `cubby use <name>`, `cubby logout --server <name>` / `--all` and `cubby version` are new, and
  `--server` accepts a server's name. Running a server's `/skill.sh` adds it to the list.
- Servers on different Cubby versions work side by side: the `cubby` command is now a small launcher that runs, for
  each server, a CLI matching that server's version (downloaded once into `~/.cubby/cli/<version>/`), and falls back
  to the last known version when a server is unreachable.
- `CUBBY_VERSION_OVERRIDE` server setting, for testing version skew locally.
- Choose what to install: `install.sh` installs the latest release by default; `--version X.Y.Z` picks a release and
  `--ref <branch|tag|commit>` installs any ref. `--domain`/`--no-domain`, `--admin-email`, `--admin-password-file`
  and `--name` answer the questions up front, for installs without prompts.
- `cubby-server upgrade` moves to the latest release (or keeps following the branch you installed from), takes a
  backup first, and replaces itself with the new version's script. `--version X.Y.Z` pins or rolls back, `--ref`
  switches to any ref, `--no-backup` skips the backup. `cubby-server version` shows what's running, what it follows
  and the latest release.
- "Update available" notice in the Admin tab, with the release notes and the upgrade command. The server asks GitHub
  for the latest release once a day (its only outbound request); admins can turn it off, and `CUBBY_UPDATE_CHECK=0`
  disables it entirely.
- Releases are tagged and published automatically when a release PR is merged (see CONTRIBUTING.md "Releases").
- `cubby help [<command>] [--json]`: every command and flag the targeted server supports. Each server's `/docs.md`
  includes the same list.
- CI fails when test coverage drops: unit-only and unit + integration thresholds (`.c8rc.unit.json`, `.c8rc.json`),
  with `npm run coverage:ratchet` to raise them.


### Changed

- The CLI always matches the server it's talking to; in an app folder, the server in `cubby.json`. This now covers
  every command that talks to a server, including `login`, `signup`, `whoami` and `help`, not just app commands.
- The agent skill only names a fixed core of commands every server supports and tells agents to run
  `cubby help --json` for the rest. The launcher refreshes the installed skill from newer CLIs and never downgrades it.
- `cubby version` reports the CLI version that runs for the current server, the launcher's version and the server's.
- Servers older than Cubby 0.1.1 aren't supported: the CLI refuses them with one line asking the admin to upgrade.
- A server's `/skill.sh` keeps an installed skill that's newer than its own, instead of downgrading it.

- Servers report exactly what they run: `X.Y.Z` for a release build, `X.Y.Z-dev+<commit>` for anything else, in
  `/api/info` (which also gains `commit`), the `x-cubby-version` header, the Admin tab, `/docs.md` and the CLI they
  serve.

### Upgrading from 0.1.0

0.1.0's `cubby-server upgrade` pulls `main` and doesn't update itself. Run these once:

```sh
sudo cubby-server upgrade
sudo install -m 755 /opt/cubby/src/docker/cubby-server /usr/local/bin/cubby-server
sudo cubby-server upgrade --version <latest release>   # switch from following main to releases
```

- `~/.cubby/config.json` moves to a multi-server format (`"format": 1`). Existing single-server configs are migrated
  automatically on first use.
- An app's `cubby.json` now pins it to its server and gets a `"format"` field. It's no longer rewritten to follow
  whichever server you logged in to last; move an app with `cubby link <app> --server <url>`.
- `cubby logout` forgets the current server instead of every server; use `--all` for the old behavior.
- The agent skill no longer embeds a server URL. It finds servers with `cubby servers` and picks one by name.

## [0.1.0] - 2026-10-11

First public version.

### Added

- Self-hosted server: one Docker container with Caddy, the Cubby server and a shared PocketBase.
- `install.sh` one-line installer and the `cubby-server` command (status, logs, upgrade, backups, restore, set-domain).
- Domain mode with automatic HTTPS, and IP mode on `sslip.io` (HTTP only).
- Dashboard: signup with an invite code, My apps, Everyone's apps gallery, and an Admin tab (invites, limits, users, apps, disk).
- Per-app isolation in one PocketBase: collection prefixes, a tenant-guarding proxy, and per-app login tokens.
- `cubby` CLI served by each server: browser-approved login, `init`, `deploy` (schema + build + upload), rollback, schema push/pull/drop.
- Non-destructive schema pushes; deleting needs an explicit `cubby schema drop`.
- Agent skill for Claude Code, Codex, Cursor and OpenCode, installed with `curl <server>/skill.sh | sh`.
- App template: Vite, React, Tailwind and the PocketBase SDK, with `AGENTS.md` for coding agents.
- Nightly backups with 7 kept.
- Unit, integration and browser test suites, with CI.
