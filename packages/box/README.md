# @firedrill-tools/tool-box

A synthetic, stateful subset of the **Box Content API 2.0** as a Firedrill Tool (backend only, no app). It simulates one
fictional enterprise, *Northwind Studio*: users, a folder tree with inherited collaboration roles, files with versions and SHA-1
digests, the trash, full-text search, folder collaborations, file comments and the user event stream. Every response is computed
from `context.state` under world virtual time; nothing contacts Box, sends email or creates reachable shared links.

Version `0.1.0`, engine `>=0.1.0 <0.2.0`, license Apache-2.0.

## Install

```sh
firedrill tool add ./firedrill-tools-tool-box-0.1.0.tgz --install   # or a Git URL / local path
firedrill serve
```

`tool add` grants the new local actor all 23 operations (`box.<operation>`). To grant them by hand, add
`{ "packageId": "box", "operationId": "<operation>" }` entries to the actor's `grants` in `firedrill/world.json`.

Point a test process at the served HTTP binding: the connection recipe `box-rest-client` maps
`BOX_API_BASE_URL ← FIREDRILL_HTTP_URL` and `BOX_DEVELOPER_TOKEN ← FIREDRILL_HTTP_TOKEN`. Both Box hosts share that base URL:
API calls use `/2.0/...` and uploads use Box's upload-host paths `/api/2.0/...`.

## Identities

The caller is resolved from actor attributes:

| attribute | meaning |
|---|---|
| `userId` | a seeded user id such as `"20002"` |
| `login` | a user login, matched case-insensitively |
| *(neither)* | the default user **`20001` Maya Chen** — this is what an actor created by `firedrill tool add` gets |

A claimed `userId`/`login` with no user row, or an `inactive` user, answers 401 `unauthorized` from every operation. Firedrill
grants decide which operations an actor may call at all (a missing grant is the framework's 403 before the Tool runs);
item-level rights are enforced by the Tool.

**Permissions.** Owners have full rights. Folder collaborations grant Box roles (`editor`, `viewer`, `previewer`, `uploader`,
`co-owner`), inherited by every descendant. An item the caller cannot see answers 404 `not_found`; an item the caller can see but
not act on answers 403 `access_denied_insufficient_permissions`. Folder `"0"` is the caller's own *All Files* root and also lists
folders shared with that user.

## Starting data

`starter.json` and `firedrill/baseline.scenario.json` hold the same rows; virtual time is **2026-09-15T16:00:00Z**.

| namespace | rows | notes |
|---|---|---|
| `users` | 5 | Maya Chen (admin, default identity), Daniel Okafor, Priya Raman, Jonah Weiss (8 KiB quota, 7,800 bytes used, 4 KiB upload limit), Lena Fischer (inactive) |
| `folders` | 11 | Maya's Marketing (Campaigns 2026 › Q3 Launch, Brand Assets), Finance (Invoices, Weekly Reports with 8 files), Personal (empty), Old Drafts (trashed); Daniel's Vendor Contracts and Priya's Design Reviews, shared with Maya |
| `files` | 24 | UTF-8 text documents, including `Präsentation Übersicht.md` and two trashed files (`obsolete-budget.csv`, `draft-v0.txt`) |
| `versions` / `blobs` | 26 / 26 | file versions and their content, with real SHA-1 digests |
| `collaborations` | 7 | one pending invite to an external address at `example.com` |
| `comments` | 4 | including a reply |
| `event-log` | 6 | the user event stream (the latest 1,000 are kept) |
| `meta` | 1 | id counters and the object counter used by the cap |

All names, logins and content are fictional (`@northwind-studio.example.com`, `@example.com`).

## Operations

Canonical MCP names are `box.<operation>`; no provider MCP aliases are declared. All HTTP routes use `Authorization: Bearer`.

| operation | HTTP route | what it does |
|---|---|---|
| `users.get-me` | `GET /2.0/users/me` | the calling user, quota and enterprise |
| `folders.get` | `GET /2.0/folders/{folder_id}` | folder with embedded first page of `item_collection` |
| `folders.list-items` | `GET /2.0/folders/{folder_id}/items` | offset or marker paging; `folder_id` `trash` lists the caller's trash |
| `folders.create` | `POST /2.0/folders` | create a folder (409 `item_name_in_use` names the existing item) |
| `folders.update` | `PUT /2.0/folders/{folder_id}` | rename, move, describe, tag; `If-Match` etag checks |
| `folders.delete` | `DELETE /2.0/folders/{folder_id}` | move to trash; `recursive=true` required when not empty |
| `folders.copy` | `POST /2.0/folders/{folder_id}/copy` | deep copy (current versions only) |
| `files.get` | `GET /2.0/files/{file_id}` | file info with `fields` selection |
| `files.update` | `PUT /2.0/files/{file_id}` | rename, move, describe, tag; `If-Match` |
| `files.delete` | `DELETE /2.0/files/{file_id}` | move to trash |
| `files.copy` | `POST /2.0/files/{file_id}/copy` | copy, optionally of an older `version` |
| `files.upload` | `POST /api/2.0/files/content` | multipart upload (`attributes` part first, then `file`) |
| `files.upload-version` | `POST /api/2.0/files/{file_id}/content` | new version; `If-Match` |
| `files.download` | `GET /2.0/files/{file_id}/content` | current or `?version=` content |
| `files.list-versions` | `GET /2.0/files/{file_id}/versions` | previous versions |
| `files.restore` | `POST /2.0/files/{file_id}` | restore from trash, optionally renamed or to a new `parent` |
| `search.query` | `GET /2.0/search` | terms, phrases, `AND`/`OR`/`NOT`, type/extension/ancestor/date/trash filters |
| `collaborations.create` | `POST /2.0/collaborations` | invite a user (accepted) or an email (pending) to a folder |
| `collaborations.list-for-folder` | `GET /2.0/folders/{folder_id}/collaborations` | marker paging |
| `collaborations.delete` | `DELETE /2.0/collaborations/{collaboration_id}` | remove access |
| `comments.create` | `POST /2.0/comments` | comment on a file, or reply to a comment |
| `comments.list-for-file` | `GET /2.0/files/{file_id}/comments` | offset paging |
| `events.list` | `GET /2.0/events` | user event stream: `stream_position` (`0`, `now`, a number), `stream_type` `all` or `changes` |

Errors use Box's envelope `{ "type": "error", "status", "code", "message", "context_info"?, "request_id" }` with Box code names
(`not_found`, `trashed`, `access_denied_insufficient_permissions`, `item_name_in_use`, `item_name_invalid`,
`item_name_too_long`, `folder_not_empty`, `precondition_failed`, `storage_limit_exceeded`, `file_size_limit_exceeded`,
`user_already_collaborator`, `bad_request`, `unauthorized`, `rate_limit_exceeded`, `unavailable`, `internal_server_error`).

## Events and faults

| id | kind | when |
|---|---|---|
| `file.uploaded` | event | after a committed `files.upload` or `files.upload-version` |
| `collaboration.created` | event | after a committed `collaborations.create` |
| `item.trashed` | event | after a committed `files.delete` or `folders.delete` |
| `rate-limited` | fault (before) | `search.query`, `folders.list-items`, `files.upload`, `files.upload-version` answer 429 with `Retry-After: 1`; nothing written |
| `writes-unavailable` | fault (before) | `files.upload`, `files.upload-version`, `files.copy`, `folders.create`, `folders.copy` answer 503 with `Retry-After: 1`; nothing written |
| `upload-committed-lost` | fault (after commit) | `files.upload` commits the file and event, then answers 500 |

## Compatibility

Routes, field names, paging fields and the error envelope follow the public Box Content API 2.0 reference for the implemented
subset. **Not verified against a real client**: no official Box SDK has been run against `firedrill serve`, and
`manifest.compatibility` is empty. There are no MCP aliases.

## Conformance

`firedrill tool test box` runs the `conformance` suite twice (14 drills: browse, write flow, uploader/viewer, editor by
login, quota, fresh install, unknown user, inactive user, no grants, three fault scenarios, at the object cap, over the object
cap). The target `test/conformance.mjs` uses Node built-ins only and calls the Box routes with the served bearer token. Together
the drills observe every operation, declared error, event and fault.

## Limitations

- **Subset only.** 23 operations. Shared links, metadata, web links, tasks, chunked upload sessions, webhooks, folder restore,
  permanent deletion, version promotion, locks, watermarks, classifications and legal holds have no route (framework 404);
  `shared_link` is always `null`.
- **Text content only.** Uploads must be UTF-8 and at most 256 KiB (`file_size_limit_exceeded`). No binary files, thumbnails,
  previews or representations. The `Content-MD5` digest header is ignored.
- **Downloads answer 200 with the body**, not Box's 302 redirect to a download URL.
- **Auth.** Any valid Firedrill token is accepted as a Box bearer token; there are no OAuth scopes or token endpoints. Missing
  or invalid tokens get the framework's 401 envelope, not Box's. `As-User` impersonation is not simulated and answers 400.
- **Framework envelopes remain** for malformed percent-encoding in path segments (404), non-JSON content types on JSON routes
  (415), non-UTF-8 upload bodies (400) and requests that cannot be mapped.
- **Search** indexes immediately. The query language covers terms (matched as substrings of the searched text), quoted phrases and
  `AND`/`OR`/`NOT` without parentheses. Ranking is deterministic and simple. `mdfilters` and enterprise scope answer 400.
  Zone-less timestamps are rejected.
- **Malformed query encoding.** Serve decodes query strings leniently, so a broken escape such as `%E0%A4%A` reaches the Tool as
  U+FFFD. It fails with Box's 400 `bad_request` envelope instead of silently matching nothing. This covers `query`, `file_extensions`, `ancestor_folder_ids`
  and `fields` on every route; enumerated parameters (`type`, `content_types`, `sort`, `direction`, `trash_content`) already
  fail schema validation. A correctly encoded U+FFFD (`%EF%BF%BD`) is rejected the same way. `%ZZ` stays literal, and non-ASCII searches such as
  `Größe` work normally.
- **Roles simplified.** Collaborations are on folders only; `viewer uploader`, `previewer uploader` and group collaborations are
  not supported. Pending invites cannot be accepted through the API and no email is sent.
- **Trash.** Items stay in trash indefinitely (`purged_at` is rendered but nothing is purged).
- **Event stream.** The latest 1,000 events are kept; downloads and previews are not logged; visibility follows current access.
  `stream_type` `admin_logs`/`sync` and long-polling are not supported.
- **Caps.** At most 2,000 objects (folders, files, versions, collaborations, comments) per world. At the cap every create
  fails with 400 `bad_request`; above it every operation except `users/me` fails before scanning, so no list is silently cut
  short. A scenario that adds rows must also update `meta/counters.objectCount`.
- `If-None-Match`/304 and `fields` sub-selections such as metadata templates are not implemented.

## Trademarks

Box is a trademark of its owner. The name is used only to identify the simulated API in a test environment; this package is
not affiliated with or endorsed by Box.
