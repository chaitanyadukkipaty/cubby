# {{SLUG}} — a Cubby app

Vite + React 19 + Tailwind CSS v4 frontend, PocketBase backend, hosted on Cubby.
Live URL: {{URL}}

## Workflow

```sh
npm run dev            # local dev server; backend calls go to the real Cubby backend
cubby schema push      # apply cubby/schema.json now (needed before `npm run dev` can use new collections)
cubby deploy -m "msg"  # push schema (if changed) + build + publish. This is the only command needed to ship.
cubby deploys          # list deploys;  cubby rollback <id> to revert the frontend
```

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
4. **This is a static frontend.** There is no server code. Put all security in collection API rules.
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

## Not supported (yet)

Server-side code/hooks, cron jobs, OAuth providers, emails (verification/reset), custom domains, SQL views.
