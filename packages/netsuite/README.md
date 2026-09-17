# @firedrill-tools/tool-netsuite

A synthetic **NetSuite** Tool for [Firedrill](https://firedrill.run): one fictional two-subsidiary OneWorld account exposed through a
subset of **SuiteTalk REST Web Services** — the record service under `/services/rest/record/v1` and **SuiteQL** under
`/services/rest/query/v1/suiteql` — plus four operations shaped like Oracle's MCP Standard Tools. All state is local and
deterministic: Firedrill owns the ledger, virtual time and evidence. No Oracle service is contacted, no e-mail is delivered and no
money moves.

Version `0.1.0`, engine `>=0.1.0 <0.2.0`, licence Apache-2.0. The package ships a **browser app** as well as the backend: a
recreation of the NetSuite application shell (see *Browser app* below) that drives the same operations an agent calls.

## Install

```sh
firedrill tool add ./firedrill-tools-tool-netsuite-0.1.1.tgz --install
```

`firedrill tool add` seeds the starter account from `starter.json` (virtual time 2026-09-16T17:00:00Z, 09:00 account time at a fixed
−08:00). Grant the operations your agent needs, for example:

```json
{ "packageId": "netsuite", "operationId": "customer.list" },
{ "packageId": "netsuite", "operationId": "sales-order.transform" },
{ "packageId": "netsuite", "operationId": "suiteql.query" }
```

## Connecting a client

**HTTP.** Use `FIREDRILL_HTTP_URL` as the base URL instead of `https://<accountId>.suitetalk.api.netsuite.com` and
`FIREDRILL_HTTP_TOKEN` as the OAuth 2 Bearer token; the token's *value* is not inspected, the acting identity comes from the actor's
attributes. Paths keep NetSuite's shape, for example `GET /services/rest/record/v1/customer?q=…&limit=…&offset=…`,
`PATCH /services/rest/record/v1/invoice/{id}`, `POST /services/rest/record/v1/salesOrder/{id}/!transform/invoice` and
`POST /services/rest/query/v1/suiteql` (which requires `Prefer: transient`). Request headers decoded to arguments:
`Prefer`, `X-NetSuite-Idempotency-Key` (must be an RFC 4122 UUID), `X-NetSuite-PropertyNameValidation`
(`ignore|warning|error`, default `warning`) and `If-Match`. Successful writes answer **204** with a relative `Location` header.

**Canonical / MCP.** `record.get`, `record.metadata`, `suiteql.run` and `subsidiary.list` carry the argument shapes of the MCP
Standard Tools `ns_getRecord`, `ns_getRecordTypeMetadata`, `ns_runCustomSuiteQL` and `ns_getSubsidiaries`. `record.get` and
`suiteql.run` have **no** HTTP route — call them through the canonical operation endpoint.

## Identities

| actor attribute | meaning |
|---|---|
| `netsuiteAccountId` (optional) | The account the token belongs to. Present and ≠ `TSTDRV2184096` → `INVALID_LOGIN` (401) on every operation. |
| `netsuiteRoleId` (optional) | The role in use. Absent → role `3` (Administrator). An unseeded role id → `INVALID_LOGIN`. |
| `netsuiteEmployeeId` (optional) | The logged-in employee; drives `createdBy`/`lastModifiedBy`. Absent → the account default `101`. Unknown → `INVALID_LOGIN`. |
| `netsuiteSubsidiaryId` (optional) | Overrides the role's subsidiary restriction. `"0"` means all subsidiaries. |

Rules apply in order: **account** → **permission** (NetSuite's `none < view < create < edit < full` over `LIST_CUSTJOB`,
`TRAN_SALESORD`, `TRAN_CUSTINVC`, `TRAN_CUSTPYMT`, `LIST_ITEM`, `LIST_SUBSIDIARY`, `SETUP_RECORD_METADATA`, `REPO_ANALYTICS`) →
**subsidiary scope**. An out-of-scope record answers `NONEXISTENT_ID` (404) rather than 403, as NetSuite hides it. There is no
per-row owner. **Fresh-install fallback:** an actor without attributes acts as employee 101 in the Administrator role.

Seeded roles: `3` Administrator, `1001` A/R Clerk (sales orders read-only, no delete), `1002` Sales Rep (no invoices, payments or
SuiteQL), `1003` Canada Controller (A/R Clerk permissions restricted to subsidiary 2), `1004` Restricted Viewer (no permissions).

## Starting data

**Whitlock Instruments Inc**, a fictional Seattle oceanographic-instrument maker with a Canadian subsidiary, 69 state rows:
2 subsidiaries, 3 employees, 5 roles, 12 customers (ids 1001–1012), 10 items (ids 2001–2010), 9 sales orders, 11 invoices and
5 customer payments (ids 5001–5055), plus `meta/account`, `meta/counters`, `meta/limits` and one `line-counters` row per transaction.

Deliberate edge cases: an inactive customer (1004) and an inactive item (2006); a customer with no e-mail (1003); an individual
rather than a company (1008); a customer whose `entityId` is at the 83-character limit (1011); two customers whose names differ only
in case (1002 / 1012); an item stocked only in subsidiary 2 (2005); three service items that are **not** in the `inventoryItem`
collection (2008–2010); a zero-total invoice (5039); a fractional quantity (order 5008); a 200-line order and its 200-line invoice
(5009 / 5040); a voided invoice (5036); a payment with 1,500.00 unapplied (5054); and a partially billed order (5002).

Internal ids are NetSuite-style numeric strings drawn from three counters (`nextEntityId`, `nextItemId`, `nextTransactionId`), and
the row id **is** the internal id. Money is stored with two decimals and computed in integer cents; quantities and rates carry up to
four decimals. Balances (`balance`, `overdueBalance`, `unbilledOrders`, `amountRemaining`) are **computed on every read** from the
transactions, never stored.

## Operations

26 operations over 24 provider-shaped routes: `list`/`get` for customer, sales order, invoice, customer payment and inventory item;
`create`/`update` for customer, sales order and invoice; `customer.delete`; `sales-order.items.list`; the two transforms
(`salesOrder → invoice`, `invoice → customerPayment`); `subsidiary.list`; `suiteql.query`; the four MCP-shaped operations; and `session.get`, which returns the signed-in session
(account, employee, role with its permission levels, subsidiary scope, server time and account date). `session.get` has **no HTTP
route** — NetSuite exposes this through its application shell, not as a REST resource — and is what the browser app reads to render
the account/role chrome and to date every screen from world virtual time.
Declared errors use NetSuite's problem envelope
(`{ type, title, status, "o:errorDetails": [ { detail, "o:errorCode", … } ] }`): `INVALID_LOGIN` 401, `INSUFFICIENT_PERMISSION` 403,
`NONEXISTENT_ID` 404, `RCRD_HAS_BEEN_CHANGED` 409, `CONCURRENCY_LIMIT_EXCEEDED` 429, `UNEXPECTED_ERROR` 500, and
`INVALID_ID` / `INVALID_CONTENT` / `INVALID_KEY_OR_REF` / `INVALID_PARAMETER` / `INVALID_REQUEST` / `USER_ERROR` /
`RESULT_SET_TOO_LARGE` at 400.

**`q` filters.** `customer.list`, `sales-order.list`, `invoice.list`, `customer-payment.list` and `inventory-item.list` accept
NetSuite's `q` grammar (`field OPERATOR value`, `AND` binding tighter than `OR`, parentheses, `[a,b]` lists) over a published field
list per record type. Operators follow the field's type: `EMPTY`/`EMPTY_NOT` anywhere, `IS`/`IS_NOT` for booleans and strings,
`CONTAIN`/`START_WITH`/`ENDWITH`, `ANY_OF`/`BETWEEN`/`EQUAL`/`GREATER…`/`LESS…`/`WITHIN` for numbers, `ON`/`BEFORE`/`AFTER`/
`ON_OR_BEFORE`/`ON_OR_AFTER` for dates, each with a `_NOT` form. An unknown field or an operator the type does not accept is
`INVALID_REQUEST`, never a silently ignored filter. Status is filtered by its **stored key** (`pendingFulfillment`, `paidInFull`, …),
not by NetSuite's `SalesOrd:B` form.

**Paging.** `limit` 1–1000 (default 1000; SuiteQL default 10) and an `offset` that must be a multiple of `limit`. Ordering is
internal id ascending, numerically — NetSuite does not document a default order, so this package fixes one. Pages are also bounded by
encoded UTF-8 bytes (`meta/limits.maxPageBytes`, default 900,000) and every scan is bounded by `meta/limits.maxScanRows`
(default 5,000); reaching either bound fails `RESULT_SET_TOO_LARGE` rather than silently truncating.

**SuiteQL subset.** `SELECT [DISTINCT] … FROM <table> [[INNER|LEFT] JOIN … ON …] [WHERE …] [GROUP BY …] [HAVING …] [ORDER BY …]
[FETCH FIRST n ROWS ONLY]` over `customer`, `transaction`, `transactionLine`, `item`, `employee` and `subsidiary`, with column and
table aliases, `?` bind parameters, `COUNT`/`SUM`/`MIN`/`MAX`/`AVG`, `UPPER`/`LOWER`/`NVL`, `LIKE`, `IN`, `BETWEEN`, `IS [NOT] NULL`
and `BUILTIN.DF(<column>)`. Every scalar is rendered as a JSON string, as NetSuite does. A join condition must be one or more column
equalities so the joined table is indexed into a `Map` once per request. Anything outside the subset — a non-`SELECT` statement, a
second statement, subqueries, `UNION`, `CASE`, window functions, an unknown table or column — fails `INVALID_REQUEST` naming the
construct. `Prefer: transient` is required on the HTTP route.

## Events and faults

Events: `record.changed` (`{ recordType, recordId, changeType: CREATE|UPDATE|DELETE, occurredAt, employeeId, subsidiaryId }`) and
`transaction.status-changed` (`{ recordType, recordId, tranId, previousStatus, status, occurredAt, total, amountRemaining }`).
Nothing is delivered anywhere; there are no subscriptions and no callbacks (NetSuite has no first-party outbound webhook for record
changes, so declaring one would invent a protocol).

Faults, each with a scenario in `firedrill/`: `concurrency-limit` (every operation → 429, `Retry-After: 5`), `write-outage` (the nine
write operations → 500, reads keep working), `record-locked` (the five edit/transform operations → 409) and
`transform-response-lost` (`after_commit` on the two transforms: the invoice or payment **is** created and its events emitted, but
the caller sees 500 — the double-billing hazard worth rehearsing).

## Conformance

`firedrill tool test netsuite` runs 15 drills over 6 scenarios and 7 actors and passes with **zero coverage violations**: every one
of the 25 operations has a successful call, every declared error of every operation is observed, both events are emitted and all four
faults activate, over two identical runs. See [`specs/netsuite/VERIFICATION.md`](../../specs/netsuite/VERIFICATION.md) in this
repository for the exact commands and outputs.

## Browser app

`firedrill serve` publishes a browser app for this Tool (**Tools → Open app**). It is a recreation of the NetSuite
application shell — the dark application bar with the Oracle NetSuite lockup, global search, Recent Records, Create New,
Shortcuts, Help and the user menu; the blue global menu bar (Activities, Payments, Transactions, Lists, Reports,
Analytics, Documents, Setup, Customization, Commerce, Support) with their real submenus; the account/role strip; and the
release footer. Screens:

| screen | route | operations |
|---|---|---|
| Home dashboard — the full portlet grid: Reminders (seven counters), Recent Records, Navigation, Tasks, Key Performance Indicators, Trend Graphs (invoiced sales by month), Report Snapshots (Sales by Customer), Settings, Shortcuts, Custom Search (Open Invoices), Calendar (month grid on the account date), Phone Calls, Tips. Every figure is paged out of the Tool's own collections; Tasks, Phone Calls and calendar events are rendered empty and labelled not simulated | `#/home` | `invoice.list`/`get`, `sales-order.list`/`get`, `customer-payment.list`, `session.get` |
| Customers list — quick filter mapped to a real `q`, Show Inactives, NetSuite's paging strip | `#/customers` | `customer.list`, `customer.get` |
| Customer record — Primary Information / Address / Financial / Transactions / System Information subtabs, Edit form, Actions → Delete with confirmation | `#/customers/<id>` | `customer.get`, `customer.update`, `customer.delete`, `sales-order.list`, `invoice.list`, `subsidiary.list` |
| Sales Orders list with a status filter | `#/orders` | `sales-order.list`, `sales-order.get` |
| Sales order record — Items sublist with its own paging, totals, **Bill** (whole order or a quantity per line) | `#/orders/<id>` | `sales-order.get`, `sales-order.items.list`, `sales-order.transform` |
| Enter Sales Order — customer and item pickers that page as you type, line grid, live subtotal | `#/orders/new` | `customer.list`/`get`, `inventory-item.list`/`get`, `sales-order.create` |
| Invoices list — Open / Overdue / Paid In Full / All views | `#/invoices` | `invoice.list`, `invoice.get` |
| Invoice record — items, totals, applied payments, **Accept Payment** | `#/invoices/<id>` | `invoice.get`, `invoice.update`, `invoice.transform`, `customer-payment.list`/`get` |
| Create Invoice | `#/invoices/new` | `invoice.create`, `customer.list`, `inventory-item.list` |
| Customer Payments list | `#/payments` | `customer-payment.list`, `customer-payment.get` |
| Items (read-only) with a detail panel | `#/items` | `inventory-item.list`, `inventory-item.get` |
| Subsidiaries (read-only) | `#/subsidiaries` | `subsidiary.list` |
| SuiteQL Query Tool — editor, results grid with paging, raw response body | `#/suiteql` | `suiteql.query` |

The app and the API share one world: a customer created in the app is visible over `GET /services/rest/record/v1/customer`
and the reverse, and the app re-reads after every write and whenever `getContext().revision` moves.

Permissions and subsidiary scope come from the acting role through `session.get`: an action the role cannot perform is
disabled, and a refused read renders NetSuite's own "Permission Violation" text. "Today", due-date colouring and the
account date come from world virtual time (`session.get.accountDate`), never from the browser clock, so replaying a world
on another day renders identically.

**Controls that are present but not simulated.** Every persistent control of the real client is rendered with its label and
hover state; those outside this Tool's scope open a short "Not simulated by this Tool" panel: global search suggestions
(the search box itself filters customers), Help, Shortcuts personalization, the user menu (Set Preferences, Change
Password, Change Role; Log Out is disabled), the role switcher, portlet setup and Personalize Dashboard, the Tasks / Phone Calls / Calendar portlets (their New and View All buttons; activities are not modelled, so the lists are empty rather than invented), the Navigation portlet's out-of-scope menu entries, Customize
View / Export on every list, Print / Email / More and the unsupported entries of each record's Actions menu (Fulfill,
Close Order, Void, Credit Memo, Make Copy, Merge, Make Inactive), New Item, New Subsidiary, Save & New / Save & Print /
Reset on the entry forms, Save Query / Query History in the SuiteQL tool, and every global-menu entry outside the table
above (Activities, Reports, Documents, Customization, Commerce, Support and the unimplemented Transactions, Lists,
Payments and Setup entries). Nothing invents data for them.

Assets: `app/assets/oracle-netsuite.svg` and `app/assets/oracle.svg` are the official downloaded Oracle marks (sources and
checksums in `app/assets/ATTRIBUTION.md`); the bundled face is Open Sans (SIL OFL 1.1, `app/assets/fonts/LICENSE.txt`),
since NetSuite's own Oracle Sans is proprietary. Interface glyphs are original SVG paths in the app's `icons.js`.

## Trademarks

Oracle, NetSuite, Oracle NetSuite, SuiteTalk, SuiteQL, SuiteAnalytics and the Oracle NetSuite logo are trademarks of
Oracle Corporation. This package is an independent, unofficial simulation: product names and logos are used only to
identify the simulated service inside a Firedrill test environment. It is not affiliated with, endorsed by, sponsored by
or connected to Oracle Corporation, and it contacts no Oracle service.

## Limitations

- **No official client has been run against this package.** Fidelity is `behavioral` / `stateful` / `contract`; nothing claims
  `validated`. Oracle's SuiteCloud SDK and the MCP Standard Tools SuiteApp were used as documentation, not as test clients.
- The account time zone is a fixed −08:00 with no daylight saving, and the fiscal calendar is not modelled.
- Currency is per subsidiary (USD / CAD) with **no exchange rates and no consolidation**; a CAD transaction's total is a CAD number.
- Taxes are a flat per-subsidiary rate (8.6 % / 5 %) on each line, not a tax-code engine; there are no tax groups, no nexuses and no
  tax items.
- No fulfillments, item receipts, credit memos, journal entries, deposits, custom records, custom fields, saved searches, workflows,
  SuiteScript, file cabinet, employees-as-vendors, or sublists other than `item`, `apply`, `addressBook` and `subsidiary`.
- Sales-order status is derived from billed quantities only (approval and fulfilment are not simulated), so `partiallyFulfilled` and
  `pendingBilling` appear in starter data but are never *computed*.
- `subsidiary`, `employee` and `role` rows are read-only; there is no operation that writes them.
- The metadata catalog is assembled on every call from a field table in `lib/metadata.mjs` that mirrors the state schemas and the `q`
  filter tables. It is not the real NetSuite `application/schema+json` document, and its `x-ns-*` keys are this package's own.
- Two request shapes are refused by the framework before this Tool's codecs see them, so they answer Firedrill's envelope rather than
  NetSuite's: a body that is not JSON at all, and a body over the framework's size limit. A `__proto__` key is also removed by the
  framework's JSON decoding before the codec runs; a `constructor` or `prototype` key does reach the codec and answers
  `INVALID_REQUEST`.
- When the *world* denies an operation (an actor whose grants do not cover it), the denial is raised by Firedrill before any handler
  runs. The provider-shaped routes still answer a coherent NetSuite envelope — `403` with `INSUFFICIENT_PERMISSION` and a generic
  "Permission Violation: ..." detail — because the codec maps a denied outcome itself and never quotes the framework's own
  message (which names the internal operation id). The detail is therefore less specific than a role-permission refusal, which names
  the missing permission. On the canonical operation endpoint the denial keeps Firedrill's `world.OPERATION_DENIED` outcome, as it must.
- An argument that violates an operation's own input schema (a value longer or larger than the schema allows) is rejected by
  Firedrill before the handler runs. The routes still answer a coherent NetSuite envelope — `400` with `INVALID_PARAMETER` and a
  generic "Invalid request parameter value. ..." detail — because the codec derives the NetSuite code from the outcome status the
  framework reports, so the body's `status` always matches the HTTP status line. The bounds this package documents (`fields` at most
  40 names, `q` at most 2000 characters, per-field lengths on write bodies) are checked in the handlers, so those cases answer the
  specific `INVALID_PARAMETER` / `INVALID_REQUEST` / `INVALID_CONTENT` detail with `o:errorQueryParam` or `o:errorPath`.
- `Location` headers and every `links[].href` are **relative** paths: a codec cannot see the request host.
- Idempotency is the framework's: a retry carrying the same `X-NetSuite-Idempotency-Key` replays the recorded outcome. NetSuite's own
  header behaviour (and its 4-hour window) is not otherwise simulated.
