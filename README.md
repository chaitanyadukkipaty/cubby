<div align="center">

<img src="docs/assets/logo.svg?v=aa679b5d" width="88" alt="Cubby logo">

# Cubby

**A home for the apps your agents build.**

Self-host one server, give it a name like **Priya's Cubby**, invite your friends or team, and let everyone's
AI coding agent build, deploy and share full-stack apps — each with a real database, logins and a live URL.

[**Documentation**](https://chaitanyadukkipaty.github.io/cubby/) ·
[Install](#install-a-server) ·
[Several servers](#belong-to-several-cubbies) ·
[How it works](#how-it-works) ·
[Contributing](CONTRIBUTING.md)

[![CI](https://github.com/chaitanyadukkipaty/cubby/actions/workflows/ci.yml/badge.svg)](https://github.com/chaitanyadukkipaty/cubby/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-d9480f)](https://chaitanyadukkipaty.github.io/cubby/)
![Node 20+](https://img.shields.io/badge/node-20%2B-1d1d1b)
![Self-hosted](https://img.shields.io/badge/self--hosted-Docker-1d1d1b)

<img src="docs/assets/app-friend-polls.png?v=20577a53" width="760" alt="Friend Polls, an app built by an AI agent from one sentence and hosted on Cubby">

<sub>Friend Polls: built and deployed by Claude Code from one sentence, in about three minutes.</sub>

</div>

---

## What it feels like

You type one sentence to your coding agent:

> Build me an app where my friends can create polls and vote on them, and host it on Priya's Cubby.

The agent finds the server you named, sets itself up, sends you **one link to approve**, designs the data model and
its security rules, builds the UI, deploys it, and replies with the URL. Your friends see it in the server's gallery
and can use it right away.

```mermaid
sequenceDiagram
    participant You
    participant Agent as Your agent (Claude Code, Codex, Cursor…)
    participant Cubby as Priya's Cubby
    You->>Agent: "Build me a polls app and host it on Priya's Cubby"
    Agent->>Agent: cubby servers → picks "Priya's Cubby"
    Agent->>Cubby: install CLI, start login
    Agent-->>You: "Open this link and click Approve"
    You->>Cubby: Approve
    Agent->>Cubby: cubby init → schema → build → cubby deploy
    Cubby-->>Agent: https://friend-polls.priyas-server.com
    Agent-->>You: "Here's your app, and what to add next"
```

## Why Cubby

Coding agents can write a whole web app from a sentence. **Hosting it is the hard part**: it needs a database,
user accounts, a URL, and a way for friends to use it. Hosted builders solve that, but your apps live on someone
else's platform and you can't bring your own agent.

|  | **Cubby** | Hosted builders | A VPS by hand |
| --- | :---: | :---: | :---: |
| You own the server and data | ✅ | — | ✅ |
| Use the agent you already like | ✅ | — | ✅ |
| Database, logins, uploads, realtime per app | ✅ | ✅ | per app, by hand |
| One-command deploys the agent runs itself | ✅ | ✅ | — |
| Friends get their own accounts and apps | ✅ | separate accounts | — |

## Features

- **Agent-native.** A skill teaches Claude Code, Codex, Cursor and OpenCode to set up, build and deploy by themselves. They log in through a browser approval, so nobody pastes passwords or tokens into a chat.
- **Real backend for every app.** Collections, user accounts, file uploads and live updates from a shared [PocketBase](https://pocketbase.io). Each app is walled off by collection prefix, and its security comes from database rules.
- **One-command deploys.** `cubby deploy` pushes schema changes, builds and publishes. The last 10 deploys are kept for instant rollback.
- **Safe by default.** Schema pushes never delete data. Apps can't touch each other's data or logins. Only owners can change their apps.
- **Made for groups.** Each server has its own name ("Priya's Cubby"). Invite with a signup code, browse everyone's apps in a gallery, and manage users, limits and disk from an admin tab.
- **Many servers, one agent.** Belong to your friends' cubby and your team's: one skill and one CLI know them all by name, even when they run different Cubby versions.
- **Easy to run.** One install script, one Docker container, automatic HTTPS, nightly backups, and versioned releases: the Admin tab tells you when one is out, and `cubby-server upgrade` installs it after a backup.

<table>
<tr>
<td width="50%"><img src="docs/assets/dashboard-my-apps.png?v=2a8e741c" alt="Dashboard with the Connect your AI agent card"><p align="center"><sub>Your dashboard on Priya's Cubby: connect your agent, see your apps</sub></p></td>
<td width="50%"><img src="docs/assets/connect-approve.png?v=fd35d280" alt="Approval page for connecting an AI agent"><p align="center"><sub>One click to connect an agent to a named server</sub></p></td>
</tr>
<tr>
<td width="50%"><img src="docs/assets/dashboard-gallery.png?v=9cdf21ee" alt="Gallery of everyone's apps"><p align="center"><sub>Everyone's apps</sub></p></td>
<td width="50%"><img src="docs/assets/dashboard-admin.png?v=e8871123" alt="Admin tab with users, apps, limits, invite code and an update notice"><p align="center"><sub>Admin: server name, invites, limits, users, disk, updates</sub></p></td>
</tr>
</table>

## Install a server

On a Linux VPS with ports 80 and 443 open:

```sh
curl -fsSL https://raw.githubusercontent.com/chaitanyadukkipaty/cubby/main/install.sh | sudo bash
```

It asks for a domain (optional), an admin email, a password and a name for your server (like "Priya's Cubby"),
then prints your URL and a **signup code**.
Send both to your friends.

| Mode | App URLs | HTTPS |
| --- | --- | --- |
| **Domain** (point `example.com` and `*.example.com` at the server) | `https://<app>.example.com` | Automatic |
| **No domain** | `http://<app>.203-0-113-5.sslip.io` | No, so traffic is unencrypted |

Switch later with `sudo cubby-server set-domain example.com`. See the [full install guide](https://chaitanyadukkipaty.github.io/cubby/#install).

### Choose a version, and upgrade

The installer installs the **latest release**. To pick something else, pass options after `bash -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/chaitanyadukkipaty/cubby/main/install.sh | sudo bash -s -- --version 0.1.1
curl -fsSL https://raw.githubusercontent.com/chaitanyadukkipaty/cubby/main/install.sh | sudo bash -s -- --ref my-branch
```

`--domain`, `--no-domain`, `--admin-email`, `--admin-password-file` and `--name` answer the questions up front, for an
install with no prompts.

When a new release is out, the Admin tab says so, with the release notes. On the server:

| Command | Does |
| --- | --- |
| `sudo cubby-server upgrade` | Back up, then move to the latest release (or keep following the branch you installed) |
| `sudo cubby-server upgrade --version 0.1.1` | Move to a specific release, including rolling back |
| `sudo cubby-server upgrade --ref <branch\|tag\|commit>` | Run any ref, e.g. to try a fix before it's released |
| `sudo cubby-server version` | Show what's running, what it follows, and the latest release |

A server built from a release reports its version, like `0.1.1`. Anything else reports the commit too, like
`0.1.1-dev+b2cb75c`, so you always know exactly what code is running. Releases are cut by the maintainer and published
automatically; see [Releases](CONTRIBUTING.md#releases).

## Connect your agent and build

1. Open the server URL and **sign up** with the signup code.
2. Run the command shown on your dashboard, once per server:
   ```sh
   curl -fsSL https://your-server.com/skill.sh | sh
   ```
   It installs the `cubby` agent skill and adds the server to `~/.cubby/config.json`.
3. Ask your agent for an app in plain words, naming the server if you have more than one. That's it.

<details>
<summary><b>CLI reference</b> (your agent runs these; every command takes <code>--json</code>)</summary>

| Command | What it does |
| --- | --- |
| `cubby login <server>` | Log in by approving a link in the browser (`--token` for CI). Adds the server to your list. |
| `cubby servers` / `cubby use <name>` | List your servers with their names and versions, set the default |
| `cubby logout [--server <name>] [--all]` | Forget one server (the current one by default) or all of them |
| `cubby init <app>` | Create an app from the template |
| `cubby deploy -m "…"` | Push schema if changed, build, publish (`--unlisted` hides it from the gallery) |
| `cubby deploys` / `cubby rollback <id>` | List deploys, restore one instantly |
| `cubby schema push \| pull \| drop` | Manage the data model (push never deletes) |
| `cubby projects` / `info` / `delete` | Manage apps |
| `cubby link <app> --server <name>` | Attach this folder to an app, or move it to another server |
| `cubby skill install \| remove \| status` | Manage the agent skill |
| `cubby version` | Show which CLI version runs for the current server, and the server's version |
| `cubby help [<command>] [--json]` | Every command and flag the targeted server supports |

`--server <name|url>` works on every command.

</details>

## Belong to several cubbies

Most people end up on more than one server: a friends' cubby and a team's, say. One skill and one CLI handle all of
them by name:

```sh
curl -fsSL https://priyas-server.com/skill.sh | sh     # adds "Priya's Cubby"
curl -fsSL https://cubby.acme.dev/skill.sh | sh        # adds "Acme Cubby"
cubby servers
# * Priya's Cubby   https://priyas-server.com  alex@example.com  v0.1.0
#   Acme Cubby      https://cubby.acme.dev     alex@acme.dev     v0.2.0
```

- **New apps** go to the server you name ("host it on Acme Cubby"). With one server, the agent just uses it; if it's
  unclear, it asks once.
- **Existing apps** are pinned to their server in `cubby.json`, so a redeploy can never land on the wrong one.
- **The CLI always matches the server it's talking to; in an app folder, the server in `cubby.json`.** The `cubby`
  command is a small launcher. For every command that talks to a server, logging in included, it runs a CLI of that
  server's version, downloaded once into `~/.cubby/cli/<version>/`, so an older and a newer server work side by side.
  If a server is unreachable, it falls back to the last version it saw. Servers older than Cubby 0.1.1 aren't
  supported: the CLI says so and asks you to have the admin run `sudo cubby-server upgrade`.
- **Agents ask, not guess.** The skill only names the commands every server supports. For anything else the agent
  runs `cubby help --json`, which answers for the server it's targeting (the same list is in each server's
  `/docs.md`). The installed skill only ever moves forward to newer versions.

```mermaid
flowchart LR
    L["cubby (launcher)"] -->|"Priya's Cubby is v0.1.0"| A["CLI v0.1.0<br/>~/.cubby/cli/0.1.0"]
    L -->|"Acme Cubby is v0.2.0"| B["CLI v0.2.0<br/>~/.cubby/cli/0.2.0"]
    A --> P[Priya's Cubby]
    B --> Q[Acme Cubby]
```

## How it works

```mermaid
flowchart LR
    A[Coding agent<br/>cubby CLI + skill] --> C[Caddy<br/>HTTPS]
    B[Browsers] --> C
    C --> S
    subgraph S[Cubby server]
      D[Dashboard + API]
      H["App hosting<br/>&lt;app&gt;.your-server.com"]
      P["Database proxy<br/>&lt;app&gt;/pb/* → own data only"]
    end
    P --> DB[(Shared PocketBase<br/>one prefix per app)]
    D --> DB
```

- Every app gets its own **subdomain**, so apps can't read each other's logins in the browser.
- App `polls` owns collections named `polls__*`. The proxy only lets the app reach those, and rejects logins issued by other apps.
- Apps are static **Vite + React + Tailwind** frontends; security lives in each collection's API rules.
- One Docker container runs Caddy, the Cubby server (Node.js) and PocketBase, with a single data volume.
- Each server serves its own CLI (`/cli.tgz`), agent docs (`/docs.md`) and skill installer (`/skill.sh`), so agents
  always follow the rules of the server they're deploying to.

Read more: [security model](https://chaitanyadukkipaty.github.io/cubby/#security) · [data and rules](https://chaitanyadukkipaty.github.io/cubby/#schema) · [running the server](https://chaitanyadukkipaty.github.io/cubby/#admin)

## Develop

```sh
git clone https://github.com/chaitanyadukkipaty/cubby && cd cubby
cp .env.example .env
npm run setup     # downloads PocketBase into ./bin, installs dependencies
npm run dev       # http://localhost:8080 · apps at http://<app>.localhost:8080
```

```
server/    control API, app hosting, database proxy, dashboard (public/)
cli/       the cubby CLI, the app template (template/) and the agent skill (skill/)
docker/    container entrypoint and the cubby-server management script
docs/      this project's documentation site (GitHub Pages)
tests/     unit, integration and browser tests
```

### Tests

| Command | Runs |
| --- | --- |
| `npm run test:unit` | Fast unit tests, no network |
| `npm run test:integration` | Tests against a real server and PocketBase |
| `npm run test:e2e` | Browser tests for the dashboard and the app template (Playwright) |
| `npm run coverage` | Unit and integration tests with a coverage report in `coverage/` |
| `npm test` | All of the above, in pyramid order |

## Contributing

Contributions are welcome, from people and their agents. Read **[CONTRIBUTING.md](CONTRIBUTING.md)** first. In short:

1. Open an issue for anything bigger than a small fix, and agree on the approach.
2. Branch from `main` (`feat/…`, `fix/…`, `docs/…`) and use [Conventional Commits](https://www.conventionalcommits.org/).
3. Add tests at the right level of the pyramid, update the docs, and run `npm test`.
4. Open a pull request using the template. `main` is protected: changes land only through pull requests with passing CI,
   squash-merged.

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md), and report security problems privately as described in [SECURITY.md](SECURITY.md).
Notable changes are listed in the [changelog](CHANGELOG.md).

## Status and limits

Cubby is early (v0.1.0, with server names and multi-server support in the [next release](CHANGELOG.md)). It's built
for groups who trust each other, not as a hostile multi-tenant cloud.

- All apps share one SQLite database, which suits a group of friends or a small team.
- Not yet supported: server-side code, cron jobs, custom domains per app, single sign-on across apps, app emails.
