# @firedrill-tools/tool-quickbooks

A synthetic **QuickBooks Online** Tool for [Firedrill](https://firedrill.run): one fictional company (realm) exposed through a
subset of the QuickBooks Online Accounting API v3 (`/v3/company/{realmId}/…`) and through MCP tool names used by QuickBooks MCP
servers. All state is local and deterministic: Firedrill owns the ledger, virtual time and evidence. No Intuit service is contacted,
no e-mail is delivered and no money moves.

Version `0.1.1`, engine `>=0.1.0 <0.2.0`, licence Apache-2.0. The package also ships a browser app that recreates the QuickBooks Online web app over the same local state (see [Browser app](#browser-app)).

## Install

```sh
firedrill tool add ./firedrill-tools-tool-quickbooks-0.1.2.tgz --install
```

`firedrill tool add` seeds the starter company from `starter.json` (virtual time 2026-09-15T09:00:00Z, 02:00 company time).
Grant the operations your agent needs, for example:

```json
{ "packageId": "quickbooks", "operationId": "query.run" },
{ "packageId": "quickbooks", "operationId": "invoices.post" },
{ "packageId": "quickbooks", "operationId": "payments.post" }
```

## Connecting a client

- **HTTP** (connection recipe `qbo-rest`): use `FIREDRILL_HTTP_URL` as the base URL instead of `https://quickbooks.api.intuit.com`
  and `FIREDRILL_HTTP_TOKEN` as the OAuth 2 Bearer token. Paths are `/v3/company/9341453172839201/<entity>`. Intuit SDKs hard-code
  the host, so the client must be configured to read the base URL.
- **MCP** (connection recipe `qbo-mcp`): connect a Streamable HTTP MCP client to `FIREDRILL_MCP_URL` with `FIREDRILL_MCP_TOKEN`.
  The 19 alias tool names below are listed next to the canonical `quickbooks.<operation>` names (44 tools in total). Results are the
  JSON object as `structuredContent` plus the same JSON as a text block (the entity itself, or `{ results, totalCount? }` for searches),
  not the prose text of the open-source stdio MCP server.

## Identities

| actor attribute | meaning |
|---|---|
| `realmId` (optional) | Realm the token was issued for. Present and different from `9341453172839201` → `AUTHENTICATION_FAILED` (HTTP 401, code `3200`) on every operation. |
| `role` (optional) | `company_admin` (everything), `standard_limited_customers` (customers, invoices, payments read/write; items read-only; no chart of accounts) or `reports_only` (company info only). Any other value → `AUTHENTICATION_FAILED`. |

**Fresh-install fallback:** an actor without attributes (as `firedrill tool add` creates) acts as `company_admin` of the seeded realm.
The `{realmId}` path segment of HTTP routes must equal the company realm; otherwise `AUTHORIZATION_FAILED` (403, code `3100`), as
QuickBooks answers for a token used against another company. The user-role model is a test fixture: real QuickBooks lets only admins
connect apps. There is no per-row ownership; every permitted caller sees the whole company.

## Starting data

Brightwater Studio LLC, a fictional San Diego design and photography studio (company time fixed at UTC−07:00), 57 state rows:

- 10 accounts (Checking opening 12,480.00, Undeposited Funds, Accounts Receivable, three income accounts, an inactive income account,
  Printing Costs, Software Subscriptions, Owner's Equity).
- 14 customers (Ids 58–71): two `Harbor…` names, `O'Neill Bakery`, `Fernwood Café`, `Juniper Yoga` without e-mail, inactive
  `Old Town Florist`, `Nova Dental Lab` without transactions, `Pacific Rowing Club` with an open balance.
- 8 items (Ids 20–27): Service and NonInventory items, a 0-price `Hours` item, inactive `Legacy retainer`.
- 14 invoices (Ids 1036–1049): 4 paid, 1 partially paid (1042, 900.00 due), 4 overdue, 1 due today, 3 not yet due (one with custom
  DocNumber `BW-2026-07`), 1 voided. Open A/R is 9,805.00.
- 6 payments (Ids 190–195) including a two-invoice payment, a 500.00 unapplied payment and a voided payment; 2 synthetic delivery rows.

Row ids are the entity id zero-padded to 10 digits (`invoices/0000001042`). Ids and automatic DocNumbers come from `meta/counters`.

## Operations

All HTTP paths are prefixed `/v3/company/{realmId}` and use `Authorization: Bearer`. QuickBooks puts create, update, delete and void
of an entity on one `POST /<entity>` (selected by `Id`+`SyncToken` in the body and `?operation=`), and Firedrill matches routes on
method and path only, so each writable entity has one REST dispatcher operation (`*.post`) whose output carries `action`. The
`requestid` query parameter is the idempotency key on every write route; `minorversion` is accepted and ignored.

| operation | MCP alias | HTTP route | notes |
|---|---|---|---|
| `company-info.get` | `get_company_info` | `GET /companyinfo/{companyId}` | `time` is company virtual time |
| `query.run` | — | `GET /query?query=`, `POST /query` (`application/text` body) | `select * \| count(*) \| fields from Customer\|Item\|Invoice\|Payment\|Account\|CompanyInfo`, `where` with `AND`, `=`, `<`, `>`, `<=`, `>=`, `IN`, `LIKE` (`%` only), `orderby`, `startposition`, `maxresults` ≤ 1000 |
| `customers.get` | `get_customer` | `GET /customer/{id}` | `Balance` computed from invoices |
| `customers.post` | — | `POST /customer` | create, full update, sparse update (`sparse: true`), `?operation=update` |
| `customers.search` | `search_customers` | — | criteria array/object, `limit`, `offset`, `asc`, `desc`, `count`, `fetchAll` |
| `customers.create` | `create_customer` | — | `{ customer }` |
| `customers.update` | `update_customer` | — | `{ customer }` with `Id` and `SyncToken` |
| `customers.delete` | `delete_customer` | — | makes the customer inactive (QuickBooks has no customer delete); refused with an open balance |
| `items.get` | `read_item` | `GET /item/{id}` | |
| `items.post` | — | `POST /item` | `Service` and `NonInventory` only |
| `items.search` | `search_items` | — | |
| `invoices.get` | `read_invoice` | `GET /invoice/{id}` | `LinkedTxn` payments and a `SubTotalLineDetail` line |
| `invoices.post` | — | `POST /invoice` | `?operation=update\|delete\|void`, `?include=allowduplicatedocnum` |
| `invoices.send` | — | `POST /invoice/{id}/send?sendTo=` | synthetic delivery row; sets `EmailStatus EmailSent` and `DeliveryInfo` |
| `invoices.pdf` | `get_invoice_pdf` | `GET /invoice/{id}/pdf` | HTTP answers `application/pdf` bytes; MCP answers base64 |
| `invoices.search` | `search_invoices` | — | |
| `invoices.create` | `create_invoice` | — | `{ customer_ref, line_items[{ item_ref, qty, unit_price }] … }` |
| `invoices.update` | `update_invoice` | — | `{ invoice_id, patch }`; missing `SyncToken` means the current one |
| `invoices.delete` | `delete_invoice` | — | id or `{ Id, SyncToken }` |
| `payments.get` | `get_payment` | `GET /payment/{id}` | `UnappliedAmt` computed |
| `payments.post` | — | `POST /payment` | `?operation=update\|delete\|void`; linked invoice balances change in the same operation |
| `payments.search` | `search_payments` | — | `{ customer_ref, txn_date_from, txn_date_to, limit }` |
| `payments.create` | `create_payment` | — | `{ customer_ref, total_amt, line[{ amount, linked_txn }] … }` |
| `accounts.get` | `get_account` | `GET /account/{id}` | `CurrentBalance` computed from the ledger |
| `accounts.search` | `search_accounts` | — | |

25 operations, 14 HTTP routes, 19 MCP aliases. Endpoints outside this list do not exist (404 or 405).

### Behaviour

- Money is computed in integer cents; line `Amount` must equal `Qty × UnitPrice`. No sales tax is calculated (`TotalTax` is 0).
- Invoice `Balance` = `TotalAmt` − applied payment lines. A payment line can never exceed the invoice's open balance, link an invoice
  of another customer or a voided invoice; the applied total can never exceed `TotalAmt`.
- Voiding an invoice zeroes its amounts and un-applies linked payments (they keep `TotalAmt` and become unapplied); deleting it
  removes the row and un-applies the same way. Voiding or deleting a payment restores the invoice balances.
- `SyncToken` increases on every write of a row, including balance changes caused by payments; a stale token fails `5010`.
- Customer and item names are unique case-insensitively (`6240`); invoice `DocNumber` is unique unless `include=allowduplicatedocnum` (`6140`).
- Queries on Customer, Item and Account return only active rows unless `Active` is filtered. Default order is `Id`.
- Malformed percent-encoding: serve decodes query strings leniently, so a broken escape such as `%E0%A4%A` reaches the Tool as U+FFFD. U+FFFD anywhere in a query (GET `query=` or a POST text body) fails `4000` "Error parsing query" instead of running a corrupted search, and U+FFFD in `sendTo` fails `6000` "Invalid Email Address format". A correctly encoded U+FFFD (`%EF%BF%BD`) is rejected the same way. `%ZZ` stays literal, and non-ASCII values such as `café` work normally.
- Scans are bounded by `meta/limits.maxScanRows` (default 5000). Passing the bound fails `STATE_BOUND_EXCEEDED` (HTTP 500,
  `SystemFault`) instead of returning partial results. Query pages stop before about 900 KB of encoded JSON: the rows that
  fit are returned and `maxResults` counts them, so `STARTPOSITION + maxResults` is the next position. Because of that, a
  page shorter than the requested `MAXRESULTS` cannot be told apart from the last page (real QuickBooks clients, including
  Intuit's SDK samples, treat a short page as the end): a client that wants every row must continue until a page comes back
  as an empty `QueryResponse` (`{"QueryResponse":{}}`), or drive its loop from `select count(*)`; the bundled app does the
  former. The first row of a page is always returned (see the invoice byte bound under Limitations), so a row that `GET` can
  read is always found by its own query; a single row that could never fit fails `STATE_BOUND_EXCEEDED` rather than an
  opaque framework 500.

### Errors

Errors use the QuickBooks `Fault` envelope: `{ "Fault": { "Error": [{ "Message", "Detail", "code", "element" }], "type" }, "time" }`.

| declared error | QuickBooks code | HTTP |
|---|---|---|
| `OBJECT_NOT_FOUND` | 610 | 400 |
| `REQUIRED_PARAM_MISSING` | 2020 | 400 |
| `INVALID_REFERENCE` | 2500 | 400 |
| `QUERY_PARSE_ERROR` / `QUERY_VALIDATION_ERROR` | 4000 / 4001 | 400 |
| `STALE_OBJECT` | 5010 | 400 |
| `BUSINESS_VALIDATION` | 6000 | 400 |
| `DUPLICATE_DOC_NUMBER` / `DUPLICATE_NAME` | 6140 / 6240 | 400 |
| `AUTHENTICATION_FAILED` | 3200 | 401 |
| `AUTHORIZATION_FAILED` | 3100 | 403 |
| `THROTTLE_EXCEEDED` (fault only) | 3001 | 429 |
| `STATE_BOUND_EXCEEDED` | 10000 | 500 |
| `SERVICE_UNAVAILABLE` (fault only) | 10000 | 503 |

## Events and faults

- Events `invoice.changed`, `payment.changed`, `customer.changed` with `{ realmId, name, id, operation, lastUpdated }`, following the
  entity/operation vocabulary of QuickBooks webhooks (one event per entity change, not a batched notification).
- Fault `throttled` (all operations, before): HTTP 429, code `3001`.
- Fault `write-outage` (the 12 writes, before): HTTP 503; reads keep working.
- Fault `payment-response-lost` (`payments.post`, `payments.create`, after commit): the payment is saved and events are emitted, but the
  caller receives 503. A naive retry of a full payment then fails `6000`; a retry of an unapplied payment creates a second payment.

## Compatibility

Not verified against a real client. No official Intuit SDK or `node-quickbooks` has been run against this package, so
`manifest.compatibility` is empty. The package conformance suite (`firedrill tool test quickbooks`, 16 drills) exercises the HTTP routes
with plain `fetch` and the MCP aliases with raw JSON-RPC.

Known deviations from QuickBooks Online:

- **Fault responses have no `time`.** A fault outcome never runs the handler, so throttling and outage bodies omit `time`; declared
  errors include it. The exact 429 and 503 bodies are not published by Intuit; the shapes here are approximations.
- **Framework refusals.** Over HTTP, a request the input schema rejects (for example a JSON array as the body) is rendered as a `6000`
  Fault whose Detail is `Business Validation Error: arguments do not match quickbooks.<operation>`; over MCP the client receives the
  MCP input-validation error instead; a request body nested deeper than 512 levels is refused before the operation runs. A caller denied by
  Firedrill grants receives HTTP 403 before the handler runs.
- **MCP results are JSON**, not the text content of the stdio MCP server. `search_*` return `{ results, totalCount? }`.
  `get_invoice_pdf` returns base64 and refuses `output_path` (a Tool cannot write files). `delete_customer` makes the customer inactive.
- **`requestid` reuse.** Replaying a write with the same `requestid` and body returns the first result (JSON key order may differ).
  Reusing a `requestid` with a different body returns HTTP 400 with a `6000` ValidationFault whose Detail is the framework message
  `the idempotency key was already used with different arguments`, without `time`; QuickBooks' own behaviour for that case is not published.
- **Large query pages.** A page whose entities would exceed about 900 KB of UTF-8 JSON is cut before the first row that does
  not fit; `maxResults` counts the rows returned and `startPosition + maxResults` is the next position. QuickBooks itself
  only cuts a page at `MAXRESULTS`, so its clients treat `maxResults` below what they asked for as the last page — here that
  assumption silently drops every row after a byte cut. Callers must continue until an empty `QueryResponse` (or compare
  with `select count(*)`). `search_*` with `fetchAll` has no next position and fails `STATE_BOUND_EXCEEDED` (HTTP 500,
  `10000` SystemFault) when everything does not fit; use `limit` and `offset` instead.
- **Malformed escapes in the path.** Firedrill decodes every path segment before it matches a route, so a broken percent escape in
  the path (`GET …/customer/%E0%A4%A`, `…/customer/%ZZ`, `/v3/company/%E0%A4%A/customer/58`) answers HTTP 404 with the framework body
  `{"schemaVersion":1,"code":"framework.HTTP_ROUTE_NOT_FOUND","error":"synthetic API route not found"}` rather than a QuickBooks Fault;
  the Tool is never called. A well-formed id that merely does not exist (including a correctly encoded U+FFFD, `%EF%BF%BD`) reaches the
  Tool and gets the `610` Object Not Found Fault. The canonical `/v1/operations` path takes ids as JSON, so it always reaches the Tool.
- **`intuit_tid`** is the Firedrill call id, not an Intuit transaction id.
- **Webhooks** are modelled as Firedrill events; no `dataChangeEvent` HTTP notification is delivered unless you configure callbacks.

## Browser app

`firedrill serve` prints an app link for this Tool (also under **Tools → Open app** in the inspector). The app recreates the current
QuickBooks Online web layout, is served from `firedrill/tools/quickbooks/app/site/`, and every screen calls this Tool's own operations
through `/_firedrill/client.js`, so UI writes are visible over HTTP/MCP and the reverse. It never reads the browser clock: "today" comes
from the `time` field of `company-info.get` / `query.run` (world virtual time in the company time zone).

| screen | what works | operations |
|---|---|---|
| Home | greeting, shortcuts, Invoices widget (unpaid overdue / not due yet, paid not deposited / deposited), Bank accounts, Sales last 30 days, Customers owing money | `company-info.get`, `query.run` |
| Sales & Get paid → Invoices | money bar filters, status / date / customer filters, invoice-number search, 25-per-page paging, Receive payment, row menu Edit / Send / Print or download / Void / Delete with confirmations, row selection with the "N selected" batch bar (Print transactions / Send transactions / Delete, each reported per row) | `query.run`, `invoices.post`, `invoices.send`, `invoices.pdf` |
| Invoice form (new / edit) | customer, e-mail, terms (fixed list), dates, invoice no. (automatic when blank), line table, message and internal notes, totals and balance due, Save, Save and send, duplicate-number prompt ("Use anyway"), stale-edit banner | `invoices.get`, `query.run`, `invoices.post`, `invoices.send` |
| Receive payment | customer, date, method, reference, deposit account, outstanding invoices with per-line amounts, unapplied remainder | `query.run`, `payments.post` |
| Payments | received payments with customer filter and paging, Void / Delete | `query.run`, `payments.post` |
| Customers | money bar, search, open-balance filter, include inactive, paging, New customer drawer, row actions, row selection with the "N selected" batch bar (Make inactive, reported per row) | `query.run`, `customers.post` |
| Customer page | contact header, open and overdue totals, Transaction list, Customer details, Edit, Make inactive / active | `customers.get`, `query.run`, `customers.post`, `customers.delete` |
| Products & services | search, status filter, paging, New / Edit drawer (Service, Non-inventory), Make inactive / active, row selection with the "N selected" batch bar (Make active / Make inactive, reported per row) | `query.run`, `items.post` |
| Accounting → Chart of accounts | read-only account list with balances, name/number search, include inactive | `query.run` |

Mutations send an idempotency key, reused only when retrying a throttled attempt. Lists refresh when the world revision moves, unless a
form or dialog is open. Access failures (for example the `reports_only` role) render "You don't have access" states; QuickBooks Fault
details and codes appear in error banners.

The left menu collapses to an icon rail with the "Collapse the menu" control, as it does in the real client; each rail item keeps its
label as a tooltip and accessible name, and the choice is remembered for the browser session. Below 900px the menu becomes the drawer
opened by the top-bar menu button.

Chrome that is visible but **not simulated** (it opens a "not simulated by this Tool" panel): Bookmarks, Feed, Reports, All apps,
Expenses & Bills, Banking, Payroll, Taxes, Mileage, My accountant, Team, Customize, the Overview and All sales tabs, My experts, Help,
Notifications, Settings, the account menu, templates, import, the batch-actions entries Print packing slip (invoices) and Email and
Create statements (customers) and Reclassify and Assign category (products & services), list print/export/settings icons (including the chart of accounts print and table-settings icons), the Home Profit & loss and Expenses cards, statements, form history/settings/help icons, and
every Create-menu entry other than Invoice, Receive payment, Add customer and Add product/service. Inventory and Bundle item types are
shown disabled. The font is Figtree (OFL), a stand-in for Intuit's proprietary typeface; logo sources are recorded in
`firedrill/tools/quickbooks/app/assets/ATTRIBUTION.md`.

## Limitations

- One company, US English, USD only: no multicurrency, sub-customers (jobs), classes, departments, locations or custom fields.
- No sales tax engine: `TaxCodeRef` is stored (`TAX`/`NON`) but `TotalTax` is always 0; `GlobalTaxCalculation` accepts only `NotApplicable`.
- Items are `Service` and `NonInventory` only; no inventory quantities, bundles or categories.
- Invoice lines are `SalesItemLineDetail` only (no discount, description-only or group lines). Estimates cannot be linked.
- An invoice has at most 250 lines and each `Line.Description` at most 4,000 characters (as in QuickBooks), and additionally
  all `Line.Description` text on one invoice (including descriptions inherited from items) totals at most 600,000 bytes
  *as returned* — JSON-encoded UTF-8 without the quotes, so a newline, quote or backslash counts 2 bytes, a control
  character 6 and a CJK character 3 (`6000` ValidationFault on create, full update and sparse update, over REST and MCP).
  This keeps every stored invoice readable by `GET`, the PDF route, a single-row query and every list page that contains
  it under the framework's 1 MiB response cap.
- Payments link invoices only (no credit memos or journal entries) and do not process cards (`ProcessPayment` must be false).
- Terms are a fixed list (`1` Due on receipt, `2` Net 15, `3` Net 30); payment methods are stored as given refs.
- The chart of accounts, CompanyInfo and account balances are read-only; `CurrentBalance` is derived from invoices and payments only.
- Not implemented (the routes do not exist): vendors, bills, estimates, sales receipts, credit memos, refunds, deposits, transfers,
  journal entries, purchases, employees, time activities, attachables, preferences, reports, batch, change data capture, OAuth endpoints.
- The query language has no `OR`, parentheses, `NOT` or joins (QuickBooks has none either); `LIKE` supports `%` only.
- The user-role model (`standard_limited_customers`, `reports_only`) is a simplified test fixture.
- "Send" records a synthetic delivery row; no e-mail is sent. The PDF is a simple deterministic one-page layout, not Intuit's template.

## Trademarks

QuickBooks, Intuit and their logos (bundled unmodified in the browser app) are trademarks of Intuit Inc. They are used only to identify the simulated service in a test environment.
This package is not affiliated with or endorsed by Intuit.
