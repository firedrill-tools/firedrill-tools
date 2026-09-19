# @firedrill-tools/google-drive

A synthetic **Google Drive** for [Firedrill](https://firedrill.run) drills. It simulates "My Drive" for a small set of
synthetic Google Workspace users behind a bounded subset of the **Drive API v3** (`/drive/v3/…` and `/upload/drive/v3/…`)
and exposes the eight tool names of Google's published **Drive MCP** contract as aliases. Each actor is one user identified
by an e-mail address; a user owns a root folder, files and folders under it, and sees other users' items through
permissions (direct, or inherited from an ancestor folder), which is how "Shared with me" is formed. Files carry metadata
plus, for text-like content, a stored body that can be read, exported, downloaded and replaced. Nothing leaves the world:
no notification e-mail is sent, no Google service is contacted, nothing is rendered by a real Docs/Sheets engine.

Tool id `google-drive` · package version `0.1.1` · engine `>=0.1.0 <0.2.0` · Apache-2.0 · **backend + browser app**
(the declaration carries `"ui": { "root": "app/site", "entry": "index.html" }`; see [Browser app](#browser-app)).

## Install

```sh
firedrill tool add @firedrill-tools/google-drive --install
firedrill serve
```

`tool add --install` on a fresh project creates `local-dev` with every operation granted and copies the 111 starter rows
(virtual time 2026-09-14T09:00Z). In an existing project it changes nothing silently: add the grants you want to the actor
that represents your agent, for example

```json
{ "id": "agent", "attributes": { "email": "dana.reyes@example.test", "displayName": "Dana Reyes" },
  "grants": [ { "packageId": "google-drive", "operationId": "files.list" }, { "packageId": "google-drive", "operationId": "files.create" } ] }
```

### Identities

| actor attribute | use |
|---|---|
| `email` (optional) | the user's address, lower-cased. **Without it the actor acts as the world's primary seeded user**: the lowest `users` row id (`dana.reyes@example.test` in the starter data), so the grant-only `local-dev` actor that `tool add --install` creates sees the starter Drive with no manual step. A world without any `users` row falls back to `<actorId>@example.test`. An explicit address that has no `users` row is an empty Drive whose user row and root folder are materialised on first contact — never an error. |
| `displayName` (optional) | overrides the `users` row's display name in `owners[]`, `lastModifyingUser`, `sharingUser` and permission `displayName`. |

A full user needs all 19 grants (the operation ids in the table below). Framework grants authorise calling an operation;
an actor without a grant gets a Drive-shaped 403 `insufficientPermissions` ("Insufficient Permission") over HTTP and
`isError` over MCP. Row-level access (owner / writer / commenter / reader) is computed by the Tool, see [Access model](#access-model).

## Starting data

`starter.json` (and the author world in `firedrill/world.json`) holds 111 fictional rows: 1 counter row, 3 users, 31 files
(3 roots + 28 items), 21 content bodies, 43 direct permissions (31 owner rows + 12 shares) and 12 per-user rows. Everything is
authored around the virtual instant 2026-09-14T09:00Z (a Monday), which `starter.json` carries as `virtualTimeUs`.

- **Dana Reyes** (`dana.reyes@example.test`, 15 GiB quota, permission id `06000000000000000001`) — the primary agent user.
  `Projects` (blue folder) holds `Billing v2` (shared with Sam as an editor: a Google Doc of design notes, an invoice
  schedule Sheet, a kickoff Slides deck and a PDF vendor comparison), `Platform roadmap.md` (the only file whose text
  contains "observability"; Sam reads it; carries `properties`/`appProperties`) and `Archive` (a trashed `2025 retro.txt`
  and a starred `Old budget.csv`). In her root: `Team handbook` (anyone with the link), `Onboarding checklist` (visible to
  the whole `example.test` domain, discoverable), `Contract draft - ACME.docx` (Sam edits), an empty `Screenshots` folder, a
  shortcut to Sam's Q3 planning notes, `Expense report - August.xlsx` (Sam comments until 2026-10-01), two `Meeting notes`
  Docs she viewed on 11 and 13 September, and `logo.png`.
- **Sam Okafor** (`sam.okafor@example.test`, 15 GiB, `…02`) — `Q3 planning notes` (Dana reads), a private salary-bands
  Sheet nobody else sees, the `Design system` folder (Dana edits, but *editors cannot share*) with `Tokens.json`,
  `Component inventory` (Ravi reads, *viewers cannot copy or download*) and `Offsite photos` (Dana reads; three PNGs for
  paging and natural ordering).
- **Ravi Menon** (`ravi.menon@example.test`, `…03`) — owns nothing and has a **4,096-byte storage quota**, so
  `STORAGE_QUOTA_EXCEEDED` is reachable without a fault.

Binary bodies are small, real files stored as base64 of their bytes: a one-page PDF (`Vendor comparison.pdf`), a DOCX and an
XLSX (valid ZIP packages with a document/worksheet part) and four RGB PNGs (`logo.png` 32×32, `IMG_0401`–`0403` 48×36); each
row's `size` and `md5Checksum` are those of the bytes `files.get?alt=media` returns. Google
Docs/Sheets/Slides bodies are plain text (Sheets as CSV). All addresses use `example.test`, `example.com` or `example.org`;
the content is invented. Replace it with your own scenarios — nothing in the behavior depends on these rows. Starter ids use
the prefix `1st…` (files) and `05…`/`06…` (permissions); generated ids use `1fd…`, `07…` and `08…`, so they never collide.

## Operations

Canonical MCP names are `google-drive.<operation>`; the alias column lists the Google Drive MCP tool name exposed in
addition. `fileId` accepts the alias `root` everywhere. Every `File` is returned as the REST `File` resource (camelCase
discovery-document names, int64 values as strings) **plus** the MCP conveniences `title`, `parentId`, `fileSize`, `viewUrl`,
`owner`, `contentSnippet` (first 200 characters of stored text) and `canAddChildren`, which the REST routes strip.

| operation | MCP alias | HTTP route | notes |
|---|---|---|---|
| `about.get` | — | `GET /drive/v3/about` | `user`, `storageQuota` (int64 strings; `limit` absent when unlimited), supported import/export formats, `folderColorPalette`; the canonical/MCP result also carries `serverTime` (the world's virtual now, RFC 3339 UTC) — the REST resource omits it |
| `files.list` | `search_files` | `GET /drive/v3/files` | `q` (grammar below), `orderBy`, `pageSize` (≤1000, default 100), `pageToken`, `spaces=drive`, `corpora=user`, `fields`; without `q` trashed items are included, as in Google; default order `folder,modifiedTime desc,name` |
| `files.recent` | `list_recent_files` | — (MCP/canonical only) | `orderBy` `recency` (default) / `lastModified` / `lastModifiedByMe`, `pageSize` (default 10); no folders, no trashed items |
| `files.get` | `get_file_metadata` | `GET /drive/v3/files/{fileId}` | canonical result `{ file }`; `alt=media` returns the stored bytes of a blob (`{ media }` canonically; raw body over REST) and records a view |
| `files.create` | `create_file` | `POST /drive/v3/files` (JSON metadata) · `POST /upload/drive/v3/files?uploadType=media` (UTF-8 body, `Content-Type` = content type, name `Untitled`) | folders, shortcuts, Google Docs/Sheets/Slides with a text body, blobs with `textContent`/`base64Content`; conversion to a Google type only when `mimeType` names one and `contentMimeType` is importable (`text/plain`, `text/markdown`, `text/html` → Docs; `text/csv`, `text/tab-separated-values` → Sheets); `disableConversionToGoogleType` keeps a blob |
| `files.update` | — | `PATCH /drive/v3/files/{fileId}` · `PATCH /upload/drive/v3/files/{fileId}?uploadType=media` | rename, description, `mimeType` (blobs), `starred` / `viewedByMeTime` (per user, no version bump), `trashed` (owner; cascades), `addParents`/`removeParents` (move; single parent), `folderColorRgb`, `properties`/`appProperties` (`null` deletes a key), `writersCanShare` / `copyRequiresWriterPermission` (owner), content replace; an empty-effect patch changes nothing |
| `files.copy` | `copy_file` | `POST /drive/v3/files/{fileId}/copy` | not folders; needs `canCopy`; default name `Copy of …`; destination = source parent when writable, else the caller's root |
| `files.delete` | — | `DELETE /drive/v3/files/{fileId}` (204) | owner only; a folder cascades to the caller's descendants, items owned by others move to their owner's root |
| `files.empty-trash` | — | — (canonical only) | permanently deletes every trashed file the caller owns; `{ deleted }`. No REST route: `DELETE /drive/v3/files/trash` would overlap `DELETE /drive/v3/files/{fileId}` under the framework's route rule |
| `files.export` | — | `GET /drive/v3/files/{fileId}/export?mimeType=…` | Docs → `text/plain`, `text/markdown`, `text/html`; Sheets → `text/csv`, `text/tab-separated-values`; Slides → `text/plain`; raw body |
| `files.download` | `download_file_content` | — (MCP/canonical only) | `{ id, title, mimeType, content }` with base64 content; Google types are exported first (`exportMimeType`, default `text/plain` / `text/csv`) |
| `files.read-content` | `read_file_content` | — (MCP/canonical only) | plain text of Google types and text blobs; shortcuts resolve to their target; binary blobs and folders give `""` with `textFormattingNotSupported: true` |
| `permissions.list` | `get_file_permissions` | `GET /drive/v3/files/{fileId}/permissions` | direct rows (owner first) then rows inherited from ancestor folders flagged with `permissionDetails`; `pageSize`, `pageToken`, `fields` |
| `permissions.get` | — | `GET …/permissions/{permissionId}` | direct rows only |
| `permissions.create` | — | `POST …/permissions` | `user` / `group` / `domain` / `anyone`; an existing grantee is updated in place; `expirationTime` (user/group, future); `transferOwnership=true` with `role=owner` to another in-world user (`moveToNewOwnersRoot`); `sendNotificationEmail` / `emailMessage` validated, never sent |
| `permissions.update` | — | `PATCH …/permissions/{permissionId}` | `role`, `expirationTime`, `removeExpiration`, `transferOwnership` |
| `permissions.delete` | — | `DELETE …/permissions/{permissionId}` (204) | never the owner row |
| `changes.start-page-token` | — | `GET /drive/v3/changes/startPageToken` | |
| `changes.list` | — | `GET /drive/v3/changes?pageToken=…` | journal of every successful mutation visible to the caller; `includeRemoved`, `pageSize`, `newStartPageToken` on the last page |

Canonical inputs use the field names of Google's Drive MCP tools (`query`, `pageSize`, `pageToken`, `excludeContentSnippets`,
`fileId`, `exportMimeType`, `title`, `contentMimeType`, `textContent`, `base64Content`, `parentId`,
`disableConversionToGoogleType`, plus the deprecated aliases `content` and `mimeType` where Google documents them) and the
REST codecs translate to and from the Drive API spelling (`q`, `name`, `parents[]`, `addParents`, …). Canonical `mimeType`
keeps its REST meaning (the type of the created file); `contentMimeType` is the type of the uploaded body.

### Query grammar (`q`)

`name` (`contains` = case-insensitive prefix-of-word match, `=`, `!=`), `fullText contains` (case-insensitive substring over
name, description and stored text), `mimeType` (`=`, `!=`), `trashed` / `starred` / `sharedWithMe` (`=`, `!=` with
`true`/`false`), `modifiedTime` / `createdTime` / `viewedByMeTime` (`<`, `<=`, `=`, `!=`, `>`, `>=` against RFC 3339; a date
alone means midnight UTC), `'<id>' in parents` (`root` allowed), `'<address>' in owners | writers | readers` (effective role,
case-insensitive), `visibility = 'anyoneCanFind' | 'anyoneWithLink' | 'domainCanFind' | 'domainWithLink' | 'limited'`,
`shortcutDetails.targetId = '…'`, `properties has { key='k' and value='v' }`, `appProperties has {…}`, combined with `and`,
`or`, `not` and parentheses; string values in single quotes with `\'` and `\\` escapes. Anything else is 400 `invalid`
(`location: q`). Malformed percent-encoding in `q` reaches the Tool as U+FFFD (the framework decodes query strings
leniently); a `q` holding U+FFFD is a mangled request, so it answers 400 `invalid` (`location: q`) instead of quietly
matching nothing. A correctly encoded U+FFFD (`%EF%BF%BD`) is refused the same way; `%ZZ` stays literal and is ordinary
text. Correctly encoded accented, CJK and emoji terms search normally. `orderBy` keys: `createdTime`, `folder`, `modifiedByMeTime`, `modifiedTime`, `name`, `name_natural`,
`quotaBytesUsed`, `recency`, `sharedWithMeTime`, `starred`, `viewedByMeTime`, each with an optional ` desc`.

`fields` masks are honoured on the REST routes one level deep (`files(id,name),nextPageToken`, `*`); an unknown name is
400 `invalidParameter`. Without `fields` the full resource is returned (Google's default set for `files.list` is smaller).

### Access model

The effective role of an address on a file is the highest of: `owner` (the `ownerEmail`), and every direct permission row on
the file or on any ancestor folder that names the address (`user`), its domain (`domain`) or `anyone`, ignoring expired rows
and `group` rows (groups are never expanded). An ancestor folder's owner is an editor of items others create inside it.
Roles: `owner > writer > commenter > reader`; a file with no role is **404** (no probing). `capabilities` follow from the
role: readers download and copy (unless `copyRequiresWriterPermission`), commenters comment, writers edit, rename, replace
content, move and add children, and share when `writersCanShare` holds on the file *and* every ancestor folder; only the
owner trashes, restores, permanently deletes, changes the sharing flags or transfers ownership; the root folder can be
neither renamed, moved, shared, trashed nor deleted. `starred`, `viewedByMe(Time)`, `modifiedByMe(Time)` and
`sharedWithMeTime` are per user. `permissions[]`/`permissionIds[]` appear on a `File` for its owner only, as in Google.

### Errors

Drive's classic envelope `{ "error": { "errors": [{ "domain", "reason", "message", "locationType"?, "location"? }], "code",
"message" } }` with `notFound` (404), `badRequest` / `invalid` / `invalidParameter` / `required` (400),
`invalidSharingRequest` (400), `insufficientFilePermissions` (403), `fileNotExportable` (403), `storageQuotaExceeded` (403),
`usageLimits/userRateLimitExceeded` (403, `Retry-After: 30`), `sharingRateLimitExceeded` (403) and `backendError` (500).
Framework outcomes keep Firedrill's status codes with a Drive-shaped body: schema failures 400 `badRequest`, missing grants
403 `insufficientPermissions`; unknown routes are the framework 404 and undeclared methods on a known path 405. A request the
codec cannot map (for example `driveId=…`, a non-integer `pageSize`, or a PATCH without a JSON content type) is the framework's
400/415 envelope.

### Bounds

Every bound is a row in `meta` with id `limits` (optional; defaults `files` 5000, `children` 500 per folder, `permissions`
100 per file, `depth` 100 folder levels, `changes` 20000, `users` 200). Operations that read the whole `files` namespace
(`about.get`, `files.list`, `files.recent`, creating or copying into a folder, trashing or deleting a folder,
`files.empty-trash`) refuse a world beyond `files` with 400 `badRequest` (`FAILED_PRECONDITION`) instead of serving a
truncated view; writes refuse to fill a bound further. Point reads and single-file writes keep working. Content is capped at
256 KiB per file (`maxUploadSize` in `about`), and the framework caps HTTP bodies at 1 MiB. List pages are therefore filled by
bytes as well as by count: `files.list`, `files.recent`, `permissions.list` and `changes.list` stop a page before its entries pass
about 900 KB of UTF-8 (measured on the entry as sent on the widest surface: the larger of the `fields`-masked REST entry and the
MCP framing of the full canonical entry, which carries the value twice) and
return a real `nextPageToken`, so a page can hold fewer than `pageSize` items, as Google allows. Page tokens are opaque, bounded
(a few hundred characters whatever the file names) and checksummed; a forged, truncated or tampered token, or one issued for other
arguments, answers 400 `badRequest` (`location: pageToken`). Pagination is live: when the last file of a page is renamed, moved or
trashed before the next page is fetched, no unchanged file is skipped; files whose long names share its first 24 characters may be
sent again. An export whose rendering exceeds its declared output bound (more than 400,000 characters or 900 KB for `files.export`;
more than 300,000 bytes, i.e. 400,000 base64 characters, for an export-based `files.download`) answers 403
`exportSizeLimitExceeded`.
The canonical `/v1/operations` endpoint and the MCP aliases ignore the REST `fields` mask and return the full operation
value, and an MCP tool result carries that value twice (JSON-escaped in `content[0].text` and again as
`structuredContent`), so the same page is a little over twice as large there. Pages are therefore filled against that
widest rendering: a `files.list`, `files.recent`, `permissions.list` or `changes.list` page stays under 1 MiB over REST,
over `/v1/operations` and over MCP, whatever `fields` asks for. A page may consequently be shorter than `pageSize` even
when the REST body is small.

## Events and faults

| id | kind | payload / effect |
|---|---|---|
| `file.created` | event | `{ fileId, name, mimeType, parentId, ownerEmail, actorEmail, source: "create" \| "upload" \| "copy" }` |
| `file.changed` | event | `{ fileId, actorEmail, changedFields, version, trashed, parentId? }` from `files.update` (only when something changed; `changedFields` such as `["name"]`, `["trashed"]`, `["parents"]`, `["content"]`, `["starred"]`) and from `permissions.create/update/delete` (`["permissions"]`, plus `"owners"`/`"parents"` on a transfer) |
| `file.deleted` | event | `{ fileId, actorEmail, cascade, removedCount }` from `files.delete` and (with `fileId: ""`) from `files.empty-trash` |
| `user-rate-limited` | fault | every write (`files.create/update/copy/delete/empty-trash`, `permissions.create/update/delete`) → 403 `usageLimits/userRateLimitExceeded` + `Retry-After: 30`; no state change |
| `sharing-rate-limited` | fault | `permissions.create` → 403 `sharingRateLimitExceeded`; every other write keeps working |
| `backend-error` | fault | `files.list`, `files.get`, `files.create`, `files.copy` → 500 `backendError` before any state change |
| `storage-quota-exceeded` | fault | `files.create`, `files.update`, `files.copy` → 403 `storageQuotaExceeded` regardless of the real quota (the same code is reached naturally when a user's `storageQuotaLimit` would be exceeded) |

Activate a fault in a scenario with `"faults": [{ "packageId": "google-drive", "faultId": "backend-error" }]`.

## Browser app

`firedrill serve` also starts a browser client for this Tool ("Tools → Open app" in the inspector, or the app link printed
by `serve`). It is a recreation of the Google Drive web client — the same shell (hamburger, Drive mark and wordmark, the
wide rounded search field, help/settings/apps/avatar, the white "+ New" pill, the nav rail, the rounded white content
surface), the same palette (`#f8fafd` page, Google blue `#0b57d0`, `#c2e7ff` selection), Roboto, Material Symbols glyphs and
Drive's own list/grid rows, menus, dialogs and empty states.

Every screen is the Tool's own operations, so a change made in the app is immediately visible over the REST routes and the
MCP aliases, and vice versa; a reset restores both.

| screen | what it does | operations |
|---|---|---|
| Home | "Suggested files" cards plus a recently-opened list | `files.recent`, `about.get` |
| My Drive / folders | breadcrumb navigation, sortable Name / Owner / Last modified / File size columns, list and grid layout, `Load more` paging, per-row star and ⋮ menu, right-click menu | `files.list` (`'<id>' in parents and trashed = false`, `orderBy`, `pageToken`) |
| Shared with me · Recent · Starred · Trash | grouped by sharer / by recency bucket, trash bar with **Empty trash**, restore and delete-forever | `files.list` (`sharedWithMe`, `starred`, `trashed`), `files.update`, `files.delete`, `files.empty-trash` |
| Search | the search field and an advanced-search popover (type, owner, words, date modified) that shows the compiled Drive query; the chip row **Type · People · Modified** filters any view | `files.list` |
| Preview | Drive's dark viewer: Docs/Slides and text blobs as a page, Sheets as a grid, images inline, "No preview available" with Download for everything else | `files.get`, `files.read-content`, `files.export`, `files.download` |
| Editor | title plus plain-text body for Docs/Sheets/Slides with an explicit **Save** | `files.update` (`textContent`) |
| Details pane | thumbnail, who has access, type/size/storage/location/owner/modified/opened/created/checksum, editable description, and an **Activity** tab from the change journal | `files.get`, `permissions.list`, `files.update`, `changes.list` |
| Share dialog | add people or a domain with a role, change or remove a role, transfer ownership, expiring rows and inherited rows marked as such, General access (Restricted / domain / Anyone with the link), Copy link | `permissions.list/create/update/delete` |
| Move dialog | folder browser with breadcrumb and **Show more folders** paging (every sub-folder is reachable, 100 per request); **Move** stays disabled for the current parent and for the item itself | `files.list`, `files.update` (`addParents`/`removeParents`) |
| New menu | New folder, File upload (paste text with a MIME type, optional conversion to the Google type), blank Google Docs / Sheets / Slides | `files.create` |
| Sidebar tree | the My Drive caret expands its top-level folders (100 per request, **Show more folders** until every folder is listed) | `files.list` |
| Row hover and selection bar | hovering a row shows Share, Download, Rename and Add to starred; ctrl/cmd-click and shift-click select several items and the selection bar offers Share, Download, Move, Move to trash, Copy link and More (Share, Move and Copy link need exactly one item; trash, restore and star apply to every selected item, one idempotent call each) | `files.update`, `permissions.*`, `files.download` |
| Source chip | Owned by me / Shared with me / Starred, added to the compiled `q` next to Type, People and Modified | `files.list` |

Behaviour: every mutation carries a fresh idempotency key; destructive actions confirm ("Delete forever?", "Empty trash?")
and trashing offers **Undo**; loading skeletons, empty states, an error banner with **Retry**, rate-limit and quota
snackbars and a "You don't have access to this Drive" panel for an actor without grants are all rendered from the real
outcomes; the world revision is polled every 2 s and a background change re-reads the list without discarding an open form;
`/` focuses search, `↑`/`↓` move the selection, `Enter` opens, `Esc` closes. **All dates come from `about.get.serverTime`**
(the world's virtual clock), never from the browser clock, so a replay renders identically on any day. The app ships no
remote request: Roboto, the Drive/Docs/Sheets/Slides marks and the Forms/Calendar/Keep/Tasks/Contacts marks are local files under `firedrill/tools/google-drive/app/`
(sources and licences in `app/assets/ATTRIBUTION.md`), and every record string is rendered with `textContent`.

Not simulated (rendered in place with Drive's glyph, hover state and tooltip; each opens a short "not simulated by this
Tool" panel and changes nothing): the header **Ready for offline** button; the **Support** menu's Training, Updates and Send
feedback entries (Help opens this app's own help); the **Settings** menu's Settings and Get Drive for desktop entries; the
Google apps launcher tiles for Account, Forms, Calendar, Keep, Tasks and Contacts (Drive opens Home, Docs/Sheets/Slides create a
blank file); the sidebar **Computers** entry and its caret, **Spam**, and **Get more storage**; the New menu's **Folder
upload**, **Google Forms** and **More** (Drawings, My Maps, Sites, Apps Script, Jamboard); the right side panel's **Calendar**,
**Keep**, **Tasks**, **Contacts** and **Get add-ons** buttons (the panel itself can be hidden and shown). Home shows the 8 most
recent folders and the 24 most recently used files as suggestions and says so; it is not Google's ranking model.

App limitations: Docs/Sheets/Slides are plain text (Sheets renders the stored CSV as a grid), so there is no rich
formatting, no comments and no collaborative cursor; "Download" hands the bytes the Tool returns to the browser; drag and
drop, real file uploads, thumbnails, OCR, shared drives, activity per-actor detail and offline mode do not exist; the
Activity tab shows the Tool's change journal entries (changed / deleted forever), not Google's activity feed; PDF and Office
blobs show "No preview available" with Download (the app does not render them), and an image whose bytes the browser cannot
decode (for example one you upload as an arbitrary `base64Content`) falls back to the same card.

## Connecting a client

`manifest.connections` describes two seams for test processes: `googleapis-http` (`GOOGLE_DRIVE_API_BASE_URL` ←
`FIREDRILL_HTTP_URL`, `GOOGLE_DRIVE_ACCESS_TOKEN` ← `FIREDRILL_HTTP_TOKEN`: point the client's root URL at the base so requests
hit `<base>/drive/v3/…` and `<base>/upload/drive/v3/…` and send the token as `Authorization: Bearer`) and `drive-mcp`
(`GOOGLE_DRIVE_MCP_URL` ← `FIREDRILL_MCP_URL`, `GOOGLE_DRIVE_MCP_TOKEN` ← `FIREDRILL_MCP_TOKEN`, Streamable HTTP). Protocol
compatibility statement: **not verified against a real client.** Neither Google's Drive MCP server
(`drivemcp.googleapis.com`), the `googleapis` Node client, `google-api-python-client` nor any other client library has been
run against this package; the alias names and input argument names follow Google's published tool documentation as read
on 2026-09-14, and the alias outputs are documented supersets whose exact field naming is unverified. `manifest.compatibility`
is empty. Uploads must use `uploadType=media` with a UTF-8 body: `multipart` and `resumable` uploads (the default of most
`googleapis` `files.create({ media })` calls) answer 400, and a non-UTF-8 body is refused by the framework — binary content is
created through the canonical/MCP `base64Content`.

## Conformance

`firedrill tool test google-drive` runs thirteen drills twice (REST flow as the owner, MCP aliases, sharing roles as the
colleague, the intern's quota, a fresh-install actor without identity attributes, a denied actor, the four faults, the
`over-bound` scenario and the `cyclic-parents` scenario, whose hand-authored folder cycle is the only way to reach the
ancestor-chain bound) from `firedrill/` with the Node-only target `test/conformance.mjs`, checks that every operation, every
declared error of every operation, every event and every fault was observed, and compares the two passes. Author-written
checks are not certification of Google Drive fidelity.

## Limitations

- A bounded subset of Google Drive API v3: 19 operations / 17 REST routes, My Drive only. Every other endpoint returns the
  framework 404 (unknown path) or 405 (known path, undeclared method): no shared drives (`drives.*`, `driveId`,
  `corpora=drive|allDrives`), no `files.watch`/`changes.watch`/`channels.stop` push, no `revisions.*`, `comments.*`/`replies.*`,
  `files.generateIds` (client-assigned `id` on create is refused), labels, access proposals, `apps.*`, `appDataFolder`, batch,
  `$discovery`. `files.emptyTrash` is canonical/MCP only (route overlap rule above).
- Uploads are `uploadType=media` with a UTF-8 text body of at most 256 KiB; `multipart`/`resumable` → 400. Content is stored,
  never rendered: Docs/Sheets/Slides are plain-text (Sheets: CSV) representations; export covers the text-based formats only
  (`application/pdf`, Office, OpenDocument, images, thumbnails, OCR and import of binary Office bodies → 400). Blobs keep their
  bytes verbatim (`md5Checksum`, `size`); `acknowledgeAbuse`, `keepRevisionForever`, `ignoreDefaultVisibility`,
  `supportsAllDrives`, `includeItemsFromAllDrives`, `includePermissionsForView`, `restrictToMyDrive` are accepted and ignored;
  `createdTime`/`modifiedTime` cannot be set by the client.
- Authentication is the isolated world bearer token; OAuth scopes, consent, service accounts, domain-wide delegation and
  `isAppAuthorized` are not emulated.
- Sharing never leaves the world: notification e-mails are validated and ignored; sharing with an address that has no
  `users` row records the permission but nobody can act on it; groups are listed but never expanded; domain permissions match
  the address suffix; ownership transfers apply immediately to in-world users only (no `pendingOwner` consent, no quota check
  on the new owner, descendants of a transferred folder keep their owner); `photoLink` is absent; `deleted` is always false.
- Inherited permission rows are listed with `permissionDetails` but cannot be read, changed or removed through the
  descendant. `writersCanShare=false` on a folder applies to its contents; `resourceKey`s do not exist.
- `files.list` returns the full `File` by default; `fields` masks are one level deep; default ordering is
  `folder,modifiedTime desc,name`; `pageSize` above 1000 → 400; pagination is live (not a snapshot); tokens are bound to the
  exact query/order arguments.
- `fullText` is substring matching (no stemming, ranking or Google's tokenisation); `name contains` is prefix-of-word matching;
  `properties`/`appProperties` are plain maps with no per-app scoping; `visibility` is derived from direct rows only.
- Trash and delete follow Google's owner-only rule; trashing a folder trashes every descendant regardless of owner; trashed
  items are never auto-purged; trash, restore and move bump `version` but leave `modifiedTime` unchanged.
- `changes.list` is a simple per-world journal (`changeType: "file"`, no `drive` changes); removed entries are returned to users
  who could see the file at removal time; tokens never expire.
- `viewedByMeTime` is updated by content reads (`alt=media`, `read_file_content`, `download_file_content`, `export`) and by
  explicit patches, not by metadata reads; `modifiedByMeTime` by any successful write of the actor.
- Storage quota counts stored bytes of every file the user owns (Google Workspace types count their text size, as Google
  has done since 2021); `usageInTrash` counts trashed items; `limit` is per `users` row (`0` = unlimited).
- Virtual time only: every timestamp resolves against the world clock.
- All data is fictional. Never point this package at a production Google account; it cannot reach one.

## Trademarks

Google Drive, Google Docs, Google Sheets, Google Slides, Google Forms, Google Calendar, Google Keep, Google Tasks, Google
Contacts, Google Workspace and Google, and the Drive, Docs, Sheets, Slides, Forms, Calendar, Keep, Tasks and Contacts
logos shipped with the browser app under `firedrill/tools/google-drive/app/`, are trademarks of Google LLC. The names and
logos are used here only to identify the service this package simulates inside a test environment; this package is an
independent Firedrill Tool and is not affiliated with, sponsored by or endorsed by Google. Every logo file is the vendor's
own artwork, downloaded unmodified, with its source URL recorded in `app/assets/ATTRIBUTION.md`; the bundled Roboto subset
is used under the SIL Open Font License 1.1 (`app/assets/fonts/OFL.txt`).
