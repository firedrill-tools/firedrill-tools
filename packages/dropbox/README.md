# @firedrill-tools/tool-dropbox

A synthetic **Dropbox** account for [Firedrill](https://firedrill.run): a stateful Tool that answers a documented subset of
the Dropbox API v2 (`POST /2/...`) from world state. Agents under test can list and page folders, poll the change feed,
upload and download files, move, copy, delete and restore them, walk revision history, search names and text content and
manage shared links, then assert on the resulting state. Nothing leaves the world: no Dropbox service is contacted, shared
link URLs are never served and no e-mail is sent.

This is an independently maintained Firedrill Tool package. It is not affiliated with or endorsed by Dropbox, Inc.

## Install

```sh
firedrill tool add /path/to/firedrill-tools-tool-dropbox-0.1.1.tgz --install
firedrill serve
```

`tool add` into a new project creates a world, copies the starter data and grants a default actor every operation. For an
existing world, add grants for the operations you need (`packageId: dropbox`, operation ids below) and copy the rows from
`starter.json` (or your own) into a scenario. Run the packaged conformance suite with `firedrill tool test dropbox`.

Point a Dropbox client at the Firedrill HTTP URL instead of `https://api.dropboxapi.com` / `https://content.dropboxapi.com`
(both hosts' paths are served from the same base URL) and use the Firedrill HTTP token as the bearer token.

## Identities and scopes

The caller's Dropbox account comes from actor attributes:

| attribute | meaning |
|---|---|
| `accountId` | Dropbox account id (`dbid:…`) of an `accounts` row. An id with no row answers `401 invalid_access_token` for every operation. |
| `email` | Used when `accountId` is absent; case-insensitive match on an `accounts` row, otherwise `401 invalid_access_token`. The email lookup scans at most 1000 accounts; larger worlds must set `accountId` (the 401 message says so). |
| `scopes` | Optional array of scoped-app permissions (`account_info.read`, `files.metadata.read`, `files.content.read`, `files.content.write`, `sharing.read`, `sharing.write`). Absent means a full-access token. A missing scope answers `401 missing_scope` with `required_scope`. |

**Fallback:** an actor with neither `accountId` nor `email` (for example the one `firedrill tool add` creates) acts as the
account with the lowest row id — Maya Chen in the starter data. A world without any account row gets an empty account derived
from the actor id, stored on its first write.

Accounts are isolated: every entry, revision, link and change row carries its account id, and another account's ids, revs
and link URLs behave exactly like missing ones.

## Starting data

`starter.json` (same rows as `firedrill/baseline.scenario.json`), virtual time 2026-09-14T09:00:00Z, all people fictional
(`@example.test`):

- **Maya Chen** (`dbid:AAAmaya…01`, pro, 2 GiB): 31 live entries — `/Projects/Atlas Launch` (a markdown brief with three
  revisions, a CSV, an SVG, a real PNG, a file with parentheses in its name), an empty `/Projects/Archive`, seven invoices for
  paging, `/Personal/Recipes/Pâté en croûte.txt` (non-ASCII), a real PDF, three real JPEGs under `/Photos/2026-08 Offsite`,
  `/Team Notes/Weekly sync.TXT`, `/Contracts/Vendor agreement v2.txt`, and a deleted `/Old draft.txt` with two revisions.
  Four shared links: public with expiry, public folder, password-protected folder, and one that expired on 2026-09-01.
- **Jonas Berg** (`dbid:AABjonas…02`, basic): a 65,536-byte allocation with 60,690 bytes used, so `insufficient_space` is
  reachable with an ordinary upload; his `/Projects` folder shows that namespaces are per account.

State namespaces: `meta` (`counters`, optional `limits`), `accounts`, `entries` (row `<accountId>/<id>`, deleted entries kept
as tombstones), `revisions` (row `<accountId>/<entryId>/<rev>`), `shared_links` (row `<accountId>/<linkId>`), `journal`
(change feed, 12-digit sequence). Content is stored inline: `text` for UTF-8 files, `base64` of the real bytes for binaries.

## Operations and routes

Every route is `POST`, bearer auth, at the Dropbox API v2 path. Canonical operations are also exposed as MCP tools and
through `POST /v1/operations/dropbox/<operation>`; no provider-specific MCP aliases are declared (Dropbox's remote MCP
server does not publish its tool schemas, so a matching contract cannot be verified).

| operation | HTTP route | scope | notes |
|---|---|---|---|
| `users.get-current-account` | `/2/users/get_current_account` | `account_info.read` | canonical value adds `server_time` (virtual now); the route omits it |
| `users.get-space-usage` | `/2/users/get_space_usage` | `account_info.read` | `used` = sum of live file sizes |
| `files.list-folder` | `/2/files/list_folder` | `files.metadata.read` | `recursive`, `include_deleted`, `limit` 1–2000 (default 500); sorted by `path_lower` |
| `files.list-folder-continue` | `/2/files/list_folder/continue` | `files.metadata.read` | pages the listing, then returns changes since it (deleted entries as `.tag: deleted`) |
| `files.list-folder-get-latest-cursor` | `/2/files/list_folder/get_latest_cursor` | `files.metadata.read` | cursor after the current state |
| `files.get-metadata` | `/2/files/get_metadata` | `files.metadata.read` | path, `id:` or `rev:`; `include_deleted` |
| `files.create-folder` | `/2/files/create_folder_v2` | `files.content.write` | missing parents created; `autorename` |
| `files.upload` | `/2/files/upload` | `files.content.write` | args in `Dropbox-API-Arg` or `?arg=`; UTF-8 text body; `mode` add/overwrite/update, `autorename`, `client_modified`, `content_hash` check; identical content is a no-op |
| `files.download` | `/2/files/download` | `files.content.read` | bytes in the body, metadata JSON (non-ASCII escaped) in `Dropbox-API-Result`; `rev` |
| `files.delete` | `/2/files/delete_v2` | `files.content.write` | subtree becomes restorable tombstones; `parent_rev`; links on deleted entries are removed |
| `files.move` | `/2/files/move_v2` | `files.content.write` | keeps ids and revs, case-only renames, links follow |
| `files.copy` | `/2/files/copy_v2` | `files.content.write` | new ids and revs, quota checked |
| `files.search` | `/2/files/search_v2` | `files.metadata.read` | see "Search" below; `max_results`, `order_by`, `file_status`, `filename_only`, `file_extensions`, `file_categories`, `path` |
| `files.search-continue` | `/2/files/search/continue_v2` | `files.metadata.read` | resumes by the full sort key |
| `files.list-revisions` | `/2/files/list_revisions` | `files.content.read` | newest first, `limit` 1–100, works for deleted files (`server_deleted`) |
| `files.restore` | `/2/files/restore` | `files.content.write` | new rev with the old content; un-deletes |
| `sharing.create-shared-link-with-settings` | `/2/sharing/create_shared_link_with_settings` | `sharing.write` | `requested_visibility` public/password, `link_password`, `expires`, `audience` public/no_one, `allow_download` |
| `sharing.list-shared-links` | `/2/sharing/list_shared_links` | `sharing.read` | all links, or one path (plus ancestor folder links unless `direct_only`); 200 per page |
| `sharing.revoke-shared-link` | `/2/sharing/revoke_shared_link` | `sharing.write` | body `null` |

Errors follow Dropbox's envelopes: `400` plain text `Error in call to API function "<fn>": <reason>` (invalid arguments,
bad `Content-Type`, invalid cursors, `content_hash` mismatch, oversized upload); `401` JSON `invalid_access_token` /
`missing_scope`; `409` JSON `{"error_summary": "path/not_found/...", "error": {...}}` with the route's nested union
(`path`, `path_lookup`, `path_write`, `from_lookup`, `to`, `reset`, `invalid_argument`, `invalid_revision`,
`shared_link_already_exists` with the existing link's metadata, `settings_error`, `shared_link_not_found`,
`shared_link_malformed`, `cant_move_folder_into_itself`, `duplicated_or_nested_paths`, `insufficient_quota`,
`too_many_files`); `429` JSON with `Retry-After: 1`; `500` text.

## Events and faults

| id | kind | when |
|---|---|---|
| `files.changed` | event | once per committed create-folder, upload (not for the identical-content no-op), delete, move, copy or restore, with `change`, `id`, `path_lower`, `rev` |
| `shared-link.created` / `shared-link.revoked` | events | link created / revoked |
| `rate-limited` | fault (before) | uploads, folder creation, delete, move, copy, restore and link creation answer `429 too_many_requests` |
| `write-contention` | fault (before) | upload, create folder, delete, move, restore answer `429 too_many_write_operations` |
| `upload-outage-after-commit` | fault (after commit) | the upload is stored, but the caller sees `500` — an agent should check `get_metadata`/`content_hash` before retrying |

Bounds can be tightened (never loosened) per scenario with a `meta/limits` row: `entries` (default 10,000 entry rows per
account, live and deleted), `depth` (25), `revisions` (50,000 per account), `links` (5,000), `journal` (5,000 retained
changes per world) and `uploadBytes` (262,144). A bound that would be exceeded fails with `too_many_files` (or `reset` for a
cursor older than the retained journal, or a `400` for an oversized upload); results are never silently truncated.

## Search

`files/search_v2` splits the query into words (letters and digits), folds case and accents (`pate` finds `Pâté`), and
matches an entry when every query word is a prefix of a word in its name, or — unless `filename_only` — of a word in the
content of a text file. Folders match on name only; binary files (images, PDFs) are never content-searched.
`relevance` orders filename matches first, then names with fewer extra words, then `path_lower`; `last_modified_time`
orders by `server_modified`, newest first. Highlights are not produced (`include_highlights` is accepted and ignored).
An empty query, more than 32 words, or a query containing U+FFFD answers `409 invalid_argument`.

## Compatibility

- **Not verified against a real Dropbox client.** The official SDKs (`dropbox` on npm, `dropbox` on PyPI) have not been
  run against this package, and `manifest.compatibility` is empty. The packaged conformance suite uses raw `fetch` with
  the wire shapes described above.
- Shapes follow the public Dropbox API v2 route specifications (`files`, `sharing`, `users` namespaces) for the fields
  listed here; union members without data are accepted both as `"value"` and as `{".tag": "value"}`.
- Undeclared paths (`/2/files/upload_session/start`, `/2/files/get_temporary_link`, `/2/files/delete`, …) answer the
  framework's `404` JSON body rather than Dropbox's `400 Unknown API function`; a declared path with another method answers
  the framework's `405`.
- Firedrill grant denials answer `403` with `{"error_summary": "no_permission/...", "error": {".tag": "no_permission"}}`;
  this is a Firedrill access decision, not a Dropbox error.
- Requests the codec cannot map (unparseable `Dropbox-API-Arg`, a wrong `Content-Type`, JSON nested deeper than 512 levels,
  both `Dropbox-API-Arg` and `arg`) answer Dropbox's `400` text form through a rejected-argument path, so the message after
  the prefix is this package's wording. Non-UTF-8 upload bodies are refused by the framework itself (`400
  framework.HTTP_BODY_INVALID`, JSON).

## Browser app

`firedrill serve` also starts a browser app (declared as `"ui": {"root": "app/site"}`) that looks and works like the
Dropbox web app and calls the same operations as agents through `/_firedrill/client.js`, as the selected actor:

- **Shell**: product rail (Dropbox mark, Home, All files, Photos, Shared, Signatures, Send and track, More, Settings),
  section sidebar (All files, Recents, Starred, Photos, Shared, Deleted files, top-level folders, plan and storage meter
  from `get_space_usage`), top bar with Search, Upgrade, help, notifications, apps and the account menu.
- **All files**: breadcrumb, Create (Folder, Text file), Upload (Files as text content), list/grid view, the
  Name · Who can access · Modified table sorted folders first, hover Share button, "…" menu (Open, Download, Copy link,
  Share, Rename, Move, Copy, Version history, Delete), multi-select with Move/Copy/Delete; pages of 100 with "Show more"
  through `list_folder/continue`; empty-folder, error and denied states.
- **Preview**: text and Markdown as a page, CSV as a table, PNG/JPEG/GIF/WebP/SVG as images, other types "Preview not
  available"; Share, Download, Edit (text files, uploads with `mode: update` on the current rev so a stale edit is refused)
  and an Info panel (size, type, modified, location, access, number of versions).
- **Dialogs**: Share (create a link with visibility, password, expiry and download settings, copy it, delete it),
  Move/Copy folder picker (with Create folder and "Keep both" after a conflict), Version history (download or restore a
  version), confirmations for Delete, Delete link and Restore.
- **Home** (recent files), **Photos** (image files grouped by month), **Shared** (the account's links), **Deleted files**
  (restore the latest version) and **Search results** (type filters, file names only, "Show more results").

Every write carries an idempotency key, one write runs at a time, dates are formatted in UTC and relative dates use the
world's virtual time (`server_time`), and the visible view refreshes when the world revision changes.
Rendered but **not simulated** (they open a "not simulated by this Tool" panel or are disabled): Signatures, Send and
track, More (Passwords, Backup, Transfer), Settings, Upgrade / Get more space, help, notifications, apps, Starred,
Organize, Get the app, Shared folder and Paper doc creation, folder upload, folder download (zip), inviting people to a
share, the Activity and Comments tabs of the preview, the Folders/Files tabs of Shared, and Sign out. Binary files from
your computer cannot be uploaded (the Upload dialog takes text content). Photos shows thumbnails rendered from each image file's own bytes (PNG, JPEG, GIF, WebP, SVG); other files keep a file-type tile.

## Limitations

- **Subset only**: the 19 routes above. No upload sessions, batch routes, `get_temporary_link`, thumbnails or previews,
  export, Paper, file properties, locks, tags, `list_folder/longpoll`, file requests, team or business routes, shared
  folders or members, `modify_shared_link_settings`, `get_shared_link_metadata`, `get_shared_link_file`, OAuth routes or the
  deprecated unversioned routes.
- **Text uploads only**: upload bodies must be valid UTF-8, at most 262,144 bytes (Dropbox allows 150 MiB per call).
  Seeded binary files can be downloaded as bytes, moved, copied, deleted and restored.
- **Paths**: writes take `/path` destinations (not `id:`); reads and `delete_v2`, `move_v2`/`copy_v2` sources accept `id:`;
  `get_metadata` and `download` also accept `rev:`. `ns:` paths, `Dropbox-API-Path-Root` and `Dropbox-API-Select-User` are
  rejected. Case-insensitive comparison uses JavaScript's Unicode lower-casing; names with a lone surrogate are malformed.
- **Upload modes**: `update` for a path with no file answers `path/conflict/file`; `strict_conflict` and `mute` are
  accepted and have no further effect (there is no desktop client to notify).
- **Downloads**: a file whose metadata JSON (ASCII-escaped) exceeds 15,000 bytes cannot be downloaded (`400`), because
  the framework caps response headers at 16 KiB; `get_metadata` still works.
- **Shared links are records**: URLs have Dropbox's `/scl/fi/…?rlkey=…&dl=0` form but are never served; passwords are
  checked for presence and never stored; `team_only` visibility and `audience: team` answer `settings_error/not_authorized`
  (accounts have no team); only one link per entry (a second request answers `shared_link_already_exists`).
- **Revisions** are kept for the life of the world (no 30/180-day window); `list_revisions` supports `mode: path` only.
- **Change feed**: the journal keeps the newest 5,000 changes per world; older cursors answer `reset`. Several changes to
  one path in a page collapse into its current state.
- **No webhook callback** is declared: Dropbox signs notifications with the app secret over the raw body, and this package
  does not claim that the framework's callback signature matches it.
- **No MCP aliases** for Dropbox's remote MCP server (its tool schemas are not publicly documented).
- Search is the approximation described above (no OCR, stemming, fuzzy matching or Office/PDF content indexing).

## Conformance

`firedrill tool test dropbox` runs 12 drills (`firedrill/conformance.suite.json`) twice and compares the results. They
cover every operation, every declared error of every operation, all three events and all three faults, with six actors:
`owner` (Maya), `colleague` (Jonas, quota and isolation), `local-dev` (no attributes, fallback identity), `no-scopes`
(`scopes: []`), `ghost` (unknown account) and `auditor` (no grants), plus scenarios `rate-limited`, `write-contention`,
`upload-outage`, `over-bound` (`meta/limits.entries = 5`) and `tight-limits` (`uploadBytes = 64`, `journal = 3`).

## Trademarks

Dropbox and the Dropbox logo are trademarks of Dropbox, Inc. They are used here only to identify the service this Tool
simulates in a test environment. This package is not affiliated with, sponsored or endorsed by Dropbox, Inc.

## License

Apache-2.0. See `LICENSE`.
