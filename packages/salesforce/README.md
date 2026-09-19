# @firedrill-tools/salesforce

A synthetic **Salesforce org** for [Firedrill](https://firedrill.run): one org exposed through the subset of the Salesforce Platform REST API that agents actually use — sObject rows (`/services/data/vXX.X/sobjects/…`), upsert by external id, SOQL `query`/`queryAll` with query locators, parameterized search, sObject Collections, the Composite resource, `limits`, describe, the OpenID Connect `userinfo` endpoint — plus the two data-facing tool names of Salesforce's DX MCP server (`run_soql_query`, `get_username`). Agents that read and write Accounts, Contacts, Leads, Opportunities and Tasks can run against it instead of a real org: Firedrill owns the state, the virtual clock, faults and the evidence; nothing here contacts Salesforce and no e-mail, Chatter post, workflow or trigger ever runs.

Backend only (no bundled UI). Browse and edit the state with the Firedrill inspector, the REST routes or the MCP tools.

## Install

```sh
firedrill tool add @firedrill-tools/salesforce --install
firedrill serve
```

A fresh project receives the starter data (64 rows: the fictional **Brightwater Instruments** org) and an actor with exactly the 20 operation grants. An existing world is not changed: add the grants you need (`packageId: "salesforce"`, one `operationId` per row of the table below) to the actor that will call the Tool, and add the starter rows (or your own) as scenario state.

## Identities

An access token acts as one Salesforce **User**; the org then applies that user's **profile** (object permissions) and its **org-wide defaults plus ownership** (sharing). The calling actor is mapped to a user by one attribute:

| actor attribute | meaning |
|---|---|
| `username` | resolved case-insensitively against `users[].Username`; must belong to an **active** user |
| *(none)* | the org's default identity (`org.defaultUserId`, seeded as `005Fd0000000001IAA` — Maren Solberg, System Administrator); if that row is gone, the first active user by row id. `firedrill tool add` creates such an actor, so a first run sees the seeded data |

A `username` that matches no user, or a deactivated user, fails every operation with `INVALID_SESSION_ID` (HTTP 401, `[{"message":"Session expired or invalid","errorCode":"INVALID_SESSION_ID"}]`). Framework grants decide whether an operation may be called at all (a missing grant is the framework's `denied`, rendered as 403 `API_DISABLED_FOR_ORG`); the profile and the sharing rules below decide what the call may see and change.

### Object permissions and sharing

Each `profiles` row carries `objectPermissions[sobjectType] = { create, read, edit, delete, viewAll, modifyAll }`. `User` and `Profile` are readable by every profile and writable by none (`INVALID_TYPE_FOR_OPERATION`). A type the profile cannot read is invisible: absent from the global describe, `NOT_FOUND` on basic info / describe, `INVALID_TYPE` everywhere else (Salesforce's exact "sObject type 'X' is not supported…" wording; 404 on sObject-row routes, 400 on query/search/collections). Missing `create`/`edit`/`delete` rights fail `INSUFFICIENT_ACCESS_OR_READONLY` (403).

Record visibility follows `org.orgWideDefaults[sobjectType]` plus ownership:

| org-wide default (seeded) | who can read a record | who can edit / delete it |
|---|---|---|
| `Private` (Opportunity, Task) | owner; anyone with `viewAll`/`modifyAll` | owner; `modifyAll` |
| `ReadOnly` — Public Read Only (Account) | every user with object `read` | owner; `modifyAll` |
| `ReadWrite` — Public Read/Write (Lead) | every user with object `read` | every user with object `edit`/`delete` |
| `ControlledByParent` (Contact) | as the parent Account; a contact without an Account behaves as `Private` | as the parent Account; without an Account: its owner |

A record the caller cannot read behaves as missing (`NOT_FOUND`, absent from queries, search, `recentItems` and collections retrieve); a readable but not editable record fails `INSUFFICIENT_ACCESS_OR_READONLY`. No role hierarchy, sharing rules, manual shares, permission sets, field-level security or territories.

## Starting data

Brightwater Instruments (`00DFd0000000001MAA`, a fictional laboratory-equipment maker on `brightwater.example.com`; instance URL `https://brightwater.example.my.salesforce.test`, currency EUR, virtual time 2026-09-14T09:00:00Z):

- 4 profiles: System Administrator, Standard User, Read Only, Sales Development Rep (no Opportunity access, read-only Account, no Contact delete).
- 6 users: Maren Solberg (admin, default identity), Diego Álvarez and Aiko Tanaka (Standard Users), Ben Okafor (SDR), Lena Fischer (Read Only), Jonas Weber (Standard User, **inactive** — still owns records).
- 10 accounts (one deleted, one parent/subsidiary pair, two sharing the same name, three with `External_Id__c`), 14 contacts (one without an account, one deleted, non-ASCII names, a mixed-case e-mail), 8 leads (one converted), 9 opportunities (stages spread, one open opportunity without an Amount), 8 tasks (one overdue, one completed, Who/What links to contacts, leads, accounts and opportunities).
- Custom fields: `Account.External_Id__c` (external id, unique), `Account.Customer_Tier__c` (picklist), `Contact.External_Id__c` (external id, unique), `Opportunity.ARR__c` (currency).

`starter.json` and `firedrill/baseline.scenario.json` carry the same rows; ids are stable 18-character case-safe Salesforce ids (`001Fd0000000101IAA`, …) and the id counter (`meta/counters`) starts above the seeded record numbers, so a fresh org mints `001Fd0000001001IAA` first.

## Operations

All routes accept `Authorization: Bearer <token>` or the legacy `Authorization: OAuth <token>` (the world token). Every `/services/data/{version}/…` route needs `v46.0` … `v66.0` (otherwise `NOT_FOUND`); canonical calls default to `v62.0`. Object-bodied responses and handler-raised errors carry `Sforce-Limit-Info: api-usage=U/M` from the `org` row.

| operation | MCP alias | HTTP route |
|---|---|---|
| `versions.list` | — | `GET /services/data` |
| `userinfo.get` | `get_username` | `GET /services/oauth2/userinfo` |
| `limits.get` | — | `GET /services/data/{version}/limits` |
| `sobjects.list` | — | `GET /services/data/{version}/sobjects` |
| `sobjects.basic-info` | — | `GET /services/data/{version}/sobjects/{sobjectType}` |
| `sobjects.describe` | — (canonical `salesforce.sobjects.describe`, or a composite subrequest `GET …/sobjects/{sobjectType}/describe`; see Limitations) | — |
| `records.create` | — | `POST /services/data/{version}/sobjects/{sobjectType}` (201 + `Location`) |
| `records.retrieve` | — | `GET …/sobjects/{sobjectType}/{id}` and `GET …/sobjects/{sobjectType}/{externalIdField}/{value}` (`?fields=` projection incl. `Owner.Name`) |
| `records.update` | — | `PATCH …/sobjects/{sobjectType}/{id}` (204) |
| `records.delete` | — | `DELETE …/sobjects/{sobjectType}/{id}` (204, cascades) |
| `records.upsert` | — | `PATCH …/sobjects/{sobjectType}/{externalIdField}/{value}` (200 with `created`) |
| `query.execute` | `run_soql_query` | `GET …/query?q=` and `GET …/queryAll?q=` (`Sforce-Query-Options: batchSize=N`) |
| `query.more` | — | `GET …/query/{locator}` and `GET …/queryAll/{locator}` |
| `search.parameterized` | — | `POST …/parameterizedSearch` |
| `collections.create` | — | `POST …/composite/sobjects` |
| `collections.retrieve` | — | `POST …/composite/sobjects/{sobjectType}` and `GET …?ids=&fields=` |
| `collections.update` | — | `PATCH …/composite/sobjects` |
| `collections.delete` | — | `DELETE …/composite/sobjects?ids=` |
| `collections.upsert` | — | `PATCH …/composite/sobjects/{sobjectType}/{externalIdField}` |
| `composite.execute` | — | `POST …/composite` |

Canonical names (`salesforce.<operation>`) are always exposed over MCP, direct and `POST /v1/operations/salesforce/<operation>`; canonical inputs fold the path/query parameters into one object (`sobjectType`, `id`, `externalIdField`, `value`, `record`, `q`, `fields`, `ids`, `version`, …) and canonical outputs are the Salesforce JSON shapes plus a `_limitInfo` string that the REST codec lifts into the header.

### Records

Seven sObjects: `Account`, `Contact`, `Lead`, `Opportunity`, `Task` (writable) and `User`, `Profile` (read only), with a documented subset of the standard fields (see the describe output) plus the custom fields from the `custom-fields` rows. Writes validate like Salesforce: unknown field → `INVALID_FIELD`, read-only/system field → `INVALID_FIELD_FOR_INSERT_UPDATE`, missing required field (`Name`, `LastName`, `Company`, `StageName`, `CloseDate`) → `REQUIRED_FIELD_MISSING`, wrong JSON type → `JSON_PARSER_ERROR`, over-length text or bad e-mail → `INVALID_FIELD`, restricted picklist → `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`, malformed id → `MALFORMED_ID`, id of the wrong sObject → `FIELD_INTEGRITY_EXCEPTION`, missing/deleted/inactive target → `INVALID_CROSS_REFERENCE_KEY`, duplicate unique value → `DUPLICATE_VALUE`, converted lead → `CANNOT_UPDATE_CONVERTED_LEAD`, the seeded validation rule *Closed Won opportunities must have an Amount* → `FIELD_CUSTOM_VALIDATION_EXCEPTION`. `OwnerId` defaults to the caller; `Lead.Status`, `Task.Status`/`Priority` default; `Contact`/`Lead.Name`, `Opportunity.IsClosed`/`IsWon`/`ForecastCategory`/default `Probability` and `Task.IsClosed` derive on every write. Deletes are soft (recycle bin, visible through `queryAll`) and cascade as Salesforce does: Account → Contacts, Opportunities, Tasks; Contact/Lead → Tasks (`WhoId`); Opportunity → Tasks (`WhatId`). Ids may be given in 15- or 18-character form; 18 characters are always returned. A 15-character id is case-sensitive; an 18-character id is case-insensitive as in Salesforce: its suffix (any case) re-cases the first 15 characters, so `001fd0000000101iaa` resolves to `001Fd0000000101IAA`. A suffix that is not a valid checksum for the body (a case bit set on a digit position, or a character outside `A–Z0–5`, e.g. `…101IAB`) → `MALFORMED_ID`; a valid suffix that re-cases the body to an id that does not exist (e.g. `001Fd0000000101AAA` → `001fd0000000101`) → `NOT_FOUND`.

### SOQL subset

`SELECT <fields> FROM <sObject> [WHERE …] [ORDER BY f [ASC|DESC] [NULLS FIRST|LAST], …] [LIMIT n] [OFFSET n]` and `SELECT COUNT() FROM …`. Fields: API names, relationship fields **one level** deep (`Account.Name`, `Owner.Username`, `CreatedBy.Name`, `Who.Name`, `Who.Type`, `What.Name`, `Profile.Name`), `FIELDS(ALL|STANDARD|CUSTOM)` (`ALL`/`CUSTOM` need `LIMIT ≤ 200`), child subqueries for `Account.Contacts`, `Account.Opportunities`, `Account.Tasks`, `Contact.Tasks`, `Lead.Tasks`, `Opportunity.Tasks`. WHERE: `=`, `!=`, `<>`, `<`, `<=`, `>`, `>=`, `LIKE` (`%` any sequence, `_` one character, `\%` and `\_` literal; case-insensitive; a `%`-free segment containing `_` at most 256 characters), `IN`, `NOT IN`, `AND`, `OR`, `NOT`, parentheses (nesting of parentheses and `NOT` up to 100 levels); strings with Salesforce's escapes (`\'`, `\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\f`, `\%`, `\_`; any other backslash sequence → `MALFORMED_QUERY`), numbers, `TRUE`/`FALSE`, `NULL`, dates, datetimes, and the date literals `TODAY`, `YESTERDAY`, `TOMORROW`, `THIS_WEEK`, `LAST_WEEK`, `NEXT_WEEK`, `THIS_MONTH`, `LAST_MONTH`, `NEXT_MONTH`, `THIS_YEAR`, `LAST_YEAR`, `LAST_90_DAYS`, `NEXT_90_DAYS`, `LAST_N_DAYS:n`, `NEXT_N_DAYS:n`, `LAST_N_MONTHS:n`, `NEXT_N_MONTHS:n`. Long text areas (`Description` on every sObject: textarea longer than 255 characters) cannot be filtered or sorted, as in Salesforce: `WHERE`/`ORDER BY` on them fails `INVALID_FIELD` (`field 'Description' can not be filtered in query call` / `… can not be sorted in a query call`), and describe reports them `filterable: false`, `sortable: false`; search still scans them. A string literal holds at most 4,000 characters (longer → `MALFORMED_QUERY`), as in Salesforce. Text comparisons are case-insensitive; the default sort is `ASC NULLS FIRST`; `ORDER BY` takes at most 32 fields, a statement at most 100,000 characters, `LIMIT`, `OFFSET` and `LAST_N_DAYS:n`-style counts are 32-bit integers (`LIMIT 99999999999999999999` or `LIMIT 2147483648` → `MALFORMED_QUERY` `numeric value out of range: …`; `OFFSET` above 2,000 → `MALFORMED_QUERY` `NUMBER_OUTSIDE_VALID_RANGE`), and a field selected twice fails `MALFORMED_QUERY` (`duplicate field selected: …`), as in Salesforce; unsorted results come in creation order. Everything else (`GROUP BY`, `HAVING`, aggregates other than bare `COUNT()`, semi-joins, `TYPEOF`, `WITH`, `USING SCOPE`, `FOR UPDATE`, `ALL ROWS`, `INCLUDES`, functions, deeper paths, fiscal/week literals) fails `MALFORMED_QUERY` with an explicit "unsupported" message; unknown fields fail `INVALID_FIELD`, unknown sObjects `INVALID_TYPE`.

Paging: `Sforce-Query-Options: batchSize=N` (default 2000). When rows remain, `done: false` and `nextRecordsUrl: /services/data/{version}/query/{locator}` follow; the locator is self-contained (`01g` + base64url of `{ q, includeDeleted, offset, batchSize, userId }` + `-offset`), so `query.more` re-runs the query deterministically. A locator that does not decode, belongs to another user or points past the end fails `INVALID_QUERY_LOCATOR`.

Response size: the framework refuses HTTP responses over 1 MiB, so every body whose size depends on stored rows is measured in encoded UTF-8 bytes of the JSON actually sent, row by row, before the row is admitted (a Tool budget of 900,000 bytes). A query page stops before it would pass the budget — like Salesforce, which returns smaller batches for wide rows — with `done: false` and a `nextRecordsUrl` that resumes at the first row not returned, so every row appears exactly once however wide or non-ASCII the rows are. A single row that alone would pass the budget (for example an Account whose child subquery returns many 32,000-character `Description` values) fails 400 `LIMIT_EXCEEDED` (`The response would exceed the 900,000-byte response budget of this Tool; …`) instead of a truncated row. Parameterized search and sObject Collections retrieve have no paging, so results past the budget fail the same `LIMIT_EXCEEDED`.

Error text: caller-supplied names and values quoted in error messages (unknown columns, sObject types, relationships, tokens, picklist values, ids, references) are clipped to 255 characters ending in `…`, every `fields` entry is clipped the same way (item errors declare `maxLength` 255), and a message never exceeds 3,000 characters. The error code and HTTP status are unchanged, so a 6,000-character unknown field answers Salesforce's 400 `INVALID_FIELD` rather than a framework 500.

### Parameterized search

`POST …/parameterizedSearch` with `{ q, sobjects?: [{ name, fields?, where?, orderBy?, limit? }], in?: ALL|NAME|EMAIL|PHONE|SIDEBAR, fields?, overallLimit?, defaultLimit? }`. Terms (quoted phrases stay together) must each match as a case-insensitive prefix of a token (split on whitespace and `@ . / _ - , ; : ( ) " '`) of the scoped fields; `*` matches any run of non-whitespace characters and `?` one non-whitespace character. An sObject may appear only once in `sobjects` (a repeat → `MALFORMED_QUERY`, `MALFORMED_SEARCH: duplicate sObject type …`). Results respect sharing and are grouped by sObject in the order given; `Id` and `Name` (`Subject` for Task) are returned when `fields` is absent. A search string (`q` after trimming) shorter than two or longer than 200 characters, a bad `where`/`orderBy` → `MALFORMED_QUERY`.

### Collections and composite

sObject Collections take up to 200 records (`attributes.type` per record, mixed types allowed) or 2,000 ids for retrieve, and answer 200 with a per-item array: `{ id, success, errors: [{ statusCode, message, fields }] }` (`created` on upsert); with `allOrNone: true` every write is rolled back and the would-be successes become `ALL_OR_NONE_OPERATION_ROLLED_BACK`. Composite takes up to 25 subrequests (at most 5 queries) over `sobjects/{type}` (POST create, GET basic info), `sobjects/{type}/{id}` (GET/PATCH/DELETE), `sobjects/{type}/{extIdField}/{value}` (GET/PATCH), `sobjects/{type}/describe`, `query?q=`, `queryAll?q=`, `limits`, with `@{referenceId.id}`, `@{ref.Field}`, `@{ref.records[N].Field}` and `@{ref.totalSize}` substitution in urls and string body values; results come back as `{ compositeResponse: [{ body, httpHeaders, httpStatusCode, referenceId }] }`; under `allOrNone` a failure rolls everything back and marks the siblings `PROCESSING_HALTED`; an unsupported subrequest url is a per-item 404, an unresolvable reference a per-item 400 `INVALID_INPUT`. The whole composite response shares the 900,000-byte budget: a `query`/`queryAll` subrequest returns a smaller page (`done: false`, working `nextRecordsUrl`) sized to the bytes left, and a GET subrequest (or an error entry) that no longer fits becomes a per-item 400 `[{"errorCode":"LIMIT_EXCEEDED","message":"The response would exceed the 900,000-byte response budget of this Tool; …"}]` (counts as a failure under `allOrNone`); write results are small and always admitted. Five `SELECT Id FROM Account` subrequests over 2,009 accounts answer 200 with three full 2,000-row pages, a 1,189-row page and one `LIMIT_EXCEEDED` entry (900,173 bytes). Item-level failures inside these 200 envelopes are not Firedrill `tool_error` outcomes — assert on state or events instead.

## Events and faults

| id | kind | when |
|---|---|---|
| `record.created` | event | a record was inserted (`records.create`, upsert-create, collections, composite) — `{ sobjectType, id, ownerId, createdById }` |
| `record.updated` | event | stored fields actually changed — `{ sobjectType, id, changedFields }` (derived fields included) |
| `record.deleted` | event | a record was soft-deleted, including cascaded children (`cascadedFrom` = the parent id) |
| `api-limit-exceeded` | fault (`before`, all 20 operations) | HTTP 403 `[{"message":"TotalRequests Limit exceeded.","errorCode":"REQUEST_LIMIT_EXCEEDED"}]` |
| `row-locked` | fault (`before`, the nine writes) | HTTP 400 `UNABLE_TO_LOCK_ROW`; nothing is written, reads keep working |
| `write-committed-lost` | fault (`after_commit`, `records.create`, `records.upsert`, `collections.create`, `collections.upsert`) | the insert **commits** (row and `record.created` exist) but the caller sees 503 `SERVER_UNAVAILABLE`; a naive retry of an Account with `External_Id__c` then fails `DUPLICATE_VALUE`, a retry of a plain Contact silently duplicates — the trap an agent must handle by re-reading |

Select a fault in a scenario: `"faults": [{ "packageId": "salesforce", "faultId": "row-locked" }]`. Events for writes rolled back inside an `allOrNone` envelope are never emitted.

## Limits

Every scan is bounded by `org.limits.maxRowsPerNamespace` (default and hard cap 10,000). A namespace beyond the bound fails the operation with `LIMIT_EXCEEDED` (`state exceeds the supported bound of N rows for <namespace>`) — never a silently truncated result; the conformance suite lowers the bound (`tight-limits` scenario) to prove it. LIKE patterns and search wildcards are matched without regular expressions, in time linear in the stored value's length (LIKE tests its anchored first and last segments on the raw value before anything else, folds each row's value at most once per query however many clauses read it, and locates `%`-free literal segments with Knuth–Morris–Pratt and segments containing `_` with a bit-parallel automaton; all search terms run as one bit-parallel automaton). A LIKE segment between two `%` wildcards that contains `_` may be at most 256 characters (longer → `MALFORMED_QUERY`; a Tool bound, not a Salesforce one); the leading and trailing segments are compared in place and have no such bound. Because only fields of at most 255 characters are filterable, each WHERE comparison of a row costs bounded work, and one request evaluates at most 500,000 WHERE comparisons × candidate rows, summed over every statement, child subquery and search `where` it runs (a composite shares one allowance); beyond that the statement fails `MALFORMED_QUERY` with Salesforce's `Query is either selecting too many fields or the filter conditions are too complicated` wording (Salesforce reports `QUERY_TOO_COMPLICATED`; a Tool bound). ORDER BY computes each row's sort keys lazily and at most once (a later key is read only for rows whose earlier keys tie), and one request computes at most 200,000 sort keys across all its statements, subqueries and search `orderBy` clauses (beyond → the same `MALFORMED_QUERY`; a Tool bound). Rows are indexed by id and child subqueries group their children by parent once per query, so relationship reads, sharing checks, subqueries and delete cascades cost one pass over the rows involved, not rows × rows. JSON request bodies nested deeper than 512 levels are refused at decode time with 400 `framework.HTTP_REQUEST_MAPPING_FAILED` (`JSON body nests deeper than 512 levels`) before schema validation recurses. Response bodies are byte-budgeted (see SOQL paging and Collections and composite). `LIMIT_EXCEEDED` also answers more than 200 records per collection call, 2,000 ids per retrieve, 25 composite subrequests or 5 composite queries.

## Compatibility

- **Not verified against a real client.** jsforce (`new Connection({ instanceUrl, accessToken, version: "62.0" })`), simple-salesforce (`Salesforce(instance_url=…, session_id=…)`) and the Salesforce DX MCP server (`@salesforce/mcp`) are the intended clients — paths, field names, status codes and the error-array envelope follow the Salesforce REST API Developer Guide for the implemented subset — but none has been run against this Tool; the manifest `compatibility` array is empty. The two MCP aliases reproduce `@salesforce/mcp`'s tool names and accept its documented argument names (`query`, `usernameOrAlias`, `directory`, `useToolingApi`, `defaultTargetOrg`, `defaultDevHub`) as recalled from its published README, not verified against the running server (it is a stdio process over the `sf` CLI auth store).
- Authentication is the world token (`Bearer` or `OAuth` scheme) plus the actor's `username`; the OAuth token/authorize/revoke endpoints are not served and `GET /services/data`, which Salesforce serves without authentication, requires the token here.
- Connection recipe `salesforce-rest-client` maps `SALESFORCE_INSTANCE_URL` → `FIREDRILL_HTTP_URL` and `SALESFORCE_ACCESS_TOKEN` → `FIREDRILL_HTTP_TOKEN` for pointing an existing agent's environment seam at the Tool.
- MCP results carry the JSON value in the text content block; `structuredContent` must be an object, so array-shaped operations (`versions.list`, the collections) and their error outcomes arrive wrapped as `{ "result": … }`. Arguments are validated against the operation's input schema by the MCP layer before the Tool runs.
- Content type is `application/json;charset=UTF-8`; `Sforce-Limit-Info` is emitted on object-bodied successes and handler-raised errors only (array bodies, framework outcomes and fault-injected errors have no carrier — wire codecs are pure and have no state).

## Limitations

- A bounded synthetic subset: 20 operations, 23 routes, seven sObjects (five writable) with a documented field subset (no compound `BillingAddress`/`MailingAddress`, formula, roll-up, rich-text, multi-select or geolocation fields; picklists are restricted; the only validation rule is `Closed_Won_Requires_Amount`). Everything else answers the framework's 404 (or 405 where only other methods exist on the path): no lead conversion, undelete, `updated`/`deleted` tracking, full SOSL `/search`, `composite/batch|tree|graph`, Bulk API, Tooling/Metadata API, Apex REST, Chatter, UI API, reports, list views, `recent`, layouts, quick actions, blobs, Case/Campaign/Event/Note/Product/Pricebook objects, custom objects (custom **fields** on the seeded objects only), duplicate-rule blocking, workflow/flow/trigger side effects, the `/services/data/vXX.X/` resource index or any other `@salesforce/mcp` tool.
- **Malformed percent-encoding in a path.** A plain route whose path segment is not valid percent-encoded UTF-8 (e.g. `GET …/sobjects/Account/001%E0%A4%A`) is answered by the framework with 404 `framework.HTTP_ROUTE_NOT_FOUND` before the Tool runs (the route matcher discards undecodable segments), not Salesforce's `[{"errorCode":"NOT_FOUND"}]` envelope. Inside `POST …/composite` the Tool parses subrequest urls itself: an undecodable path segment is a per-item 404 `NOT_FOUND`, an undecodable `q` a per-item 400 `MALFORMED_QUERY`, an undecodable `fields` a per-item 400 `INVALID_FIELD`, and an undecodable parameter the route does not read is ignored. `GET …/query?q=` and `…/queryAll?q=` with malformed encoding reach the Tool with the undecodable bytes replaced by U+FFFD (the framework does not expose the raw bytes), so any SOQL statement containing U+FFFD fails 400 `MALFORMED_QUERY` ("the q parameter is not valid percent-encoded UTF-8") instead of running with a corrupted literal. This also rejects a correctly encoded U+FFFD (`%EF%BF%BD`) and a literal U+FFFD sent through `run_soql_query` or canonical `query.execute`.
- **Route-overlap consequence.** The framework rejects `GET …/sobjects/{type}/describe`, `…/updated` and `…/deleted` because they overlap the record-retrieve template, so those literal segments reach `records.retrieve` and fail `MALFORMED_ID` 400. Full describe is available canonically, over MCP and as a composite subrequest.
- Upsert by external id answers 200 on both branches (Salesforce: 201 on create) because a route declares one success status; the body always carries `created`. `MALFORMED_ID` is 400 on every route (Salesforce answers 404 on some GET paths). Salesforce's `STRING_TOO_LONG`, `INVALID_EMAIL_ADDRESS`, `NUMBER_OUTSIDE_VALID_RANGE`, `INACTIVE_OWNER_OR_USER` and `MALFORMED_SEARCH` are folded into `INVALID_FIELD`, `MALFORMED_QUERY` and `INVALID_CROSS_REFERENCE_KEY` (the original code is named in the message).
- `Sforce-Query-Options: batchSize` is honoured down to 1 (Salesforce clamps to 200–2000) so paging can be exercised against small worlds; query locators re-run the query, so rows written between pages are visible (Salesforce cursors are snapshots). Date literals are evaluated in UTC with Sunday-start weeks (Salesforce uses the user's time zone and locale); `OFFSET` ≤ 2,000; `Probability` is defaulted from the stage but kept when sent explicitly.
- Ids are Salesforce-shaped (18 characters, real key prefixes, the real case-safe suffix) but the 9-digit body is a decimal counter. `recentItems` is "the five most recently modified visible records", not a per-user MRU. `Sforce-Limit-Info` and `limits.get` are constant decorations from the `org` row (`used` never increments). `_limitInfo` appears in canonical/MCP outputs. `attributes.url`/`nextRecordsUrl` are relative paths and `userinfo.urls` use the `.test` instance URL from the `org` row — the Tool does not know its public base URL.
- Object permissions come from the profile only; sharing knows org-wide defaults, ownership, `viewAll`/`modifyAll` and Controlled-by-Parent contacts. A multiple-match upsert (Salesforce 300) cannot occur because the seeded external id fields are unique. The recycle bin is permanent (no undelete, no purge).

## Develop

```sh
firedrill validate
firedrill tool test salesforce
firedrill serve --scenario baseline --actor admin
npm pack --ignore-scripts
```

The conformance suite (`firedrill/conformance.suite.json`, 15 drills over 8 actors and 5 scenarios, target `test/conformance.mjs` using Node built-ins only) exercises every operation, every declared error on every operation that declares it, the three events and the three faults, and is run twice to prove determinism. The world has eight actors, so `firedrill serve` needs `--actor`.

## Trademarks

Salesforce and the Salesforce product names belong to Salesforce, Inc. and are used only to identify the service this package simulates in a test environment. This package is not affiliated with or endorsed by Salesforce.

## License

Apache-2.0 — see `LICENSE`.
