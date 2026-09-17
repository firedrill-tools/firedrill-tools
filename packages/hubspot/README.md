# @firedrill-tools/tool-hubspot

A synthetic **HubSpot CRM portal** for [Firedrill](https://firedrill.run): one fictional account holding contacts,
companies, deals, notes and tasks, exposed through a bounded subset of the HubSpot CRM v3 Objects, Search, Owners,
Pipelines and Properties APIs, the CRM v4 Associations API, the Account Info API, and through the tool names of
HubSpot's published MCP server. Agents that talk to HubSpot through `@hubspot/api-client`-style REST calls or over
MCP can be exercised against it without a portal, a private-app token or network access.

Everything is computed from the world's state: record ids come from a counter row, timestamps from Firedrill's
virtual clock, visibility from the calling actor's owner row. Nothing here contacts HubSpot; no e-mail, sequence or
workflow is ever triggered.

Package id `hubspot`, version `0.1.0`, engine `>=0.1.0 <0.2.0`, license Apache-2.0. **Backend only** — there is no
browser app; browse state through the REST routes, the MCP aliases or the Firedrill inspector.

## Install

```sh
firedrill tool add ./firedrill-tools-tool-hubspot-0.1.0.tgz --install   # or the npm name once published
firedrill serve --scenario baseline --no-open
```

`firedrill serve` prints the HTTP and MCP endpoints and their tokens. A new world receives the starter data and
the grants below. Existing worlds do not change silently: add the grants and (optionally) the `starter.json` rows
to your own world or scenario.

### Grants and identity

Every actor that should use the Tool needs the grants for the operations it may call (`packageId: "hubspot"`):

```
account.get-details  objects.list  objects.get  objects.create  objects.update  objects.archive
objects.batch-read  objects.batch-create  objects.batch-update  objects.search
associations.list  associations.create-default  associations.create  associations.batch-create
associations.archive  associations.batch-read  associations.list-labels
owners.list  owners.get  pipelines.list  pipelines.get  pipelines.list-stages  properties.list  properties.get
```

and these actor **attributes**, which model a HubSpot private app acting for one portal user:

| attribute | meaning |
|---|---|
| `email` (optional) | Selects the caller: the non-archived `owners` row with that e-mail (case-insensitive) is the caller's user and owner. A claimed e-mail with no match (or a deactivated owner) fails every operation with `UNAUTHORIZED` (HTTP 401, category `INVALID_AUTHENTICATION`), like an invalid token. **Absent** (e.g. the actor `firedrill tool add` creates): the caller is the portal's default user, the first non-archived owner in row-id order — Maya Lindqvist (`41001`) in the starter data; a portal without any active owner answers `UNAUTHORIZED`. |
| `scopes` (optional, string array) | Granted private-app scopes. Absent = every scope the Tool knows. Present = each operation needs its scope (`crm.objects.<type>.read/write`, `crm.objects.owners.read`, `crm.schemas.<type>.read`, `oauth`); a missing one fails `MISSING_SCOPES` (HTTP 403 with `errors[0].context.requiredGranularScopes`). Notes and tasks are gated by the contacts scopes. |
| `recordAccess` (optional, `all` \| `owned`) | HubSpot's "owned records only" user permission. With `owned`, records owned by someone else are absent from lists, searches and association listings, and get/update/archive/associate on them fail `NOT_FOUND` exactly like a non-existent id. Unassigned records stay visible. |

### Connections

Two connection recipes are declared: `hubspot-api-client` (`HUBSPOT_API_BASE_PATH` = the HTTP binding,
`HUBSPOT_ACCESS_TOKEN` = its token, sent as `Authorization: Bearer …`) and `hubspot-mcp` (`HUBSPOT_MCP_URL` /
`PRIVATE_APP_ACCESS_TOKEN` for the MCP binding). The values are isolated world tokens for test processes only; the
official `@hubspot/mcp-server` is a stdio process bound to `api.hubapi.com` and is not the client being run — its
tool names are exposed by this package's MCP binding directly.

## Starting data

`starter.json` (and the conformance `firedrill/world.json`) contain 118 fictional rows, virtual time
2026-09-14T09:00:00Z (`virtualTimeUs 1789376400000000`, copied into the world by `firedrill tool add`, so records created
in a fresh install are stamped 2026-09-14, after every seeded record): portal `24871365` (EU data hosting, `Europe/Stockholm`, `EUR`) of **Brightline Analytics**, a
small B2B data-tooling company (`@brightline.example.com`), with four owners (Maya Lindqvist and Tom Achebe in
Sales, Priya Raman in Customer Success, Jonas Weber deactivated), 14 contacts (one archived, one without e-mail,
one with a mixed-case e-mail, two still owned by the deactivated owner, three unassigned, non-ASCII names), 6
companies (one archived, a parent and a subsidiary sharing a domain, one without contacts or deals), 8 deals across
the `default` Sales Pipeline (HubSpot's seven default stages) and a custom `5f2a9c1e` Renewals pipeline (one closed
won, one closed lost, one without an amount), 4 notes and 4 tasks (one overdue, one completed), 24 links stored as 48
directed association rows (a primary company, a user-defined `Champion` label, a link to the archived company), the
HubSpot-defined association type ids for the ten type pairs in scope, and three custom properties
(`contacts/plan_tier`, `deals/arr`, hidden `companies/csm_health`). Object ids are below 1001; created records start
at 1001.

## Operations

| operation | MCP alias | HTTP route |
|---|---|---|
| `account.get-details` | `hubspot-get-user-details` | `GET /account-info/v3/details` |
| `objects.list` | `hubspot-list-objects` | `GET /crm/v3/objects/{objectType}` |
| `objects.get` | — | `GET /crm/v3/objects/{objectType}/{objectId}` |
| `objects.create` | — | `POST /crm/v3/objects/{objectType}` |
| `objects.update` | — | `PATCH /crm/v3/objects/{objectType}/{objectId}` |
| `objects.archive` | — | `DELETE /crm/v3/objects/{objectType}/{objectId}` |
| `objects.batch-read` | `hubspot-batch-read-objects` | `POST /crm/v3/objects/{objectType}/batch/read` |
| `objects.batch-create` | `hubspot-batch-create-objects` | `POST /crm/v3/objects/{objectType}/batch/create` |
| `objects.batch-update` | `hubspot-batch-update-objects` | `POST /crm/v3/objects/{objectType}/batch/update` |
| `objects.search` | `hubspot-search-objects` | `POST /crm/v3/objects/{objectType}/search` |
| `associations.list` | `hubspot-list-associations` | `GET /crm/v4/objects/{objectType}/{objectId}/associations/{toObjectType}` |
| `associations.create-default` | — | `PUT /crm/v4/objects/{fromObjectType}/{fromObjectId}/associations/default/{toObjectType}/{toObjectId}` |
| `associations.create` | — | `PUT /crm/v4/objects/{fromObjectType}/{fromObjectId}/associations/{toObjectType}/{toObjectId}` |
| `associations.batch-create` | `hubspot-batch-create-associations` | `POST /crm/v4/associations/{fromObjectType}/{toObjectType}/batch/create` |
| `associations.archive` | — | `DELETE /crm/v4/objects/{fromObjectType}/{fromObjectId}/associations/{toObjectType}/{toObjectId}` |
| `associations.batch-read` | — | `POST /crm/v4/associations/{fromObjectType}/{toObjectType}/batch/read` |
| `associations.list-labels` | `hubspot-get-association-definitions` | `GET /crm/v4/associations/{fromObjectType}/{toObjectType}/labels` |
| `owners.list` | — | `GET /crm/v3/owners` |
| `owners.get` | — | `GET /crm/v3/owners/{ownerId}` |
| `pipelines.list` | — | `GET /crm/v3/pipelines/{objectType}` |
| `pipelines.get` | — | `GET /crm/v3/pipelines/{objectType}/{pipelineId}` |
| `pipelines.list-stages` | — | `GET /crm/v3/pipelines/{objectType}/{pipelineId}/stages` |
| `properties.list` | `hubspot-list-properties` | `GET /crm/v3/properties/{objectType}` |
| `properties.get` | `hubspot-get-property` | `GET /crm/v3/properties/{objectType}/{propertyName}` |

`{objectType}` accepts `contacts`, `companies`, `deals`, `notes`, `tasks`, their singular spellings and the numeric
ids `0-1`, `0-2`, `0-3`, `0-46`, `0-27`; anything else is `404 OBJECT_NOT_FOUND` ("Unable to infer object type").
Canonical names are also reachable as `POST /v1/operations/hubspot/<operation>` and as MCP tools `hubspot.<operation>`.

Behaviour highlights, all computed from state:

- Records are `{ id, properties, createdAt, updatedAt, archived, archivedAt?, associations? }`; property values are
  strings or `null`. Reads return the requested properties (unknown names are dropped) or the type's default set,
  always with `hs_object_id` and the create/modified timestamps. Writes validate every value against the property
  definition (unknown → `Property "x" does not exist`, read-only, wrong number/date/boolean/enumeration, invalid or
  deactivated `hubspot_owner_id`), reject empty property maps, and answer `400 VALIDATION_ERROR` with one
  `errors[]` entry per bad property.
- Contact `email` is unique (case-insensitive): a duplicate fails `409 CONFLICT` with `Contact already exists.
  Existing ID: …`. Company `domain` is not unique. Deals need `dealstage` (pipeline defaults to `default`) and the
  stage must belong to the pipeline; `hs_deal_stage_probability`, `hs_is_closed` and `hs_is_closed_won` are derived
  from the stage. Notes and tasks need `hs_timestamp`; task status/priority/type are enumerations.
- `datetime`/`date` values (and datetime search filter values) are parsed without the host clock or time zone: an
  epoch-millisecond digit string, or ISO 8601 `YYYY-MM-DD[THH:MM[:SS[.fraction]]][Z|±HH:MM|±HHMM|±HH]`. A value
  without a zone designator is **UTC** and a date-only value is midnight UTC, so the same input stores the same
  instant on every machine; values are stored as `YYYY-MM-DDTHH:MM:SS.sssZ` and must fall within years 0000–9999
  (`253402300800000` or `9999-12-31T23:00:00-05:00` is `INVALID_DATE`). Anything else (e.g. `September 20,
  2026`, `2026-02-30`, `24:00:00`) fails `400 VALIDATION_ERROR` (`INVALID_DATE`); an invalid date filter value fails
  the search with `400`.
- On create a `null` value sets nothing (the property stays unset); PATCH merges and `null` clears. A required
  datetime that is present but invalid reports only `INVALID_DATE`, not also `REQUIRED_FIELD_NOT_SET`. `objects.update` emits one `object.property-changed` event per property whose stored
  value actually changed. Archiving is a soft delete: archived records vanish from lists, searches, lookups and
  association listings unless `archived=true` is requested; they are never restored.
- Malformed query flags (`?limit=abc`, `?archived=maybe`) on list/get routes answer `400 VALIDATION_ERROR` in
  HubSpot's envelope (`limit must be between 1 and 100`, `archived must be true or false`).
- JSON request bodies may nest at most 512 levels. A deeper body is refused with `400` before argument validation
  (the codec measures depth iteratively); ordinary bodies a few levels deep are unaffected.
- Listing pages by ascending id with `limit`/`after` (`paging.next.after` + a relative `link`); search takes
  `filterGroups` (OR of ANDs, ≤ 5 groups, ≤ 6 filters each, ≤ 18 total; operators `EQ NEQ LT LTE GT GTE BETWEEN IN
  NOT_IN HAS_PROPERTY NOT_HAS_PROPERTY CONTAINS_TOKEN NOT_CONTAINS_TOKEN`, typed comparison for numbers and dates),
  a free-text `query` (every token a prefix of a token in the type's searchable properties), one sort (object or
  `"-createdate"` shorthand), `limit` ≤ 200 and a decimal offset `after` below 10 000; `total` is exact.
- Property values are limited to 65,536 characters (HubSpot's limit); a longer value fails `400 VALIDATION_ERROR` with
  `INVALID_LENGTH` and nothing is written.
- List and search pages are filled by the UTF-8 size of the encoded body as well as by count: a page stops before it
  would pass 900,000 bytes and `paging.next.after` points at the first record not returned, so every record appears
  exactly once while paging. A single record, a get, a create/update response, a batch read/create/update or an
  association batch read that would be larger answers `400 VALIDATION_ERROR` ("above this Tool's 900000-byte response
  limit"), and a rejected write commits nothing.
- Batch reads/updates report unknown ids in `errors` (`numErrors`) and process the rest; batch creates are
  all-or-nothing on validation errors or duplicate e-mails; batch bodies take 1–100 inputs.
- Associations are stored as two directed rows per link with HubSpot's real type ids (contact→company `279`/`280`,
  primary `1`/`2`, contact→deal `4`/`3`, company→deal `342`/`341`, primary `6`/`5`, note and task pairs, plus the
  user-defined `Champion` `57`/`58`). A HubSpot-defined `Primary` label is exclusive per record and type pair;
  `create-default` is idempotent; inline `associations` on create resolve the target type from the type id;
  archiving removes both directions and answers 204 even when nothing was linked.
- Owners list/get (`idProperty=userId`, `archived`), deal pipelines and stages (`metadata.probability`/`isClosed`
  as strings), property definitions (HubSpot-defined constants merged with custom `properties` rows; the REST
  route lists hidden ones, the MCP alias filters them unless `includeHidden`).

Every response carries `X-HubSpot-Correlation-Id` and constant `X-HubSpot-RateLimit-*` headers. Errors use HubSpot's
envelope `{ status: "error", message, correlationId, category, errors?, context?, links? }` with categories
`INVALID_AUTHENTICATION` (401), `MISSING_SCOPES` (403, also for a framework-denied actor), `OBJECT_NOT_FOUND` (404),
`VALIDATION_ERROR` (400, also for schema-invalid input), `CONFLICT` (409), `RATE_LIMITS` (429) and `INTERNAL_ERROR`
(503). Requests with a form or text body get the framework's 415; paths outside the table above get 404 (or 405
when only other methods exist on that path).

## Events and faults

Events: `object.created` (one per record created, batch included), `object.property-changed` (one per changed
property on update, derived deal properties included) and `association.changed` (one per directed row added or
removed, with `associationTypeIds` and `removed`). Consumers can attach callbacks to them in their own world.

Faults (select them in a scenario with `faults: [{ packageId: "hubspot", faultId }]`):

| fault | timing | effect |
|---|---|---|
| `rate-limited` | before, every operation | `429 RATE_LIMITS` "You have reached your secondly limit." with `X-HubSpot-RateLimit-Secondly-Remaining: 0` and `Retry-After: 1`; nothing runs. |
| `write-unavailable` | before, every write | `503 INTERNAL_ERROR`; nothing is written, reads keep working. |
| `write-committed-lost` | after commit, `objects.create` / `objects.batch-create` | The record **is** created and `object.created` emitted, yet the caller sees 503. A naive retry of a contact create then hits `409 CONFLICT`; a retry of a company create silently duplicates — the behaviour an agent must handle. |

## Conformance

`firedrill tool test hubspot` runs thirteen drills twice over the HTTP and MCP bindings (a scripted target,
`test/conformance.mjs`, Node built-ins only): the full REST flow (every route, error path and edge case, including
datetime coercion), the MCP aliases, owned-record visibility, read-only scopes, no scopes, a framework-denied actor,
an unknown e-mail, a deactivated owner, an actor without identity attributes, size bounds (65,536-character values,
pathological wildcard searches, byte-bounded list/search pages over large CJK records, oversized batches), and one
drill per fault. Together they observe every operation, every declared error of every
operation, all three events and all three faults, and the repeat pass proves determinism.

## Protocol compatibility

The HTTP surface follows the HubSpot API reference field-by-field for the routes above (paths, query parameters,
JSON bodies, `paging`, batch envelopes, error envelope, rate-limit headers), so `@hubspot/api-client` with its
`basePath` pointed at the HTTP binding is the intended client — but **no official client has been run against this
Tool**: compatibility is by reference, not verified against a real client, and the manifest `compatibility` array is
empty. The eleven MCP aliases reproduce the tool names of `@hubspot/mcp-server` 0.4.0 and take the REST body field
names those tools forward; their exact argument schemas were not verified against the running server.

## Limitations

- A bounded synthetic subset: 24 operations, 24 routes, five object types. No tickets, custom objects/schemas, calls,
  e-mails, meetings, communications, the legacy engagements API, `batch/upsert`, `batch/archive`, merge, GDPR delete,
  property history (`propertiesWithHistory` is rejected with 400), property/pipeline/association-label management,
  lists, forms, files, workflows, webhooks, timeline events, OAuth token endpoints, API-usage endpoints or CSV
  import/export. Ten of the official MCP server's 21 tools (engagements, workflows, schemas, links, feedback) are absent.
- Authentication is the world token plus the actor's `email`; scopes are enforced only when the actor declares
  `scopes`, from the small scope list above (no highly-sensitive-data scopes, no team-based access; `recordAccess`
  knows only `all` and `owned`, and unassigned records are visible to `owned` users).
- The HubSpot-defined property set is the small subset agents use, not HubSpot's several hundred; no calculated or
  analytics properties, no `hs_all_owner_ids`; custom properties come from starter rows; `hasUniqueValue` only on
  contact `email`; `hubspot_owner_assigneddate` is stamped on contacts only.
- Deals derive only probability and closed flags from the stage; no `hs_closed_amount`, forecast categories, line
  items, quotes or currency conversion.
- Search is synchronous (a write is searchable immediately; HubSpot's index lags), offset-paged, one sort, no
  relevance ranking or fuzzy matching; `CONTAINS_TOKEN` is whole-word with `*` wildcards, matched in time linear in
  the value (KMP substring search, no regular expression). One search may spend at most 40,000,000 character units of
  matching work (folding, tokenising and scanning property values); a search that would need more answers
  `400 VALIDATION_ERROR` ("characters of matching work") instead of blocking the server. HubSpot has no such error. `query` and every filter `value`/`values` item/`highValue` are limited to 3,000 characters (HubSpot's
  query limit, applied to filter values too); a longer one answers `400 VALIDATION_ERROR`.
- Batch routes always answer 200/201 with `numErrors`/`errors`; HubSpot answers 207 on partial failures.
- Responses are capped at 900,000 UTF-8 bytes because the framework refuses HTTP responses over 1 MiB. HubSpot itself
  would return a 100-input batch of large records; here it answers `400 VALIDATION_ERROR` and the caller must send
  fewer inputs or request fewer properties. List and search pages may hold fewer than `limit` records.
- Only the ten type pairs above have association definitions; `paging.next.link` is a relative path; archived
  records keep their association rows (hidden from listings) and are never restored.
- Rate-limit headers are constant decorations; `Remaining` only drops under the `rate-limited` fault. Batch
  `startedAt`/`completedAt` and all timestamps come from virtual time, which does not advance within a drill.
- `correlationId` is the Firedrill invocation correlation id, not a HubSpot-format UUID.
- Object, owner and association ids are bounded to 512 characters by the operation input schemas (the framework's
  own state row-id bound). Within that bound an unknown id — including an `idProperty=email` lookup of an address
  longer than 64 characters — answers HubSpot's 404; only a longer id (in a path or a batch input) answers
  `400 VALIDATION_ERROR` with the generic message `Invalid input JSON: arguments do not match hubspot.<operation>`,
  where HubSpot would answer 404. Pipeline ids and property names of any length answer HubSpot's 404. Error messages
  shorten echoed caller values to 100 **code points** (`aaaa…`), so an astral character is never split and a quoted
  value keeps its closing quote. The whole `message` is then bounded to the framework's cap of 1000 UTF-16 units,
  again cut on a code point boundary and ending in `…` (an aggregated `Property values were not valid: […]` summary
  over several long property names is the one message that can reach it); `errors[]` always lists every field in full.
- **Malformed percent-encoding**: `firedrill serve` decodes query strings and bodies leniently, so a broken escape
  such as `%E0%A4%A` reaches the Tool as U+FFFD (while `%ZZ` stays literal and a bad path segment 404s). U+FFFD in a
  search expression or free-text filter is treated as a mangled request, never as search text: `objects.search`
  `query`, every filter `value`/`values` item/`highValue`, and the `owners.list` `email` filter answer
  `400 VALIDATION_ERROR` ("contains an invalid character (U+FFFD)") instead of silently matching nothing. A correctly
  encoded U+FFFD (`%EF%BF%BD`) is rejected the same way; legitimate non-ASCII searches (`café`, `Müller`, CJK)
  work normally. A mangled *property name* answers the existing `Property "…" does not exist` error, and a mangled
  read projection (`?properties=`) is dropped like any unknown property name, as HubSpot does. Free-text `query`
  tokens are letters, digits and `@._+-`; a query made only of other characters (an emoji, punctuation) yields no
  tokens and behaves exactly like an empty `query` — no text filter, so the `filterGroups` decide the result.
- `GET /crm/v3/properties/{objectType}` keeps hidden definitions by default over HTTP (`?includeHidden=false` drops
  them); the canonical `properties.list` operation defaults to `includeHidden: false`. A non-boolean value answers
  `400 VALIDATION_ERROR`. **Deviation:** real HubSpot's REST route has no hidden filter and ignores unknown query
  parameters, so it would answer **200** for `?includeHidden=maybe`; this Tool validates the flag for consistency
  with `limit` / `archived`. Unknown parameters other than `includeHidden` are still ignored (`?foo=bar` → 200).
- **Framework limitation (`__proto__`)**: the framework's JSON decoding removes a `__proto__` key before the handler
  runs, so `{"properties":{"__proto__":"x","firstname":"P"}}` creates the contact from `firstname` alone instead of
  reporting HubSpot's `PROPERTY_DOESNT_EXIST`, and a body with only `__proto__` reads as `properties must be a
  non-empty object`. `constructor` and `prototype` do reach the handler and answer `PROPERTY_DOESNT_EXIST`. No caller
  key ever reaches a plain object: property names are resolved through a `Map` of definitions, so the shared realm
  cannot be poisoned.

## Trademarks

HubSpot is a trademark of HubSpot, Inc. The name is used only to identify the service this package simulates in a
test environment; there is no affiliation with or endorsement by HubSpot.

## Safety

Tools and conformance targets are trusted local executable code, not a sandbox. Review before running. Keep
credentials and generated worlds/reports out of the package and repository; the file list excludes `.firedrill/`.
