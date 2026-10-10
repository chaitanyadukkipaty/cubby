# Changelog

All notable changes to Cubby are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
