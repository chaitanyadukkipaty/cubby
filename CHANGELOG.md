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

### Changed

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
