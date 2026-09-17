# @firedrill-tools/tool-linear

A synthetic **Linear workspace** for [Firedrill](https://firedrill.run): one organization with several teams exposed through a subset of the Linear GraphQL API (`POST /graphql`) and through the tool names of the official Linear MCP server. Agents that read and write issues, comments, projects and labels can run against it instead of a real workspace: Firedrill owns the state, the virtual clock, faults and the evidence; nothing here contacts Linear and no notification or webhook is ever sent.

Backend only (no bundled UI). Browse and edit the state with the Firedrill inspector, the GraphQL route or the MCP tools.

## Install

```sh
firedrill tool add <path-or-name-of-this-package> --install
firedrill serve
```

A fresh project receives the starter data (103 rows: the fictional **Lumen Audio** workspace) and an actor with exactly the 24 operation grants. An existing world is not changed: add the grants you need (`packageId: "linear"`, one `operationId` per row of the table below) to the actor that will call the Tool, and add the starter rows (or your own) as scenario state.

## Identities

An API key or OAuth token acts as one Linear user. The calling actor is mapped to one `users` row:

| actor attribute | meaning |
|---|---|
| `userId` | the id of an **active** `users` row |
| `email` | resolved case-insensitively against `users[].email`; used only when `userId` is absent |
| *(neither)* | the seeded default user `0000000a-0000-4000-8000-000000000001` (Maya Lindqvist — workspace admin, member of every team); if that row was removed, the first active user by row id |

An explicit `userId`/`email` that matches no user or a suspended user (`active: false`) fails every operation with `AUTHENTICATION_ERROR` (HTTP 401, `{"errors":[{"message":"Authentication required, not authenticated","extensions":{"type":"authentication error",…}}]}`). Framework grants decide whether an operation may be called at all; the user's role and team memberships decide what it may see and change.

### Roles and team visibility

Roles come from the user's own flags: **admin** (`admin: true`), **guest** (`guest: true`), otherwise **member**. A team's `memberIds` array is its membership.

| team | admin / member | guest |
|---|---|---|
| public (`private: false`) | visible | visible only when listed in `memberIds` |
| private (`private: true`) | visible only when listed in `memberIds` (admins are not implicit members) | visible only when listed in `memberIds` |

An invisible team behaves as missing: it is absent from every list, and its issues, states, labels, cycles, projects (a project is visible when at least one of its teams is) and comments fail `NOT_FOUND` with Linear's wording (`Entity not found: Issue - Could not find referenced Issue.`). Users are workspace-wide and always listable. Anyone who can see a team can create, update and archive its issues and comment on them. `FORBIDDEN` (403) is raised for: editing another user's comment (author or admin only), creating a workspace label while `organization.restrictLabelManagementToAdmins` is `true` as a non-admin (starter: `true`), and creating or updating a project as a guest or as a user who is not a member of any of the project's teams.

## Starting data

Lumen Audio (`urlKey lumenaudio`, virtual time 2026-09-14T09:00:00Z, `gitBranchFormat {username}/{issueIdentifier}-{issueTitle}`):

- 6 users: Maya Lindqvist (admin, default identity), Daniel Okafor, Sofia Reyes, Kenji Watanabe (**guest**, MOB only), Lars Bergström (**suspended**), Amélie Dubois.
- 3 teams: `ENG` Engineering (public, cycles enabled, 14 issues, default state Backlog), `MOB` Mobile (public, cycles disabled, 6 issues, default state Todo), `SEC` Security (**private**, triage enabled, members Maya and Sofia, 4 issues, default state Triage).
- 18 workflow states (ENG 7 incl. In Review and Duplicate; MOB 5; SEC 6 incl. Triage), 8 labels (workspace Bug/Feature/Improvement; ENG backend/frontend/**legacy** (archived); MOB ios/android), 3 projects (Spatial Audio Engine — ENG, started; Companion App 2.0 — MOB + ENG, planned; SOC 2 Readiness — SEC only), 3 ENG cycles (completed, active, future).
- 24 issues (`ENG-1` … `ENG-14`, `MOB-1` … `MOB-6`, `SEC-1` … `SEC-4`) with sub-issues, an archived issue (`ENG-3`), a duplicate, an overdue due date, estimates and non-ASCII text; 12 comments (six on `ENG-2` including one threaded reply).

`starter.json` and `firedrill/baseline.scenario.json` (and the conformance `world.json`) carry the same rows; ids are UUID-formatted with a per-kind prefix, and rows created at run time use ids from the `meta/counters` row (`00000000-0000-4000-8000-<counter>`), so they never collide. Issue numbers come from each team's `issueCount` and are never reused.

## Operations

| operation | MCP alias | GraphQL field(s) |
|---|---|---|
| `organization.get` | `get_workspace` | `organization` |
| `viewer.get` | — | `viewer` |
| `users.list` | `list_users` | `users` |
| `users.get` | `get_user` | `user(id)` |
| `teams.list` | `list_teams` | `teams` |
| `teams.get` | `get_team` | `team(id)` |
| `workflow-states.list` | `list_issue_statuses` | `workflowStates` |
| `labels.list` | `list_issue_labels` | `issueLabels` |
| `labels.create` | `create_issue_label` | `issueLabelCreate` |
| `projects.list` | `list_projects` | `projects` |
| `projects.get` | `get_project` | `project(id)` |
| `projects.save` | `save_project` | `projectCreate`, `projectUpdate` |
| `cycles.list` | `list_cycles` | `cycles` |
| `issues.list` | `list_issues` | `issues`, `searchIssues` |
| `issues.get` | `get_issue` | `issue(id)` |
| `issues.create` | — | `issueCreate` |
| `issues.update` | — | `issueUpdate` |
| `issues.save` | `save_issue` | — (create or update with the official argument names) |
| `issues.archive` | — | `issueArchive` |
| `comments.list` | `list_comments` | `comments` |
| `comments.create` | — | `commentCreate` |
| `comments.update` | — | `commentUpdate` |
| `comments.save` | `save_comment` | — |
| `graphql.execute` | — | the `POST /graphql` route itself |

Every operation's canonical output is the Linear GraphQL object shape (camelCase `Issue`, `Team`, `Project`, … with one level of nested objects, connections `{ nodes, pageInfo }`, mutation payloads `{ success, lastSyncId, issue | comment | project | issueLabel | entity }`). Inputs accept two spellings, one per call: the **official Linear MCP server's argument names** (`team`, `state`, `assignee` = id, name, e-mail or `"me"`, `labels` by name or id, `project`, `cycle`, `parentId`, `query`, `limit`/`cursor`/`orderBy`) and the **GraphQL input names** (`{ input: { teamId, stateId, assigneeId, labelIds, projectId, cycleId, … } }`, `filter`, `first`/`after`). Arguments the official server accepts but this Tool does not model (`delegate`, `template`, `milestone`, `links`, `patch`, relations, releases, SLAs, `includeGroups: true`, `includeRelations`, …) are rejected with `INVALID_INPUT` naming the argument — never silently ignored. Friendly reference resolution is exact id → exact key/identifier → case-insensitive name/e-mail; an ambiguous name is `INVALID_INPUT`. Caller-supplied ids and identifiers are bounded before any state lookup: an issue identifier is a 1–5 character team key and an issue number of at most 9 digits (`ENG-12`), and any id longer than 512 characters matches nothing, so an oversized or malformed id (for example `ENG-` followed by 600 digits over GraphQL `issue`, `issueUpdate`, `issueArchive`, `commentCreate.issueId`, `issueCreate.parentId` or a `comments` issue filter) is Linear's `NOT_FOUND` (`Entity not found: Issue - Could not find referenced Issue.`), never a server error.

Lists return `{ nodes, pageInfo: { hasNextPage, hasPreviousPage, startCursor, endCursor } }` with `first`/`limit` 1–250 (default 50; `list_projects` ≤ 50), opaque cursors valid only for the same order and filter (`INVALID_INPUT` "Invalid cursor" otherwise; cursors are validated in full before any lookup on every list, `projects.get` and GraphQL connection: canonical unpadded base64url of at most 1,024 characters, strict UTF-8 with no overlong forms, surrogates or code points above U+10FFFF, and JSON of exactly the shape this Tool issues — anything else, including a forged or truncated token, is the same `Invalid cursor` error and never a server error; an empty cursor is `Invalid cursor` over GraphQL and a framework schema rejection on the canonical/MCP surface, whose schemas require a non-empty string), ordered descending by `orderBy` (`updatedAt` default, or `createdAt`), ties by id. Nested lists are pages too, never a silently cut list: `projects.get`/`get_project` returns one page of the project's visible unarchived issues as `issues { nodes, pageInfo }` (`issuesFirst` 1–250, default 50; `issuesAfter` = the previous `endCursor`; same order and cursor scope as GraphQL `project(id) { issues(first, after) }`, so a cursor from one continues on the other), and `issues.get`/`get_issue` returns one page of the issue's comments, oldest first, as `comments { nodes, pageInfo }` (`commentsFirst` 1–250, default 50; `commentsAfter` = the previous `endCursor`; same order and cursor scope as GraphQL `issue(id) { comments(first, after) }` without `orderBy`, so a cursor from one continues on the other; a `comments.list` cursor belongs to another scope and is `Invalid cursor` here). Date-time arguments and filter values must be ISO-8601 (`2026-09-01`, `2026-09-01T10:00:00Z`, an offset, or an ISO duration such as `-P2D`); a date-time without a zone is read as UTC, never host-local, and other text is `INVALID_INPUT`.

Error messages that quote what you sent (an id, an input or filter key, a GraphQL field, argument, fragment, type, directive or variable name, a syntax token) quote at most 200 characters of it, and every `message` and `userPresentableMessage` is at most 4,000 characters, ending in `…` when shortened; long input keys in an error `path` are shortened the same way. A very long value therefore gets the same Linear-shaped error as a short one, never a server error.

Errors: `AUTHENTICATION_ERROR` 401, `FORBIDDEN` 403, `NOT_FOUND` 400 (Linear reports missing entities as invalid input), `INVALID_INPUT` 400, `GRAPHQL_VALIDATION_FAILED` 400, `NOT_IMPLEMENTED` 400, `RATELIMITED` 429, `INTERNAL_ERROR` 500 (faults), `FAILED_PRECONDITION` 500 (a scan bound was exceeded, see Limits). Every error carries `details.errors` in Linear's shape, which the route renders verbatim: `{ "errors": [{ "message", "path"?, "extensions": { "type", "code", "userError", "userPresentableMessage" } }] }`. Framework outcomes that reach the route's response codec use the same envelope: an actor without a grant gets `403 {"errors":[{"message":"Not authorized","extensions":{"type":"forbidden","userError":false}}]}`, and a body that parses as JSON but does not match the operation schema (`{"query": 5}`, a missing `query`) gets `400 {"errors":[{"message":"arguments do not match linear.graphql.execute","extensions":{"type":"invalid input","code":"INVALID_INPUT","userError":true,"userPresentableMessage":…}}]}`. Outcomes Firedrill decides before the route codec runs keep Firedrill's own envelope `{"schemaVersion":1,"code":"framework.…","error":"…"}`, not Linear's: a body that is not valid JSON (or nests beyond about 3,050 levels) is `400 framework.HTTP_BODY_INVALID` "request body must be valid JSON", a non-JSON `Content-Type` is `415 framework.HTTP_CONTENT_TYPE_UNSUPPORTED`, a missing, wrong or `Bearer`-prefixed `Authorization` value is `401 framework.HTTP_UNAUTHORIZED` "invalid synthetic API credential", `GET /graphql` is `405 framework.HTTP_METHOD_NOT_ALLOWED` and any other path is the framework `404`. This is a framework boundary (the Tool never runs for these requests), not something the package can reshape.

### The `/graphql` route

`POST /graphql` with `Authorization: <world token>` (the raw token, exactly how a Linear personal API key is sent) and a JSON body `{ "query", "variables"?, "operationName"? }`. One document is executed: query or mutation, named or shorthand, with variable definitions and defaults, named and inline fragments, `@include`/`@skip`, aliases, `__typename`, block strings. Selection sets are projected from the same rows as the semantic operations to depth 8 and 2,000 selection nodes. The parser checks nesting before it descends: list and object literals (including variable defaults) nest at most 64 levels, list type references 32 and selection sets (fields and inline fragments) 32; fragments expand inside one another at most 32 levels and JSON variables nest at most 64 levels. Fields are merged the way GraphQL specifies: a named fragment spread again into the same selection set adds nothing, fields with the same response key merge their sub-selections (each written selection set counted once), and two fields with the same response key but a different field name, different arguments (compared structurally, including nested filter objects) or one with and one without a sub-selection fail `GRAPHQL_VALIDATION_FAILED` `Fields "a" conflict because …`. A fragment spread two or three times at each of 32 nesting levels therefore answers in milliseconds with the same data as one spread. Fragment expansion and field merging together may place, merge or compare at most 200,000 selections per request (`Query is too complex: fragment expansion and field merging exceed 200000 selections.`); documents within the other bounds stay far below it. A deeper document fails `GRAPHQL_VALIDATION_FAILED` (`Syntax Error: List and object values nest deeper than the maximum depth of 64.`), never a server error. The JSON body itself may nest at most 512 levels; a deeper body fails `INVALID_INPUT` (`Request body nests JSON objects and arrays deeper than the maximum depth of 512.`), and one nested beyond about 3,050 levels is refused by Firedrill's body parser with 400 `framework.HTTP_BODY_INVALID` before the Tool runs. The encoded `data` of one request is capped at 900,000 bytes (the framework refuses route responses over 1 MiB); a larger result fails `GRAPHQL_VALIDATION_FAILED` `Query result is too large: …` — request fewer nodes with `first` or fewer fields; nested connections accept `first`, `after`, `includeArchived` and `orderBy` where the list does.

Query fields: `viewer`, `organization`, `user`, `users`, `team`, `teams`, `workflowStates`, `issueLabels`, `project`, `projects`, `cycles`, `issue`, `issues`, `searchIssues`, `comments`. Mutation fields: `issueCreate`, `issueUpdate`, `issueArchive`, `commentCreate`, `commentUpdate`, `projectCreate`, `projectUpdate`, `issueLabelCreate`. Type catalog: `Organization`, `User`, `Team`, `WorkflowState`, `IssueLabel`, `Project`, `ProjectStatus`, `Cycle`, `Issue`, `Comment`, `PageInfo`, the `*Connection`/`*Edge` types and the five payload types with the fields listed in the manifest descriptions. A field, argument or type outside the catalog — including introspection (`__schema`, `__type`) and a nested `filter` argument — fails `NOT_IMPLEMENTED` with the field named; a syntax or validation problem fails `GRAPHQL_VALIDATION_FAILED` with GraphQL's usual wording (`Variable "$id" of required type "String!" was not provided.`, `Unknown fragment "X".`, `Must provide operation name if query contains multiple operations.`, …).

Every response carries `X-RateLimit-Requests-Limit`, `X-RateLimit-Requests-Remaining` and `X-Complexity`; `X-RateLimit-Requests-Reset` (virtual now + 1 h, epoch ms) is added whenever the Tool handler ran — every `200` and every Linear error envelope the Tool raises (`AUTHENTICATION_ERROR`, `NOT_FOUND`, `INVALID_INPUT`, `GRAPHQL_VALIDATION_FAILED`, `NOT_IMPLEMENTED`, `FORBIDDEN`, `FAILED_PRECONDITION`). It is absent where the handler never runs: the `rate-limited` fault's 429 and framework-level outcomes (missing grant `403`, schema-invalid input `400`). Documents with an unused fragment fail `GRAPHQL_VALIDATION_FAILED` (`Fragment "F" is never used.`).

### IssueFilter subset

Comparators `eq`, `neq`, `in`, `nin`, `lt`, `lte`, `gt`, `gte`, `contains`, `containsIgnoreCase`, `startsWith`, `null`. Fields `id`, `number`, `title`, `description`, `priority`, `estimate`, `dueDate`, `createdAt`, `updatedAt`, `startedAt`, `completedAt`, `canceledAt`, `archivedAt`; relations `team { id key name }`, `state { id name type }`, `assignee { id name displayName email isMe }` (also `{ null: true }`), `creator`, `project { id name slugId state }`, `cycle { id number isActive … }`, `parent`; collections `labels { some | every | <field> }` and `children { some | every }`; combinators `and`, `or`. Date-time comparators accept ISO date-times and ISO durations relative to virtual now (`-P1D`, `P2W`, `PT6H`). `ProjectFilter`, `UserFilter`, `TeamFilter`, `CycleFilter`, `WorkflowStateFilter`, `IssueLabelFilter` and `CommentFilter` are the subsets used by their list operations. Unknown fields or comparators fail `INVALID_INPUT` (`Unknown filter field "fixVersion" on IssueFilter`). Filters are bounded before any row is evaluated: at most 16 nested relation, collection and `and`/`or` levels, 2,000 nodes (object keys and list entries) and JSON depth 64, otherwise `INVALID_INPUT` (`Filter nesting depth exceeds the maximum of 16 nested relation, collection and and/or filters`, `Filter has more than 2000 nodes`). Each filter is validated and compiled once per call for each filter type it is used as (a GraphQL variable placed at two positions, such as `{ title: $c, createdAt: $c }` or `{ team: $f, assignee: $f }`, is validated for each position and fails `INVALID_INPUT` for the one it does not fit) and related rows are evaluated at most once per sub-filter, so a permitted `children: { some: { parent: … } }` chain answers in milliseconds. All filters and text searches of one request (every list and GraphQL root field together) share a budget of 2,000,000 evaluation steps: a clause checked on a row or a related row visited is one step. Substring search costs one more step per 16 characters (each row value searched, each needle prepared); lower-casing each value, once per request, one per 256. Equality, ordering and `in`/`nin` on strings cost one more step per 1,024 characters, so short values such as titles cost nothing extra. A `query`/`searchIssues` term is searched once per issue per request, however many aliases repeat it. Substring search (`contains`, `containsIgnoreCase`, `query`, `searchIssues`) is linear in the value length, so the budget bounds the time: the worst requests measured on a live 10,000-issue world answered or failed within about 320 ms (a concurrent call waits for them). A request that would need more fails `INVALID_INPUT` (`Filter is too complex: …`). Examples: hundreds of `or` entries under many GraphQL aliases, a relation filter over thousands of issues, or text comparisons over more than about 32 million characters, such as one `containsIgnoreCase` over more than about 460 issues with 65,536-character descriptions. Date values must be real calendar dates and non-empty durations: `2026-02-30`, `P`, `PT` and `P1.5Y` are `INVALID_INPUT`, including inside `in`/`nin` lists. Filter keys are looked up as own entries of the documented field and comparator tables only, so names inherited from JavaScript objects (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, and `__proto__` written as a GraphQL literal) are unknown fields or comparators with that same `INVALID_INPUT` error, at every nesting level and on every list operation; the GraphQL executor treats them the same way as field, argument, variable and type names (`NOT_IMPLEMENTED` / `GRAPHQL_VALIDATION_FAILED`).

## Events and faults

| id | kind | when |
|---|---|---|
| `issue.created` | event | an issue was created (`issues.create`, `issues.save`, `issueCreate`) |
| `issue.updated` | event | an issue changed (`updatedFields` lists the changed row fields; `["archivedAt"]` for an archive); not emitted when nothing changed |
| `comment.created` | event | a comment or reply was created |
| `rate-limited` | fault (`before`, all 24 operations) | `RATELIMITED` — HTTP 429 on `/graphql` with `Retry-After: 60` and `X-RateLimit-Requests-Remaining: 0` |
| `write-unavailable` | fault (`before`, the nine semantic writes) | `INTERNAL_ERROR` "Internal error occurred"; nothing is written, reads keep working. **Not** bound to `graphql.execute`: a GraphQL mutation still succeeds under this fault (see Limitations) |
| `issue-create-committed-lost` | fault (`after_commit`, `issues.create` and `issues.save`) | the issue **is created** (number consumed, `issue.created` emitted) but the caller sees `INTERNAL_ERROR`; a naive retry creates a second issue with the next identifier — the duplicate-creation trap an agent must detect by listing before retrying. A retry with the same Firedrill idempotency key replays the recorded error and creates nothing |

Select a fault in a scenario: `"faults": [{ "packageId": "linear", "faultId": "rate-limited" }]`. Project and label mutations emit no events.

## Limits

Scans are bounded (defaults: 1,000 users, teams, workflow states, labels, projects and cycles; 10,000 issues; 10,000 comments in total and 500 per issue; 1,000 parent hops). A namespace beyond its bound fails the operation with `FAILED_PRECONDITION` (HTTP 500, `state exceeds the supported bound of N rows for <namespace>`) — never a silently truncated result. Override the bounds on the `organization` row (`limits: { users, teams, "workflow-states", labels, projects, cycles, issues, comments, commentsPerIssue, childrenPerIssue }`); the conformance suite lowers them (`tight-limits` scenario) and fills an issue to the comment bound (`comment-cap` scenario) to prove the failure paths.

## Compatibility

- **Not verified against a real client.** Neither `@linear/sdk`, `linear-py`-style clients nor the official Linear MCP server itself have been run against this Tool; the manifest `compatibility` array is empty. Paths, field names, error envelopes and the MCP argument shapes follow Linear's public documentation and the official MCP server's published tool schemas for the implemented subset. `@linear/sdk`'s generated fragments select fields outside this catalog (`Issue.slaStartedAt`, `customerTicketCount`, …) and will hit `NOT_IMPLEMENTED` until the catalog is extended.
- Authentication is the raw world token in `Authorization` (API-key style) only. `Authorization: Bearer <token>` (the OAuth 2 shape) answers the framework 401 envelope, not Linear's: the framework's `header` auth kind compares the whole header value. OAuth flows, scopes and actor tokens are not modelled.
- **Framework consequence (one route, one operation):** the whole GraphQL request is one `linear.graphql.execute` invocation in Firedrill's evidence; the semantic operations it resolved to are not recorded separately, so per-operation assertions and faults bound to semantic operations (`write-unavailable`, `issue-create-committed-lost`) need the canonical `POST /v1/operations/linear/<operationId>` route or MCP.
- **No partial results:** a document with several top-level fields either fully succeeds (HTTP 200 `data`) or fails as a whole (`errors` only, every mutation rolled back). Linear returns `data` alongside `errors` for independent fields.
- Rate-limit headers are constant decorations (1500 / 1499, no request or complexity accounting); `X-Complexity` counts resolved fields, not Linear's point model. Under the `rate-limited` fault the handler does not run and the codec has no clock, so `X-RateLimit-Requests-Reset` is absent from the 429 (`Retry-After: 60` is present); it is likewise absent from framework-level denied/invalid responses.
- Two connection recipes are declared (`linear-graphql-client`: `LINEAR_API_URL`/`LINEAR_API_KEY`; `linear-mcp`: `LINEAR_MCP_URL`/`LINEAR_MCP_TOKEN`) for pointing an existing agent's environment seam at the Tool.
- MCP results: every tool result carries the JSON value in its text content block and in `structuredContent` (all outputs are objects). Arguments are validated against the operation's input schema by the MCP layer before the Tool runs, so a schema-invalid call returns an `isError` text result and never reaches the workspace.

## Limitations

- A bounded synthetic subset: 24 operations, one route, 15 query and 8 mutation fields, the type catalog above. Everything else — initiatives, milestones, project/initiative updates, documents, releases, templates, attachments and uploads, issue relations, history, reactions, notifications, favorites, customers and needs, SLAs, triage intelligence, agent delegation, roadmaps, views, webhooks, OAuth endpoints, the sync API, introspection, subscriptions, `issueDelete`/trash/unarchive, team changes, project archive/delete, label update/retire/delete, user and workspace management — fails with `NOT_IMPLEMENTED` (a GraphQL field), `INVALID_INPUT` (an MCP argument) or the framework 404 (any other path; `GET /graphql` is 405). No stub ever answers successfully.
- Permissions are the admin/member/guest + team-membership model above, not Linear's full permission matrix (no team-level roles, no project access settings). Guests can read and write in their own teams.
- Pagination cursors are Tool-specific; backward paging (`last`/`before`) is not supported (`before`/`last` over GraphQL answer 400 `NOT_IMPLEMENTED` `Unknown argument`). `searchIssues` is a case-insensitive substring match over title and description (no ranking, no `metadata`).
- Markdown bodies are stored verbatim; `bodyData`, mentions, embeds and inline (anchored) comments are not modelled; `quotedText` is always `null`, `attachments` always `[]`. Replies are one level deep.
- Archiving an issue does not archive its sub-issues (Linear does); `trash: true` is rejected; issues cannot be moved back into a `triage` state by an update. Project members, milestones and labels are not modelled (`save_project.summary` is accepted and discarded; `includeMembers`/`includeMilestones` must be `false`). Cycles are read-only; a team with cycles disabled returns an empty connection.
- `lastSyncId` is a monotonically increasing counter, not Linear's sync log; `Issue.url`, `Project.url` and `Comment.url` are display strings built from the organization `urlKey` — nothing is ever fetched.
- Rate limiting is a fault, not accounting.
- A JSON `__proto__` key (in canonical/MCP `filter` arguments or GraphQL `variables`) is removed by the framework before the Tool runs, so such a filter entry is ignored rather than rejected; the same key written as a GraphQL literal reaches the Tool and fails `INVALID_INPUT` `Unknown filter field "__proto__"`.

## Develop

```sh
firedrill validate
firedrill tool test linear        # runs the 19-drill conformance suite twice and checks coverage and determinism
firedrill serve --scenario baseline --actor admin --no-open
npm pack --ignore-scripts
```

The conformance target (`test/conformance.mjs`, Node built-ins only) exercises every operation, declared error, event and fault over `POST /graphql`, the canonical operation endpoint and the MCP aliases with seven actors and seven scenarios (including `project-pages`, a project with 265 issues, and `tight-limits`, which also proves an e-mail-identified actor's identity scan fails `FAILED_PRECONDITION` on `issues.archive`).

## Trademarks

Linear and related names belong to Linear Orbit, Inc. and are used only to identify the simulated service in a test environment. This package is an independent Firedrill Tool with no affiliation or endorsement.

## License

Apache-2.0 — see `LICENSE`.
