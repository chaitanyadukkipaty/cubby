# Changelog

All notable changes to Cubby are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
