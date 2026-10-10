# Contributing to Cubby

Thanks for helping make Cubby better. This guide explains how we work so your contribution lands smoothly.
It borrows conventions from projects like Vite, React and Node.js: small focused pull requests,
Conventional Commits, tests with every change, and docs that ship with the code.

By taking part you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
Found a security problem? **Don't open an issue.** See [SECURITY.md](SECURITY.md).

## Table of contents

- [Ways to contribute](#ways-to-contribute)
- [Before you start](#before-you-start)
- [Development setup](#development-setup)
- [Project structure](#project-structure)
- [Making a change](#making-a-change)
- [Tests](#tests)
- [Documentation](#documentation)
- [Commit messages](#commit-messages)
- [Pull requests](#pull-requests)
- [Review and merging](#review-and-merging)
- [Releases](#releases)
- [Using AI coding agents](#using-ai-coding-agents)

## Ways to contribute

- **Report a bug** with the [bug report form](https://github.com/chaitanyadukkipaty/cubby/issues/new?template=bug_report.yml). Include steps to reproduce.
- **Suggest a feature** with the [feature request form](https://github.com/chaitanyadukkipaty/cubby/issues/new?template=feature_request.yml). Describe the problem first, then your idea.
- **Improve the docs**: typos, unclear steps and missing examples are all welcome as direct pull requests.
- **Fix a bug or build a feature**: see below.
- **Try Cubby** with a new agent or on a new Linux distribution and tell us what broke.

## Before you start

- **Small fixes** (typos, obvious bugs, test gaps): open a pull request directly.
- **Anything bigger** (new features, changed behavior, new dependencies): open an issue first and wait for a maintainer to agree on the approach. This saves you from building something that can't be merged.
- **Check existing work.** Search open issues and pull requests, and comment on an issue to say you're taking it.
- Issues labelled [`good first issue`](https://github.com/chaitanyadukkipaty/cubby/labels/good%20first%20issue) are a good place to start.

### Design principles

Proposals are easier to accept when they respect these:

1. **The agent does the work.** Anything a person would type, the agent should be able to do through the CLI with `--json`. People should only need to click links and answer product questions.
2. **Safe by default.** Nothing deletes data implicitly. Apps can't reach each other's data. Only owners change apps.
3. **One container, few dependencies.** Prefer Node built-ins. New npm dependencies need a reason in the pull request.
4. **Small groups, not clouds.** Cubby is for people who know each other. Don't add complexity for hostile multi-tenancy at scale.

## Development setup

You need **Node.js 20+** (CI uses 24), **git**, and optionally **Docker** to test the container.

```sh
git clone https://github.com/chaitanyadukkipaty/cubby && cd cubby
cp .env.example .env
npm run setup        # downloads PocketBase into ./bin and installs dependencies
npm run dev          # http://localhost:8080 · apps at http://<app>.localhost:8080
```

The admin account and signup code come from `.env`. Use the CLI from the repo with `npm run cubby -- <command>`
or `node cli/src/index.js <command>`.

To test the Docker image:

```sh
docker build -t cubby:local .
docker run --rm -p 8088:80 --env-file .env -e BASE_DOMAIN=localhost:8088 -e PUBLIC_URL=http://localhost:8088 cubby:local
```

## Project structure

| Path | What lives there |
| --- | --- |
| `server/src/` | Control API, app hosting, PocketBase proxy and tenant isolation, schema translation, device login, backups |
| `server/public/` | The dashboard (single HTML file) and the skill installer script |
| `cli/src/` | The `cubby` CLI |
| `cli/template/` | The app template every `cubby init` copies (Vite + React + Tailwind + PocketBase) |
| `cli/skill/cubby/` | The agent skill (`SKILL.md`) |
| `docker/`, `Dockerfile`, `install.sh` | Packaging and server management (`cubby-server`) |
| `docs/` | The documentation site, published with GitHub Pages |
| `tests/` | `unit/`, `integration/`, `e2e/` and shared `helpers/` |

## Making a change

1. **Fork** the repo (maintainers can branch directly) and create a branch from `main`:

   | Prefix | For |
   | --- | --- |
   | `feat/<short-name>` | New features |
   | `fix/<short-name>` | Bug fixes |
   | `docs/<short-name>` | Documentation only |
   | `test/<short-name>` | Tests only |
   | `refactor/<short-name>` | Code changes with no behavior change |
   | `chore/<short-name>` | Tooling, CI, dependencies |

2. **Keep it focused.** One pull request per feature or fix. Split unrelated changes into separate PRs.
3. **Match the surrounding code**: ES modules, two-space indentation, single quotes, small functions, and comments that explain *why* rather than *what*.
4. **Write tests** at the right level of the pyramid (see below).
5. **Update the docs** wherever behavior changes (see below).
6. **Run the full suite** locally: `npm test`.
7. **Add a changelog entry** under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything users would notice.

## Tests

We follow the **testing pyramid**: many fast unit tests, fewer integration tests, and a small set of end-to-end tests.

| Layer | Where | What belongs there | Command |
| --- | --- | --- | --- |
| **Unit** (most) | `tests/unit/*.test.js` | Pure logic and every edge case: validation, rule rewriting, proxy decisions, path safety, CLI argument handling, dashboard helpers. No network, no PocketBase. | `npm run test:unit` |
| **Integration** | `tests/integration/*.test.js` | Contracts between real components: API ↔ PocketBase, proxy ↔ PocketBase, CLI ↔ server, deploy → hosting. One or two cases per contract. | `npm run test:integration` |
| **End-to-end** (fewest) | `tests/e2e/*.spec.js` | Critical user journeys in a real browser: signup, connecting an agent, deploying, admin actions, the app template. | `npm run test:e2e` |

Rules of thumb:

- **Every bug fix gets a test** that fails without the fix.
- **Push edge cases down.** If something can be tested as a unit, don't test it in a browser.
- **Coverage must not drop.** Check with `npm run coverage` (report in `coverage/`).
- Use the helpers in `tests/helpers/server.js` to start a real server on free ports with a throwaway data directory. Never point tests at a shared or long-running server.
- Tests must be deterministic: unique names and emails, explicit waits on state, no fixed sleeps.

## Documentation

Docs ship in the same pull request as the change. Depending on what you touched:

| You changed | Update |
| --- | --- |
| Anything users see or do | `docs/index.html` and, if it's headline material, `README.md` |
| CLI commands or flags | The CLI `HELP` text, `docs/index.html#cli`, the README CLI table |
| How agents should behave | `cli/skill/cubby/SKILL.md` |
| App template conventions | `cli/template/AGENTS.md` (also served as part of `/docs.md`) |
| Server setup or management | `install.sh` prompts, `docker/cubby-server` help, `docs/index.html#install` and `#admin` |

Write plainly and from the user's side: name things by what people recognize, use active voice, keep sentences short.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <summary in the imperative, lowercase, no period>

<body: what changed and why, wrapped at ~72 characters>

<footer: BREAKING CHANGE: …, Closes #123, Co-authored-by: …>
```

- **Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`, `build`.
- **Scopes:** `server`, `cli`, `skill`, `template`, `dashboard`, `docker`, `docs`, `tests`.
- **Examples:**
  - `feat(cli): support several servers in ~/.cubby/config.json`
  - `fix(server): reject realtime topics that reference other apps`
  - `docs: explain domain vs IP install modes`
- Mark breaking changes with `!` after the type (`feat(cli)!: …`) and a `BREAKING CHANGE:` footer explaining how to migrate.
- Make each commit a coherent step that passes tests on its own where practical.

## Pull requests

- **Title:** a Conventional Commit summary, e.g. `feat(server): add instance names`.
- **Description:** fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md): what and why, how you tested it, and screenshots for UI changes.
- **Link the issue** with `Closes #123`.
- **Keep it reviewable.** Aim for under ~600 changed lines excluding tests and docs; split larger work into a series.
- **CI must pass**: unit, integration, coverage and end-to-end tests run on every push.
- **Draft PRs** are welcome for early feedback.

## Review and merging

- A maintainer reviews within a few days. Reviews focus on correctness, safety (isolation, data loss), tests and docs.
- Address feedback with new commits; don't force-push during review unless asked.
- Maintainers **squash-merge**, using the PR title as the commit message, so the history on `main` reads as a changelog.

## Releases

Cubby follows [Semantic Versioning](https://semver.org/). The version lives in the root `package.json` and is shared
by the server, the CLI it serves, and the skill. To release, a maintainer:

1. Moves `## [Unreleased]` entries in `CHANGELOG.md` under a new version heading.
2. Bumps `version` in `package.json`.
3. Tags `vX.Y.Z` and publishes a GitHub release with the changelog section.

Servers pick up releases with `sudo cubby-server upgrade`.

## Using AI coding agents

AI-assisted contributions are welcome. Cubby is built for agents, after all. The same rules apply:

- **You're responsible** for every line you submit. Read it, run it, and be ready to explain it.
- Follow this guide: branch naming, Conventional Commits, tests at the right pyramid level, docs in the same PR.
- **Credit the agent** in commits with a `Co-authored-by:` trailer.
- Don't submit large, unreviewed rewrites. Keep PRs focused, as for human-written code.
