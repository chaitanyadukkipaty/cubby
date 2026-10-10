# Security policy

Cubby hosts other people's apps and data, so we take security reports seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through
[GitHub security advisories](https://github.com/chaitanyadukkipaty/cubby/security/advisories/new).

Include what you found, steps to reproduce, the impact as you understand it, and the Cubby version
(shown at the bottom of the dashboard's Admin tab and in `/api/info`).

What to expect:

- An acknowledgement within **3 business days**.
- An assessment and a plan within **10 business days**.
- A fix released as soon as practical, with credit in the release notes unless you'd rather stay anonymous.

## Supported versions

Only the latest release receives security fixes. Check what a server runs with `sudo cubby-server version` (or the
Admin tab), and upgrade with `sudo cubby-server upgrade`. The Admin tab shows when a newer release is out.

## Scope

Especially interesting:

- One app reading or changing another app's data, or using another app's logins
- Reaching the platform's own collections, the PocketBase admin UI or settings through an app
- A user deploying to, changing or deleting someone else's app
- Escaping the deploy directory (path traversal, symlinks) or the container
- Bypassing the signup code, rate limits or the agent login approval

Out of scope: unencrypted traffic on servers installed without a domain (this is documented), denial of service through
legitimate heavy use, and vulnerabilities in apps people build on Cubby (their access rules are the app owner's responsibility).
