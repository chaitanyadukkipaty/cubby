<!-- Title: a Conventional Commit summary, e.g. "feat(cli): support several servers". See CONTRIBUTING.md. -->

## What and why

<!-- What does this change, and what problem does it solve? Link the issue. -->

Closes #

## How I tested it

<!-- Which tests did you add, at which level (unit / integration / e2e)? Anything you checked by hand? -->

- [ ] Unit tests
- [ ] Integration tests
- [ ] End-to-end tests (only for user journeys)

## Screenshots

<!-- For dashboard, template or docs changes. Delete if not applicable. -->

## Checklist

- [ ] Branch and commits follow [Conventional Commits](../CONTRIBUTING.md#commit-messages)
- [ ] `npm test` passes locally and coverage didn't drop (`npm run coverage`)
- [ ] Docs updated where behavior changed (docs site, README, CLI help, `SKILL.md`, `AGENTS.md`)
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` if users will notice
- [ ] No new dependencies, or the reason is explained above
- [ ] Safe by default: no implicit data deletion, apps stay isolated, only owners change apps
