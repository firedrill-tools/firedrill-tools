# @firedrill-tools/tool-google-docs

A synthetic Google Docs service for [Firedrill](https://firedrill.run): a small set of in-world Google Workspace
users, their documents, and the operations an agent performs on and around a document — read it, create it, edit its
body with `batchUpdate`, search for it, rename or trash it, copy it, export its text, share it, comment on it and read
its version history.

It speaks two Google APIs at once, because a real Docs agent meets both:

- **Docs API v1** (`/v1/documents…`) for the document itself, with Google's `google.rpc` error envelope.
- **Drive API v3** (`/drive/v3/…`) for everything around the document, with Drive's classic error envelope —
  **restricted to files whose `mimeType` is `application/vnd.google-apps.document`**. This is a Docs Tool that speaks
  the slice of Drive a Docs agent cannot avoid, not a Drive clone.

Everything runs locally against Firedrill's state, virtual clock and evidence. No Google service is contacted, no
document is rendered, no notification e-mail is sent, and there are no credentials anywhere.

- **22 operations · 22 provider-shaped HTTP routes · 2 Google MCP tool aliases · 3 events · 3 faults · 71 starter rows**
- **A Google Docs-style browser app** that works on the same world as HTTP and MCP. See *Browser app*.

## Install

```sh
firedrill tool add @firedrill-tools/tool-google-docs --install     # from a registry
firedrill tool add ./firedrill-tools-tool-google-docs-0.1.1.tgz --install   # from a local archive
firedrill serve --scenario baseline --no-open
```

`tool add --install` creates a world if the project has none, copies the 71 starter rows and grants the default actor
every operation. `firedrill serve` also serves the browser app: open it with **Tools → Open app** or the app link it
prints. Installing into an existing world does **not** change its data or grants: add them yourself.

```json
{ "packageId": "google-docs", "operationId": "documents.get" }
```

Grant only what the agent under test should be able to do — the conformance world in this package keeps one actor with
read grants only precisely to prove that framework denial and the package's own permission rules are two different
layers.

## Identities

The Tool resolves the calling user from the actor's attributes:

| attribute | meaning |
| --- | --- |
| `email` | The signed-in Workspace user. |
| `displayName` | Overrides the stored display name in `owners[]`, `lastModifyingUser`, comment authors and permissions. |

**An actor with no attributes is not an empty account.** It acts as the *primary seeded user* — the `users` row with
the lowest row id, which is `dana.reyes@example.test` in the starter data — so a freshly installed world opens a
populated Docs home. Only a world with no `users` row at all falls back to `<actorId>@example.test`, materialising that
row on the first read or write. An explicit `email` always wins; an explicit address that has no `users` row is a valid
but empty account (`about.get` works, nothing is visible), never an authentication error.

## Starting data

Nine documents owned by four fictional people at `example.test` / `example.com`:

| document | owner | shape |
| --- | --- | --- |
| Q4 launch plan | Dana | Title, headings, a bulleted list, a 3×3 table, a named range, one comment with three replies |
| Weekly product sync notes | Dana | Headings and a numbered list; four open comments, one resolved, one deleted tombstone; a domain share |
| Pricing update - DRAFT | Dana | A table; shared with **anyone** with the link (`allowFileDiscovery: false`) |
| Interview loop rubric | Miguel | Dana is a writer |
| Support escalation policy | Priya | Dana is a **reader** only — the `PERMISSION_DENIED` fixture |
| Offsite agenda | Dana | In the trash (`explicitlyTrashed`) |
| Empty doc | Dana | Nothing but the section break and one empty paragraph |
| Release notes 2026-08 | Dana | A non-BMP emoji, an accented word, a link run and a superscript run — the UTF-16 index fixture |
| Roadmap one-pager | Sam (`example.com`) | Shared with nobody in `example.test` — must answer `NOT_FOUND`, not `403` |

World virtual time is `2026-09-14T09:00:00.000Z` and every seeded timestamp is earlier, so relative dates render
identically whenever the world is replayed. `starter.json` carries the same `virtualTimeUs`, so a world created by
`firedrill tool add` starts at that instant too: records it creates are stamped 2026-09-14, not 1970. `about.get` returns that virtual time as `serverTime`, which is where a UI
or an agent should get "now" from — never from a wall clock.

## Browser app

The package declares a browser app — `"ui": { "root": "app/site", "entry": "index.html" }` — written in plain HTML, CSS
and JavaScript with no build step and no remote requests. The Google Docs mark, the five Workspace side-panel marks the
editor rail carries, and the Roboto font are bundled with their sources and licences recorded in
`firedrill/tools/google-docs/app/assets/ATTRIBUTION.md`.

**Open it.** Run `firedrill serve` (add `--actor <id>` when the world has more than one actor — `--actor dana` in this
package's own conformance world), then choose **Tools → Open app** in the inspector, or open the app link `serve` prints
(`apps[].url` in `--json` output). Nothing else has to be started.

**Same world as your agent.** Every screen calls this package's own operations through Firedrill's app client, under the
serving actor's grants, so the app, an agent over HTTP or MCP, and drill assertions all read and write the same state.
Text typed in the app is committed with `documents.batchUpdate` and is visible to `GET /v1/documents/{id}` straight
away; a change made over HTTP or MCP shows up in the open app within about four seconds (the app watches the world
revision and refreshes, without discarding an edit in progress). Resetting the world resets both. Dates and "today" come
from `about.get`'s `serverTime` — world virtual time — never from the browser clock.

| screen | what it shows | operations |
| --- | --- | --- |
| **Docs home** | The Docs mark and "Docs" in the header, a search box and the account avatar; the "Start a new document" band with Blank and three starter templates (Meeting notes, Project proposal, Product brief); "Recent documents" as a list — Name, Owned by, and a date column that follows the sort (Last opened by me, Last modified, Date created, Title) — or as a grid of cards; the "Owned by anyone / by me / not by me" filter; and a row menu (Open, Rename, Share, Make a copy, Add to / Remove from Starred, Download, Move to trash). The main menu switches to Starred, Shared with me and Trash (Restore, and Delete forever after a confirmation). A search or filter shows the exact Drive `q` it sends as a chip. | `about.get`, `files.list`, `files.update`, `files.copy`, `files.delete`, `files.export`, `documents.create`, `documents.batch-update` |
| **Document editor** | The title (renamable), star, move-to-folder, the document-status cloud button and the "All changes saved in Drive" chip; File, Edit, View, Insert, Format, Tools, Extensions and Help menus; the formatting toolbar (zoom, paragraph style, font and size, bold/italic/underline/strikethrough, text and highlight colour, link, comment, alignment, line spacing, lists, indent, clear formatting); the ruler; the "Tabs and outline" panel on the left (the document's tab and its heading tree, collapsible to a rail button); the Workspace side-panel rail on the right and its hide control; the floating add-comment and reaction buttons beside the page; a drawn caret; and the page, rendering titles, headings, bulleted and numbered lists, tables, links, superscripts and emoji from the `Document` resource. Typing, Enter, paste and deletions across paragraphs become `insertText` / `deleteContentRange`; menu and toolbar actions become style, bullet, table, page-break, named-range (Insert → Bookmark) and `replaceAllText` (Edit → Find and replace) requests; right-clicking a table cell inserts or deletes rows and columns. Every batch carries `writeControl.requiredRevisionId`, and a stale revision shows a "changed somewhere else" banner with a reload action. A "Last API call" drawer shows the exact batch request and its response. Tools → Word count; File → Download. | `files.get`, `documents.get`, `documents.batch-update`, `files.update`, `files.copy`, `files.export`, `about.get` |
| **Comments** | Comment cards in the margin beside the page and a Comments sidebar with an Open / Resolved / All filter: author, relative time, quoted text, replies, a reply box and resolve; authors can edit or delete their own comments. Select text and use Insert → Comment (Ctrl+Alt+M) to start an anchored thread. | `comments.list`, `comments.create`, `comments.update`, `comments.delete`, `replies.create` |
| **Version history** | Revisions newest first with time, editor, the request kinds of each edit and the text length; selecting one reads that revision. | `revisions.list`, `revisions.get` |
| **Share dialog** | "Add people and groups" with a role, "People with access" (the owner, then Editor / Commenter / Viewer choices and removal), "General access" (Restricted or Anyone with the link) and Copy link. | `permissions.list`, `permissions.create`, `permissions.delete` |

States are the product's own: loading placeholders; an empty state per view and for a search with no match; an error
banner with Retry when a list read fails (the `backend-error` fault) and a "Couldn't load this document" page; the
provider's message in a snackbar when a write is refused (the `user-rate-limited` fault, a missing grant or a package
permission rule); "Can't open this document" for a document the caller cannot see; a reader or commenter banner with the
"Viewing" mode chip and the edit controls disabled; and an actor without the `about.get` grant still gets a working
home, with a notice and absolute dates.

Opening a document records **Last opened by me**: the app sends Drive's writable `viewedByMeTime` through
`files.update`, stamped with world time. That is the only way the app changes it — see *Last viewed by me* below.

### Limitations of the app

- It recreates the Docs screens for testing; it is not the Docs editor. There is no live collaborator presence, suggesting
  mode, undo or redo (each change is already a committed `batchUpdate`), spelling and grammar, voice typing, add-ons, Apps
  Script, printing or page setup. Those menu items are present but visibly disabled and say why.
- The page is one continuous sheet: no pagination or page count, no headers, footers or footnotes, and no images, drawings or
  charts — the same limits as the backend.
- Text is saved per paragraph about 1.2 seconds after you stop typing, and at once on Enter, paste, a deletion across
  paragraphs or when focus leaves the page — not keystroke by keystroke.
- Download does not save a file. Browsers block downloads inside a Tool app, so File → Download and the row menu show the
  exported plain text, Markdown or HTML with a Copy button; PDF, Word, ODT, EPUB and RTF are shown as unavailable.
- Template cards and grid thumbnails are drawn placeholders, not previews of the document. The file picker, folders (Move,
  Open file location), Meet and settings are not part of this Tool and are disabled or explain that when used. The sort
  menu does not offer "Last modified by me" because `files.list` here has no `modifiedByMeTime` order key.
- The Workspace side-panel rail to the right of the editor (Calendar, Keep, Tasks, Contacts, Maps and "Get add-ons")
  renders with each product's real mark and its hover and pressed states, but none of those products is simulated: every
  button opens a side panel that says so and makes no call. The rail can be hidden and shown like the real one.
- Document tabs are not modelled. The "Tabs and outline" panel shows the one tab this Tool stores per document — the
  document itself — and "Add tab" is visibly disabled; the Docs API tab list is not part of the implemented subset.
- Emoji reactions are not simulated: the reaction button beside the page is visibly disabled. The add-comment button
  next to it is real and starts a thread on the selection.
- The floating add-comment and reaction buttons appear only when the canvas has room beside the page; with the comment
  column open on a narrow window they are hidden, as they are in the real editor.
- Recording an open is best effort. An actor without the `files.update` or `about.get` grant, or a world under the
  `user-rate-limited` fault, opens documents normally, but "Last opened by me" keeps its previous value.
- Version history lists metadata only; it cannot show or restore an older version.
- The "Last API call" drawer shows only the most recent `documents.batchUpdate`.
- Narrow screens drop the chrome the real client also drops: below about 1024 px the side-panel rail and the tabs and
  outline panel are hidden, and below about 900 px the page fills the width, the ruler and the floating buttons are hidden
  and the menu bar scrolls horizontally instead of wrapping. On the home screen the search field shrinks so the Google
  apps button and the account avatar stay on screen, the list heading and its filters stack, and below about 600 px the
  list column headings are dropped the way the real mobile list drops them — each row still shows its own date. Nothing
  is cut off or unreachable down to 320 px.
- Format menu entries that the backend has no field for — Columns, Headers &amp; footers, Page numbers, Page orientation,
  and the Table and Image property submenus — render in the real menu positions and are visibly disabled. Insert → Table
  does work; only table *properties* are unmodelled.

## Operations

| operation | MCP alias | HTTP route |
| --- | --- | --- |
| `about.get` | — | `GET /drive/v3/about` |
| `documents.get` | `read_doc` | `GET /v1/documents/{documentId}` |
| `documents.create` | — | `POST /v1/documents` |
| `documents.batch-update` | `update_doc` | `POST /v1/documents/{documentId}:batchUpdate` |
| `files.list` | — | `GET /drive/v3/files` |
| `files.get` | — | `GET /drive/v3/files/{fileId}` |
| `files.update` | — | `PATCH /drive/v3/files/{fileId}` |
| `files.copy` | — | `POST /drive/v3/files/{fileId}/copy` |
| `files.delete` | — | `DELETE /drive/v3/files/{fileId}` |
| `files.export` | — | `GET /drive/v3/files/{fileId}/export` |
| `permissions.list` | — | `GET /drive/v3/files/{fileId}/permissions` |
| `permissions.create` | — | `POST /drive/v3/files/{fileId}/permissions` |
| `permissions.delete` | — | `DELETE /drive/v3/files/{fileId}/permissions/{permissionId}` |
| `comments.list` | — | `GET /drive/v3/files/{fileId}/comments` |
| `comments.get` | — | `GET /drive/v3/files/{fileId}/comments/{commentId}` |
| `comments.create` | — | `POST /drive/v3/files/{fileId}/comments` |
| `comments.update` | — | `PATCH /drive/v3/files/{fileId}/comments/{commentId}` |
| `comments.delete` | — | `DELETE /drive/v3/files/{fileId}/comments/{commentId}` |
| `replies.list` | — | `GET /drive/v3/files/{fileId}/comments/{commentId}/replies` |
| `replies.create` | — | `POST /drive/v3/files/{fileId}/comments/{commentId}/replies` |
| `revisions.list` | — | `GET /drive/v3/files/{fileId}/revisions` |
| `revisions.get` | — | `GET /drive/v3/files/{fileId}/revisions/{revisionId}` |

Canonical names (`google-docs.<operation>`) are always available over MCP and the `/v1/operations/...` endpoint, and
carry the same shapes plus two conveniences the REST codecs strip: `Document.content` (the verbalized plain text) and
`About.serverTime` / `About.limits`.

### Last viewed by me

`viewedByMe` and `viewedByMeTime` change only when the caller says it opened the file — `files.update` with Drive's
writable `viewedByMeTime`, which the browser app sends when you open a document — or when the caller creates, copies or
batch-updates the document. `documents.get`, `files.get`, `files.list` and `files.export` are pure reads: an agent
reading a document does not make it "opened by me", and a read never changes state.

### `documents.batchUpdate` request kinds

Sixteen of Google's request kinds are implemented, applied strictly in order to a working copy; if any request fails
the whole batch fails and **nothing** is written:

`insertText`, `deleteContentRange`, `replaceAllText`, `updateTextStyle`, `updateParagraphStyle`,
`createParagraphBullets`, `deleteParagraphBullets`, `insertPageBreak`, `insertTable`, `insertTableRow`,
`insertTableColumn`, `deleteTableRow`, `deleteTableColumn`, `createNamedRange`, `deleteNamedRange`,
`replaceNamedRangeContent`.

`writeControl.requiredRevisionId` (or `targetRevisionId`) is honoured: a batch pinned to a revision that is no longer
current fails `FAILED_PRECONDITION` and changes nothing.

Every other documented request — images, charts, headers, footers, footnotes, section and document styles, table cell
styling, person chips, rich links, dates, tabs, suggestions and the Docs-side comment requests — is **rejected by name**
with `INVALID_ARGUMENT`. Nothing is silently accepted and ignored.

### Request validation envelopes

Two classes of malformed request are answered with the provider's own envelope rather than the framework's decode error:

- **Read-only fields on `files.update`.** A `PATCH /drive/v3/files/{fileId}` body carrying a field this Tool does not
  write (`id`, `mimeType`, `owners`, `version`, anything outside `name`, `description`, `starred`, `trashed`,
  `viewedByMeTime`) answers `403 fieldNotWritable` — "The resource body includes fields which are not directly
  writable." — before the file lookup and before any other validation, and changes nothing. This is the Drive v3
  behaviour for read-only `File` fields. The route codec forwards the offending names as the `unwritableFields`
  argument (at most 32, each clipped to 128 characters); over the canonical path the same argument produces the same
  `PERMISSION_DENIED` with `details.reason: fieldNotWritable`. One key escapes the scan: a `__proto__` body key is
  dropped by the framework's JSON body parsing before the codec sees it, so `{"__proto__": {...}, "name": "a"}` is
  treated as `{"name": "a"}` and answers 200 (no prototype pollution reaches the handler; the key is simply absent).
- **Wrong-typed query values.** An integer parameter that is not an integer (`pageSize=abc`, `pageSize=1e3`) or a boolean
  that is not exactly `true`/`false` (`supportsAllDrives=maybe`, `includeDeleted=1`) answers `400 invalid` with
  `locationType: parameter` and the parameter's name as `location` — "Invalid value 'abc'. Values must match the
  following regular expression: '^-?[0-9]+$'" for integers, "Invalid boolean value: 'maybe'." for booleans. On the Docs
  route (`GET /v1/documents/{documentId}?includeTabsContent=yes`) it is the google.rpc `INVALID_ARGUMENT` envelope with
  `Invalid value at 'include_tabs_content' (TYPE_BOOL), "yes"` and a `BadRequest` field violation. The codec forwards the
  first offender as the `invalidParameter` argument (`{name, value, kind}`, name and value clipped to 64 characters);
  the handler fails on it before anything else runs, and the messages are modelled on Google's parameter-validation
  wording, not captured from a live server.

What still falls through to the framework's `400 framework.HTTP_REQUEST_MAPPING_FAILED` envelope: a JSON body that is
not an object (or is nested more than 512 levels deep), a `driveId`/`teamDriveId`/`includeTeamDriveItems` query
parameter (shared drives are not part of this Tool). Those messages are fixed text; no caller input and no runtime
error text is echoed.

### Search

`files.list` parses a documented subset of the Drive `q` grammar into a boolean tree (`and`, `or`, `not`, parentheses):

`name contains|=|!=`, `fullText contains` (title, description and body text), `mimeType =|!=`,
`trashed`/`starred`/`sharedWithMe` `=`, `modifiedTime`/`createdTime`/`viewedByMeTime` with `< <= > >= = !=`, and
`'address' in owners|writers|readers`.

Anything outside that table is `400 invalid` with `location: q` — including `parents`, which is rejected with a message
saying this Tool has no folders rather than silently ignored. A `q` containing U+FFFD is also `400 invalid` ("Invalid Value", `location: q`): malformed percent-encoding such as `%E0` decodes to that character, so the expression is treated as corrupt instead of being searched.

`fields` masks support Google's syntax, including slash paths and sub-selections nested to any depth:
`files(id,owners(emailAddress),capabilities(canEdit)),nextPageToken`, `capabilities/canEdit`, `*`. An unknown name, or a
sub-selection on a field that has no sub-fields (a scalar, or a free-form map such as `exportLinks`), is `400
invalidParameter`. Capability names are accepted by Drive's `canXxx` pattern; one this Tool does not compute is simply
absent from the response.

## Permissions

Ownership and sharing are enforced inside the handlers, on top of Firedrill's operation grants:

| action | required role |
| --- | --- |
| read a document, its comments and its revisions; export | `reader` |
| create, edit or delete a comment or reply | `commenter` (and comments may be edited only by their author) |
| `documents.batch-update`, rename, describe | `writer` |
| trash, untrash, permanent delete, share and unshare | `owner` |
| star | `reader` (it is per user and does not move `modifiedTime`) |
| record that you viewed the file (`files.update` with `viewedByMeTime`) | `reader` (per user; does not move `modifiedTime`) |

A document the caller cannot see answers `NOT_FOUND`, never `403` — there is no id-probing oracle, exactly as Google
behaves. The `capabilities` block on every `File` is computed by the same function the checks use, so a UI never offers
a button the backend will refuse.

## Events and faults

| id | kind | what it is for |
| --- | --- | --- |
| `document.created` | event | A document was created or copied. |
| `document.updated` | event | A batch update was committed; carries the request kinds and the text length before and after. |
| `document.shared` | event | A share was created, changed or removed — the seam for "notify the collaborator" in another Tool. |
| `user-rate-limited` | fault | Every write refuses with Google's write-quota message (`429 RESOURCE_EXHAUSTED` on Docs routes, `403 userRateLimitExceeded` plus `Retry-After: 30` on Drive routes); reads keep working and nothing is stored. |
| `backend-error` | fault | A provider outage on `documents.get`, `files.list`, `files.export` and `documents.batch-update`. The write fails **before** anything is written, so the document is byte-identical afterwards. |
| `lost-update-reply` | fault | The trap: the batch update **is** committed and the revision exists, but the caller sees `503`. A blind retry writes the edit twice; a retry carrying `writeControl.requiredRevisionId` is refused instead and stays correct. |

Scenarios shipped for the package's own conformance suite: `baseline`, `rate-limited`, `backend-error`,
`lost-update`, `tight-limits`, `tiny-scan` and `response-budget`.

## Bounds

Bounds are hard, documented and fail loudly with `FAILED_PRECONDITION` — a bounded read that hits its cap **refuses**
rather than returning a short page, because a truncated read can make a test pass falsely.

200 documents per world · 120,000 UTF-16 code units and 2,000 blocks per document · 50 tables per document · 20×20
cells per table · 100 named ranges · 100 permissions · 500 comments and 200 revisions per document · 100 replies per
comment · 100 requests per batch · 10,000 rows per scan · 512 levels of JSON nesting in a request body.

A JSON request body nested more than 512 levels deep is refused with a 400 by the route codec, before argument
validation runs. Real Docs and Drive requests never approach that depth.

The stored body also keeps its storage bounds per batch: at most 500 differently styled text runs per paragraph, 20,000
characters in one run of a single style, 100 paragraphs per table cell and 50 lists. A batch that would cross one (for
example 100 alternating one-character `updateTextStyle` ranges splitting one paragraph past 500 runs) is refused with
`FAILED_PRECONDITION` and commits nothing.

**Response byte budget.** The framework refuses any HTTP response over 1 MiB, so every response whose size callers
control is budgeted in UTF-8 bytes (900,000 by default; a scenario may lower `maxResponseBytes` to no less than 65,536):

- `documents.batch-update` measures the `documents.get` response the edited document would produce — the largest variant,
  the canonical resource with `includeTabsContent=true` and the title counted at 512 characters — before committing.
  A batch that would pass the budget fails with `400 FAILED_PRECONDITION` and nothing is written, so every committed
  document can always be read. `documents.get` answers the same error for a body authored past the budget.
- `files.list` and `comments.list` pages stop filling before the encoded page would pass the budget and return a real
  `nextPageToken` for the rest; permissions, replies and revisions pages do the same. A single
  file or comment thread too large for a page of its own answers `FAILED_PRECONDITION`.
- `comments.list`, `comments.get` and `comments.update` carry each comment's full list of replies. `replies.create`
  refuses (`FAILED_PRECONDITION`) a reply that would grow the thread past the budget, keeping room for the comment's
  content to be edited to its 4,096-character maximum.
- `files.export` answers Drive's `403 exportSizeLimitExceeded` ("This file is too large to be exported.") when the
  export would pass the budget. Google's own export limit is 10 MB; this Tool's is lower because of the response cap.

A scenario can lower any of them with a `meta`/`limits` row so a drill reaches the error with small data; the values in
force are reported by `about.get` as `limits`.

## Compatibility

**Not verified against a real client.** `manifest.compatibility` is empty: no official Google client (`googleapis`,
`google-api-python-client`) has been run against `firedrill serve`, so no wire-compatibility claim is made. The routes,
field names, status codes and both error envelopes follow the public Docs v1 and Drive v3 reference documents, and the
package's own conformance suite exercises every route, but that is not the same as a client run.

The two MCP aliases `read_doc` and `update_doc` match the tool names Google documents for its Docs MCP server. Their
shapes were taken from the public reference pages, not captured from a live server, and `read_doc` returns a superset
of Google's `{content}` response (the whole `Document` plus `content`). The Drive-shaped operations deliberately expose
**no** MCP alias, so installing this package beside a Drive Tool cannot collide on generic names.

## Limitations

1. **Not Google Docs.** A documented subset: 3 Docs methods, 16 of roughly 48 `batchUpdate` request kinds, and the
   Drive endpoints listed above restricted to Google Docs files. An unknown path answers 404 and an undeclared method
   on a declared path answers 405 — never a plausible stub.
2. **The browser app recreates the Docs screens; it is not Docs.** What it does not do is listed under *Browser app →
   Limitations of the app*.
3. `documents.batchUpdate`'s real path is `/v1/documents/{documentId}:batchUpdate`, but a Firedrill route path segment
   is either a whole `{parameter}` or a literal, so the colon method suffix cannot be declared. The route is
   `POST /v1/documents/{documentId}` and the codec strips a recognised `:batchUpdate` suffix from the captured value.
   Real clients are unaffected; a hand-written `POST /v1/documents/<id>` with no method suffix answers `404 NOT_FOUND`.
4. Index arithmetic (paragraph newline terminators, UTF-16 code units, table nesting) follows Google's published
   document structure but has **not** been diffed against a live Google document. The table offsets in particular are a
   faithful model, not a measured one.
5. No suggestions mode, no tabs beyond the single implicit tab, no headers, footers or footnotes, no images, drawings,
   charts, equations, person chips, rich links or dates, no document/section styles and no table cell, row or column
   styling.
6. Rendering is not simulated. `insertPageBreak` inserts a document element, not a rendered page; there are no page
   counts and no fonts.
7. Exports are text only (`text/plain`, `text/markdown`, `text/html`). There is no PDF, `.docx`, `.odt`, `.epub` or
   `.rtf` because there is no renderer; asking for one is `403 fileNotExportable`, exactly like an unexportable file in
   Drive.
8. Revisions are metadata only. `revisions.list` / `revisions.get` describe past edits, but no previous content is
   stored, so there is no restore. `revisions.update`, `revisions.delete`, `keepForever` and publishing are out of scope.
9. No folders, no shared drives, no uploads and no non-Docs files. `files.create` of an arbitrary file does not exist,
   and the `q` term `parents` is rejected with an explanatory error.
10. Sharing is simplified: owner-only, no ownership transfer, no `pendingOwner` flow, no expiration times, no
    `writersCanShare`. `sendNotificationEmail` and `emailMessage` are validated and then ignored — nothing is ever sent
    anywhere.
11. `permissions.get` and `permissions.update` are not implemented. Change a share by creating it again (which updates
    the role and keeps the permission id, as Drive does) or delete it.
12. Google requires `fields` on `comments.list` and `comments.get`; this Tool returns the full resource when `fields` is
    absent. A forgetful agent therefore succeeds here and would fail against Google.
13. Installing this package beside another package that also declares `/drive/v3/…` routes (a Drive Tool, for example)
    will collide at route registration. They are alternatives in one world, not companions.
14. `webViewLink`, `iconLink`, `exportLinks`, `htmlContent` and the comment `anchor` string are provider-shaped values
    that resolve to nothing. The anchor uses Drive's documented JSON shape, not a byte-compatible Docs anchor.
15. Storage figures in `about.get` are synthetic (`quotaBytesUsed` is `"0"` on every Docs file, matching Google) and are
    not an accounting of anything.
16. A `viewedByMeTime` sent to `files.update` is stored as sent once it parses as an RFC 3339 date-time; it is not checked
    against world time. The browser app always sends `about.get`'s `serverTime`.

## Conformance

The package ships its own test project and suite:

```sh
firedrill validate
firedrill tool inspect google-docs --json
firedrill tool test google-docs --json
```

Eighteen drills across seven scenarios and five actors cover every operation, every declared error, all three events and
all three faults, and the suite is re-run to prove determinism. The target
(`test/conformance.mjs`) uses Node built-ins only and drives the package over its HTTP routes, the canonical operation
endpoint and MCP.

## Trademarks

Google, Google Docs, Google Drive and Google Workspace are trademarks of Google LLC. This package is an independent,
unaffiliated simulation used to test software in a local environment; it is not endorsed by or connected with Google,
and it never contacts a Google service.

## License

Apache-2.0. See [LICENSE](./LICENSE).
