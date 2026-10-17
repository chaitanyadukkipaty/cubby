# {{SLUG}} — a Cubby app

Vite + React 19 + Tailwind CSS v4 frontend, PocketBase backend, hosted on Cubby.
Live URL: {{URL}}

## Workflow

```sh
npm run dev            # local dev server; backend calls go to the real Cubby backend
cubby schema push      # apply cubby/schema.json now (needed before `npm run dev` can use new collections)
cubby deploy -m "msg"  # push schema (if changed) + build + publish. This is the only command needed to ship.
cubby deploys          # list deploys;  cubby rollback <id> to revert the frontend and its jobs
cubby jobs run <name>  # run a scheduled job now and print its log (see "Scheduled jobs" below)
```

After deploying, run `cubby metrics {{SLUG}} --range 1h` and check it for API errors (5xx) before calling it done.

Set a one-line `description` in `package.json`; it's shown in the server's app gallery.
`cubby deploy --unlisted` hides the app from the gallery (it stays reachable by URL).

Add `--json` to any `cubby` command for machine-readable output. Auth comes from `~/.cubby/config.json` or `CUBBY_TOKEN`.

## Rules you must follow

1. **Always wrap collection names in `col()`** from `src/lib/pb.ts`:
   `pb.collection(col('tasks'))`, never `pb.collection('tasks')`.
   The backend is shared; this app's collections are stored as `{{PREFIX}}<name>`. Other names are rejected.
2. **Keep `<script src="/__cubby/config.js">` in `index.html` exactly as is** (no `type="module"`). It provides the backend URL and prefix at runtime.
   The build warning "can't be bundled without type=module" about it is expected; ignore it.
3. **The data model lives in `cubby/schema.json`**, using *unprefixed* names. `cubby deploy` applies it automatically.
   `cubby schema pull` writes the live schema back to the file.
4. **The frontend is static.** Browser code can only do what collection API rules allow, so put all security in
   the rules. The only server-side code is scheduled jobs in `cubby/jobs/` (below); there are no request handlers.
5. Use client-side routing only (any unknown path serves `index.html`).

## Schema format (`cubby/schema.json`)

```json
{
  "collections": [
    {
      "name": "posts",                  // lowercase, digits, underscores; no "__"
      "type": "base",                   // "base" or "auth" (auth = user accounts with email/password)
      "fields": [
        { "name": "title", "type": "text", "required": true, "max": 200 },
        { "name": "body", "type": "editor" },
        { "name": "status", "type": "select", "values": ["draft", "published"], "maxSelect": 1 },
        { "name": "cover", "type": "file", "maxSelect": 1, "maxSize": 5242880, "mimeTypes": ["image/png", "image/jpeg"] },
        { "name": "author", "type": "relation", "collection": "users", "maxSelect": 1 }
      ],
      "indexes": [{ "columns": ["author"] }, { "columns": ["title"], "unique": true }],
      "listRule": "status = 'published' || author = @request.auth.id",
      "viewRule": "status = 'published' || author = @request.auth.id",
      "createRule": "@request.auth.id != '' && @request.body.author = @request.auth.id",
      "updateRule": "author = @request.auth.id",
      "deleteRule": "author = @request.auth.id"
    }
  ]
}
```

- Field types: `text, editor, number, bool, email, url, date, autodate, select, file, relation, json, geoPoint`.
  Options are PocketBase's (`min`, `max`, `required`, `values`, `maxSelect`, `mimeTypes`, `cascadeDelete`, ...).
- Relations use `"collection": "<name in this file>"`.
- `created` / `updated` autodate fields are added automatically.
- Rules use PocketBase rule syntax. **A missing rule means only admins can do that action** (the app cannot).
  `""` means anyone, including logged-out visitors. In rules, `@collection.<name>` uses unprefixed names.
- Auth collections already have `email`, `password`, `verified`; don't declare those.
- Pushing never deletes anything: fields or collections missing from the file are kept, with their data.
  To really delete: `cubby schema drop posts.color --yes` (field) or `cubby schema drop posts --yes` (collection).
- A field's type can't be changed in place. Add a new field, or drop the old one first.

## Backend usage (PocketBase JS SDK)

```ts
import { pb, col } from './lib/pb';

await pb.collection(col('users')).create({ email, password, passwordConfirm: password });
await pb.collection(col('users')).authWithPassword(email, password);
pb.authStore.record;  pb.authStore.clear();  pb.authStore.onChange(cb);

await pb.collection(col('posts')).getList(1, 20, { filter: pb.filter('author = {:id}', { id }), sort: '-created', expand: 'author' });
await pb.collection(col('posts')).create(formDataOrObject);   // use FormData for file uploads
pb.files.getURL(record, record.cover);                         // file URL
pb.collection(col('posts')).subscribe('*', (e) => {...});      // realtime
```

Always build filters with `pb.filter()` to avoid injection.

## Scheduled jobs (`cubby/jobs/`)

Code that runs on the server on a schedule: send a digest, close expired polls, sync from an API. One file per job;
the file name is the job name (lowercase, digits, hyphens). Files starting with `_` are shared helpers, not jobs.

```ts
// cubby/jobs/close-expired-polls.ts
import type { JobContext } from './_context';

export const schedule = '*/15 * * * *';   // 5-field cron, always UTC; write it exactly like this

export default async ({ pb, env, log, fetch }: JobContext) => {
  const now = new Date().toISOString().replace('T', ' ');
  const expired = await pb.collection('polls').getFullList({ filter: pb.filter('closed = false && closes_at < {:now}', { now }) });
  for (const poll of expired) await pb.collection('polls').update(poll.id, { closed: true });
  log(`closed ${expired.length} polls`);
};
```

- `pb` acts as admin for **this app's collections only**: API rules don't apply, so a job can read and change every
  user's records. Use **unprefixed** names (`pb.collection('polls')`, no `col()`); in `@collection.` filter joins use
  `col('name')`. Other apps and the server's own data are unreachable.
- `fetch` reaches the public internet only (no localhost or private networks). Use `fetch`, not `node:http`.
- `env` holds secrets: `cubby env set RESEND_API_KEY=...` (or `--from-stdin`). Values are never shown again; never put
  them in code. `cubby env list` shows names; `cubby env unset NAME --yes` deletes one.
- npm packages are bundled in at deploy. There is no file system to write to, no child processes, and no `process.env`.
- Limits: the server's time limit per run (60s by default), 128 MB memory, two jobs at a time server-wide.
  A job never overlaps itself: a run due while the previous one is going is skipped. Runs missed while the server
  was down are not caught up, so write jobs that are safe to run late or twice (e.g. "close polls past their date").
- `cubby deploy` bundles and ships the jobs with the frontend; `cubby rollback` restores the jobs of that deploy.

Test a job right after deploying: `cubby jobs run <name>` runs it now with the same limits and prints its log
(exit code 1 if it failed). `cubby jobs` lists jobs with their next and last run; `cubby jobs logs <name>` shows past
runs; `cubby jobs pause|resume <name>` stops and restarts the schedule.

## Not supported (yet)

Request handlers/hooks (server code that runs per request), OAuth providers, emails (verification/reset), custom
domains, SQL views.
