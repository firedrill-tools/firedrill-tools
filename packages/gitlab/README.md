# @firedrill-tools/tool-gitlab

A synthetic **GitLab** instance for [Firedrill](https://firedrill.run): a documented subset of the GitLab REST API v4
(`/api/v4`) plus the tool names of the GitLab MCP server, backed by Firedrill-owned state. Agents that manage
projects, branches, commits, issues, notes and merge requests can be tested against it without touching a real
GitLab instance.

Everything is simulated: the instance URL is `https://gitlab.example.test`, users use `@example.test` addresses, commit
ids are deterministic content digests (not git object ids), and no request ever leaves the Firedrill world.

It also ships a **browser app**: a recreation of GitLab's web interface that runs on the same operations and the same
state. See [Browser app](#browser-app).

## Install

```sh
firedrill tool add ./firedrill-tools-tool-gitlab-0.1.0.tgz --install   # or an npm / Git spec
firedrill serve
```

A new world receives the starter data below and grants for all 26 operations. For an existing world, add the grants
yourself (`packageId: "gitlab"`):

`users.get`, `projects.list`, `projects.get`, `labels.list`, `branches.list`, `branches.get`, `branches.create`,
`commits.list`, `commits.get`, `commits.create`, `repository.get-file`, `repository.list-tree`, `issues.list`,
`issues.get`, `issues.create`, `issues.update`, `issues.delete`, `issues.list-notes`, `notes.save`,
`merge-requests.list`, `merge-requests.get`, `merge-requests.save`, `merge-requests.list-commits`,
`merge-requests.list-diffs`, `merge-requests.list-notes`, `merge-requests.merge`.

Run the packaged conformance suite with `firedrill tool test gitlab`.

## Connecting a client

- **REST:** point the client's GitLab URL at `FIREDRILL_HTTP_URL` (routes live under `/api/v4`) and send
  `FIREDRILL_HTTP_TOKEN` in the `PRIVATE-TOKEN` header. Connection recipe: `gitlab-rest`.
- **MCP:** connect a Streamable HTTP MCP client to `FIREDRILL_MCP_URL` with `FIREDRILL_MCP_TOKEN` as a Bearer token.
  21 GitLab MCP server tool names are exposed as aliases next to the canonical `gitlab.<operation>` names.
  Connection recipe: `gitlab-mcp`.
- **Canonical operations:** `POST {FIREDRILL_HTTP_URL}/v1/operations/gitlab/<operation>` with `{"arguments": {...}}`.

## Identities

The caller is resolved from the Firedrill actor's attributes:

| attribute | meaning |
|---|---|
| `username` | GitLab username, matched case-insensitively. It must name an `active` user. |
| `userId` | Numeric user id (integer or numeric string). If both are set they must name the same user. |

**No attributes** (the actor `firedrill tool add` creates) acts as the primary seeded user: the active, non-bot user with
the lowest id, which is `mara.lindqvist` in the starter data. An unknown, blocked, empty or malformed identity fails
every operation with `401 Unauthorized` (`UNAUTHORIZED`), like a revoked token.

Permissions follow GitLab's project roles from direct memberships: 10 Guest, 15 Planner, 20 Reporter, 30 Developer,
40 Maintainer, 50 Owner (the owner of a user namespace has 50).

- **Visibility:** public projects are visible to everyone, internal projects to everyone except external users, private
  projects to members only. Invisible projects answer `404 Project Not Found`. Expired memberships count as none.
- **Archived projects** reject every write with `403 Forbidden`.
- **Confidential issues** are visible to their author, their assignees and Planner or higher; others get `404 Not found`
  and the issue is left out of lists and counts.
- **Issue edits:** Planner or higher may edit any issue. The author may edit title, description and state; their label,
  assignee, confidentiality, lock and due-date changes are silently ignored below Planner, as GitLab does. Anyone else
  gets `403`. Unknown label names are created (colour `#6699cc`) for Reporter or higher and dropped below that.
- **Deleting issues** requires exactly Planner or Owner.
- **Notes:** anyone who can see the project may comment; locked discussions need Reporter or higher; internal notes need
  Planner or higher to write and to read (authors always see their own).
- **Repository and merge requests:** creating branches, committing and opening merge requests need Developer or higher.
  Protected branches use their push level (40 on the seeded `main`) and merge level (30 on route-planner, 40 on
  billing-api). Merge request authors may edit their own; others need Developer.
- Assignees and reviewers must be project members; unknown user ids or usernames answer `404 User Not Found`, and
  existing non-members are dropped.
- Framework grants are checked first: an actor without a grant receives `403 {"message":"403 Forbidden"}`.

## Starting data

`starter.json` (82 rows, virtual time `2026-09-15T09:00:00Z`) describes the fictional Northwind Logistics instance:

- **Users:** `mara.lindqvist` (2, owner), `theo.brandt` (3), `ines.okafor` (4), `ravi.menon` (5), `june.park` (6,
  external), `deploy-bot` (7, bot), `ex.contractor` (8, blocked).
- **Projects:**
  - `northwind/route-planner` (101, public, merge-commit method): memberships mara 50, theo 40, ines 30, ravi 20,
    june 10 (expires 2026-12-31), deploy-bot 30.
  - `northwind/billing-api` (102, private, fast-forward method): mara 50, theo 30.
  - `mara.lindqvist/dotfiles` (103, internal, archived).
- **Repository:** 13 commits with real trees and diffs, 8 branches (including slashed names), protected `main` branches.
- **Issues:** 16, including a multi-page set of 12 open issues on route-planner, a confidential issue, a locked
  discussion, an incident, an empty description, a due date and closed issues.
- **Merge requests:** 6: merged (!1), mergeable (!2), conflicting (!3), draft (!4), closed with a deleted source
  branch (!5), and billing-api !1, which needs a rebase under the fast-forward method.
- **Labels and notes:** 8 labels (including the scoped name `priority::high` and `needs review`) and 10 notes (system
  notes and one internal note).

## Operations

`{id}` is a numeric project id (see Compatibility for full paths). Every route is under `/api/v4`.

| operation | MCP alias | HTTP route(s) |
|---|---|---|
| `users.get` | `get_user` | `GET /user`, `GET /users/{user_id}` |
| `projects.list` | `list_projects` | `GET /projects` |
| `projects.get` | `get_project` | `GET /projects/{id}` |
| `labels.list` | `search_labels` | `GET /projects/{id}/labels` |
| `branches.list` | `list_branches` | `GET /projects/{id}/repository/branches` |
| `branches.get` | — | `GET /projects/{id}/repository/branches/{branch}` |
| `branches.create` | `add_branch` | `POST /projects/{id}/repository/branches` |
| `commits.list` | `list_commits` | `GET /projects/{id}/repository/commits` |
| `commits.get` | `get_commit` | `GET /projects/{id}/repository/commits/{sha}`, `GET …/commits/{sha}/diff` |
| `commits.create` | `add_commit` | `POST /projects/{id}/repository/commits` |
| `repository.get-file` | `get_repository_file` | `GET /projects/{id}/repository/files/{file_path}`, `GET …/files/{file_path}/raw` |
| `repository.list-tree` | `list_repository_tree` | `GET /projects/{id}/repository/tree` |
| `issues.list` | — | `GET /projects/{id}/issues` |
| `issues.get` | `get_issue` | `GET /projects/{id}/issues/{issue_iid}` |
| `issues.create` | `create_issue` | `POST /projects/{id}/issues` |
| `issues.update` | — | `PUT /projects/{id}/issues/{issue_iid}` |
| `issues.delete` | — | `DELETE /projects/{id}/issues/{issue_iid}` |
| `issues.list-notes` | — | `GET /projects/{id}/issues/{issue_iid}/notes` |
| `notes.save` | `save_note` | `POST /projects/{id}/issues/{issue_iid}/notes`, `POST …/merge_requests/{merge_request_iid}/notes` |
| `merge-requests.list` | `list_merge_requests` | `GET /projects/{id}/merge_requests` |
| `merge-requests.get` | `get_merge_request` | `GET /projects/{id}/merge_requests/{merge_request_iid}` |
| `merge-requests.save` | `save_merge_request` | `POST /projects/{id}/merge_requests`, `PUT …/merge_requests/{merge_request_iid}` |
| `merge-requests.list-commits` | `get_merge_request_commits` | `GET …/merge_requests/{merge_request_iid}/commits` |
| `merge-requests.list-diffs` | `get_merge_request_diffs` | `GET …/merge_requests/{merge_request_iid}/diffs` |
| `merge-requests.list-notes` | `get_merge_request_notes` | `GET …/merge_requests/{merge_request_iid}/notes` |
| `merge-requests.merge` | `accept_merge_request` | `PUT …/merge_requests/{merge_request_iid}/merge` |

Behaviour highlights, all computed from state:

- **Lists** use GitLab offset pagination: `page`, `per_page` (default 20, clamped to 100), `x-page`, `x-per-page`,
  `x-next-page`, `x-prev-page`, `x-total`, `x-total-pages` and a relative `link` header. Commit lists omit the totals,
  like GitLab. Canonical and MCP calls may instead use `first` and an opaque `after` cursor; a forged or foreign cursor
  fails `400 after is invalid`.
- **Response size.** The Firedrill HTTP layer refuses responses over 1 MiB, so every page is sized by bytes as well as
  count: a page stops before its items would pass 900,000 JSON bytes (always holding at least one item), and
  `x-next-page`, `x-total-pages`, `link` and `after` cursors follow those real page boundaries, so nothing is skipped.
  A page can therefore hold fewer than `per_page` items. `merge-requests.get` with `include` answers
  `422 response exceeds the supported size of 900000 bytes` when the combined object would be larger; read the
  paginated commits, diffs and notes endpoints instead.
- **Diffs.** The commit `…/diff` route and `commits.get` with `include: ["diff"]` are paginated (`page`, `per_page`;
  the canonical result carries `diffs_page`). A file patch over 200 KiB (measured as JSON bytes) is returned like GitLab
  prunes it: `diff: ""` and `too_large: true`.
- **Filters are real:** issue labels (`None`, `Any`, AND lists), `search` with `in`, assignee, author, confidential,
  `iids[]`, date ranges; branch `search` with `^prefix` and `suffix$` anchors; commit `since`/`until`/`path`/`author`/
  `first_parent`. Unsupported filters (`milestone`, `scope`, `not[...]`, `regex`, `my_reaction_emoji`, `weight`, `all`)
  fail with 400 naming the parameter. Query values with malformed percent-encoding fail 400 instead of matching nothing: the framework decodes `%E0%A4%A` to
  U+FFFD, and `search` (projects, labels, branches, issues, merge requests), `labels`, merge request `scope`, user filters and
  paths holding U+FFFD answer `{"error": "<name> is invalid"}` (issue `scope` is unsupported, so any value is a 400); a correctly encoded `%EF%BF%BD` is rejected the same way,
  `%ZZ` stays literal text, and non-ASCII searches (`café`, `漢字`, emoji) work.
- **Commits:** `commits.create` applies `create`, `update`, `delete` and `move` actions (text or base64 content, with
  `last_commit_id` conflict checks) on a branch, or creates the branch from `start_branch`/`start_sha`. Files have
  blob ids, `content_sha256` and `last_commit_id`. Base64 content must decode to well-formed UTF-8 (overlong forms,
  surrogates and code points above U+10FFFF fail `400 Invalid base64 content`), and text content with an unpaired
  surrogate fails `400 content is invalid`, so stored files always round-trip byte for byte.
- **Merge requests:** `commit_shas`, `diff_refs`, `has_conflicts` and `detailed_merge_status` (`mergeable`,
  `draft_status`, `conflict`, `need_rebase`, `commits_status`, `not_open`) are recomputed whenever a write moves either
  branch. `merge-requests.merge` checks permissions, draft and state (405), conflicts and rebase (406) and `sha` (409),
  then writes a merge commit or fast-forwards, optionally squashes, removes the source branch when asked, and writes a
  `merged` system note.
- **Issues:** label and state changes write GitLab-style system notes (`added ~"bug" label`, `closed`, `reopened`);
  `open_issues_count` is maintained.

## Errors

| code | HTTP | body |
|---|---|---|
| `BAD_REQUEST` | 400 | `{"error":"title is missing"}`, `{"message":"Branch already exists"}`, `{"message":["…"]}` or `{"message":{"title":["is too long (maximum is 255 characters)"]}}` |
| `UNAUTHORIZED` | 401 | `{"message":"401 Unauthorized"}` |
| `FORBIDDEN` | 403 | `{"message":"403 Forbidden"}` or `{"message":"403 Forbidden - You are not allowed to push into this branch"}` |
| `NOT_FOUND` | 404 | `{"message":"404 Project Not Found"}` (also Issue, Merge Request, Branch, Commit, File, User, Tree, Reference, Group) |
| `METHOD_NOT_ALLOWED` | 405 | `{"message":"405 Method Not Allowed"}` (merge of a draft, closed or merged request) |
| `NOT_ACCEPTABLE` | 406 | `{"message":"Branch cannot be merged"}` (conflicts or rebase needed) |
| `CONFLICT` | 409 | `SHA does not match HEAD of source branch: …`, `The file has changed since you started editing it: …`, `["Another open merge request already exists for this source branch: !6"]` |
| `UNPROCESSABLE` | 422 | `{"message":"422 Unprocessable Entity - issues per project exceeds the supported bound of 10000"}` |
| `RATE_LIMITED` | 429 | `Retry later` (text) with `Retry-After`, `RateLimit-Name`, `RateLimit-Limit`, `RateLimit-Observed`, `RateLimit-Remaining` |
| `BAD_GATEWAY` | 502 | `{"message":"502 Bad Gateway"}` |
| `SERVICE_UNAVAILABLE` | 503 | `{"message":"503 Service Unavailable"}` |

## Events and faults

| id | kind | details |
|---|---|---|
| `issue.changed` | event | `{object_kind:"issue", action: open\|update\|close\|reopen\|delete, project_id, project_path, iid, user_username, state, changes, labels}`. `delete` is a Tool extension; GitLab sends no webhook for deletion. |
| `note.created` | event | `{object_kind:"note", project_id, project_path, note_id, noteable_type, noteable_iid, author_username, internal}`; system notes do not emit it |
| `merge-request.changed` | event | `{object_kind:"merge_request", action: open\|update\|close\|reopen\|merge, project_id, project_path, iid, source_branch, target_branch, user_username, detailed_merge_status, merge_commit_sha}` |
| `api-rate-limited` | fault (before) | every write operation answers 429 `Retry later`; nothing is written |
| `merge-unavailable` | fault (before) | `merge-requests.merge` and `commits.create` answer 503; nothing is written |
| `note-response-lost` | fault (after commit) | `notes.save` stores the note and emits `note.created`, but the caller gets 502. This tests whether an agent re-posts a comment that was saved. |

The package's conformance suite also includes the scenarios `tight-limits` and `user-bound`, which lower the bounds in
`meta/limits`.

## Bounds

The Tool never returns silently truncated results. These bounds apply: users 500, projects 500, members 1,000, labels
500, branches 1,000, commits 5,000, issues 10,000 and merge requests 10,000 per project; notes 10,000 per issue or merge
request; files 500 per tree; file size 256 KiB; actions 100 per commit; history walks 2,000 commits; merge request
commits 1,000. A read or write beyond a bound fails `422` with the bound named. A `meta/limits` row may lower any bound
for testing.

JSON request bodies may nest at most 512 levels; a deeper body is refused while the route decodes it and answers the
framework's 400 `HTTP_REQUEST_MAPPING_FAILED` before any argument validation runs.

## Compatibility

**Not verified against a real client.** `manifest.compatibility` is empty. Routes, field names, status codes and error
bodies follow the GitLab REST API v4 documentation and the GitLab MCP server tool reference, but `python-gitlab`,
`@gitbeaker/rest`, `glab` and the official MCP server have not been exercised against this package.

Known differences, several of which are imposed by the Firedrill HTTP layer:

- **No `/` inside path parameters (framework).** The Firedrill route matcher rejects a path segment whose decoded
  value contains `/`, with the framework 404. So these REST forms are unreachable:
  - URL-encoded project paths (`/projects/northwind%2Froute-planner`); use numeric project ids;
  - slashed branch names in `…/repository/branches/{branch}` (`feature%2Feta-cache`);
  - nested files in `…/repository/files/{file_path}` (`src%2Froutes%2Feta.ts`); only root-level files are readable
    over REST.

  Canonical and MCP calls accept full project paths, slashed branch names and nested file paths as plain strings, and
  REST query parameters (`ref_name`, `path`, `ref`) accept them too.
- **`PRIVATE-TOKEN` only (framework).** A route declares one auth kind, so `Authorization: Bearer` (OAuth tokens) is
  rejected over REST with the framework 401. The MCP endpoint uses Bearer as usual.
- **JSON write bodies (framework).** Write routes require `Content-Type: application/json`; form-encoded bodies get the
  framework 415 and an empty body the framework 400. Parameters in the query string are accepted next to a JSON body.
- **Framework envelopes.** Input that fails the operation schema (for example `archived=maybe`) answers
  `400 {"error":"<framework message>"}`, and a missing grant answers `403 {"message":"403 Forbidden"}`. Unknown routes
  and missing credentials answer the framework's own 404/401 bodies.
- **Rate-limit headers.** `RateLimit-Reset` and `RateLimit-ResetTime` are not sent because route codecs have no clock;
  the `RateLimit-*` headers appear only under the fault.
- **MCP results** are the full REST objects, not the MCP server's compact shapes. The MCP OAuth flow and the work-item
  (`get_work_item`, `save_work_item`, `list_work_items`), pipeline, search, wiki and vulnerability tools are not provided.
- **`merge-requests.get`** returns `include`d `commits`, `diffs` and `notes` (with `notes_page_info`) only through
  canonical and MCP calls.
- An optional `Idempotency-Key` request header becomes the operation idempotency key.

## Limitations

- **Bounded subset.** There are no groups APIs, project, member or label administration, milestones, epics or work
  items, approvals, discussions and threads, diff notes, suggestions, rebase, cherry-pick or revert, pipelines, jobs,
  runners, releases, tags, wikis, snippets, award emoji, to-dos, search API, GraphQL, webhooks or callbacks, branch
  deletion or protected-branch management, file-level write endpoints, keyset REST pagination, `ETag` or conditional
  requests. Those paths answer 404.
- **Git is simulated.**
  - Trees are per-commit snapshots of UTF-8 text files with mode `100644`: no binaries, symlinks, submodules or LFS.
  - Diffs are line diffs with three lines of context; a rename is detected only when a deleted and an added file have
    identical content.
  - Conflicts are detected per path since the merge base, not per line.
  - Merge commits combine path-level changes from both sides.
  - `detailed_merge_status` is computed synchronously (never `checking`). CI status, approvals, discussion resolution
    and auto-merge do not exist. Fast-forward projects report `need_rebase` instead of offering a rebase.
  - The deprecated `merge_status` is derived from the detailed status.
- **Permissions are simplified.** Only direct project memberships are modelled: no group inheritance, custom roles,
  token scopes or admin mode. Guests and non-members who can see a project can also read its repository and merge
  requests; GitLab restricts code access for Guests on private projects.
- **Accepted without effect.** `unidiff` on merge request diffs (diffs are already unified) and `allow_collaboration`
  (forks are not modelled) are accepted but change nothing.
- **Size caps imposed by the 1 MiB response limit.** So that one record always fits in a response, this Tool adds
  byte caps GitLab does not have, measured as JSON-encoded UTF-8: issue and merge request descriptions and note bodies
  262,144 bytes (`400 {"message":{"description":["is too long (maximum is 262144 bytes in this Tool)"]}}`, `note`
  for notes), commit, merge and squash commit messages 131,072 bytes (`400 {"error":"commit_message is too long …"}`),
  and file content 500,000 bytes once JSON-encoded (`422`, next to the 256 KiB file-size bound).
- **Search** is a case-insensitive substring match without relevance ordering. Scoped labels (`priority::high`) are
  plain names without mutual exclusion.
- **Data** is fictional. The package never contacts gitlab.com or any GitLab instance.

## Browser app

`firedrill serve` prints the app link; the inspector also offers **Tools → Open app**. The app is static HTML, CSS and
JavaScript under `firedrill/tools/gitlab/app/site/`.

- **Operations and identity.** Every screen calls the Tool's operations through `/_firedrill/client.js` as the
  selected Firedrill actor, so whatever the app changes is visible over REST and MCP, and the reverse. The app re-reads
  when `getContext().revision` moves, without overwriting a form that has unsaved text.
- **Time.** Relative times ("3 days ago") use world virtual time from `users.get` (`server_time`), in UTC.
- **Look and feel.** It follows GitLab's current light UI (Pajamas design system):
  - the super sidebar with counters, "Search or go to…", Pinned items and the Manage/Plan/Code/Build/Secure/
    Deploy/Operate/Monitor/Analyze/Settings sections;
  - breadcrumbs, GitLab Sans and GitLab Mono, and the GitLab SVG icon set;
  - the official tanuki logo.

  Sources and licences are in `firedrill/tools/gitlab/app/assets/ATTRIBUTION.md`.

| screen | what works | operations |
|---|---|---|
| Your work → Projects (`#/`) | Member / Personal / Inactive tabs with real counts, search (3+ characters), sort, pagination | `projects.list` |
| Group and user pages | Group projects; user profile with personal projects | `projects.list`, `users.get` |
| Project overview | Header, last commit, file tree with last commit per entry, rendered README, project information (commit and branch counts) | `projects.get`, `repository.list-tree`, `commits.list`, `repository.get-file`, `branches.list` |
| Repository tree and file view | Branch switcher, path breadcrumb, line-numbered code, rendered/source toggle for Markdown, copy contents, raw view | `repository.list-tree`, `repository.get-file` |
| Edit file / New file / Delete file | Single-file editor with preview of changes, "Commit changes" modal (current branch or new branch plus "Create a merge request for this change"), stale-file conflict alert | `commits.create` |
| Commits and commit page | Day-grouped history with author filter and pagination, commit page with parents and inline diffs | `commits.list`, `commits.get` |
| Branches | Overview / Active / Stale / All (stale means more than 90 days old in world time), name filter, sort, New branch form | `branches.list`, `branches.create` |
| Labels | Prioritized and other labels with open issue and merge request counts, filter, pagination | `labels.list` |
| Issues list | Open / Closed / All with counts; filtered search (Assignee, Author, Confidential, Label, free text); sort; pagination | `issues.list`, `labels.list` |
| New issue | Type, title, Markdown description with Write/Preview, confidentiality, assignee, labels, due date | `issues.create` |
| Issue page | Title and description editing, close/reopen, lock, confidentiality, delete (with confirmation), activity with system notes and sort/filter, comments and internal notes, "Comment & close issue", sidebar assignee/labels/due date | `issues.get`, `issues.list-notes`, `issues.update`, `issues.delete`, `notes.save` |
| Merge requests list | Open / Merged / Closed / All with counts; filters (Assignee, Author, Draft, Label, Reviewer, Source and Target branch); sort; pagination | `merge-requests.list` |
| New merge request | Branch comparison step, then title with "Mark as draft", description, assignee, reviewer, labels, merge options | `branches.list`, `merge-requests.save` |
| Merge request page | Overview / Commits / Pipelines / Changes tabs. Merge widget states: Ready to merge (delete source branch, squash, edit commit message), draft, conflicts, rebase needed, missing commits or source branch, merged, closed. Comments, mark as ready/draft, close/reopen, lock, sidebar assignees/reviewers/labels, file tree plus diffs | `merge-requests.get`, `merge-requests.list-commits`, `merge-requests.list-diffs`, `merge-requests.list-notes`, `merge-requests.save`, `merge-requests.merge`, `notes.save` |
| Your work → Issues / Merge requests | Cross-project lists filtered by assignee, author or reviewer (the sidebar counters open them) | `projects.list`, `issues.list`, `merge-requests.list` |
| Search or go to… | Command palette over projects, issues (`#`) and merge requests (`!`) in the current project | `projects.list`, `issues.list`, `merge-requests.list` |

**Page states.** Loading skeletons, empty states in GitLab's wording, a 404 page for unknown or invisible records, a
403 page when the actor lacks a grant, a 401 page when the actor's identity is not an active user, and inline alerts for
declared errors: rate limiting, 503, merge conflicts and SHA mismatch, protected branches, duplicate merge requests.

**Safety and input.**
- **Writes:** every write sends a fresh idempotency key; a second click is ignored while a write is in flight.
- **Confirmations:** closing a merge request, merging and deleting ask for confirmation.
- **Rendering:** record text is rendered with DOM text nodes only; Markdown is a safe subset built from elements.
- **Keyboard:** `/` or `s` opens search, `?` lists shortcuts, and `g` then `i`/`m`/`p`/`f`/`c`/`l` navigate.

**Visible but not simulated.** These controls open a "not simulated by this Tool" dialog:

- **Project sections:** every Manage/Plan/Code/Build/Secure/Deploy/Operate/Monitor/Analyze/Settings entry other than
  Labels, Issues, Merge requests, Repository, Branches and Commits.
- **Your work entries:** Groups, To-Do List, Milestones, Snippets, Activity, Explore.
- **Header controls:** GitLab Duo Chat, Help menu entries, Set status, Edit profile, Preferences, Sign out.
- **Project and file actions:** New project and New group; Star, Fork and notifications; Find file, Blame, Web IDE,
  Replace and Download; upload file, new directory and tags.
- **Branches:** Compare and delete branch.
- **Labels:** creating, editing, prioritising and subscribing.
- **Issues:** bulk edit, CSV import and export, linked items, milestones, time tracking, to-do items, moving issues,
  abuse reports.
- **Comments:** threads, emoji reactions, editing or deleting comments, attachments.
- **Merge requests:** approvals, pipelines, resolving conflicts in the browser, rebase, plain diff and patch downloads,
  recent searches.

Starred and Contributed project tabs show an explanatory empty state, because stars and contribution events are not
modelled.

**App limitations.**
- **People pickers.** There is no member-list operation, so the assignee and reviewer pickers (and the Assignee,
  Author and Reviewer filter tokens) offer the signed-in user plus the people who appear as author, assignee or
  reviewer on the project's issues and merge requests. Both lists are read page by page, most recently updated first,
  up to 100 pages each; when a list is longer than that or cannot be read, the picker says the list may be incomplete
  and a username can still be typed into the filter tokens. The backend still enforces membership.
- **Your work lists.** The cross-project issue and merge request lists name every project whose list could not be read
  in a warning above the results instead of leaving it out silently.
- **Merge request comments.** Internal notes are offered only on issues. Comment filtering on merge requests is done in
  the browser over the full note list.
- **Commit search.** Searching commit messages is disabled because `commits.list` has no message filter.

## Trademarks

GitLab, the GitLab logo and the tanuki mark are trademarks of GitLab Inc. The name and the unmodified official logo
files are used only to identify the simulated service in a test environment. This package is not affiliated with,
sponsored by or endorsed by GitLab Inc. The GitLab Sans and GitLab Mono fonts (SIL OFL 1.1) and the GitLab SVG icons
(MIT) are redistributed under their licences; see `firedrill/tools/gitlab/app/assets/ATTRIBUTION.md`.

## License

Apache-2.0. See `LICENSE`.
