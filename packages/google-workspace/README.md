# @firedrill-tools/google-workspace

A synthetic **Google Workspace developer surface** for [Firedrill](https://firedrill.run): the three "glue" APIs an
agent reaches for when it manages people data, event subscriptions and automation for one Workspace domain.

- **People API v1** — the signed-in user's private contacts, contact groups, other contacts, contact search and
  colleagues' domain profiles.
- **Google Workspace Events API v1** — subscriptions to Chat spaces, Drive items and Meet spaces, with the
  long-running-operation envelope, suspension and reactivation.
- **Apps Script API v1** — script projects, file content, versions, deployments, a simulated `scripts.run`
  execution and the resulting process list.

Everything runs locally against Firedrill's own state and virtual clock. No Google service is contacted, no OAuth
token is exchanged, no Pub/Sub message is published and no real script is executed. The seeded domain is the
fictional `northwind-labs.example.com`; every address ends in `.example.com`.

**27 operations · 25 provider-shaped HTTP routes · 17 state namespaces · 3 domain events · 3 faults · 20 conformance drills.**

## Install

```sh
firedrill tool add @firedrill-tools/google-workspace --install
firedrill serve
```

`firedrill tool add` creates a world seeded from `starter.json` and an actor with grants for every operation. The
world's virtual time starts at `2026-09-16T09:00:00Z`, which is coherent with the seeded records.

To grant a subset explicitly, list the operation ids you want in the actor's `grants` (see
`firedrill/world.json` for the full list and for the seven scoped actors the conformance suite uses).

## Three services behind one origin

In production these are three hosts that share the `/v1` path space. Firedrill serves one origin, so each API is
mounted under its own service-name prefix and **everything after the prefix is Google's own path, verbatim**:

| service | production base URL | Firedrill base path |
|---|---|---|
| People API v1 | `https://people.googleapis.com/v1` | `$FIREDRILL_HTTP_URL/people/v1` |
| Workspace Events API v1 | `https://workspaceevents.googleapis.com/v1` | `$FIREDRILL_HTTP_URL/workspaceevents/v1` |
| Apps Script API v1 | `https://script.googleapis.com/v1` | `$FIREDRILL_HTTP_URL/script/v1` |

Official clients already have a per-API root-URL option:

```js
// googleapis (Node)
const people = google.people({ version: "v1", rootUrl: `${base}/people/`, headers: { authorization: `Bearer ${token}` } });
```

```python
# google-api-python-client
build("people", "v1", client_options=ClientOptions(api_endpoint=f"{base}/people"))
```

Every route takes `Authorization: Bearer $FIREDRILL_HTTP_TOKEN`. Errors use Google's `google.rpc.Status`
envelope with a `google.rpc.ErrorInfo` detail:

```json
{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND",
  "details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"RESOURCE_NOT_FOUND",
    "domain":"googleapis.com","metadata":{"service":"people.googleapis.com","method":"google.people.v1.PeopleService.GetPerson"}}]}}
```

`RESOURCE_EXHAUSTED` responses carry `Retry-After: 30` and `UNAVAILABLE` responses carry `Retry-After: 5`.

## Identities

The calling Workspace user is resolved from the actor's attributes:

| attribute | meaning | example |
|---|---|---|
| `email` | primary address, matched case-insensitively | `ada.okonkwo@northwind-labs.example.com` |
| `userId` | directory person id (`people/{userId}`) | `114520000000000000001` |
| `scopes` | space-separated OAuth scopes the token carries | `https://www.googleapis.com/auth/contacts.readonly` |

- **No attributes at all** — the shape `firedrill tool add` creates — resolves to the default seeded user
  **Ada Okonkwo** (`114520000000000000001`), so a fresh install sees the seeded domain rather than an empty account.
- `userId` wins over `email` when both are set.
- A claimed `email` or `userId` with no `users` row, or a suspended user, fails `UNAUTHENTICATED` (401).
- When `scopes` is **absent** the caller holds every scope this Tool understands. When it is present, each
  operation checks its required scope and otherwise fails `PERMISSION_DENIED` (403) with
  `reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT"` and `metadata.service` / `metadata.method` naming the RPC.
  Understood scopes: `contacts`, `contacts.readonly`, `contacts.other.readonly`, `directory.readonly`,
  `chat.spaces.readonly`, `drive.readonly`, `meetings.space.readonly`, `script.projects`,
  `script.projects.readonly`, `script.processes`, `script.deployments`, `script.deployments.readonly`
  (all under `https://www.googleapis.com/auth/`). An unrecognised scope string simply grants nothing.

Contacts, contact groups, other contacts and subscriptions are **private to one user**: a resource owned by
someone else answers `404 NOT_FOUND`, never 403, so existence is not revealed. Script projects carry an owner and
editors and answer `403 PERMISSION_DENIED`, which is what the Apps Script API does.

## Operations

| operation id | HTTP route |
|---|---|
| `people.get-contact` | `GET /people/v1/people/{person_id}` |
| `people.list-connections` | `GET /people/v1/people/{person_id}/connections` |
| `people.create-contact` | `POST /people/v1/people:createContact` |
| `people.update-contact` | `PATCH /people/v1/people/{id}:updateContact` |
| `people.delete-contact` | `DELETE /people/v1/people/{id}:deleteContact` |
| `people.search-contacts` | *(canonical operation only — see Limitations)* |
| `other-contacts.list` | `GET /people/v1/otherContacts` |
| `contact-groups.list` | `GET /people/v1/contactGroups` |
| `contact-groups.get` | `GET /people/v1/contactGroups/{group_id}` |
| `contact-groups.create` | *(canonical operation only — see Limitations)* |
| `contact-groups.delete` | `DELETE /people/v1/contactGroups/{group_id}` |
| `contact-groups.modify-members` | `POST /people/v1/contactGroups/{group_id}/members:modify` |
| `subscriptions.create` | `POST /workspaceevents/v1/subscriptions` |
| `subscriptions.list` | `GET /workspaceevents/v1/subscriptions` |
| `subscriptions.get` | `GET /workspaceevents/v1/subscriptions/{id}` |
| `subscriptions.delete` | `DELETE /workspaceevents/v1/subscriptions/{id}` |
| `subscriptions.reactivate` | `POST /workspaceevents/v1/subscriptions/{id}:reactivate` |
| `operations.get` | `GET /workspaceevents/v1/operations/{id}` |
| `script-projects.create` | `POST /script/v1/projects` |
| `script-projects.get` | `GET /script/v1/projects/{script_id}` |
| `script-projects.get-content` | `GET /script/v1/projects/{script_id}/content` |
| `script-projects.update-content` | `PUT /script/v1/projects/{script_id}/content` |
| `script-versions.create` | `POST /script/v1/projects/{script_id}/versions` |
| `deployments.create` | `POST /script/v1/projects/{script_id}/deployments` |
| `deployments.list` | `GET /script/v1/projects/{script_id}/deployments` |
| `scripts.run` | `POST /script/v1/scripts/{script_id}:run` |
| `processes.list` | `GET /script/v1/processes` |

Every operation is also reachable at `POST /v1/operations/google-workspace/<operation id>` with
`{"arguments": {...}}`, and over MCP under the canonical name `google-workspace.<operation id>`.

**No MCP aliases are declared.** Google publishes an official MCP tool contract for some products, but none for
the People, Workspace Events or Apps Script APIs, so inventing names here would be a false compatibility claim.

## Starting data

`starter.json` seeds 101 rows for `northwind-labs.example.com`:

- **3 users** — Ada Okonkwo (default identity, owns most of the data), Bruno Marek (owns a second set, invisible
  to Ada) and Chen Wei (owns nothing at all, so empty results are genuinely empty).
- **18 contacts** — 14 for Ada across the `Vendors` and `Q4 prospects` groups, 4 for Bruno. Edge cases on purpose:
  a contact with three e-mail addresses and two phone numbers, one with no name at all (the display name falls back
  to the address), a non-ASCII contact (`Zoë Müller`, `Bäckerei Nord`) whose search text folds diacritics, a
  birthday without a year, user-defined fields, and one contact modified "today".
- **11 contact groups** — the four system groups for Ada and Bruno plus Ada's `Vendors` (8 members),
  `Q4 prospects` (2) and `Conference 2026` (0, the empty-members edge). Chen has none.
- **5 other contacts**, one of them without a display name.
- **1 contact tombstone**, so a sync token already reports a deletion.
- **5 target resources** — two Chat spaces, two Drive files and a Meet space, with membership.
- **4 subscriptions** — one active, one suspended and reactivatable, one suspended with `RESOURCE_DELETED`
  (which cannot be reactivated), and one belonging to Bruno.
- **2 completed operations**, so `operations.get` works before anything is created.
- **3 script projects** — `Vendor invoice sync` (Ada owner, Bruno editor, two versions and an API-executable
  deployment), `Onboarding forms` (Bruno owner, Ada editor, no version yet) and `Legacy cleanup` (Bruno only, and
  its single function body is outside the supported runtime grammar).
- **6 executions** spread over three days, covering `COMPLETED`, `FAILED` and `TIMED_OUT`.

## The simulated Apps Script runtime

`scripts.run` **never evaluates arbitrary JavaScript.** It resolves the content to run (HEAD with `devMode: true`
for an owner or editor, otherwise the version of the newest `EXECUTION_API` deployment), finds the named function
in a `SERVER_JS` file, and evaluates a deliberately tiny, documented grammar: a single `return <expr>;` where
`<expr>` is at most 8 terms joined by `+`, `-`, `*` or `/`, and each term is a JSON literal (a numeric literal may
carry a leading minus: `return -1;` and `return 2 - -3;` are valid, while `+1`, `- 1`, `--1` and `-p1` are not JSON
literals and are script errors), a parameter
(`p1`…`p10` or a declared parameter name) or one of the built-ins `contactCount()`, `groupCount()` and
`scriptTitle()`, which read the caller's own state.

Anything else — and any parse failure — is reported exactly as the real API reports a runtime exception:
**HTTP 200** carrying `error.details[0]` of type `google.apps.script.v1.ExecutionError` with
`errorType: "ScriptError"`, and the execution is recorded as `FAILED`. Runtime exceptions inside the grammar are
reported the same way: division by zero, arithmetic on a non-numeric value, and any arithmetic whose result leaves
the finite JSON number range (`1e308 * 10`, `1e999`, `Infinity - Infinity`) is `Exception: non-finite numeric
result in <fn>`, never a 5xx. Source is bounded to 16 KiB per file and results to 64 KiB.

## Events and faults

| id | kind | when |
|---|---|---|
| `contact.changed` | event | after a committed contact create, update, delete, membership change or cascading group delete |
| `subscription.state-changed` | event | after a committed subscription create, delete or reactivate |
| `script.executed` | event | after `scripts.run` commits, for both a successful run and a script error |
| `rate-limited` | fault (`before`) | listings and search answer 429 `RATE_LIMIT_EXCEEDED` with `Retry-After: 30` |
| `contacts-backend-unavailable` | fault (`before`) | contact writes and content updates answer 503 and change nothing |
| `subscription-create-lost` | fault (`after_commit`) | the subscription **is** created but the caller sees 500, so the naive retry answers 409 |

A membership change that touches many contacts emits at most 50 `contact.changed` events followed by one summary
event with `change: "bulk"`, so the event stream cannot explode.

## Conformance

```sh
firedrill tool test google-workspace
```

20 drills over 6 scenarios and 9 actors exercise every operation, every declared error, all three events and all
three faults, and the suite is re-run to prove determinism. `test/conformance.mjs` is a scripted target using Node
built-ins only; it calls the provider-shaped routes and, where a specific actor or a route-less operation must be
proven, the canonical operation endpoint.

## Compatibility

**Not verified against a real client.** `manifest.compatibility` is empty. Routes, bodies and field names were
written against the People API v1, Workspace Events API v1 and Apps Script API v1 discovery documents and target
the `googleapis` Node methods `people.people.get`, `people.people.connections.list`, `people.people.createContact`,
`people.people.updateContact`, `people.people.deleteContact`, `people.otherContacts.list`,
`people.contactGroups.list/get/delete`, `people.contactGroups.members.modify`,
`workspaceevents.subscriptions.create/list/get/delete/reactivate`, `workspaceevents.operations.get`,
`script.projects.create/get/getContent/updateContent`, `script.projects.versions.create`,
`script.projects.deployments.create/list`, `script.scripts.run` and `script.processes.list`. The compatibility
block stays empty until one of those clients has actually been exercised against `firedrill serve`.

## Limitations

1. **Not a Google service.** No OAuth flow, consent screen, token exchange or quota project. `Authorization`
   carries the Firedrill world token; a missing or malformed token gets the framework's own 401 envelope rather
   than Google's `error` object.
2. **Three services behind one origin** (see above). Clients must point their per-API root URL at the prefix.
3. **Two operations have no provider-shaped route.** The framework's HTTP path grammar cannot put a `:` in a
   literal path segment, so every Google custom method must be a parameter segment — and a parameter segment
   excludes every literal sibling at the same method and depth. `people:searchContacts` would shadow
   `GET /people/v1/contactGroups` and `GET /people/v1/otherContacts`, and `POST /people/v1/contactGroups` collides
   with the `people:createContact` slot. Listing and contact creation won those slots, so
   **`people.search-contacts`** and **`contact-groups.create`** are reachable only at the canonical operation
   endpoint. Both are fully implemented.
4. **Subscriptions never deliver.** `notificationEndpoint.pubsubTopic` is validated and stored; no Pub/Sub message,
   push notification or webhook is ever sent, and nothing subscribes to real Chat, Drive or Meet resources. The
   `subscription.state-changed` domain event is the in-world signal. Subscriptions also never expire or
   self-suspend, because no scheduled work runs: the seeded suspensions are the only way into `SUSPENDED`.
   Dry runs are not stored: `subscriptions.create` with `validateOnly` answers an operation named
   `operations/validate-only`, and `subscriptions.delete` with `validateOnly`, or with `allowMissing` on an absent
   subscription, answers `operations/validate-only` or `operations/allow-missing`. `operations.get` reports both as
   `NOT_FOUND`; they never take the id of the next real mutation.
5. **Apps Script does not execute JavaScript** (see "The simulated Apps Script runtime"). There are no triggers,
   libraries, add-ons, advanced services, `SpreadsheetApp`, `GmailApp` or HTML service, and the web-app `exec` URL
   is synthetic and not reachable.
6. **A subset of People.** `people:batchGet`, the batch create/update/delete methods, directory listing and search,
   other-contact search and copy, contact photos, contact-group update and group sync tokens are **not** implemented
   and answer 404 at the path level. Only these mask entries can ever hold data: `metadata, names, nicknames,
   emailAddresses, phoneNumbers, organizations, addresses, biographies, birthdays, urls, userDefined, memberships,
   photos`. Other valid People fields (`relations`, `events`, `skills`, `genders`, …) are accepted and simply return
   nothing.
7. **Search is not Google's ranking.** Matching is deterministic token matching over names, nicknames, e-mail
   addresses, phone digits and organisations with diacritic folding, ordered by match quality then sort name. It
   does not reproduce Google's relevance model, and the real API's warmup-request requirement is not enforced
   (an empty query returns `{}`, as the warmup call does).
8. **Contact-group sync tokens are not supported** — `contactGroups.list` rejects `syncToken` with
   `INVALID_ARGUMENT` rather than pretending. Connection sync tokens *are* supported, including deleted entries
   and expiry below the retention floor.
9. **Simulation bounds are declared errors; two retention windows are not.** At most 1,500 objects per world,
   12 files and 128 KiB of source per project, 16 KiB per file, 1,000 ids per membership modification, 16 contact
   groups per contact, and list pages capped at about 900 KB of UTF-8. Each of these bounds answers a declared
   error (`RESOURCE_EXHAUSTED`, `OUT_OF_RANGE` or `INVALID_ARGUMENT` with a reason such as
   `MEMBERSHIP_LIMIT_EXCEEDED`) **before** anything is written, instead of quietly returning or storing less.
   Two per-user histories are **retention windows** instead, because the real services keep a rolling history
   rather than refusing new work: `processes.list` retains the newest **500 executions** per user (the 501st run
   succeeds and the oldest process row is dropped), and connection sync retains the newest **200 contact
   tombstones** per user (the 201st deletion succeeds, the oldest tombstone is dropped and the user's sync floor
   rises, so a sync token older than the floor answers `FAILED_PRECONDITION` / `EXPIRED_SYNC_TOKEN` instead of
   silently omitting the deletion). Page tokens carry the anchor row's sort key, so a row deleted between two
   pages does not make the rest of the list disappear: the next page resumes at the next surviving row.
10. **Apps Script file names carry no extension**, as in the real API: the manifest is `appsscript` (type `JSON`)
    and code files are `Code`, `Helpers`, … A content update whose manifest is named `appsscript.json` is refused
    with a message naming the extension-less name. `processes.list` reads Google's `userProcessFilter` fields
    (`scriptId`, `functionName`, `statuses`, `types`, `deploymentId`, `projectName`, `userAccessLevels`,
    `startTime`, `endTime`); `subscriptions.create` accepts either `ttl` or `expireTime`, never both. A query key the
    route does not declare (a misspelt filter field, say) is ignored by the framework's route codec rather than
    refused, so rely on the field names documented here.
11. **Request-mapping failures the codec cannot repair.** A syntactically valid body that is not a JSON object
    (`[1,2]`, `"text"`, `null`), or one nested deeper than 512 levels, is refused before argument validation. The
    response still carries Google's `error` envelope with `status: "INVALID_ARGUMENT"`, but its `message` names the
    mapping problem rather than a Google field path. Three failures are answered by the framework **before** the
    Tool's codec runs and therefore use the framework envelope (`{"code":"framework.…","error":"…"}`), not
    Google's: a missing or malformed world token (401, see limitation 1), a body that is not valid JSON at all
    (`not json` with `Content-Type: application/json` → 400 `framework.HTTP_BODY_INVALID`), and a path whose
    percent-encoding cannot be decoded (`%ZZ` → 404).
12. **Trademarks.** Google, Google Workspace, Google Apps Script and related names and marks are trademarks of
    their respective owners and are used here only to identify the simulated service in a test environment. This
    package is not affiliated with, endorsed by, or sponsored by Google.

## Safety

Tools and conformance targets are trusted local executable code, not a sandbox. Review before running. Keep
credentials and generated worlds out of the package and repository.

## Licence

Apache-2.0 — see [LICENSE](./LICENSE).
