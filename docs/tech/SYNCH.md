# Sync Strategy

How easyDBAccess moves a workspace between devices. There is no sync
server — a workspace syncs two ways, both client-only:

- **Gist Sync** — push/pull a workspace (or one table) to a private GitHub
  Gist. Manual, whole-object, no merge. Covered below.
- **Local `.edb` sync** — settle two copies of the SAME workspace file
  table by table and row by row, using each row's `updatedAt`. Covered in
  [`EDB.md`](EDB.md#settling-two-copies-table-by-table-and-row-by-row).

## Gist Sync

The `gist-sync` plugin (`packages/renderer/src/plugins/gist-sync.ts`) talks
directly to the GitHub Gists REST API from the browser — no backend of ours
sits in between. It:

- Serialises each table to its own `<slug>.table.json` file (the same shape
  `dump-export`'s per-table JSON option writes — see `export/table-file.ts`),
  plus one `_easydb.workspace.json` marker file carrying view templates/
  instances and the workspace's settings.
- Pushes with a Gist `PATCH` (or `POST` to create one, the first time) and
  pulls with a Gist `GET`, through the footer's Gist menu — Push, Pull,
  Share, View gist — and, per table, a table-button menu with the same Push/
  Pull plus "view gist file".
- Lets a push or pull scope to **Everything**, **Data only** (tables + rows)
  or **Settings only** (views + settings).
- Shares a workspace via a `#gist=` link: a base64'd `user=…;gist_id=…;
  gist_token=…` connection string in the URL fragment (never sent to a
  server), opened by `GistShareDialog`.

### Credentials

Configured in Settings → Gist Sync: a GitHub username, an optional gist id
(left empty to create a new gist on first Push), and a personal access
token with the `gist` scope. The token is a `secret` field — stored in the
device-local secrets store and referenced from the setting via
`${secret:name}`, never written into a setting that could itself be synced.

### Conflict handling

There is no etag or revision on a Gist file — GitHub's Gist API has none.
Instead:

- **Push** asks before deleting any `.table.json` file that is in the gist
  but not in this push (a table renamed or deleted locally, or the gist
  aggregating another device's tables that no longer apply). Declining
  keeps the remote file untouched.
- **Pull** upserts by table name, then offers to delete any local table or
  view the gist did not carry. Declining leaves local-only work alone.

Both are "ask, don't guess" — a stale remote file or a stale local table is
never silently removed.

### Size limits

Gist rejects a file over 100 MB outright, and gets slow and less reliable
past 10 MB per file — GitHub stops returning the file's inline `content`
(only a `raw_url`) above that. `push()` warns before either threshold; a
`truncated` pull result is resolved by fetching `raw_url` directly (a secret
gist's raw URL is link-accessible with `Access-Control-Allow-Origin: *`, so
no auth header and no CORS preflight is needed).

### Where the bits live

| Concern | File |
| --- | --- |
| Push / pull / share / per-table sync | `packages/renderer/src/plugins/gist-sync.ts` |
| Share-link dialog | `packages/renderer/src/dialogs/gist-share-dialog.ts` |
| The `.table.json` shape (shared with per-table export) | `packages/renderer/src/export/table-file.ts` |
| View-template restore on pull | `packages/renderer/src/views/template-restore.ts` |
| Secret-reference guard (what a push may send) | `packages/renderer/src/db/secret-guard.ts` |

## URL ingestion is CORS-dependent

There used to be a small Hono backend with a `/fetch` route that proxied a
plugin's outbound fetch past a target site's CORS headers. That backend is
gone, along with the `/sync` route (a whole-workspace JSON blob with etag
concurrency) it also hosted. `api.backend.fetch` (see `plugin-api.ts`) is
now always a direct browser fetch, so pulling data from a URL — a CSV
import, a `url-source` table, a plugin's own fetch — works only if the
target host sends CORS headers that allow it. There is no proxy left to
sidestep that.
