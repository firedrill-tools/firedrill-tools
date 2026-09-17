# @firedrill-tools/tool-unified

A synthetic **Unified.to workspace** for [Firedrill](https://firedrill.run): one fictional workspace holding a handful of
**synthetic connections** (each standing for an end-customer's authorised integration) and the unified **CRM** (contact,
company, deal, pipeline) and **Messaging** (channel, message) data models behind them, exposed through a bounded subset of
the Unified.to REST API (`/unified/connection`, `/crm/{connection_id}/…`, `/messaging/{connection_id}/…`) and through the
five Core-mode tool names of the Unified MCP server. Agents that talk to Unified.to with a REST client pointed at a custom
base URL, or over MCP, can be exercised against it without a Unified.to account, an API key or network access.

Everything is computed from the world's state: object ids come from a counter row, timestamps from Firedrill's virtual
clock, visibility from the calling actor's attributes. Nothing here contacts Unified.to or any underlying platform (HubSpot,
Slack, Gmail, …); a connection's `integration_type` is a label, and "sending" a message only stores a synthetic message row.

Package id `unified`, version `0.1.0`, engine `>=0.1.0 <0.2.0`, license Apache-2.0. **Backend only** — there is no browser
app; browse state through the REST routes, the MCP names or the Firedrill inspector.

## Install

```sh
firedrill tool add ./firedrill-tools-tool-unified-0.1.0.tgz --install   # or the npm name once published
firedrill serve --scenario baseline --no-open
```

`firedrill serve` prints the HTTP and MCP endpoints and their tokens. A new world receives the starter data (61 rows) and
the grants below. Existing worlds do not change silently: add the grants and (optionally) the `starter.json` rows to your
own world or scenario.

### Grants and identity

Every actor that should use the Tool needs the grants for the operations it may call (`packageId: "unified"`):

```
connections.list  connections.get  connections.create  connections.update  connections.remove
contacts.list  contacts.get  contacts.create  contacts.update  contacts.remove
companies.list  companies.get  companies.create  companies.update  companies.remove
deals.list  deals.get  deals.create  deals.update  deals.remove
pipelines.list  pipelines.get  channels.list  channels.get
messages.list  messages.get  messages.create  messages.update  messages.remove
```

and these optional actor **attributes**, which model a Unified.to workspace API key:

| attribute | meaning |
|---|---|
| `workspaceId` (optional) | Selects the workspace: the `workspaces` row with that id. A claimed id with no row fails every operation with `UNAUTHORIZED` (HTTP 401, `Unauthorized`), like an invalid key. **Absent** (e.g. the actor `firedrill tool add` creates): the caller is the first `workspaces` row in row-id order — `68c8000000000000000000a1` "Brightline Sales Ops" in the starter data. This fallback scans at most 100 workspace rows; with more than 100 it fails `FAILED_PRECONDITION` instead of guessing. |
| `connectionIds` (optional, string array) | A connection-scoped key (the Unified MCP server's per-connection URL). Absent = every connection of the workspace. Present = `connections.list` returns only these, every other operation on a connection outside the list fails `NOT_FOUND` exactly as for a non-existent id, and `connections.create` fails `FORBIDDEN`. |

Framework grants decide whether an actor may call an operation at all (a missing grant is refused by the framework with
HTTP 403 before the Tool runs); the attributes decide what a call may see and change. The bearer token string itself is
never interpreted.

### Connections

Two connection recipes are declared: `unified-rest` (`UNIFIED_BASE_URL` = the HTTP binding, replacing
`https://api.unified.to`; `UNIFIED_API_KEY` = its token, sent as `Authorization: Bearer …`) and `unified-mcp`
(`UNIFIED_MCP_URL` / `UNIFIED_MCP_TOKEN` for the MCP binding, Streamable HTTP with a Bearer token). The values are isolated
world tokens for test processes only.

## Starting data

`starter.json` (and the conformance `firedrill/world.json`) contain 61 fictional rows at virtual time 2026-09-16T09:00:00Z
(`virtualTimeUs 1789549200000000`, copied into the world by `firedrill tool add`, so records created in a fresh install are
stamped after every seeded record). Workspace `68c8000000000000000000a1` **Brightline Sales Ops** (`north-america`) has
nine connections, each in a different state:

| connection id (suffix) | integration | categories | state |
|---|---|---|---|
| `…0201` crm-main | `hubspot` | crm | healthy; all six `crm_*` read/write permissions + `crm_pipeline_read`; `external_xref acct-brightline`; authorised user Maya Lindqvist (`u-maya`) |
| `…0202` crm-readonly | `pipedrive` | crm | only `crm_contact_read` (writes and other objects answer 403) |
| `…0203` chat | `slack` | messaging | all messaging permissions; posts as Ops Bot (`u-opsbot`) |
| `…0204` mail | `gmail` | messaging | channels `INBOX`, `SENT`, `DRAFT` resolve the `channel_id` aliases |
| `…0205` paused | `hubspot` | crm | `is_paused true` → 403 on every data call |
| `…0206` broken | `salesforce` | crm | `last_unhealthy_code "401"` → 401 "likely broken" |
| `…0207` hris-only | `bamboohr` | hris | 501 on every CRM and messaging route |
| `…0208` sandbox-crm | `hubspot` | crm | `environment Sandbox` (hidden from `GET /unified/connection` unless `env=Sandbox`; its one contact is reachable) |
| `…0209` sandbox-omni | `hubspot` | crm, messaging | `environment Sandbox`; every CRM and messaging permission, no data rows — every list answers `[]`, so the whole surface is reachable through one connection id |

On crm-main: 2 pipelines (Sales Pipeline with Qualification 10 % → Proposal 40 % → Negotiation 70 % → Closed Won / Closed
Lost; an inactive Renewals pipeline), 5 companies (Northwind Traders, Contoso Robotics, Fabrikam Studio, inactive Tailspin
Freight without contacts, 山田物産 with a CJK address), 8 contacts (one without e-mail, one with accents, one with a CJK
display name, one unassociated), 6 deals (one in the inactive pipeline, one closed won, one closed lost with `lost_reason`,
one with `currency null`). On chat: 4 channels (`#sales-emea` is a sub-channel of `#sales`, `#exec-private` is private) and
16 messages (a thread with three replies, a mention, reactions, an attachment record, a 2,982-character message, an
unread CJK/emoji message, buttons). On mail: 3 alias channels and 4 e-mails. Seeded ids end in `…0201`–`…0814`; ids issued
at runtime start at `68c800000000000000001001` and count up in creation order.

## Operations

| operation | MCP alias | HTTP route |
|---|---|---|
| `connections.list` | `list_unified_connections` | `GET /unified/connection` |
| `connections.get` | `get_unified_connection` | `GET /unified/connection/{id}` |
| `connections.create` | `create_unified_connection` | `POST /unified/connection` |
| `connections.update` | `update_unified_connection` | `PUT` and `PATCH /unified/connection/{id}` |
| `connections.remove` | `remove_unified_connection` | `DELETE /unified/connection/{id}` |
| `contacts.list` / `get` / `create` / `update` / `remove` | — | `GET`, `GET`, `POST`, `PUT`+`PATCH`, `DELETE` on `/crm/{connection_id}/contact[/{id}]` |
| `companies.*` | — | same pattern on `/crm/{connection_id}/company[/{id}]` |
| `deals.*` | — | same pattern on `/crm/{connection_id}/deal[/{id}]` |
| `pipelines.list` / `pipelines.get` | — | `GET /crm/{connection_id}/pipeline[/{id}]` |
| `channels.list` / `channels.get` | — | `GET /messaging/{connection_id}/channel[/{id}]` |
| `messages.list` / `get` / `create` / `update` / `remove` | — | `GET`, `GET`, `POST`, `PUT`+`PATCH`, `DELETE` on `/messaging/{connection_id}/message[/{id}]` |

29 operations, 34 routes. Canonical names are also reachable as `POST /v1/operations/unified/<operation>` and as MCP tools
`unified.<operation>`; the canonical input and output shapes **are** the REST shapes (snake_case fields of the Unified.to
`Connection`, `CrmContact`, `CrmCompany`, `CrmDeal`, `CrmPipeline`, `MessagingChannel`, `MessagingMessage` schemas, with
`connection_id` and `id` folded into the argument object). Every route takes `Authorization: Bearer <token>`.

Behaviour highlights, all computed from state:

- **Lists** return a bare JSON array (no envelope, total or cursor): a page shorter than `limit` means there are no more
  records, as Unified.to documents. `limit` 1–100 (default 100; larger values are capped to 100; `0`, negative or non-numeric
  → 400), `offset` ≥ 0, `updated_gte` (ISO-8601 date or date-time; a value without a zone is UTC; impossible dates → 400),
  `sort` ∈ `name|updated_at|created_at` (default creation order; ties by id), `order` ∈ `asc|desc`, `query` (case-folded
  literal substring over name/e-mail fields — contacts: `name`, `first_name`, `last_name`, `emails[].email`; companies:
  `name`, `emails`, `domains`, `websites`; deals and channels: `name`; messages: `subject`, `message`, author name/e-mail;
  wildcards are literal characters; a U+FFFD from malformed percent-encoding → 400), `fields` (comma-separated or repeated;
  `id` is always included; unknown names ignored; **`raw` is returned only when requested**, otherwise every other field).
  Reference filters (`company_id`, `deal_id`, `contact_id`, `pipeline_id`, `parent_id`, `channel_id`) must be well-formed
  24-hex ids (400 otherwise); an unknown id matches nothing. `channel_id` also accepts `INBOX`, `SENT` and `DRAFT`, resolved
  to the connection's channel carrying that alias (none → `[]`). Messages add `type=READ|UNREAD`, `start_gte`/`end_lt` on
  `created_at`, `user_id` (author) and `user_mentioned_id`; channels add `type=PUBLIC|PRIVATE` and `parent_id`; connections
  add `env` (default `Production`), `categories` (every listed category must be present) and `external_xref` (exact).
- **Writes** ignore `id`, `created_at`, `updated_at`, `connection_id` and `workspace_id` in bodies (read-only, as Unified.to
  does) and refuse unknown fields with 400 naming the field (caller text clipped). `PUT` and `PATCH` are both **merge**
  updates of the top-level fields present: `null` clears a nullable field, an array replaces the array. Every value is
  checked against the state schema (string lengths, array sizes, enums, e-mail shape, 3-letter upper-case `currency`,
  `probability` 0–100, `employees` ≥ 0) before anything is written; a failed or denied call writes nothing.
- **Contacts** need one of `name`, `first_name`, `last_name` or an e-mail; `name` derives from first/last name when absent.
  **Companies** need `name`. Association arrays are kept **symmetric** within a connection: writing `company_ids` on a
  contact adds or removes the contact in each company's `contact_ids` (likewise `deal_ids` ⇄ `contact_ids`/`company_ids`
  on deals), only rows whose membership changes are rewritten, references to another connection or an unknown id → 400,
  and removing an object drops its id from every associated row.
- **Deals**: `stages[0].id` must be a stage of `pipelines[0].id`; a stage alone implies its pipeline, a pipeline alone takes
  its first active stage; names in the references are filled from the pipeline row. `probability` defaults to the stage's
  `deal_probability` unless the body sets it; `closed_at` is stamped with virtual now when a deal enters a stage with
  `is_closed` and cleared when it leaves one.
- **Messages** need one of `message`, `message_html`, `message_markdown` and either `channels[0].id` (an existing channel,
  ≤ 8 channels) or `parent_id` (an existing message of the connection — the reply inherits its channels). `author_member`
  in the body is ignored: the author is the connection's authorised identity (`auth.name`, `auth.emails[0]`,
  `auth.user_id`). The parent's `has_children` is maintained on create and remove; replies keep their `parent_id` when the
  parent is removed. `messages.update` accepts only `message`, `message_html`, `message_markdown`, `subject` and
  `is_unread` (clearing every text field → 400).
- **Connections**: `connections.create` yields an already-authorised connection (`integration_name` = title-cased
  `integration_type`, `is_paused false`, `last_healthy_at` = now); `categories` must list ≥ 1 of the Unified.to categories,
  every permission's prefix (`crm_` → `crm`, `messaging_` → `messaging`) must be one of them, `auth` holds only `name`,
  `emails` and `user_id` (never tokens), and `token`/unknown fields are refused. `integration_type` and `categories` cannot be
  changed afterwards. `connections.remove` deletes every contact, company, deal, pipeline, channel and message stored under
  the connection (one `object.deleted` per data row) — or refuses as a whole when a namespace exceeds the scan bound.
- **Per-connection access rules**, in order: workspace (401 `Unauthorized`), connection resolution (404 `Connection not
  found`, also for a malformed id → 400 `Invalid connection_id`), health (`last_unhealthy_code` set → 401 `The connection is
  likely broken and requires recreation`; `is_paused` → 403 `Connection is paused; monthly plan limit exceeded`), category
  (`crm`/`messaging` not in `categories` → 501 `The requested functionality is not supported by this integration`),
  permission (`crm_contact_read`, `crm_contact_write`, …, `messaging_message_write` missing → 403 `The connection lacks the
  required permissions or scopes: <permission>`), then validation (400) and existence (404 `Contact not found`, …).
- **Bounds that fail loudly instead of truncating**: each connection may hold at most `workspaces.limits.max_rows_per_namespace`
  rows per namespace (10,000 in the starter data, never more; a scenario can lower it); a scan or write past the bound
  fails `FAILED_PRECONDITION` (HTTP 500, `State exceeds the supported bound of N rows for <namespace>`). A list page whose
  UTF-8 encoding would exceed 900,000 bytes fails `PAYLOAD_TOO_LARGE` (HTTP 413, `Response exceeds 1 MB; lower limit or
  restrict fields`) — offset paging cannot express a shorter page. `raw` objects are copied key by key (≤ 8 levels, ≤ 64
  keys per level, ≤ 16 KB; `constructor`/`prototype` keys refused). JSON bodies nested deeper than 512 levels, a query
  parameter repeated more than 16 times, and non-JSON bodies on JSON routes are refused with 400 before validation.

Errors use the envelope `{ "statusCode": <status>, "message": "<text>", "error": "<reason phrase>" }` — Unified.to publishes
its status-code meanings but no error body schema, so this envelope is the Tool's documented choice; branch on the HTTP
status as you must against the real API. Statuses: 400 `BAD_REQUEST`, 401 `UNAUTHORIZED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`,
413 `PAYLOAD_TOO_LARGE`, 429 `RATE_LIMITED` (+ `Retry-After: 1`), 500 `INTERNAL_ERROR` / `FAILED_PRECONDITION`, 501
`NOT_IMPLEMENTED`. Framework outcomes are rendered in the same envelope: schema-invalid arguments 400, an actor without the
grant 403 `Forbidden`, an unknown route 404 (the framework's own body). Successful `DELETE`s answer 200 `{}`.

## Events and faults

Events mirror the Unified.to webhook vocabulary (`created | updated | deleted`, object types `crm_contact`, `crm_company`,
`crm_deal`, `messaging_message`): `object.created` and `object.updated` (`changed_fields: ["*"]`) on every create — Unified.to
documents that "updated" fires for new records too — `object.updated` with the changed top-level field names on an
update that changed something (association maintenance on other rows emits one per rewritten row), `object.deleted` on
remove and per cascaded row of `connections.remove`. Pipelines and channels never emit (they are read-only here).

Faults (select them in a scenario with `faults: [{ packageId: "unified", faultId }]`):

| fault | timing | effect |
|---|---|---|
| `rate-limited` | before, every operation | `429` `Too many requests to Unified.to` with `Retry-After: 1`; nothing runs. |
| `write-unavailable` | before, the 15 write operations | `500 Internal Server Error`; nothing is written, reads keep working. |
| `write-committed-lost` | after commit, `messages.create` | The message **is** stored, the parent's `has_children` updated and both events emitted, yet the caller sees 500. Unified.to has no idempotency key on `POST`, so a blind retry posts a duplicate — list the channel and check before re-sending. |

## Conformance

`firedrill tool test unified` runs sixteen drills twice over the HTTP and MCP bindings (a scripted target,
`test/conformance.mjs` + `test/flows/*.mjs`, Node built-ins only) across five actors (`admin`, `fresh` without attributes,
`scoped`, `ghost` with an unknown workspace, `auditor` without grants) and seven scenarios (`baseline`, one per fault,
`bounds` with the scan bound lowered to 5, `many-workspaces` with 102 workspaces, `large-channels` with two 350-member
channels): the CRM flow (every route, filter, projection, association and stage rule, every connection state), the
messaging flow, the connections flow, the MCP aliases, scoped and unknown identities, a framework-denied actor, a fresh
actor, an error-coverage sweep (404/501/403/400 on every data operation), size bounds (schema limits, prototype keys,
5,000-character keys, byte-bounded pages over 16 KB `raw` payloads, 20,000-character texts and CJK messages, long and
repeated query parameters) and one drill per fault and bound. Together they observe every operation, every declared error
of every operation, all three events and all three faults, and the repeat pass proves determinism.

## Protocol compatibility

The HTTP surface follows the Unified.to OpenAPI document (`api.unified.to/openapi.json`, version 1.0, fetched 2026-09-16)
field by field for the routes above — paths, methods, query parameters, snake_case bodies, bare-array pages, 200 on
`DELETE` — so the official `unified-typescript-sdk` / `unified-python-sdk` with their server URL pointed at the HTTP binding
are the intended clients. **No official client has been run against this Tool**: compatibility is by reference, not
verified, and the manifest `compatibility` array is empty. The five MCP aliases reproduce the Core-mode connection tool names
documented for the Unified MCP server and take the REST field names; they were not verified against the live server.
Unified.to's REST API accepts a bare token in `Authorization`; this Tool requires the `Bearer` scheme.

## Limitations

- A bounded synthetic subset of one aggregator workspace: connections, CRM contact/company/deal/pipeline, messaging
  channel/message. Absent (404): every other category (HRIS, ATS, accounting, ticketing, storage, …), CRM `lead`, `event`,
  `picklist`/`taxonomy`, pipeline and channel create/update/remove, messaging `event`, `/passthrough`, webhooks,
  integrations, API-call logs, issues, `mcp_url`, the OAuth authorisation flow, `X-Mock`, `env=Sandbox` mock data
  (Sandbox is only a connection attribute), non-JSON `Accept` formats, EU/AU hosts, `hide_sensitive`, `include_external_tools`.
- Connections are created **already authorised** with the display identity given in `auth`; the real endpoint is one
  step of an OAuth flow. `auth` never carries tokens or secrets, and identity comes from actor attributes, not from the
  bearer token string.
- Every connection behaves identically according to its `categories` and `permissions`; integration-specific field
  support, per-platform rate limits and platform quirks are not modelled. Pipelines and channels are read-only reference
  data (consumers seed them); a pipeline holds at most 20 stages with 128-character names, so `pipelines.list` can never
  exceed the page budget and does not declare `PAYLOAD_TOO_LARGE`.
- The error envelope, `Retry-After: 1`, 403 for a paused connection, 413 for an oversized page and 500 for the scan bound
  are this Tool's choices (Unified.to documents none of them). `limit` above 100 is capped silently (Unified.to's documented
  ceiling). `PUT` and `PATCH` both merge; a full-replace `PUT` is not distinguished.
- `raw` is stored and returned verbatim when requested via `fields`; the `raw` and `expand` query parameters are accepted
  and ignored. `query` is a plain case-folded substring match; `sort=name` on messages sorts by `subject`.
- Association symmetry is enforced within one connection only; cross-connection references are rejected with 400.
- Events are Firedrill events, not webhook deliveries (no `sig256`, `nonce`, delivery types or `hook_url`).
- Malformed percent-encoding in a **path** segment is answered by the framework with 404 before the Tool runs; unknown
  routes answer the framework's 404 body, not the envelope above.

## Trademarks

Unified.to and the integration names used as labels (HubSpot, Pipedrive, Slack, Gmail, Salesforce, BambooHR, Zoho, Teams)
belong to their owners and appear only to identify the simulated service and integration types in a test environment.
This package is independently maintained and implies no affiliation with or endorsement by any of them.

## Safety

Tools and conformance targets are trusted local executable code, not a sandbox. Review before running. Keep credentials and
generated worlds/reports out of the package and repository; the package file list excludes `.firedrill/`.
