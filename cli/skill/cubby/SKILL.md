---
name: cubby
description: >
  Cubby is a self-hosted server where the user and their friends or team build and host
  full-stack web apps: React + Tailwind frontends with a real backend (database, user
  accounts, file uploads, realtime) at {app}.{their-server}. Use when asked to "build an
  app", "make a web app", "build me a tool for my team", "host this", "deploy this",
  "ship it", "put this online", "make it live", "share this with my friends/team",
  "give me a URL", to update, roll back, hide or delete a Cubby app, or when the working
  directory contains a cubby.json.
---

# Cubby

**Skill version: 0.1.0**

Cubby runs on servers the user (or their friends or workplace) control, each with a name like
"Priya's Cubby". Everyone with an account on a server can open everyone's apps there; only the owner
can change or deploy one. You drive it through the `cubby` CLI. The user may belong to several
servers, possibly on different Cubby versions; the CLI picks the right version for each server.

## Working style: be like Lovable

The user describes what they want; you do everything else. They should never have to run a
command, edit a file, or answer a technical question.

- Make sensible product and design decisions yourself (layout, colors, fields, app name, auth or
  not). Ask only when the request is truly ambiguous about *what* to build, and then ask once.
- Build something polished and complete on the first deploy: real data model, empty states,
  loading and error states, mobile-friendly, a clear visual style. No placeholder lorem ipsum.
- Ship early: deploy as soon as the first useful version works, then keep improving if asked.
- Report back in plain language: what you built, the live URL, and 1-2 ideas for what to add next.

## Setup (silent, every time)

Do this yourself before building. Never ask the user to run anything.

1. **Find the servers.** Run `cubby servers --json` (a list of `{ name, url, logged_in, default }`).
   - `command not found`: read `~/.cubby/config.json` (`servers` → `url`); installing this skill
     adds the server there. Install the CLI from that server (needs Node.js 20+):
     `npm i -g {url}/cli.tgz`, then run `cubby servers --json` again.
   - No servers anywhere: ask the user once: *"What's the URL of your Cubby server?"*
2. **Pick one** (call it `{server}`, the name, or the URL if it has none):
   - Inside an app folder (has `cubby.json`): that app's server is fixed. Don't pass `--server`.
   - The user named one ("on Acme Cubby", "on Priya's server"): match it to a `name`.
   - Only one server: use it.
   - Several and the user didn't say: ask once, listing the names. Remember the answer for the
     rest of the conversation.
   For a new app on one of several servers, **always pass `--server "{server}"`** so it can't go
   to the wrong place.
3. **Log in if needed.** If the server has `"logged_in": false`, or a command says
   `Not logged in` / `Invalid token`, use browser approval:
   1. `cubby login {url} --no-wait --json` → returns `verify_url`.
   2. Tell the user, in one short message: *"To connect me to {server name}, open this link and click Approve (you can sign up there if you're new): {verify_url}"*
   3. Immediately run `cubby login --wait --json` (it waits up to 10 minutes for the approval).
   Never ask for passwords or tokens.
4. Read `{url}/docs.md` once per conversation, for the server you're using: its version, limits,
   URL scheme, schema format and frontend rules. Different servers may differ. If the docs and
   live CLI output disagree, trust the CLI.

## Build a new app

```bash
cubby init {app-name} --server "{server}" --json   # 3-40 chars: lowercase letters, digits, single hyphens
cd {app-name}
```

The new folder's `cubby.json` pins the app to that server; every later command in it goes there.

Pick a short, descriptive app name yourself (e.g. `team-polls`). If it's taken, add a word and retry.
Run `init` in a sensible place (the current folder if it's empty or a projects folder, otherwise a
new subfolder), not inside another app.

Then **read `AGENTS.md` in the new folder** and follow it. It is the authoritative guide to
the code: collection naming with `col()`, the schema file, auth, files, realtime.

The essentials:

- Frontend: Vite + React + Tailwind in `src/`. Backend: PocketBase, defined in `cubby/schema.json`.
- Always access collections as `pb.collection(col('name'))`.
- Keep `<script src="/__cubby/config.js">` in `index.html`.
- There is no server-side code. All data security lives in each collection's API rules.
- Set `description` in `package.json`: it shows in the server's app gallery.

## Ship

```bash
cubby deploy -m "{what changed}" --client {your-agent-name} --json
```

One command: pushes `cubby/schema.json` if it changed, runs `npm run build`, uploads `dist/`.
If the schema step fails, nothing is deployed. Fix the reported error and run it again.
Use `--client` with your agent name, e.g. `claude-code`, `cursor`, `codex`.

## Change an existing app

- In a folder with `cubby.json`: edit, then `cubby deploy`.
- The server stores **built output only, not source code**. An app can only be changed from the
  folder (or repo) it was built in. If the user wants to edit an app whose source isn't here,
  tell them so. Don't rebuild it from scratch without asking.
- `cubby projects --server "{server}" --json` lists the user's apps on a server.
  `cubby link {app} --server "{server}"` attaches the current folder to one.

## Destructive actions: ask the user first

Confirm with the user in plain words before running any of these:

- `cubby schema drop {collection}[.{field}] --yes`: permanently deletes that data.
- `cubby delete {app} --yes`: deletes the app, its data and every deploy.

Never use them to work around an error. `cubby schema push` never deletes anything, so a field you
removed from `schema.json` still exists (it's reported as "kept").

## Common errors

| Error | Fix |
| --- | --- |
| `Not logged in` / `Invalid token` | Setup step 3 (browser approval) |
| `Login link expired` | Start again from `cubby login {url} --no-wait --json` |
| `No server called "…"` / `Several servers are set up` | Run `cubby servers --json` and pass `--server` with one of the names |
| `This app lives on … and you're not logged in there` | Log in to that server (setup step 3) |
| `"{app}" is taken` | Pick another name |
| `You've reached the limit of N apps` | Tell the user; they can delete an app or ask the admin |
| `Cannot change {c}.{f} from X to Y` | Use a new field name, or ask the user before dropping the old one |
| `PocketBase rejected collection …` | Fix `cubby/schema.json` using the details shown |
| `warning: CLI x differs from server y` | Run `npm i -g {url}/cli.tgz` (only seen with very old CLIs) |
| `This account has been disabled` | Tell the user to contact the server admin |

## What to tell the user

- Always share the app `url` from the `cubby deploy` output, and which server it's on (`server_name`).
- Say that everyone on that Cubby server can open it and see it in the gallery, unless it was
  deployed with `--unlisted` (still reachable by URL, just not listed).
- If the URL starts with `http://` (not https), don't call it secure. The server has no HTTPS yet.
- After a bad deploy: `cubby deploys --json` lists versions and `cubby rollback {id}` restores one
  instantly (frontend only; data is never rolled back).

## Commands

| Command | Purpose |
| --- | --- |
| `cubby servers --json` | Servers the user has (name, url, logged in, default) |
| `cubby whoami [--server "{server}"] --json` | Check login on a server |
| `cubby init {app} --server "{server}" --json` | Create an app (folder + server project) |
| `cubby deploy -m "…" [--unlisted\|--listed] --json` | Schema + build + publish |
| `cubby schema push \| pull` | Apply / fetch the schema (push is also part of deploy) |
| `cubby deploys --json` / `cubby rollback {id}` | List / restore frontend versions |
| `cubby projects --json` / `cubby info --json` | List apps / current app details |
| `cubby link {app}` | Attach current folder to an existing app |

Add `--json` to any command for machine-readable output. `--server` accepts a server's name or URL.
