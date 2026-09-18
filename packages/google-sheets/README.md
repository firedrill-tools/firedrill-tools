# @firedrill-tools/tool-google-sheets

A synthetic Google Sheets service for [Firedrill](https://firedrill.run): a few in-world Google Workspace users, their
spreadsheets, and the operations an agent performs on and around a spreadsheet — read ranges, write and append values,
evaluate formulas, restructure sheets with `batchUpdate`, find the file, rename, star, trash or copy it, and share it.

It speaks two Google APIs at once, because a real Sheets agent meets both:

- **Sheets API v4** (`/v4/spreadsheets…`) for the spreadsheet itself, with Google's `google.rpc` error envelope.
- **Drive API v3** (`/drive/v3/…`) for the file around it, with Drive's classic error envelope — **restricted to files
  whose `mimeType` is `application/vnd.google-apps.spreadsheet`**. This is a Sheets Tool with the thin slice of Drive a
  Sheets agent cannot avoid, not a Drive clone.

Everything runs locally against Firedrill's state, virtual clock and evidence. No Google service is contacted, nothing is
rendered to a real grid, no notification e-mail is sent, and there are no credentials anywhere.

- **21 operations · 18 provider-shaped HTTP routes · 6 Google Sheets MCP tool aliases · 3 events · 3 faults · 107 starter rows**
- **Browser app included**: a recreation of the Google Sheets web client (home list, spreadsheet editor, sharing) that
  calls the same operations as agents; see *Browser app*.

## Install

```sh
firedrill tool add ./firedrill-tools-tool-google-sheets-0.1.1.tgz --install   # from a local archive
firedrill tool add @firedrill-tools/tool-google-sheets --install              # from a registry, once published
firedrill serve --scenario baseline --no-open
```

`tool add --install` creates a world if the project has none, copies the 107 starter rows and grants the default actor
every operation. Installing into an existing world does **not** change its data or grants: add the starter rows and the
grants you want yourself, one per operation:

```json
{ "packageId": "google-sheets", "operationId": "values.get" }
```

Grant only what the agent under test should be able to do. Framework grants decide whether an operation may be called at
all; the package's own sharing roles (below) decide what that user may do to a particular spreadsheet.

## Identities

| actor attribute | meaning |
| --- | --- |
| `email` | The signed-in Workspace user. |
| `displayName` | Overrides the stored display name in `owners[]`, `lastModifyingUser` and `about.get`. |

**An actor with no attributes is not an empty account.** It acts as the *primary seeded user* — the `users` row with the
lowest row id, `avery.chen@example.test` in the starter data — so a freshly installed world sees the starter spreadsheets.
Only a world with no `users` row at all falls back to `<actorId>@example.test`, materialising that row on the first
create. An explicit `email` always wins; an explicit address without a `users` row is a valid but empty account
(`about.get` works, no file is visible), never an authentication error.

## Access rules

- A spreadsheet is visible to its owner and to anyone named by a `user` permission, the caller's domain in a `domain`
  permission, or an `anyone` permission. Everything else answers **`NOT_FOUND`** (never `403`), so ids cannot be probed.
  `files.list` lists owned files and files shared by `user`/`domain` permissions; `anyone` links open by id only.
- Effective role is the highest match: owner > writer > commenter > reader. Reads, starring and being the *source* of a
  copy need reader (commenter behaves as reader; comments are out of scope). Every values write, `batchUpdate`,
  `insert_dimension`, being the *destination* of `copyTo`, and renaming need writer. Trashing, deleting and sharing are
  owner-only. Violations answer `PERMISSION_DENIED` (Sheets 403 `PERMISSION_DENIED`, Drive 403 `insufficientFilePermissions`).
- A trashed spreadsheet stays readable by id but refuses every content write with `FAILED_PRECONDITION`
  ("This document is in the trash.") and is only listed when `q` mentions `trashed`.
- `File.capabilities` (`canEdit`, `canShare`, `canCopy`, `canDelete`, `canTrash`, `canUntrash`, `canRename`, `canComment`) is
  computed by the same rules the handlers enforce.

## Starting data

Virtual time is `2026-09-14T15:00:00.000Z`; every seeded timestamp is earlier. `about.get` returns the virtual time as
`serverTime` (the REST route strips it), and `TODAY()`/`NOW()` evaluate against it. All addresses use `example.test`.

| spreadsheet | owner | shape |
| --- | --- | --- |
| Q3 Marketing Budget | Avery | `Budget` (frozen header, currency and percent formats, `SUM`/share/variance formulas, a `#DIV/0!` cell, `IFERROR`, a cross-sheet reference, named range `TotalBudget`), `Assumptions` (percent, date, boolean, `TODAY()`), and a hidden `Owner's Notes` with a circular pair; Jordan writer, Morgan reader; starred |
| Customer Pipeline 2026 | Avery | `Leads`: header, 15 leads, **one empty gap row**, 2 more leads (unicode and emoji names, a text id `00123`, a ragged row) — the append table-detection fixture; `Summary` with `COUNTA`, `COUNTIF`, `SUMIF`, `VLOOKUP` and `SUM` over `Leads` |
| Team Offsite Planning | Jordan | Avery is a **commenter** — the `PERMISSION_DENIED` fixture for Avery |
| Inventory Count - Warehouse B | Jordan | Shared with Morgan only — **`NOT_FOUND`** for Avery |
| Untitled spreadsheet | Avery | One empty `Sheet1` (empty reads have no `values`) |
| Old Vendor List | Avery | **In the trash** |
| Hiring Tracker | Morgan | Shared with the `example.test` domain as reader; one cell note |

Users: Avery Chen, Jordan Patel, Morgan Lee, Sam Okafor (owns nothing; sees only the domain-shared tracker).

## Operations

| operation | MCP alias | HTTP route |
| --- | --- | --- |
| `spreadsheets.create` | — | `POST /v4/spreadsheets` |
| `spreadsheets.get` | `get_spreadsheet` | `GET /v4/spreadsheets/{spreadsheetId}` (`ranges`, `includeGridData`, `fields`) |
| `spreadsheets.batch-update` | `update_spreadsheet` | `POST /v4/spreadsheets/{spreadsheetId}:batchUpdate` |
| `sheets.insert-dimension` | `insert_dimension` | — (REST uses `insertDimension` in `:batchUpdate`) |
| `sheets.copy-to` | — | `POST /v4/spreadsheets/{spreadsheetId}/sheets/{sheetId}:copyTo` |
| `values.get` | `get_values` | `GET /v4/spreadsheets/{spreadsheetId}/values/{range}` |
| `values.batch-get` | — | `GET /v4/spreadsheets/{spreadsheetId}/values:batchGet` |
| `values.update` | `update_values` | `PUT /v4/spreadsheets/{spreadsheetId}/values/{range}` |
| `values.update-formulas` | `update_formulas` | — (REST uses `PUT …/values/{range}?valueInputOption=USER_ENTERED`) |
| `values.append` | — | `POST /v4/spreadsheets/{spreadsheetId}/values/{range}:append` |
| `values.batch-update` | — | `POST /v4/spreadsheets/{spreadsheetId}/values:batchUpdate` |
| `values.clear` | — | — (see *Compatibility*) |
| `files.list` | — | `GET /drive/v3/files` |
| `files.get` | — | `GET /drive/v3/files/{fileId}` |
| `files.update` | — | `PATCH /drive/v3/files/{fileId}` (`name`, `starred`, `trashed`) |
| `files.copy` | — | `POST /drive/v3/files/{fileId}/copy` |
| `files.delete` | — | `DELETE /drive/v3/files/{fileId}` (permanent) |
| `permissions.list` | — | `GET /drive/v3/files/{fileId}/permissions` |
| `permissions.create` | — | `POST /drive/v3/files/{fileId}/permissions` |
| `permissions.delete` | — | `DELETE /drive/v3/files/{fileId}/permissions/{permissionId}` |
| `about.get` | — | `GET /drive/v3/about` |

Every operation is also callable by its canonical name (`google-sheets.<operation>`) over MCP and at
`POST /v1/operations/google-sheets/<operation>`. HTTP routes use bearer auth with the world token; OAuth scopes are not
emulated.

### What the Sheets behaviour computes

- **A1 notation**: `Sheet1!A1:B2`, `'Q3 Budget'!A:C` (`''` escapes a quote), `Sheet1!A2:C` (open end), `Sheet1!1:3`,
  a bare sheet name (whole grid), a bare `A1:B2` (first sheet), reversed corners, and named ranges. Returned ranges are
  sheet-qualified and quoted only when needed. Unparsable text answers `Unable to parse range: …`; bounds outside the
  grid answer Google's `Range (Sheet1!AA1) exceeds grid limits. Max rows: 1000, max columns: 26`.
- **Input**: `RAW` stores JSON values as given. `USER_ENTERED` parses `=formulas`, a leading `'` (forced text), `TRUE`/`FALSE`,
  numbers (`-1,234.5`, `1e3`), percentages, `$` amounts and dates (`2026-09-14`, `9/14/2026`, `2026-09-14 15:30`, zone-less
  means UTC), suggesting a number format when the cell has none. `null` leaves a cell unchanged; `""` clears it. A
  single-cell range is only an origin; a multi-cell range bounds the write ("Requested writing within range …").
- **Rendering**: `FORMATTED_VALUE`, `UNFORMATTED_VALUE`, `FORMULA`; `SERIAL_NUMBER` or `FORMATTED_STRING` dates; `ROWS` or
  `COLUMNS`. Trailing empty rows and cells are trimmed and an empty range has no `values`. Supported number-format patterns:
  `0`, `0.00`, `#,##0`, `#,##0.00`, `"$"#,##0.00`, `$#,##0`, `0%`, `0.00%`, `0.00E+00` and date/time patterns built from
  `yyyy yy mmmm mmm mm m M dd d hh h HH H ss am/pm`; anything else renders as General.
- **Formulas** are stored as text and evaluated on every read, so results never go stale. Grammar: numbers, strings, booleans,
  error literals, references with `$` and sheet qualifiers, ranges (`A1:B2`, `A:C`, `1:3`), named ranges, unary `+ -`,
  `%`, `^`, `* /`, `+ -`, `&`, comparisons. Functions: `SUM AVERAGE MIN MAX COUNT COUNTA COUNTIF SUMIF IF IFERROR AND OR
  NOT ROUND ROUNDUP ROUNDDOWN ABS CONCATENATE LEN UPPER LOWER TRIM LEFT RIGHT VLOOKUP TODAY NOW`. Errors follow Sheets:
  `#DIV/0!`, `#VALUE!`, `#REF!` (bad sheet, deleted reference, circular dependency), `#NAME?`, `#N/A`, `#NUM!`, `#ERROR!`
  (parse error), with `effectiveValue.errorValue` in grid data.
- **Reference adjustment**: inserting or deleting rows/columns (batch requests, `insert_dimension`, `INSERT_ROWS` appends)
  and renaming a sheet rewrite every stored formula in the spreadsheet and shift named ranges.
- **Append**: the table is the first non-empty row at or below the range top (within the range's columns) through the
  last row before an empty row; data goes after it. `OVERWRITE` grows the grid when needed; `INSERT_ROWS` inserts rows first.
- **`batchUpdate`** applies requests in order to a working copy and commits once, so an invalid request applies nothing.
  Supported kinds: `addSheet`, `deleteSheet`, `updateSheetProperties`, `duplicateSheet`, `updateSpreadsheetProperties`,
  `insertDimension`, `deleteDimension`, `appendDimension`, `updateCells`, `repeatCell`, `findReplace`, `sortRange`,
  `addNamedRange`, `deleteNamedRange`. Cell formats supported by `updateCells`/`repeatCell`: bold, italic, strikethrough,
  underline, font size, text and background colour, horizontal alignment, wrap strategy and number format.
- **Drive `q`**: `name = / contains`, `mimeType = / !=`, `trashed`, `starred`, `sharedWithMe`, `'<email>' in owners|writers|readers`,
  `modifiedTime|createdTime|viewedByMeTime` comparisons against RFC 3339 date-times **with a zone**, joined by
  `and`/`or`/`not` and parentheses. `orderBy`: `modifiedTime`, `name`, `createdTime`, `viewedByMeTime` (± `desc`, up to 3).
  Page tokens are self-contained and bound to the query.
- **`fields`** masks (`a,b(c,d)`, `a/b`, `*`) are Google's system parameter and are accepted on every Sheets and Drive
  route: the handler validates the mask against the response shape (400 `INVALID_ARGUMENT` for the Sheets routes, Drive's
  400 `invalidParameter` for `/drive/v3`) before any write, and the REST route sends only the selected fields, in the
  resource's own order. The canonical operation accepts the same argument, validates it and returns the unmasked value.
  Response-size budgets measure the masked shape; the cell text rendered for a values read still counts toward the same
  1 MiB bound, so a mask cannot make an over-large values read succeed (`spreadsheets.get` bounds that work at 16 MiB).

## Events and faults

| id | kind | when |
| --- | --- | --- |
| `spreadsheet.created` | event | after `spreadsheets.create` or `files.copy` (`source: create|copy`) |
| `values.changed` | event | once per affected sheet per committed write that changed cells (`source`: update, formulas, append, batchUpdate, clear, updateCells, repeatCell, findReplace, sortRange, duplicateSheet) |
| `sheet.changed` | event | per structural change: added, deleted, renamed, resized, duplicated, copied, hidden, shown, reordered |
| `write-rate-limited` | fault, before | the nine write operations with REST routes or MCP aliases: Sheets routes 429 `RESOURCE_EXHAUSTED`, Drive routes 403 `userRateLimitExceeded`, both with `Retry-After: 30` |
| `sheets-backend-unavailable` | fault, before | `spreadsheets.get`, `values.get`, `values.batch-get`, `values.update`: 503 `UNAVAILABLE`, state untouched |
| `append-response-lost` | fault, after commit | `values.append` commits the row and emits `values.changed`, but the caller sees 503 — a blind retry appends a duplicate |

No subscriptions and no callbacks.

## Bounds

Defaults (overridable per scenario with a `meta/limits` row, reported by `about.get.limits`): 100 spreadsheets per world;
50 sheets per spreadsheet; 20,000 rows and 200 columns per sheet; 400,000 grid cells per spreadsheet; 10,000 stored rows
per read scan; 10,000 cells per write; 100 requests per batch; 100 ranges per batch read or write; 50,000 characters per
cell; 2,000 characters per formula; 20,000 cell visits per read (literal reads and formula evaluations; memoised results are
free) and 10,000 dependency levels per read (a formula nests at most 64 levels of parentheses and calls); 100 permissions and
50 named ranges per spreadsheet; 9,000 row writes per request. **Every bound fails with `FAILED_PRECONDITION`
(`… exceeds the supported bound of N …`) instead of returning a truncated result.**

**Response size.** Every response that carries cell text (`values.get`, `values.batchGet`, `spreadsheets.get` with grid
data, `values.update`/`values.append`/`values.batchUpdate` with `includeValuesInResponse`, `spreadsheets.batchUpdate` with
`includeSpreadsheetInResponse`) is measured in UTF-8 bytes of its JSON while it is built. A response that would pass
900,000 bytes fails with `400 INVALID_ARGUMENT` "Response too large: the requested data exceeds the 900000-byte response
limit. Request a smaller range, fewer ranges or less grid data." and no write of that request is kept; it is never
shortened. The size is measured on the shape actually sent: with a `fields` mask (for example
`spreadsheets.get?includeGridData=true&fields=sheets(data(rowData(values(formattedValue))))`) only what the mask keeps
counts, so a small masked read of a large grid still answers 200; the unmasked data one read may render is separately
bounded at 16 MiB with the same error. Drive `files.list` and `permissions.list` stop a page before its encoded entries would pass that size and
return `nextPageToken` at the first entry not returned, also counting only what their `fields` mask keeps. A text formula result is limited to 50,000 characters (`#VALUE!`,
as in Sheets), and `findReplace` refuses (`INVALID_ARGUMENT`) a replacement that would grow any cell past 50,000
characters. The app's grid splits a window that is too large into smaller reads, so every cell still loads.

## Compatibility

**Not verified against a real client.** The routes follow the public Sheets API v4 and Drive API v3 discovery documents
(paths, query parameters, JSON field names, status codes and both error envelopes) for the subset above, but no official
SDK (`googleapis`, `google-api-python-client`) or Google's Sheets MCP server has been run against `firedrill serve`, and
the manifest's `compatibility` list is empty. Known deviations, most caused by the framework's route rules:

- **Colon methods.** A Firedrill route segment is either a whole `{parameter}` or a plain literal, so
  `{spreadsheetId}:batchUpdate`, `{range}:append`, `{sheetId}:copyTo`, `values:batchGet` and `values:batchUpdate` are
  declared as parameters and each codec requires the exact method suffix. Clients send exactly these paths, so the wire
  shape is unchanged; any other suffix answers Google's 404 `NOT_FOUND`.
- **Route overlap.** Two routes may not share a path shape. `…/values/{range}:clear` has the same shape as `:append`,
  and `values:batchClear` and the `…ByDataFilter` methods share the `values:batchUpdate` shape, so **`values.clear` has no
  REST route** (use the canonical operation, or `updateCells` with `fields: "userEnteredValue"`), and `batchClear`,
  `getByDataFilter` and every `…ByDataFilter` method answer 404.
- Sheet titles containing `/` cannot appear in a **path** range (the framework rejects a decoded `/`); use
  `values:batchGet`'s `ranges` query or the canonical operations.
- `GET /drive/v3/about` does not require `fields` (Drive does); a `range` in a `PUT` body is not compared with the path range.
- `files.list` implies `trashed = false` when `q` has no `trashed` term (the Drive UI convention, not the raw API default).
- The MCP aliases take the input shapes published for Google's Developer Preview Sheets MCP server but return the REST
  resources; `update_values` parses input as `RAW`, an assumption.
- A framework denial (the actor lacks the operation's grant) is answered in the route family's envelope: Sheets routes
  return 403 `PERMISSION_DENIED` ("Request had insufficient authentication scopes.") and Drive routes return 403 with
  reason `insufficientPermissions`. Only the canonical `POST /v1/operations` call returns the framework's own denial body.
- Request bodies or query parameters of the wrong JSON type are rejected by the operation's input schema and answered
  with Google's 400 envelope, but the message is the framework's schema message rather than Google's `Invalid value at …`
  text. A Drive `files.update` body field other than `name`, `starred` or `trashed` answers 403 `fieldNotWritable`, even
  for fields Drive itself accepts (such as `description`).
- A JSON request body nested more than 512 levels deep is refused by the route codec before the operation runs; the
  framework answers 400 `framework.HTTP_REQUEST_MAPPING_FAILED` rather than Google's envelope (the bound exists because
  argument validation recurses on the body).

## Browser app

`firedrill serve` prints the app link (also under **Tools → Open app** in the inspector). The app is a faithful
recreation of the Google Sheets web client, served from `firedrill/tools/google-sheets/app/site/`, and every action is an
ordinary operation call through `/_firedrill/client.js` for the selected actor — so a change made in the app is visible
over the REST routes and MCP tools, and an agent's change appears in the app within about two seconds (it polls the world
revision and never overwrites a cell being edited, an open dialog or a title being typed).

| screen | what it does | operations |
|---|---|---|
| Sheets home | *Start a new spreadsheet* strip (Blank), recent spreadsheets as a list grouped Today / Yesterday / Previous 7 days / Previous 30 days / Earlier or as a thumbnail grid, *Owned by anyone / by me / not by me* filter, sort by last opened by me / last modified / title, search (the compiled Drive `q` is shown under the heading), *Load more* paging, row menu (Rename, star, Make a copy, Remove, Open in new tab), drawer views Recent / Starred / Shared with me / Trash (Restore, Delete forever with confirmation), file picker dialog | `about.get`, `files.list`, `files.update`, `files.copy`, `files.delete`, `spreadsheets.create`, `values.get` (grid thumbnails) |
| Spreadsheet editor | title (rename), star, *View only* badge, trash banner with Restore, last-edit popover; File / Edit / View / Insert / Format / Data menus; toolbar (currency, percent, decimal places, number formats, font size, bold, italic, strikethrough, text and fill colour, alignment, wrapping, functions); name box (A1 ranges and named ranges) and formula bar; virtualised grid loaded in 100-row chunks with frozen rows/columns, range selection by mouse, Shift and headers, typing / Enter / F2 / double-click editing, Delete, copy / cut / paste as tab-separated values, error-cell triangles with the error message on hover, right-click menu (insert/delete rows and columns, sort range, define named range); sheet tabs with Add Sheet, All Sheets (unhide), tab menu (Delete, Duplicate, Copy to existing spreadsheet, Rename, Change color, Hide, Move); selection Sum / Average / Min / Max / Count chip; Named ranges side panel; Find and replace dialog (regular expressions shown disabled) | `spreadsheets.get` (`markViewed`, `includeGridData` + `ranges`), `files.get`, `values.batch-update` (`USER_ENTERED`), `values.clear`, `values.batch-get`, `spreadsheets.batch-update` (`repeatCell`, `insertDimension`, `deleteDimension`, `addSheet`, `deleteSheet`, `duplicateSheet`, `updateSheetProperties`, `sortRange`, `findReplace`, `addNamedRange`, `deleteNamedRange`), `sheets.copy-to`, `files.update`, `files.copy`, `files.list`, `spreadsheets.create` |
| Share dialog | add people with Viewer / Commenter / Editor, change or remove access, General access Restricted / domain / Anyone with the link with a role, Copy link; read-only for non-owners | `permissions.list`, `permissions.create`, `permissions.delete` |
| States | loading skeletons and spinners, empty lists, provider error messages with *Try again*, a failed cell write keeps the typed text in the cell editor for retry with the same idempotency key, *Sorry, the file you have requested does not exist.*, and a no-access page when the actor lacks grants | — |

Every mutation carries an idempotency key; destructive actions (delete rows/columns/sheets/named ranges, Delete forever)
ask for confirmation. The product logo is the official 2026 Google Sheets mark and the interface font is Roboto (OFL);
sources and licences are recorded in `firedrill/tools/google-sheets/app/assets/ATTRIBUTION.md`.

## Limitations

- A coherent subset only: 14 of Google's ~70 `batchUpdate` request kinds (others fail the batch with `INVALID_ARGUMENT`);
  no charts, pivot tables, filters, conditional formatting, data validation, protected ranges, merges, borders, banding,
  developer metadata, data sources, tables, `autoFill`/`cutPaste`/`copyPaste`/`pasteData`, `moveDimension`, column
  widths, hyperlinks or chips; notes are read-only starter data; no comments, revision history, folders, shared drives,
  uploads or exports; no ownership transfer; `sendNotificationEmail` never sends.
- Formula engine: the listed functions only (others `#NAME?`), no array formulas or spills, no `IMPORTRANGE`, exact-match
  `VLOOKUP` only (`is_sorted` must be `FALSE`), no iterative calculation. `TODAY()`/`NOW()` use the world clock in UTC
  regardless of the spreadsheet's time-zone label. `sortRange`, `duplicateSheet`, `copyTo`, `files.copy` and `repeatCell`
  move formula text verbatim without rebasing relative references; deleting a sheet leaves formulas that name it, which
  then evaluate to `#REF!`.
- `findReplace` is literal only (`searchByRegex` is refused); it matches string cells, numbers and booleans by their
  General text, and formula text when `includeFormulas` is set.
- `en_US` parsing and formatting only; a limited set of number-format patterns.
- Sharing is owner-only (`writersCanShare` is not modelled) and `commenter` behaves as `reader`.
- Browser app: fixed column widths (100 px) and row heights (21 px); no fill handle dragging or offline mode. Dates in
  the app render in UTC relative to the world clock. The main-menu drawer lists Docs, Sheets, Slides, Forms, Settings,
  Help & Feedback and Drive as the product does; the Tool's Recent/Starred/Shared with me/Trash views sit under
  Sheets in that drawer (the product has no such views there).
- Controls shown for fidelity but not simulated: they render in place with the product's glyphs, hover states and
  tooltips, and open a short "not simulated by this Tool" panel without sending any request. Toolbar: Search the menus,
  Undo, Redo, Print, Paint format, Zoom, Font, Borders, Merge cells, Vertical align, Text rotation, Insert link, Insert
  comment, Insert chart, Create a filter, Filter views. Title bar: Move, comment history, Google Meet. Sheet bar:
  Explore. Home drawer: Docs, Slides, Forms, Settings, Help & Feedback, Drive. Menus: File → Import, Download, Email,
  Move, Version history, Make available offline, Details, Settings, Print; Edit → Undo, Redo, Paste special (every
  entry), Move (every entry); View → Show (Formula bar, Gridlines, Formulas, Protected ranges), Group, Comments, Zoom,
  Full screen; Insert → Cells, Pivot table, Chart, Image, Drawing, Timeline, Link, Checkbox, Dropdown, Emoji, Smart
  chips, Comment, Note; Format → Theme, Rotation, Merge cells, Convert to table, Conditional formatting, Alternating
  colors; Data → Create a filter, Create filter view, Add a slicer, Protect sheets and ranges, Named functions,
  Randomize range, Column stats, Data validation, Data cleanup, Split text to columns, Data extraction, Data
  connectors; every Tools and Extensions item; Help → Help, Training, Updates, Help Sheets improve, Privacy Policy,
  Terms of Service, Function list, Keyboard shortcuts. Home: Template gallery and Hide templates (only *Blank
  spreadsheet* is offered). Edit → Cut, Copy and Paste open the product's "use the keyboard shortcut" note; the
  Ctrl+X/C/V shortcuts on the grid do cut, copy and paste. *Hide the menus* works locally in the browser and changes
  no data.

## Test

```sh
firedrill tool test google-sheets
```

The packaged conformance suite (11 drills over 5 scenarios and 5 actors, driven by `test/conformance.mjs` with Node
built-ins only) observes every operation, declared error, event and fault, and runs twice to check determinism.

## Trademarks

Google Sheets, Google Drive, Google Workspace, Google and the Google Sheets logo are trademarks of Google LLC. The product
names and the logo file bundled with the browser app belong to their owner and are used only to identify the simulated
service in a test environment. This package is an independent Firedrill Tool and is not affiliated with, sponsored by or
endorsed by Google.

## License

Apache-2.0. See `LICENSE`.
