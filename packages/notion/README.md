# @firedrill-tools/tool-notion

A synthetic **Notion workspace** for [Firedrill](https://firedrill.run): one fictional workspace with a wiki page tree,
three databases (the 2025-09-03 *database container + data source* model), blocks, comments and users, exposed through a
bounded subset of the Notion REST API (`/v1/...`, `Notion-Version: 2025-09-03` shapes plus the 2026-03-11 page-markdown
endpoints) and through the tool names of the open-source Notion MCP server. Agents that talk to Notion through
`@notionhq/client`-style REST calls or over MCP can be exercised against it without a workspace, an integration token or
network access.

Everything is computed from the world's state: ids come from a counter row, timestamps from Firedrill's virtual clock,
visibility and capabilities from the calling integration. Nothing here contacts Notion; no notification, e-mail or webhook
is ever sent, and no `notion.so` URL in a response resolves anywhere.

Package id `notion`, version `0.1.0`, engine `>=0.1.0 <0.2.0`, license Apache-2.0. The package ships a **browser app**
(a recreation of the Notion web client over the same operations — see *App*) next to the REST routes and MCP aliases.

## Install

```sh
firedrill tool add ./firedrill-tools-tool-notion-0.1.1.tgz --install   # or the npm name once published
firedrill serve --scenario baseline --no-open
```

`firedrill serve` prints the HTTP and MCP endpoints and their tokens. A new world receives the starter data and the
grants below. Existing worlds do not change silently: add the grants and (optionally) the `starter.json` rows to your
own world or scenario.

### Grants and identities

Every actor that should use the Tool needs the grants for the operations it may call (`packageId: "notion"`):

```
users.me  users.list  users.get  search
pages.create  pages.retrieve  pages.update  pages.retrieve-property  pages.move  pages.retrieve-markdown  pages.update-markdown
databases.create  databases.retrieve  data-sources.retrieve  data-sources.query  data-sources.update
blocks.retrieve  blocks.children.list  blocks.children.append  blocks.update  blocks.delete
comments.create  comments.list  workspace.context  workspace.trash
```

Two optional actor **attributes** model *which internal integration* is calling and *which person* it acts for:

| attribute | meaning |
|---|---|
| `integrationId` (optional) | Row id in the `integrations` namespace. Selects the bot user returned by `users.me`, the capability set (`content`, `comments`, `user_information`) and the visibility scope (`workspace` or a list of shared root pages/databases). **Absent = the first `integrations` row in row-id order** — the seeded workspace-wide *Firedrill Agent* — so a grant-only actor created by `firedrill tool add --install` sees the whole starter workspace. An id that names no row fails every operation with `UNAUTHORIZED` (HTTP 401 `unauthorized`, "The bearer token is not valid."). |
| `userId` (optional) | Row id of a **person** user. When present, writes are attributed (`created_by`, `last_edited_by`, comment author with `display_name.type: "user"`) to that person and `workspace.context.user` returns them. When absent, writes are attributed to the integration's bot user, exactly as the real API does. An id that is not a person row also fails `UNAUTHORIZED`. |

The seeded integrations are `fd000000-0000-4000-8000-000700000001` **Firedrill Agent** (`content: read_update_insert`,
`comments: read_insert`, `user_information: with_emails`, workspace-wide), `…000700000002` **Notes Sync** (`content: read`,
`comments: read`, `user_information: none`, shared only with the *Meeting notes* subtree) and `…000700000003` **Status
Board** (`content: read`, `comments: none`, `user_information: without_emails`, workspace-wide). The conformance world
(`firedrill/world.json`) shows every combination as actors `member`, `agent-only`, `notes-bot`, `board-bot`, `stranger`
and `auditor`.

Rules the behavior enforces: an object is visible only if it, or an ancestor in its parent chain, is one of the
integration's shared roots (Notion never distinguishes "missing" from "not shared": both answer `object_not_found`);
trashed objects stay readable by id (`in_trash: true`) but leave search, queries and children listings; every content
read needs `content ≥ read`, updates/moves/markdown edits/block edits/deletes `read_update`, creating pages, databases and
blocks `read_update_insert`, listing comments `comments ≥ read`, creating them `read_insert`, and `users.list` /
`users.get` need `user_information ≠ none` (`person.email` appears only with `with_emails`). Violations answer
`RESTRICTED_RESOURCE` (HTTP 403 `restricted_resource`). Framework grants are checked before any of this: an actor
without the grant is denied by Firedrill (HTTP 403 with a Notion-shaped `restricted_resource` body).

### Connections

Two connection recipes are declared: `notion-sdk` (`NOTION_BASE_URL` = the HTTP binding, `NOTION_TOKEN` = its token, to be
passed as `baseUrl` / `auth` to `@notionhq/client` in a test-only process) and `notion-mcp` (`NOTION_MCP_URL` /
`NOTION_MCP_TOKEN` for the MCP binding). The values are isolated world tokens for test processes only. Neither client has
been exercised against this package yet (see *Compatibility*).

## Starting data

`starter.json` (and `firedrill/world.json`) contain 103 fictional rows, virtual time `2026-09-14T09:00:00Z`: the workspace
**Halvard Robotics** (`@halvard.example`), five people (Ines Okafor, Tomas Lindqvist, Priya Raman, Marco Belli and the
guest Yuki Sato), three bot users, three integrations, a wiki of nine pages (*Halvard Robotics Home* at the workspace root
→ *Engineering* → *Onboarding guide* and the empty *Empty scratchpad*; *Design principles* with 13 top-level blocks
including a toggle with children, numbered and bulleted lists, a quote, a callout, a code block, a divider and a bookmark;
*Meeting notes* → two *Weekly sync* pages; and *Roadmap 2025* in the trash), three databases — **Projects** (5 rows;
status, people, date range, relation to Tasks), **Tasks** (14 rows; status with groups, assignee, due date, priority
select, tags multi-select, checkbox, number, url, rich text with a user mention, relation to Projects, computed
`created_by` / `last_edited_time`) and the empty inline **Decisions log** — 49 blocks and 6 comments in four discussions.
The data deliberately covers an unassigned task, a task due "today", an overdue one, one without a due date, an `Urgent`
one, three titles containing "Firmware", shared tags, a bot-authored comment and an unshared subtree.

Row ids are UUID-shaped (`fd000000-0000-4000-8000-KKKKNNNNNNNN`, `KKKK` = kind, `NNNNNNNN` = sequence) so `format: uuid`
clients accept them; seeded rows use sequences below `0x1000`, created rows take the next value of `meta/counters`
(`next_id`, shared by rows, property ids and select-option ids). Ids are accepted dashed or as 32 hex characters and always
returned dashed.

## Operations

Every operation has one canonical shape: the **flattened Notion request** (path + query + body fields in one snake_case
object) in, and the **exact Notion response body** out. That is also the shape the Notion MCP server exposes per tool, so
the aliases carry the same schemas, and the HTTP codecs only move fields between the path/query and that object.

| operation | MCP alias | HTTP route |
|---|---|---|
| `users.me` | `API-get-self` | `GET /v1/users/me` (served by the `get-user` route, see *Compatibility*) |
| `users.list` | `API-get-users` | `GET /v1/users` |
| `users.get` | `API-get-user` | `GET /v1/users/{user_id}` |
| `search` | `API-post-search` | `POST /v1/search` |
| `pages.create` | `API-post-page` | `POST /v1/pages` |
| `pages.retrieve` | `API-retrieve-a-page` | `GET /v1/pages/{page_id}` |
| `pages.update` | `API-patch-page` | `PATCH /v1/pages/{page_id}` |
| `pages.retrieve-property` | `API-retrieve-a-page-property` | `GET /v1/pages/{page_id}/properties/{property_id}` |
| `pages.move` | `API-move-page` | `POST /v1/pages/{page_id}/move` |
| `pages.retrieve-markdown` | `API-retrieve-page-markdown` | `GET /v1/pages/{page_id}/markdown` |
| `pages.update-markdown` | `API-update-page-markdown` | `PATCH /v1/pages/{page_id}/markdown` |
| `databases.create` | — | `POST /v1/databases` |
| `databases.retrieve` | `API-retrieve-a-database` | `GET /v1/databases/{database_id}` |
| `data-sources.retrieve` | `API-retrieve-a-data-source` | `GET /v1/data_sources/{data_source_id}` |
| `data-sources.query` | `API-query-data-source` | `POST /v1/data_sources/{data_source_id}/query` and legacy `POST /v1/databases/{database_id}/query` |
| `data-sources.update` | `API-update-a-data-source` | `PATCH /v1/data_sources/{data_source_id}` |
| `blocks.retrieve` | `API-retrieve-a-block` | `GET /v1/blocks/{block_id}` |
| `blocks.children.list` | `API-get-block-children` | `GET /v1/blocks/{block_id}/children` |
| `blocks.children.append` | `API-patch-block-children` | `PATCH /v1/blocks/{block_id}/children` |
| `blocks.update` | `API-update-a-block` | `PATCH /v1/blocks/{block_id}` |
| `blocks.delete` | `API-delete-a-block` | `DELETE /v1/blocks/{block_id}` (200 + block object, as Notion) |
| `comments.create` | `API-create-a-comment` | `POST /v1/comments` |
| `comments.list` | `API-retrieve-a-comment` | `GET /v1/comments?block_id=` |
| `workspace.context` | — | — (canonical only: workspace, acting user, resolved integration, `now` from virtual time, row bounds) |
| `workspace.trash` | — | — (canonical only: the trash roots — trashed pages and databases whose own parent is live — newest deletion first, cursor-paginated; backs the app's Trash panel, Notion has no public trash listing) |

Canonical names are also reachable as `POST /v1/operations/notion/<operation>` and as MCP tools `notion.<operation>`.
Mutations accept an optional `X-Firedrill-Idempotency-Key` request header (Notion clients never send one).

Behaviour highlights, all computed from state:

- **Property types**: `title`, `rich_text`, `number`, `select`, `multi_select`, `status`, `date`, `checkbox`, `url`,
  `email`, `phone_number`, `people`, `relation` (single direction), and the computed `created_time`, `created_by`,
  `last_edited_time`, `last_edited_by`. Values are validated against the data source's schema (`X is not a property that
  exists.`, `Status is expected to be status.`, unknown status option, relation outside the related source, computed
  property in a write → `400 validation_error`); unknown `select` / `multi_select` option names are added to the schema
  as Notion does. `null` clears a value; a create fills omitted properties with empty values. Plain pages hold exactly
  `title` (`properties: { title: [...] }` and `{ title: { title: [...] } }` are both accepted).
- **Query** (`data-sources.query`): Notion's per-type condition table (text `equals … is_not_empty`, number comparisons,
  checkbox, select/status `equals`, multi-select/people/relation `contains`, date `before/after/on_or_before/on_or_after/
  equals` and the relative windows `this_week`, `past_week/month/year`, `next_week/month/year` computed from virtual
  time; date-only values compare by UTC calendar day, weeks start on Monday), `and`/`or` compounds nested at most two
  levels with ≤ 100 conditions per group, `sorts` by property or `timestamp` applied stably (empties last, select/status
  by option order), `filter_properties`, `in_trash` / `archived`, cursor pagination (`page_size` 1–100, `start_cursor` =
  id of the last item; unknown → `The start_cursor provided is invalid.`). Anything else answers `400 validation_error`
  with Notion's `body.filter…` wording.
- **Search**: case-insensitive substring match of every whitespace-separated token against page and data-source titles,
  `filter.value: page | data_source`, `sort.timestamp: last_edited_time` ascending/descending (default descending),
  cursor pagination; trashed and unshared objects are excluded.
- **Blocks**: `paragraph`, `heading_1/2/3`, `bulleted_list_item`, `numbered_list_item`, `to_do`, `toggle`, `quote`,
  `callout`, `code`, `divider`, `bookmark`, `image` (external only) plus the maintained `child_page` / `child_database`
  (their block id equals the page / database id). Appends take ≤ 100 children nested ≤ 2 levels, at the end or
  `after` a sibling; updates replace `rich_text` wholly and merge `checked`, `color`, `language`, `icon`, `url`, `caption`
  (the MCP server's `type: { <type>: … }` wrapper is accepted; a type change is rejected); deletes trash the subtree
  (`archived: false` restores). Rich text supports `text` (annotations, link) and `mention` (`user`, `page`, `date`);
  items are capped at 2000 characters (link URLs at 2000) and 100 per array, and one rich-text array may render to at most
  800 000 UTF-8 bytes (the text is sent twice, as `text.content` and `plain_text`).
- **Trash**: `pages.update { in_trash: true }` (or `archived`) trashes the page, its blocks, child pages and child
  databases; `in_trash: false` restores the subtree; editing a trashed object answers `Can't edit block that is archived…`.
  `data-sources.update { in_trash: true }` trashes the source and its pages. Restore is a whole-subtree operation and
  diverges from Notion here: blocks deleted individually with `blocks.delete` before the page was trashed come back
  when the page is restored.
- **Move**: into a page (properties reduced to the title, a `child_page` block appears at the end of the target) or
  into a data source (title kept under the target's title property, other values re-created empty); moving a page into
  itself, a descendant or a trashed parent is rejected.
- **Markdown** (`pages.retrieve-markdown` / `pages.update-markdown`): a deterministic dialect — `#`/`##`/`###`,
  paragraphs, `- ` bullets, `1. ` numbered items (renumbered), `- [ ] / - [x]` to-dos, `> ` quotes, `> <emoji> text`
  callouts, fenced code with the Notion language name, `---`, `<details><summary>…</summary>` toggles, two-space
  indentation for nested list children, inline `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[text](url)`,
  user mentions as `[@Name](notion://user/<id>)`, child pages / databases as `[📄 Title](notion://page/<id>)` /
  `[🗃️ Title](notion://database/<id>)` (kept in place, never duplicated, never removable through markdown), and
  `bookmark` / `image` blocks as `<unknown type="…" id="…" url="…"/>` listed in `unknown_block_ids`. Nesting
  (`<details>`, indented list children) follows the append rule — at most two levels below a top-level block, else the
  append's `body.content[0]….children nests blocks deeper than 2 levels` error — and parsing is linear in the content
  length (an unclosed `[`, `` ` ``, `**` or `~~` stays plain text). `replace_content`
  needs `allow_deleting_content: true` when blocks would be removed; `update_content` applies `old_str` → `new_str`
  (`replace_all_matches` for several hits; zero or ambiguous hits are rejected; `new_str` is literal text) and edits
  unchanged blocks in place — at most 100 `content_updates` per request, and a step that would grow the markdown past
  `max_markdown_bytes` is rejected before it is built (`the resulting markdown exceeds 102400 bytes (at
  body.content_updates[i])`);
  `insert_content` adds at `position.type: start | end`. `replace_content_range` and `allow_async` are rejected.
- **Comments**: `comments.create` with `parent.page_id` starts a discussion, with `discussion_id` joins one;
  `comments.list` lists a page's or block's comments in creation order, paginated.
- **Bounds**: every scan is bounded by `meta/limits.max_rows_per_namespace` (default 10 000) and fails with
  `FAILED_PRECONDITION` (HTTP 400 `validation_error`, "state exceeds the supported bound of N rows in <namespace>")
  instead of truncating; `max_page_size` 100, `max_children_per_append` 100, `max_markdown_bytes` 102 400 (UTF-8 bytes), 1000 block
  elements per parsed markdown document, 100 `content_updates` per request. Block positions are gapless among a
  parent's live children; trashed blocks keep their last position (a restored block returns near it). Lower the
  `limits` row in a scenario to prove the failure (the shipped `bounded` scenario uses 4).

### Errors

Tool errors are rendered with Notion's envelope `{ "object": "error", "status", "code", "message", "request_id" }`:
`VALIDATION_ERROR` → 400 `validation_error`, `FAILED_PRECONDITION` → 400 `validation_error`, `UNAUTHORIZED` → 401
`unauthorized`, `RESTRICTED_RESOURCE` → 403 `restricted_resource`, `OBJECT_NOT_FOUND` → 404 `object_not_found`,
`CONFLICT_ERROR` → 409 `conflict_error`, `RATE_LIMITED` → 429 `rate_limited` (+ `Retry-After: 1`), `SERVICE_UNAVAILABLE` →
503 `service_unavailable`. Messages follow Notion's wording where known (`Could not find page with ID: … Make sure the
relevant pages and databases are shared with your integration.`, `path.page_id should be a valid uuid`, `query failed
validation: query.page_size should be ≤ 100, instead was 250.`). Every validation message names the section the value
came from, so a body value is reported as `body.parent.page_id`, a query value as `query.block_id` and a path segment
as `path.page_id`. Framework outcomes keep their statuses — schema-invalid
input 400, missing grant 403, unknown route 404/405 — but the bodies of the declared routes are Notion-shaped too.

Query `page_size` on `GET /v1/users`, `GET /v1/blocks/{block_id}/children`, `GET /v1/comments` and
`GET /v1/pages/{page_id}/properties/{property_id}` is never rejected by the route codec: a value that is not a plain
decimal integer (`abc`, empty, `1e999`, `1.5`) answers 400 `validation_error` `query failed validation: query.page_size
should be a number, instead was \`"abc"\`.`, a non-integer number answers `should be an integer`, a value below the range
(`0`, `-1`) answers `should be ≥ 1, instead was 0.` and one above it (`101`, `99999999999`) `should be ≤ 100`. The same
messages are used for `page_size` in a JSON body (`POST /v1/search`, data source and database query, canonical
`workspace.trash`), where the field is named `body.page_size` and any JSON type reaches the handler, so
`{"page_size":"abc"}` answers Notion's message rather than a schema rejection. Non-string values in validation messages
are printed as JSON (`instead was \`{}\``).

`property_id` path segments are decoded once by the server. A property matches when its id or name equals that value,
when its (URL-encoded, Notion-style) id decodes to it, or when the value itself decodes once more to an id or name — so
both `/properties/%3AUPp` and a client-side re-encoded `/properties/%253AUPp` resolve an id stored as `%3AUPp`, and
percent escapes are compared case-insensitively, so a client that re-encodes with lower-case hexadecimal (`%3a…`)
resolves the same property. A
malformed leftover encoding (`%25`, `%25E0%25A4%25A`, `%25ZZ`) never throws; it answers 400 `validation_error`
`Could not find property with name or id: %`. Error messages that echo caller input (ids, property keys) are capped at the
framework's 1000-character outcome-message limit and end with `…` when cut.

## Events and faults

| id | kind | when |
|---|---|---|
| `page.created` | event | `pages.create` (`entity_id`, `parent_type`, `parent_id`, `database_id`, `author_id`) |
| `page.properties_updated` | event | `pages.update` with properties/icon/cover (`updated_properties` = property ids, `icon`, `cover`); `pages.move` (`updated_properties: []`) |
| `page.content_updated` | event | `pages.create` with `children`, `blocks.children.append`, `blocks.update`, `blocks.delete`, `pages.update-markdown` (`updated_blocks`) |
| `page.deleted` / `page.undeleted` | event | `pages.update` trashing / restoring a live / trashed page |
| `comment.created` | event | `comments.create` (`discussion_id`, `parent_type`, `parent_id`, `page_id`) |
| `rate-limited` | fault (`before`) | `search`, `data-sources.query`, `blocks.children.list`, `pages.retrieve` answer 429 `rate_limited` with `Retry-After: 1` |
| `write-unavailable` | fault (`before`) | `pages.create`, `pages.update`, `blocks.children.append`, `comments.create` answer 503 `service_unavailable`; nothing is written |
| `update-committed-response-lost` | fault (`after_commit`) | `pages.update` commits but the caller sees 409 `conflict_error` — models Notion's transient save conflict where a retry must re-read first |

Scenarios `rate-limited`, `write-unavailable`, `update-lost` and `bounded` ship in `firedrill/`; no subscriptions or
callbacks are declared (attach your own callbacks to the events above).

## App

`firedrill serve` also serves a browser app (declared as `ui: { root: "app/site" }`) that recreates the Notion web
client a workspace member sees, with every control wired to the operations above through `/_firedrill/client.js`:

- **Sidebar**: workspace switcher (workspace icon and name; the menu shows the acting person or bot and the integration's
  capabilities), Search (`⌘/Ctrl K`), Home, Inbox (every comment of the 25 most recently edited live pages, read with
  `start_cursor`; it says *Showing comments from the 25 most recently edited pages.* when more exist), the *Private* page tree (roots from `search`, children loaded on expand
  from `blocks.children.list` in block order, full-page databases included, inline databases and database rows excluded),
  Settings / Templates / Trash / Invite members panels (lists the app loads with a request cap — the page index, a page's
  subpages, workspace members, a page's comments — show a notice when the cap trips instead of hiding rows), `+` to create pages (`pages.create`; integrations cannot create at
  the workspace root, so new top-level pages go under the first root page and the app says so).
- **Home**: greeting from virtual time, *Upcoming events* (not simulated: no calendar connection), *Recently visited* cards (index sorted by `last_edited_time` — the API has no visit
  history) and a *Home database view* widget: the first data source with a people + status property, queried with
  `people contains <acting user>`.
- **Page**: icon (emoji picker → `pages.update icon`), title (`pages.update`), property panel for database rows with the
  right editor per type (text/number/url/email/phone inputs, date with optional end date, select/status/multi-select
  option pickers that can create options, people picker from `users.list`, relation picker backed by
  `data-sources.query`, checkbox), page comments under the title (`comments.list`, reply / new discussion via
  `comments.create`), the block editor (`blocks.children.list` paginated with *Load more*; plain-text editing of text
  blocks on blur → `blocks.update`, Enter appends a block after the current one, Backspace on an empty block deletes it,
  `/` opens the block menu → `blocks.children.append` with `after`; to-do checkboxes; toggles load children on expand;
  the `⋮⋮` handle menu offers Comment and Delete (confirmed) → `blocks.delete`; child pages / inline databases render in
  place), the top-bar comments panel, and the `…` menu with Copy link, Markdown (`pages.retrieve-markdown` with a
  *Replace page content* editor → `pages.update-markdown replace_content`, confirmed), Move to (`pages.move`) and Move
  to Trash (confirmed, with Undo). Trashed pages show the red banner with *Restore page*.
- **Database** (full page and inline): Table and Board views, *Filter* builder composing real `data-sources.query`
  filters (per-type conditions, `and`), *Sort* menu, search-in-view (title `contains`), *New* (`pages.create` in the
  data source, then the side peek), inline cell editing (`pages.update`), *Load 50 more* pagination, `COUNT` footer,
  column menu (sort, filter, rename, delete) and the *Properties* editor (`data-sources.update`: add, rename, delete).
  Board groups by the first status (else select) property client-side over the same query.
- **States**: skeleton loading, empty page / *No pages yet* / *No results* / empty trash and inbox, the product's
  "This content doesn't exist or you don't have access." page for `object_not_found`, capability and framework denials
  as toasts or the *You don't have access* page, a rate-limit retry state, a connection screen when the app is opened
  outside its local link; every timestamp and "today" comes from `workspace.context.now`, never the browser clock; the
  page re-fetches when `getContext().revision` changes unless the viewer is typing; mutations carry idempotency keys and
  destructive actions confirm. Usable at phone width (the sidebar becomes a drawer).

The app uses the same records as the API: a page created over REST appears in the sidebar within two seconds; a cell edited
in the table is visible to `pages.retrieve`. External images and bookmarks are never fetched (the serving policy blocks
remote requests), so image blocks and covers render as frames with the URL as caption. Assets: the official Notion logo
files under `firedrill/tools/notion/app/assets/` (sources in `ATTRIBUTION.md`) and the Inter typeface (SIL OFL).

## Conformance

`firedrill tool test notion` runs 16 drills (`firedrill/*.drill.json`, suite `conformance`) with a Node-built-ins-only
target (`test/conformance.mjs`, bindings `http` + `mcp`) that exercises every operation, every declared error, every
event and every fault, then re-runs the suite to prove determinism: workspace reads with pagination and validation
errors, task triage with real filters/sorts/create/update/move/comments, page authoring with blocks, markdown and a new
database, trash and restore, the MCP aliases, four identity/scope drills, the framework-denied actor, and one drill per
fault plus the bounded scenario, and a byte-budget drill (oversized rich text refused with nothing stored; near-limit
blocks, comments, search results and query rows read back once each across byte-filled pages under 1 MiB; oversized
markdown and database writes answer `validation_error`), and a schema-growth drill (a data source schema is refused at
exactly one byte over what it may add to every page, accepted at the limit, and its rows stay readable).

## Compatibility

- **Not verified against a real client.** `manifest.compatibility` is empty: neither `@notionhq/client` nor
  `@notionhq/notion-mcp-server` has been run against `firedrill serve` yet. The MCP aliases reproduce the tool names and
  flattened argument shapes of the open-source Notion MCP server 2.x (`API-` + OpenAPI operationId) as read from its
  tool schemas; the hosted `mcp.notion.com` contract (`notion-search`, `notion-fetch`, …) is a different, undocumented
  surface and is **not** claimed.
- `GET /v1/users/me` is served by the `get-user` route (`users.get` with `user_id: "me"`, no user-information capability
  needed) because the framework rejects a literal path segment next to the `/v1/users/{user_id}` template. The canonical
  `users.me` operation and its `API-get-self` alias are unaffected; in drill evidence a `GET /v1/users/me` counts as a
  `users.get` call.
- `Notion-Version` is accepted but neither enforced nor echoed; responses always use the 2025-09-03 shapes (database
  containers without `properties`, `parent.type: data_source_id` on database pages, `type: page_or_data_source` lists)
  plus the 2026-03-11 markdown endpoints. A 2022-06-28 client works only through the legacy `POST /v1/databases/{id}/query`
  and `pages.create` with `parent.database_id`. `missing_version` is never returned.
- Unsupported Notion paths (`/v1/oauth/*`, `/v1/file_uploads*`, `POST /v1/data_sources`, `PATCH /v1/databases/{id}`,
  data-source templates, …) do not exist: the framework answers 404 (or 405 when only other methods exist on the path).
  Never a plausible stub.

## Limitations

- Single workspace, single-token model: no OAuth, no public integrations, no multi-workspace tokens; `users.me` always
  returns a bot owned by the workspace.
- Property types limited to the list above — no formulas, rollups, files, unique ids, verification, buttons or places;
  relations are single-direction (no synced property); `people` values must be workspace users; `date.time_zone` is
  stored, not interpreted.
- Block types limited to the list above — `table`, columns, synced blocks, embeds, media uploads, `link_to_page` and
  direct `child_page` / `child_database` appends are rejected with `validation_error`; `after` is supported but the
  2026-03-11 `position` object for appends is not.
- The markdown dialect is a deterministic subset, not Notion's enhanced markdown: text containing markdown markers does
  not escape, date mentions render as plain text, `replace_content_range`, `allow_async` (202 tasks) and `include_transcript`
  are not supported, and `update_content` keeps block ids only where the old and new markdown align block by block.
- Search matches titles only (no content search, fuzziness or relevance ranking); cursors are last-item ids valid only
  against unchanged ordering; there is no `request_status.incomplete`, no `partial` objects, no `public_url`.
- No permanent deletion (Notion has none), no comment edits/deletes/attachments/`display_name` overrides, no
  data-source schema events, no webhooks, no optimistic concurrency (`conflict_error` only occurs through the fault),
  no `Retry-After` beyond the fault header.
- Framework-level `invalid` (schema) and `denied` outcomes use the framework's statuses; only their bodies are
  Notion-shaped. `FAILED_PRECONDITION` (row bound) has no Notion equivalent and is sent as 400 `validation_error`.
- Response size: the framework refuses any response over 1 MiB, so every list (`users.list`, `search`, data source
  query, block children, comments, property items, trash) ends a page at `page_size` items or about 900 KB of encoded
  results, whichever comes first, with `next_cursor` naming the last item returned. Writes are bounded so one object
  always fits one response: a block's content, a page, a comment, a database and a data source may render to at most
  800 000 UTF-8 bytes, a data source schema to 150 000 (and to at most 150 000 bytes added to the rendering of each of
  its pages, counting `created_by`/`last_edited_by` as the widest expanded user, so a stored page still fits after any
  later schema change), and one create/append request may add 900 000 bytes of block
  content; beyond that the write answers `validation_error` and stores nothing. A read whose single response would
  still pass 1 000 000 bytes (a page's markdown over many large blocks, for example) answers `validation_error`
  `The response is too large: …`; read such a page through `GET /v1/blocks/{id}/children` instead. The request body
  itself is capped at 1 MiB by the framework (HTTP 413).
- JSON request bodies may nest at most 512 levels: a deeper body is refused by the route codec with `400`
  `framework.HTTP_REQUEST_MAPPING_FAILED` ("JSON nesting is deeper than the maximum depth of 512") before argument
  validation, because the framework validates arguments recursively and a deeper body would overflow the stack.
  Depth is measured iteratively, and ordinary bodies (blocks, rich text, filters) are far below the bound. The bound
  is applied by the provider-shaped `/v1/...` routes; the canonical `POST /v1/operations/notion/<operation>` path is
  decoded by the framework itself, where a body nested a few thousand levels deep still answers `413`
  `{"error":"Maximum call stack size exceeded"}`; the exact depth depends on the serve process's stack limit and
  has been measured anywhere from about 3,000 to more than 6,000 levels (framework limitation, recorded in
  `specs/notion/VERIFICATION.md`).
- Malformed percent-encoding is decoded leniently by the framework: a bad escape such as `%E0%A4%A` becomes U+FFFD
  (`%ZZ` is not a valid escape and stays literal in query strings and bodies — e.g. `filter_properties=%ZZ` reaches the
  handler and answers Notion's own "Could not find property with name or id: %ZZ" — while any unresolvable escape,
  `%ZZ` included, in a *path* segment is a `404` "route not found"). A query-language input carrying U+FFFD is
  treated as a mangled request rather than a literal to match, and answers `validation_error` "… contains an invalid
  character (U+FFFD); check the request's percent-encoding": `search` `query`, data-source query `filter` property
  names and string condition values, `sorts[].property`, and `filter_properties`. Correctly encoded non-ASCII search
  terms (accents, CJK, emoji) are unaffected.
- `GET /v1/comments` without `block_id` is refused by the declared input schema (`block_id` is required, as in
  Notion), so the message is Notion's envelope carrying the schema text "arguments do not match notion.comments.list"
  rather than a hand-written field message.
- Bounds: 10 000 rows per namespace (configurable through `meta/limits`), 100 items per page, 100 children per append
  nested two levels, 2000 characters per rich-text item, 100 KB of markdown, 1000 block elements per parsed markdown
  document (Notion's per-request block limit; `update_content` counts both the current page and the result, so pages
  over 1000 blocks are edited through the blocks API), 64 stored block levels below a page (appends that would go
  deeper fail with `validation_error`). Each bound answers `validation_error`; nothing is truncated. `__proto__` is
  reserved as a property name, but the two forms differ: *renaming* a property to `__proto__`
  (`data-sources.update { properties: { Highlights: { name: "__proto__" } } }`) is refused with `validation_error`
  "… uses the reserved property name __proto__.", while a request that carries `__proto__` as a property *key* never
  reaches the Tool — the framework strips own `__proto__` keys while decoding the body, so the call succeeds (`200`)
  with that one field silently absent from the created or updated schema (see `specs/notion/VERIFICATION.md`).
- App: editing a text block replaces its rich text with one plain run (annotations, links and mentions of the edited
  block are flattened; untouched blocks keep them); block types cannot be changed in place (the `/` menu inserts a new
  block); the sidebar lists the first 5 000 visible pages; *Recently visited* is ordered by last edit; favorites,
  expanded tree nodes and view filters are per-browser conveniences, not workspace state; Notion AI, teamspaces,
  templates, sharing settings, notifications and permanent deletion have no API surface and are shown as informational
  panels rather than working controls.
- App controls outside this Tool's scope render in place with the product's glyph, hover state and tooltip and open a
  short *Not simulated by this Tool* panel (or are disabled): sidebar *Meetings*, *Notion AI* and *Marketplace*; the
  top-bar *View all updates* (clock), *Add to Favorites* (star) and, on full-page databases, *Comments* and *Share*;
  the database *Automations* (lightning) button, the *New* caret's *New template*, and the Timeline, Calendar, List,
  Gallery, Chart, Feed and Map layouts in the *Add a new view* menu (Table and Board work); Home *Upcoming events*
  (*Connect calendar*) and the Home *Learn* cards (text-only guide cards; the guides live on the vendor's help
  center); the sidebar *Teamspaces* section (heading, hover *...* and *+*, *Browse teamspaces*) and *Shared* section
  (heading, hover *+*, *Start collaborating*), drawn in place without invented entries because the API does not model
  teamspaces or per-member sharing; the cover *Reposition* button and the cover picker's *Upload* and *Unsplash* tabs
  (visibly disabled); and, in the inline text toolbar shown over a selection, *Ask AI*, *Turn into* (*Text*), *Link*,
  *Bold*, *Italicize*, *Underline*, *Strike-through*, *Mark as code*, *Text color* and *...* (edited blocks are
  written as one plain rich-text run). Working: *Add icon*, *Add cover* and *Change cover* (Gallery gradients, Link
  and Remove through `pages.update` `cover`; external images are drawn as gradients), *Add comment*, and the toolbar's
  *Comment* (opens the block's discussions).

## Trademarks

Notion and the Notion logo are trademarks of Notion Labs, Inc. They are used here only to identify the simulated
service in a test environment; this package is an independent Firedrill Tool and is not affiliated with, sponsored by
or endorsed by Notion Labs, Inc. The logo files under `firedrill/tools/notion/app/` (`notion.svg`, `notion-wordmark.svg`)
are unmodified downloads whose sources are recorded in `firedrill/tools/notion/app/assets/ATTRIBUTION.md`, together with
the Inter font's SIL Open Font License.

## Safety

Tools and conformance targets are trusted local executable code, not a sandbox. Review before running. Keep
credentials and generated worlds/reports out of the package and repository; the file list excludes `.firedrill/`.
