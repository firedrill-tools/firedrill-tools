# @firedrill-tools/tool-jira

A synthetic **Jira Cloud site** for [Firedrill](https://firedrill.run): one tenant exposed through the Jira Cloud platform REST API v3 (`/rest/api/3/…`), the Jira Software agile REST API 1.0 (`/rest/agile/1.0/…`), the OAuth accessible-resources lookup and the Jira tool names of the Atlassian Remote MCP Server. Agents that create, search, edit, transition and comment on issues can run against it instead of a real site: Firedrill owns the state, the virtual clock, faults and the evidence; nothing here contacts Atlassian and no notification is ever sent.

Backend only (no bundled UI). Browse and edit the state with the Firedrill inspector, the REST routes or the MCP tools.

## Install

```sh
firedrill tool add <path-or-name-of-this-package> --install
firedrill serve
```

A fresh project receives the starter data (79 rows: the fictional **Stellarforge Robotics** site) and an actor with exactly the 27 operation grants. An existing world is not changed: add the grants you need (`packageId: "jira"`, one `operationId` per row of the table below) to the actor that will call the Tool, and add the starter rows (or your own) as scenario state.

## Identities

The calling actor is mapped to one Atlassian account:

| actor attribute | meaning |
|---|---|
| `accountId` | the account id of an **active** `users` row (`712020:…`) |
| `emailAddress` | resolved case-insensitively against `users[].emailAddress`; used only when `accountId` is absent |
| *(neither)* | the seeded default user `712020:0f3b4a6e-1c2d-4e5f-8a9b-000000000001` (Priya Natarajan — site admin, SFR lead); if that row was removed, the first active atlassian user by row id |

An explicit `accountId`/`emailAddress` that matches no user, a deactivated user or an `app` account fails every operation with `UNAUTHORIZED` (HTTP 401, Jira's `{"message":…,"status-code":401}` envelope plus `X-Seraph-LoginReason: AUTHENTICATED_FAILED`). Framework grants decide whether an operation may be called at all; the account and the project roles below decide what it may see and change.

### Project access

Projects carry an `accessLevel` (Jira's team-managed levels) and `project-members` rows grant roles; the project lead is an implicit Administrator.

| `accessLevel` | browse (issues, comments, boards, sprints) | create / edit / comment / transition / assign / move to sprint | delete an issue, edit or delete **others'** comments |
|---|---|---|---|
| `open` | everyone | everyone | `Administrator` |
| `limited` | everyone | `Member`, `Administrator` | `Administrator` |
| `private` | `Viewer`, `Member`, `Administrator` | `Member`, `Administrator` | `Administrator` |

A project the caller cannot browse behaves as missing (`NOT_FOUND`, Jira's wording: `Issue does not exist or you do not have permission to see it.`); a visible project the caller may not write to fails `PERMISSION_DENIED` (403). Assignable users are every active atlassian account in an `open` project, and Members/Administrators elsewhere; inactive users and app accounts are never assignable.

## Starting data

Stellarforge Robotics (`cloudId 3f9c2b1e-7d4a-4c6e-9b8f-2a1d5e6f7c80`, base URL `https://stellarforge.jira.example`, virtual time 2026-09-14T09:00:00Z):

- 6 users: Priya Natarajan (site admin, default identity), Marcus Oyelaran, Elena Sokolova, Tomasz Wiśniewski, Aiko Tanaka (**inactive**) and the "Automation for Jira" app account.
- 3 projects: `SFR` Stellarforge Rover (software, team-managed, **open**, simplified workflow, Epic/Story/Task/Bug/Subtask), `PLAT` Platform Services (software, company-managed, **limited**, classic workflow, Task/Bug/Subtask), `SEC` Security Response (business, **private**, classic workflow, Task only). Roles: Marcus is an SFR Member, PLAT Member and SEC Viewer; Priya is a PLAT Administrator and SEC Member; Tomasz is a PLAT Viewer only.
- 22 issues (`SFR-1` … `SFR-14`, `PLAT-1` … `PLAT-6`, `SEC-1`, `SEC-2`) with epics, subtasks, sprints, labels, due dates, resolutions and non-ASCII text; 13 comments (six on `SFR-12`); 2 boards (SFR scrum, PLAT kanban); 3 sprints (closed, active, future).
- Two workflows: `simplified` (To Do / In Progress / In Review / Done, any-to-any transitions `11`, `21`, `31`, `41`) and `classic` (Jira's default: Open, In Progress, Reopened, Resolved, Closed with transitions `11` Start Progress, `51` Stop Progress, `21` Resolve Issue, `31` Close Issue, `41` Reopen Issue). A transition into a Done-category status sets the resolution (default `Done`) and `resolutiondate`; a transition out of it clears both.

`starter.json` and `firedrill/baseline.scenario.json` carry the same rows; ids are stable and the id counters (`meta/counters`) start above the seeded ids.

## Operations

| operation | MCP alias | HTTP route |
|---|---|---|
| `resources.list` | `getAccessibleAtlassianResources` | `GET /oauth/token/accessible-resources` |
| `myself.get` | `atlassianUserInfo` | `GET /rest/api/3/myself` |
| `server-info.get` | — | `GET /rest/api/3/serverInfo` (`serverTime` is virtual time) |
| `projects.search` | `getVisibleJiraProjects` | `GET /rest/api/3/project/search` |
| `projects.get` | — (canonical `jira.projects.get` only, see Limitations) | — |
| `projects.statuses` | — | `GET /rest/api/3/project/{projectIdOrKey}/statuses` |
| `issue-types.create-meta` | `getJiraProjectIssueTypesMetadata` | `GET /rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes` |
| `priorities.list` | — | `GET /rest/api/3/priority` |
| `statuses.list` | — | `GET /rest/api/3/status` |
| `issues.create` | `createJiraIssue` | `POST /rest/api/3/issue` |
| `issues.get` | `getJiraIssue` | `GET /rest/api/3/issue/{issueIdOrKey}` |
| `issues.update` | `editJiraIssue` | `PUT /rest/api/3/issue/{issueIdOrKey}` (204) |
| `issues.delete` | — | `DELETE /rest/api/3/issue/{issueIdOrKey}` (204) |
| `issues.assign` | — | `PUT /rest/api/3/issue/{issueIdOrKey}/assignee` (204) |
| `issues.transitions` | `getTransitionsForJiraIssue` | `GET /rest/api/3/issue/{issueIdOrKey}/transitions` |
| `issues.transition` | `transitionJiraIssue` | `POST /rest/api/3/issue/{issueIdOrKey}/transitions` (204) |
| `issues.search` | `searchJiraIssuesUsingJql` | `GET` and `POST /rest/api/3/search/jql` |
| `issues.count` | — | `POST /rest/api/3/search/approximate-count` |
| `comments.list` | — | `GET /rest/api/3/issue/{issueIdOrKey}/comment` |
| `comments.add` | `addCommentToJiraIssue` | `POST /rest/api/3/issue/{issueIdOrKey}/comment` (201) |
| `comments.update` | — | `PUT /rest/api/3/issue/{issueIdOrKey}/comment/{commentId}` |
| `comments.delete` | — | `DELETE /rest/api/3/issue/{issueIdOrKey}/comment/{commentId}` (204) |
| `users.search` | `lookupJiraAccountId` | `GET /rest/api/3/user/search` |
| `users.assignable` | — | `GET /rest/api/3/user/assignable/search` |
| `boards.list` | — | `GET /rest/agile/1.0/board` |
| `sprints.list` | — | `GET /rest/agile/1.0/board/{boardId}/sprint` |
| `sprints.move-issues` | — | `POST /rest/agile/1.0/sprint/{sprintId}/issue` (204) |

Every operation's canonical input and output is the Jira REST v3 / agile 1.0 JSON shape (issue beans `{ id, key, self, fields }`, paged envelopes, ADF bodies). The MCP aliases expose the same shapes; where the official server flattens arguments (`createJiraIssue`: `projectKey`, `issueTypeName`, `summary`, `description`, `assignee_account_id`, `additional_fields`; `addCommentToJiraIssue`: `commentBody`; `getVisibleJiraProjects` and `lookupJiraAccountId`: `searchString`) the canonical schema accepts both spellings, one per call. Every alias accepts an optional `cloudId`, which must equal the site's cloud id (`NOT_FOUND` otherwise). The canonical `jira.<operation>` names are always exposed as well.

Errors: `UNAUTHORIZED` 401, `PERMISSION_DENIED` 403, `NOT_FOUND` 404, `VALIDATION_ERROR` 400 (Jira's `{ errorMessages, errors }` envelope with field-level messages such as `errors.summary`), `INVALID_JQL` 400, `RATE_LIMITED` 429, `SERVICE_UNAVAILABLE` 503, `FAILED_PRECONDITION` 500 (a state bound was exceeded, see Limits). Framework outcomes render in the same envelope: an actor without a grant gets `403 {"errorMessages":["You do not have permission to perform this action."],"errors":{}}`, schema-invalid input `400`.

### JQL subset

`clause ((AND|OR) clause)* [ORDER BY field [ASC|DESC], …]`, `NOT`, parentheses, quoted or bare values, `in (…)` lists.

| field | operators | values |
|---|---|---|
| `project` | `= != in not in is/is not` | key, id or name, `EMPTY` (every issue has a project, so `project is EMPTY` matches nothing) |
| `priority` | `= != in not in > >= < <= is/is not` | name or id (ordering by rank), `EMPTY` with `= != in not in is/is not` |
| `issuetype`/`type`, `status`, `statusCategory` | `= != in not in` | name or id (`statusCategory` also `new`/`indeterminate`/`done`); no `EMPTY` |
| `assignee`, `reporter`, `creator` | `= != in not in is/is not` | accountId, display name, e-mail, `currentUser()`, `EMPTY` |
| `labels` | `= != in not in is/is not` | label (case-sensitive), `EMPTY` |
| `sprint` | `= != in not in is/is not` | id, name, `openSprints()`, `futureSprints()`, `closedSprints()`, `EMPTY` |
| `parent` | `= != in not in is/is not` | issue key or id, `EMPTY` |
| `key`/`issuekey`/`id` | `= != in not in > >= < <=` (ordering within one project) | issue key or id; no `EMPTY` |
| `resolution` | `= != in not in is/is not` | name, id, `Unresolved`, `EMPTY` |
| `summary`, `description` | `~ !~ is/is not` | whole-word match, `prefix*`; case-insensitive; `is EMPTY` for a blank value |
| `comment`, `text` | `~ !~` | whole-word match, `prefix*`; case-insensitive |
| `created`, `updated`, `resolved`/`resolutiondate`, `duedate`/`due` | `= != > >= < <= is/is not` | `yyyy-MM-dd`, `yyyy-MM-dd HH:mm`, `yyyy/MM/dd`, periods `-7d`/`2w`/`3h`/`30m` and compound periods `4w 2d`/`-1w 3d 4h` (up to 8 terms of 1–6 digits, a leading sign applies to the whole period), `now()`, `startOfDay()`, `endOfDay()`, `startOfWeek()`, `endOfWeek()` (each with an optional `("-1d")` offset); `=` on a date-only value matches the whole day; `= EMPTY`/`!= EMPTY` equal `is`/`is not` |

`EMPTY` and `NULL` are the same keyword. On a field without an empty state (`key`, `status`, `issuetype`, `statusCategory`, `comment`, `text`, `~` values) any `EMPTY`, including one inside a list such as `key in (SFR-1, EMPTY)`, fails `INVALID_JQL` 400 "The field '…' does not support searching for EMPTY values."; an ordered comparison with `EMPTY` (`created > EMPTY`, `priority < null`) fails "The operator '…' does not support searching for EMPTY values on the field '…'."; `is`/`is not` on a field that lacks them fails "The operator 'is' is not supported by the '…' field.". Parentheses and `NOT` may nest at most 64 levels, and a query containing U+FFFD (malformed percent-encoding decoded by the HTTP layer) fails as a syntax error instead of searching for a mangled value. Field, function and sort names are matched only against the documented subset: a name such as `constructor`, `__proto__` or `toString` (`sprint in constructor()`, `constructor = SFR`, `ORDER BY __proto__`) fails `INVALID_JQL` 400 like any other unknown name, never a silent empty search.

`ORDER BY` accepts `created`, `updated`, `priority`, `key`, `status`, `summary`, `duedate`, `assignee`, `resolved` (empty values last); without `ORDER BY` results are `created DESC`. Paging uses `nextPageToken` (bound to the query and the caller; any other token is `400 The page token is invalid.`); `maxResults` is 1–100; `fields` defaults to none (`id`/`key` only), as Jira's enhanced search does. Anything outside the subset (`was`, `changed`, `during`, `membersOf()`, `linkedIssues()`, `fixVersion`, `component`, `cf[…]`, unknown functions or values) fails `INVALID_JQL` with a message naming the construct.

## Events and faults

| id | kind | when |
|---|---|---|
| `issue.created` | event | an issue was created |
| `issue.updated` | event | edit, assign, transition (with `transition: { id, name, fromStatusId, toStatusId }`) or move to sprint; `changedFields` lists what changed |
| `comment.created` | event | a comment was added (directly, or through `update.comment` on an edit/transition) |
| `rate-limited` | fault (`before`, all 27 operations) | HTTP 429 `Rate limit exceeded.` with `Retry-After: 2`, `X-RateLimit-Remaining: 0` |
| `write-unavailable` | fault (`before`, the nine writes) | HTTP 503 `Service temporarily unavailable. Please try again later.`; nothing is written, reads keep working |
| `transition-committed-lost` | fault (`after_commit`, `issues.transition`) | the transition **commits** (status, resolution, comments, events) but the caller sees 503; a naive retry of the same transition id then fails `400 Transition id '…' is not valid for this issue.` — the retry trap an agent must detect by re-reading the issue |

Select a fault in a scenario: `"faults": [{ "packageId": "jira", "faultId": "rate-limited" }]`.

## Limits

Scans are bounded by the `site` row's `limits` (defaults: 1,000 users, projects, boards, sprints and members per project; 10,000 issues; 500 comments per issue). A namespace beyond its bound fails the operation with `FAILED_PRECONDITION` (HTTP 500, `state exceeds the supported bound of N rows for <namespace>`) — never a silently truncated result. Raise the limits on the `site` row if your data is larger; the conformance suite lowers them (`tight-limits` scenario) to prove the failure path. Comments added through `update.comment` on an edit or transition count toward the same per-issue bound.

Text and response sizes:

- `description` and comment bodies (`comments.add`, `comments.update`, `update.comment` on edit and transition) are capped at Jira's 32,767-character limit for multi-line text fields: a plain string counts its characters, an Atlassian Document Format body counts its serialized JSON. Anything longer answers `400 {"errorMessages":[],"errors":{"description"|"comment":"The entered text is too long. It exceeds the allowed limit of 32,767 characters."}}` and writes nothing.
- Every response body stays under 900,000 UTF-8 bytes (the framework refuses HTTP responses over 1 MiB). `issues.search` pages hold as many issues as fit: a page can hold fewer than `maxResults`, and `nextPageToken`/`isLast` resume exactly at the first issue not returned. `comments.list`, `project/search`, boards, sprints and create-meta pages that end early report `maxResults` equal to the rows returned, so `startAt + maxResults` resumes exactly; user searches return a shorter array (continue with `startAt` plus its length).
- JSON request bodies may nest at most 512 levels: a deeper body is refused with `400` in the route codec (depth is measured iteratively) before argument validation. Ordinary bodies, including nested Atlassian Document Format, are unaffected.
- Caller text quoted back in errors is clipped to 200 characters with an ellipsis: an unknown key in `fields` or `update` (create, edit, transition) answers `400 {"errors":{"<key, clipped>":"Field '<key, clipped>' cannot be set. …"}}` however long the key is (an error-map key longer than 200 characters is clipped to 200 plus `…#` and an 8-hex-digit FNV-1a digest of the full key, so two long keys that share a prefix stay distinct entries), and the same applies to quoted account ids, priority and resolution references, labels, due dates, transition ids and comment ids.
- The inline `comment` field of an issue bean holds up to 100 comments and as many as fit: `maxResults` is the number inline, `total` the number that exist; page the rest with `GET …/issue/{key}/comment`.
- An issue whose bean cannot fit in one response even alone (for example thousands of long labels) answers `400` "The issue 'KEY' is too large to return (… bytes; the response limit is 900000 bytes). Request fewer fields …" on `GET …/issue/{key}` and when a search page reaches it; request fewer `fields`. Unpaged definition responses (priorities, statuses, project statuses, transitions, `jira.projects.get`) over the budget fail `FAILED_PRECONDITION`, like the scan bounds.

## Compatibility

- **Not verified against a real client.** No official SDK (`jira.js`, `atlassian-python-api`, `jira` for Python) and not the Atlassian Remote MCP Server itself have been run against this Tool; the manifest `compatibility` array is empty. Field names, paths, status codes and error envelopes follow Atlassian's public REST v3 / agile 1.0 documentation for the implemented subset; the MCP alias argument shapes follow the published tool descriptions.
- Authentication is `Authorization: Bearer <world token>` only (the OAuth 2.0 shape). Basic `email:api_token` is not accepted: the framework's `basic` auth kind needs a fixed username, so it cannot model "any e-mail plus token". The `api.atlassian.com/ex/jira/{cloudId}/…` OAuth path prefix is not served; point clients at the Firedrill HTTP origin.
- `X-AREQUESTID` carries the Firedrill correlation id. `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-NearLimit` and (under the fault) `Retry-After` are constant decorations; `X-RateLimit-Reset` is not emitted because wire codecs have no clock.
- Two connection recipes are declared (`jira-rest-client`: `JIRA_BASE_URL`/`JIRA_API_TOKEN`; `jira-mcp`: `ATLASSIAN_MCP_URL`/`ATLASSIAN_MCP_TOKEN`) for pointing an existing agent's environment seam at the Tool.
- MCP results: every tool result carries the JSON value in its text content block. `structuredContent` must be an object under the MCP specification, so for the array-shaped operations (`resources.list`, `priorities.list`, `statuses.list`, `projects.statuses`, `users.search`, `users.assignable` and their aliases) the framework wraps it as `{ "result": [...] }` — and wraps the error outcome of those operations the same way. Arguments are validated against the operation's input schema by the MCP layer before the Tool runs, so a schema-invalid call (for example `getJiraIssue` without `issueIdOrKey`) returns an `isError` text result and never reaches the site.

## Limitations

- A bounded synthetic subset: 27 operations and 27 routes over one site, three access levels, three roles and two fixed workflows. Every other Jira path answers the framework 404 (or 405 when only other methods exist on it). There are no attachments, worklogs, watchers, votes, issue links or remote links, changelogs, issue properties, bulk operations, archive, project/board/sprint management, components, versions, custom fields beyond the Sprint field (`customfield_10020`), screens, filters, dashboards, groups, permission schemes, issue-level security, webhooks, notifications, `expand=renderedFields|editmeta|changelog|versionedRepresentations`, or the v2 API. `getJiraIssueRemoteIssueLinks` is not aliased.
- **Framework limitation (route overlap):** `GET /rest/api/3/project/{projectIdOrKey}` and `GET /rest/api/3/issue/{issueIdOrKey}/comment/{commentId}` are not served because they overlap `GET /rest/api/3/project/search` and `GET /rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes` under the framework's HTTP route-overlap rule. Use `project/search?keys=KEY`, the canonical `jira.projects.get` operation (MCP or the Firedrill operation endpoint), and `comments.list`.
- `PUT /rest/api/3/issue/{key}` always answers 204; `returnIssue=true` is rejected (400). `notifyUsers`, `updateHistory`, `properties`, `fieldsByKeys`, `reconcileIssues`, `rankBeforeIssue`/`rankAfterIssue`/`rankCustomFieldId` are accepted and ignored. Comment `visibility` is rejected (400).
- ADF: descriptions and comment bodies are stored as received after a structural check (`doc`, `version: 1`, `content[]`); a plain string is accepted and wrapped in one paragraph (real Jira v3 requires ADF); `~` search and `commentBody` use text nodes only — no rendering, mentions, media or Markdown conversion (the official MCP server converts Markdown; this Tool stores `commentBody` verbatim).
- Timestamps are rendered in UTC (`+0000`), not in the caller's time zone; date functions use UTC days with Monday-start weeks. `approximate-count` is exact. Search results are live, not a snapshot.
- Workflows have no conditions, validators, screens or post-functions beyond the resolution rule; `expand=transitions.fields` is unavailable. Status names repeat across workflows exactly as in Jira (`In Progress` is `10001` and `3`), so resolve statuses by id when it matters.
- Agile: one project per board, no board filter, backlog, ranking, estimation, epics endpoints or sprint lifecycle; moving issues checks the board's project, rejects subtasks and closed sprints.
- Issue deletion emits no event. Deleting an epic keeps its child issues and clears their parent link; subtasks require `deleteSubtasks=true`.
- Rate limiting is a fault, not accounting; permissions are the three-role model, not Jira's permission schemes or global permissions (`siteAdmin` is informational).

## Develop

```sh
firedrill validate
firedrill tool test jira        # runs the 16-drill conformance suite twice and checks coverage and determinism
firedrill serve --scenario baseline --no-open
npm pack --ignore-scripts
```

The conformance target (`test/conformance.mjs`, Node built-ins only) exercises every operation, declared error, event and fault over the provider-shaped routes and the MCP aliases with seven actors and five scenarios.

## Trademarks

Jira, Atlassian and related names belong to Atlassian Pty Ltd and are used only to identify the simulated service in a test environment. This package is an independent Firedrill Tool with no affiliation or endorsement.

## License

Apache-2.0 — see `LICENSE`.
