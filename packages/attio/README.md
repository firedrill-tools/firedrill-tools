# @firedrill-tools/tool-attio

A synthetic **Attio workspace** for Firedrill. It serves a documented subset of Attio's REST API v2: people, companies and
deals records, attribute definitions, lists and list entries, notes, tasks, workspace members and token identity. All state
lives in Firedrill (SQLite, virtual time, reset, evidence). No Attio service is ever contacted, and no e-mail, call or
meeting is created or delivered.

It also serves a browser app that recreates the Attio web app on the same state (see [App](#app)).

## Install

```sh
firedrill tool add /absolute/path/to/firedrill-tools-tool-attio-0.1.1.tgz --install
firedrill serve
```

A new world receives the starter data, `virtualTimeUs` 2026-09-15T09:00:00Z and grants for the 27 operations below.
Existing worlds get no silent changes: add the grants (`packageId: "attio"`, each `operationId`) and starter rows yourself.

Connect an HTTP client with the `attio-rest` connection recipe. Set the client's base URL to `FIREDRILL_HTTP_URL` in place of
`https://api.attio.com`; paths keep their `/v2` prefix. Send `FIREDRILL_HTTP_TOKEN` as the Bearer token. Canonical operations
are also available as `attio.<operation>` over Firedrill's operation, MCP and CLI bindings.

## Identities

An Attio token acts for one workspace member. The Tool resolves the caller from actor attributes:

| attribute | meaning |
|---|---|
| `workspaceMemberId` | Member id. An id that names no member answers 401 `invalid_api_key`. |
| `email` | Used when `workspaceMemberId` is absent. Matched case-insensitively; an unknown e-mail answers 401. |
| *(neither)* | Fallback for actors created by `firedrill tool add`: the first `admin` member in row-id order (Priya Raman, `00000009-0000-4000-8000-000000000001`). |
| `scopes` | Optional array of Attio scope names. When absent, every scope is granted. When present, a missing scope answers 403 `unauthorized`, and a `…:read-write` scope satisfies `…:read`. |

A member with `access_level: "suspended"` answers 403 `Workspace member is suspended.` on every operation.

List access follows Attio's model. The effective level is the higher of `workspace_access` and the member's
`workspace_member_access` entry, and admins always get `full-access`. With no effective level the list is invisible: it is
missing from `GET /v2/lists` and answers 404 on its entries and attributes routes. A `read-only` level refuses entry writes
with 403.

Object-level record permissions are not modelled. Every active member can read and write all people, companies, deals, notes
and tasks.

## Starting data

The fictional workspace **Kestrel Labs** (`kestrel-labs`) has 99 rows, all e-mail addresses and domains under `example.com`:

- **Configuration**: 3 objects, 35 attribute definitions, 4 members (Priya admin, Tomás and Hana members, Owen suspended), a workspace row and an id counter.
- **Companies (9)**: includes Brightwater Analytics with two domains and an archived "Finance" category still stored, a legacy duplicate "Cobalt and Pine Ltd" sharing `cobaltpine.example.com` (so assert by domain answers `multiple_match_results`), and Juniper Logistics with no domain.
- **People (12)**: diacritics (Zoë, Chloé), two people named Sam, Marcus with two e-mails, Ines with a phone but no e-mail, Rafael with no company. Every `company` value has its `team` inverse.
- **Deals (5)**: every stage, including a deal with no value and a deal owned by the suspended member.
- **Lists (4)** with 12 entries:
  - `enterprise_accounts`: read-and-write, and one company appears twice.
  - `recruiting`: full-access.
  - `investors`: visible only to Priya.
  - `partner_referrals`: read-only, except that Tomás has read-and-write.
- **Notes (6)**: a markdown note, plaintext notes including literal asterisks, and notes on a company, people and a deal.
- **Tasks (7)**: overdue, due today, completed, unassigned, two assignees, no links, and linked to a deal.

Ids are UUID-shaped and deterministic (`{kind}-0000-4000-8000-{sequence}`). New ids come from the `meta/counters` row and
timestamps come from virtual time, so replaying a world gives identical results.

## Operations

No MCP aliases are declared: Attio's hosted MCP server's tool schemas could not be verified, so MCP clients use the canonical
`attio.<operation>` names with the REST-shaped arguments.

| operation | HTTP route | notes |
|---|---|---|
| `self.identify` | `GET /v2/self` | Token identity and scopes. The canonical result also carries `server_time` (virtual time), which the route omits. |
| `objects.list` | `GET /v2/objects` | people, companies, deals |
| `attributes.list` | `GET /v2/objects/{identifier}/attributes`, `GET /v2/lists/{identifier}/attributes` | `limit`, `offset`, `show_archived` |
| `select-options.list` | `GET /v2/objects/{identifier}/attributes/{attribute}/options`, `GET /v2/lists/{identifier}/attributes/{attribute}/options` | Options of a `select` attribute in configured order; `show_archived` |
| `statuses.list` | `GET /v2/objects/{identifier}/attributes/{attribute}/statuses`, `GET /v2/lists/{identifier}/attributes/{attribute}/statuses` | Statuses of a `status` attribute in configured order; `show_archived` |
| `records.query` | `POST /v2/objects/{object}/records/query` | Filter, sorts, `limit` 1–500 and `offset` |
| `records.get` | `GET /v2/objects/{object}/records/{record_id}` | Every non-archived attribute; unset attributes are `[]` |
| `records.create` | `POST /v2/objects/{object}/records` | Required and unique attributes are checked; relationship inverses are kept in sync |
| `records.assert` | `PUT /v2/objects/{object}/records?matching_attribute=` | Updates one match, creates when there is none, and answers `multiple_match_results` when several match |
| `records.update` | `PATCH` (append) and `PUT` (overwrite) `/v2/objects/{object}/records/{record_id}` | |
| `records.delete` | `DELETE /v2/objects/{object}/records/{record_id}` | Also deletes the record's entries and notes and unlinks it from references and tasks |
| `records.search` | `POST /v2/objects/records/search` | Prefix tokens over names, e-mails, domains and phone digits (diacritics folded) |
| `lists.list` | `GET /v2/lists` | Visible lists only |
| `entries.query` | `POST /v2/lists/{list}/entries/query` | Entry filters, plus `path` filters on the parent record |
| `entries.create` | `POST /v2/lists/{list}/entries` | |
| `entries.get` | `GET /v2/lists/{list}/entries/{entry_id}` | |
| `entries.update` | `PATCH` (append) and `PUT` (overwrite) `/v2/lists/{list}/entries/{entry_id}` | |
| `entries.delete` | `DELETE /v2/lists/{list}/entries/{entry_id}` | |
| `notes.list` | `GET /v2/notes` | Newest first; `limit` 1–50 (default 10), `offset`, `parent_object` together with `parent_record_id` |
| `notes.get` | `GET /v2/notes/{note_id}` | |
| `notes.create` | `POST /v2/notes` | `plaintext` or `markdown`; the other representation is derived |
| `notes.delete` | `DELETE /v2/notes/{note_id}` | |
| `tasks.list` | `GET /v2/tasks` | `is_completed`, `assignee` (id, e-mail, or empty for unassigned), `linked_object` + `linked_record_id`, `sort`, `limit`, `offset` |
| `tasks.create` | `POST /v2/tasks` | Links by record id, `email_addresses` (people) or `domains` (companies) |
| `tasks.update` | `PATCH /v2/tasks/{task_id}` | Completing a task stamps `completed_at`; content is not updatable |
| `tasks.delete` | `DELETE /v2/tasks/{task_id}` | |
| `workspace-members.list` | `GET /v2/workspace_members` | |

Value writes accept Attio's formats for these attribute types: text, number, checkbox, currency, date, timestamp, select,
status, record-reference, actor-reference, domain, email-address, phone-number and personal-name. Filters support shorthand
equality and these operators: `$eq`, `$contains`, `$starts_with`, `$ends_with`, `$in`, `$gt`, `$gte`, `$lt`, `$lte`, `$not_empty`,
`$and`, `$or` and `$not`.

Filter bounds: nesting depth 8, 100 clauses, 100 `$in` values, operands of at most 3,000 characters, and 5 sorts. An operand
containing U+FFFD is rejected. No regular expression is ever built from caller text.
Request bodies nested deeper than 512 levels are refused with 400 before validation.

Mutations accept an optional `X-Firedrill-Idempotency-Key` header. Attio clients do not send one.

### Errors

Errors use Attio's envelope `{ "status_code", "type", "code", "message" }`:

| code | HTTP | `type` / `code` |
|---|---|---|
| `AUTHENTICATION_FAILED` | 401 | `auth_error` / `invalid_api_key` |
| `UNAUTHORIZED` | 403 | `auth_error` / `unauthorized` |
| `NOT_FOUND` | 404 | `invalid_request_error` / `not_found` |
| `VALIDATION_TYPE` | 400 | `invalid_request_error` / `validation_type` |
| `VALUE_NOT_FOUND` | 400 | `invalid_request_error` / `value_not_found` |
| `MULTIPLE_MATCH_RESULTS` | 400 | `invalid_request_error` / `multiple_match_results` |
| `UNIQUENESS_CONFLICT` | 409 | `invalid_request_error` / `uniqueness_conflict` |
| `CONTENT_TOO_LARGE` | 413 | `invalid_request_error` / `content_too_large` (note content over 100,000 characters) |
| `RATE_LIMITED` | 429 | `rate_limit_error` / `rate_limit_exceeded`, with `Retry-After: 1` |
| `SERVICE_UNAVAILABLE` | 503 | `api_error` / `service_unavailable` |
| `FAILED_PRECONDITION` | 400 | `invalid_request_error` / `state_bound_exceeded` (simulator bound, see Limitations) |

Some outcomes are decided by Firedrill before the Tool runs: a missing grant (403), an argument object that fails the input
schema (400) and an unsupported operation (404). These are still rendered in the same envelope. A missing or invalid bearer
token, an unknown path and an unsupported media type are answered by the framework with its own envelope.

## Events and faults

| id | kind | description |
|---|---|---|
| `record.created` | event | Once per record created by `records.create` or by the create branch of `records.assert`. |
| `record.updated` | event | Once per attribute whose stored values changed, including relationship inverses. |
| `list-entry.created` | event | Once per `entries.create`. |
| `rate-limited` | fault, before | All 27 operations answer 429. |
| `write-unavailable` | fault, before | The 12 write operations answer 503; reads keep working. |
| `create-committed-lost` | fault, after commit | `records.create` and `tasks.create` commit, but the caller receives 503. A retry then conflicts or duplicates. |

## Conformance

`firedrill tool test attio` runs 16 drills twice and compares the results. The drills are backed by `test/conformance.mjs`,
which uses Node built-ins only and calls the provider routes. Together they cover:

- every operation, both successful and failing, and every operation/declared-error pair;
- every event and every fault;
- a default fresh-install identity, scopes, suspended and unknown identities, and framework denial;
- list permissions, pagination, cascade deletes, the scan bound, and a notes page over the response size budget.

## Compatibility

**Not verified against a real client.** `compatibility` is empty: no official Attio SDK or MCP client has been run against
`firedrill serve`. Paths, field names and error bodies follow Attio's public REST reference.

## Limitations

- **Schema**: standard objects only (people, companies, deals). There are no custom objects and no writes to object, attribute, option, status, list or view configuration; change the schema through starter or scenario rows.
- **Attribute types**: `location`, `rating` and `interaction` are not modelled, and neither are enriched attributes such as social handles.
- **Value history**: only current values are stored, and `active_until` is always `null`. The attribute value-history endpoints are absent.
- **Parsing**: phone numbers are stored as `+` and digits; national numbering plans are not parsed. A domain's `root_domain` is its last two labels.
- **Search and query**:
  - `records.search` is immediately consistent, and `request_as` does not change results.
  - `filter_view_id` (saved views) is rejected with `validation_type`.
  - Attio's score-based query rate limits are not simulated.
- **Scan bound**: whole-namespace reads are limited to 5,000 rows per namespace (row `meta/limits`). Past the bound, and for pages whose encoded body would exceed about 900 KB, the Tool answers `state_bound_exceeded` instead of returning a truncated page.
- **Undocumented error bodies**: the 401, 413 and 503 `code` strings (`invalid_api_key`, `content_too_large`, `service_unavailable`) are assumptions, because Attio's public reference does not show those bodies. `state_bound_exceeded` is not an Attio code.
- **Retry-After**: the 429 header is `1` (delta-seconds), not Attio's HTTP date, because route encoders have no virtual clock.
- **Actor stamps**: every write is stamped `created_by_actor: { type: "api-token", id: <client_id> }`. The Tool context does not reveal whether a call came from an app or an API client, so member-attributed writes are not distinguished.
- **Deletes**: a deleted record's entries and notes are removed without events, and there is no merge, restore or audit trail.
- **Notes and tasks**: notes cannot be updated, `meeting_id` must be `null` and `tags` are always empty. Markdown conversion covers headings, lists, quotes, emphasis, strikethrough, highlight and links. Tasks are plaintext only, and there is no `GET /v2/tasks/{id}`.
- **Absent areas**: comments, threads, e-mails, calls, meetings, files, webhooks management, reports, workflows, SCIM and OAuth endpoints. Their routes answer 404.
- `web_url` values follow the real product's URL pattern but are inert strings.

## App

`firedrill serve` opens a browser app that recreates the Attio web app's layout. It uses the same state as the HTTP routes, so
writes made in the app show up over the API and the reverse is also true. Every screen calls the operations above through
`/_firedrill/client.js`, and it reloads when the world revision changes.

- **Sidebar**: workspace switcher, Quick actions (⌘K search via `records.search`), Tasks with an open-task count, Notes, the
  Records section (Companies, People, Deals) and the Lists section, plus the account menu.
- **Object tables**: the view bar, Sort, a Filter builder that compiles to Attio filter syntax, search, inline cell editing,
  bulk delete with confirmation, offset pagination, and a "New person/company/deal" create modal.
- **Record page**: breadcrumb header, Overview/Notes/Tasks tabs, and a Record Details panel with inline edits. Its Lists
  section shows the record's entries and supports add, edit and remove.
- **Lists**: a kanban board grouped by the list's status attribute (move entries between stages), or an entry table.
- **Tasks page**: Assigned to me, All tasks and Completed. Tasks are grouped by due date using world virtual time. You can
  create, complete, reassign and delete them.
- **Notes page**: a note list with a Markdown reader, a composer and delete.
- **Paging, never silent truncation**: the sidebar task count pages through `tasks.list` (200 per call) and shows "1,000+"
  past 1,000 open tasks (one extra single-row read tells exactly 1,000 from more). The record page's Notes and Tasks tabs
  load 50 at a time with "Load more" (the tab counter reads "50+" until the last page); the Tasks tab pages open tasks
  before completed ones, and the Overview asks `tasks.list` for open tasks (`is_completed: false`) directly. The Lists section pages each list's entries for the record (500 per call) and says so past
  1,000. Reference names come from an index of up to 5,000 records per object; names past it are fetched on demand with a
  `record_id` `$in` query, so they never read "Unknown record". Table search shows at most 25 matches (the
  `records.search` limit) and says so; the list board refuses lists over 2,000 entries and points to the entry table.
- **States**: loading, empty, error, rate-limited, unavailable and denied states. A token missing the member or list scopes
  still opens the workspace, shows "Unknown member" names and marks lists as "No access to lists".
- **Not simulated**: Notifications, Emails, Calls, Reports, Workflows, Sequences, Favorites, Create list, Invite teammates,
  Help, workspace and profile settings, and the Activity, Emails, Calls, Files and Comments tabs. These controls are present
  and have hover states, but they only open a "not simulated by this Tool" panel.

Every mutation carries an idempotency key. Records are rendered with DOM APIs only (no `innerHTML`). Dates use world virtual
time in UTC. Interface text is set in Inter (SIL OFL 1.1, bundled). The logo and favicon are the vendor's own files; their
sources are listed in `firedrill/tools/attio/app/assets/ATTRIBUTION.md`.

## Trademarks

Attio and its logo are trademarks of their owner. They are used only to identify the simulated service in a test environment.
This package is not affiliated with or endorsed by Attio.

## License

Apache-2.0. See `LICENSE`.
