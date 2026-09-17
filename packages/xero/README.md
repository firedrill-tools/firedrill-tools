# @firedrill-tools/tool-xero

A synthetic **Xero Accounting API 2.0** subset for Firedrill. It simulates one fictional New Zealand organisation,
**Kōwhai Joinery Ltd**, with its chart of accounts, tax rates, contacts, sales invoices and bills, and payments. All
state lives in the Firedrill world (SQLite, virtual time, reset, evidence). No Xero service is contacted, "email invoice"
only records a synthetic send, and no money moves.

Kind: backend Tool (provider-shaped HTTP routes, canonical operations and MCP tool-name aliases) with a browser app that
recreates the Xero web app over the same operations (see "Browser app").

## Install

```sh
firedrill tool add /absolute/path/to/firedrill-tools-tool-xero-0.1.0.tgz --install
firedrill serve
```

A new world receives the starter data below and a default actor with every operation granted. For an existing world,
add grants for the operations you need (`packageId: "xero"`, operation ids in the table below) and the starter rows from
`starter.json`.

## Identities and permissions

A Xero access token belongs to one app connection and carries OAuth **scopes**; each REST request names the organisation
in the `xero-tenant-id` header. The Tool reads two optional actor attributes:

| attribute | meaning | when absent (fresh `firedrill tool add` actor) |
|---|---|---|
| `xeroTenantId` | tenant the token is connected to | the seeded tenant `6d1c2f0e-4b8a-4c3e-9a51-2f7e0b9d4c11` |
| `scopes` | space-separated OAuth scopes | all six: `accounting.settings`, `accounting.settings.read`, `accounting.contacts`, `accounting.contacts.read`, `accounting.transactions`, `accounting.transactions.read` |

Checks, in order: an actor `xeroTenantId` that differs from the organisation, or a REST call whose `xero-tenant-id`
header is missing or names another tenant, fails **403** `FORBIDDEN`. A missing scope fails **401** `UNAUTHORIZED`:
reads need `<family>.read` or `<family>`, writes need `<family>`. The families are `accounting.settings` (organisation,
accounts, tax rates), `accounting.contacts` (contacts) and `accounting.transactions` (invoices, payments, invoice e-mail).
Unknown scope words are ignored. There is no per-row ownership; Firedrill grants decide whether an actor may call an
operation at all (framework denial is 403).

## Starting data

`starter.json` (and the conformance `baseline` scenario) holds **55 rows**. Virtual time is `2026-09-14T22:00:00Z`,
which is 15 September 2026 10:00 in the organisation's fixed +12:00 zone.

- Organisation: Kōwhai Joinery Ltd, GST registered, financial year ending 31 March, `PeriodLockDate` 2026-03-31.
- 12 accounts: bank `090`/`091`, sales `200`, other revenue `260`, cost of goods `310`, expenses `429`/`453`, system accounts `610`/`800`/`820`, equity `970`, and archived `205`.
- 4 tax rates: `OUTPUT2` and `INPUT2` (15%), `NONE`, `ZERORATED`.
- 12 contacts. Edge cases: one archived (Old Mill Antiques), one without an e-mail (Riverbend Dental), one with a `ContactNumber` (`CUST-003`), non-ASCII names and cities, and one with no transactions.
- 16 invoices: `INV-1001`…`INV-1014` plus bills `TT-5521` and `BH-0098`. Statuses: 3 DRAFT (one with no lines, one tax-inclusive), 1 SUBMITTED, 4 AUTHORISED unpaid (two overdue, one due today), 1 AUTHORISED part-paid, 3 PAID ACCREC plus 1 PAID bill, 1 VOIDED and 1 DELETED.
- 6 payments. Edge cases: one reconciled (cannot be deleted), one already DELETED, and one bill payment.
- 2 synthetic invoice e-mail log rows, plus `meta/counters` (next invoice number 1015) and `meta/limits` (`maxScanRows` 5000).

## Operations

REST paths are relative to `/api.xro/2.0` on `FIREDRILL_HTTP_URL`, with `Authorization: Bearer <token>` and
`xero-tenant-id`. Canonical names are `xero.<operation>`; MCP aliases use the Xero MCP server's tool names.

| operation | MCP alias | HTTP route |
|---|---|---|
| `organisation.get` | `list-organisation-details` | `GET /Organisation` |
| `accounts.list` | `list-accounts` | `GET /Accounts` (`where`, `order`) |
| `accounts.get` | — | `GET /Accounts/{AccountID}` |
| `tax-rates.list` | `list-tax-rates` | `GET /TaxRates` (`where`, `order`, `TaxType`) |
| `contacts.list` | `list-contacts` | `GET /Contacts` (`where`, `order`, `page`, `pageSize`, `IDs`, `searchTerm`, `includeArchived`, `summaryOnly`, `If-Modified-Since`) |
| `contacts.get` | — | `GET /Contacts/{ContactID or ContactNumber}` (includes `Balances`) |
| `contacts.save` | — | `PUT /Contacts`, `POST /Contacts`, `POST /Contacts/{ContactID}` (`summarizeErrors`) |
| `contacts.create` | `create-contact` | — |
| `contacts.update` | `update-contact` | — |
| `invoices.list` | `list-invoices` | `GET /Invoices` (`where`, `order`, `page`, `pageSize`, `IDs`, `InvoiceNumbers`, `ContactIDs`, `Statuses`, `searchTerm`, `summaryOnly`, `unitdp`, `If-Modified-Since`) |
| `invoices.get` | — | `GET /Invoices/{InvoiceID or InvoiceNumber}` (`unitdp`; a value other than 2 or 4 answers 400 `ValidationException`) |
| `invoices.save` | — | `PUT /Invoices`, `POST /Invoices`, `POST /Invoices/{InvoiceID}` (`summarizeErrors`, `unitdp`) |
| `invoices.create` | `create-invoice` | — (creates DRAFT) |
| `invoices.update` | `update-invoice` | — (DRAFT only) |
| `invoices.email` | — | `POST /Invoices/{InvoiceID}/Email` → 204 |
| `payments.list` | `list-payments` | `GET /Payments` (`where`, `order`, `page`, `pageSize`) |
| `payments.get` | — | `GET /Payments/{PaymentID}` |
| `payments.create` | — | `PUT /Payments`, `POST /Payments` |
| `payments.record` | `create-payment` | — |
| `payments.delete` | — | `POST /Payments/{PaymentID}` with `{ "Status": "DELETED" }` |

Writes accept an `Idempotency-Key` header (at most 128 characters) or a canonical `idempotencyKey`; replay is Firedrill's
recorded-outcome semantics. Firedrill stores the recorded outcome as canonical JSON (keys sorted), so the Xero routes
project every envelope through a fixed field-order table (`lib/field-order.mjs`): a replay is the first response byte for
byte apart from the per-request `Id`, and stored rows (organisation, accounts, tax rates, addresses, phones) render in
Xero's documented field order rather than the store's sorted order. `pagination` precedes the collection, as in the Xero
Accounting API reference examples. The canonical `/v1/operations` envelope is Firedrill's own and keeps its sorted keys on
replay.

### Behaviour implemented

- **Envelope**: `{ Id, Status: "OK", ProviderName: "Firedrill", DateTimeUTC: "/Date(ms+0000)/", <Collection>: [...] }`. Dates are `/Date(ms+0000)/` with `DateString` / `DueDateString` companions, and null fields are omitted. `pagination { page, pageSize, pageCount, itemCount }` appears only when `page` is given. Unpaged invoice lists omit `LineItems`, as Xero does.
- **`where`**: a hand-written parser. It supports `==`, `!=`, `>`, `>=`, `<`, `<=`, `&&`/`AND`, `||`/`OR`, `!`/`NOT`, parentheses, `"text"`, numbers, `true`/`false`, `null`, `guid("…")`, `DateTime(y,m,d[,h,mi,s])`, and the `Contains`, `StartsWith` and `EndsWith` methods (case-insensitive). Nested paths such as `Contact.ContactID`, `Invoice.InvoiceNumber` and `Account.Code` work. Limits: 2,000 characters, 50 comparisons, nesting depth 10. Anything else, unknown fields, type mismatches and malformed encoding (U+FFFD) fail with `QueryParseException` (ErrorNumber 16). `order` takes up to 3 `Field [ASC|DESC]` keys.
- **Malformed percent-encoding**: serve decodes query strings leniently, so a broken escape such as `%E0%A4%A` reaches the Tool as U+FFFD. It is treated as a mangled request, never as search text: `where`, `order` and `TaxType` answer 400 `QueryParseException` (ErrorNumber 16), and `searchTerm`, `InvoiceNumbers` and the `payments.list` filters (`invoiceNumber`, `invoiceId`, `paymentId`, `reference`) answer 400 `ValidationException` (ErrorNumber 10). A correctly encoded U+FFFD (`%EF%BF%BD`) is rejected the same way. `%ZZ` stays literal, and non-ASCII searches such as `café` work normally.
- **Invoices**: totals, per-line tax (Exclusive / Inclusive / NoTax) and 4-dp unit amounts, plus Xero's status workflow. DRAFT and SUBMITTED can move to SUBMITTED, AUTHORISED or DELETED. AUTHORISED can be voided only without payments. PAID, VOIDED and DELETED refuse changes with "Invoice not of valid status for modification". An invoice with a payment refuses edits.
- **Approval** requires an active contact, lines with a valid AccountCode and TaxType, a DueDate (ACCREC) and a date after `PeriodLockDate`. Account codes must suit the document: bank, system and archived accounts are refused.
- **Numbers and contacts**: `INV-nnnn` numbers are assigned automatically and must be unique among non-deleted sales invoices; a deleted invoice's number may be reused. `Contact { Name }` with no match creates the contact.
- **Payments** apply only to AUTHORISED documents, cannot exceed `AmountDue`, and must go to a bank account or one that accepts payments. They update `AmountPaid`, `AmountDue`, `Status` (PAID) and `FullyPaidOnDate`. Deleting a payment (not reconciled) reopens a PAID invoice.
- **Contacts**: names must be unique among active contacts ("Please enter a unique Name."). `ContactStatus: ARCHIVED` archives a contact. `IsCustomer` / `IsSupplier` are derived from invoices. `Balances` (outstanding and overdue) appear on single GET only.
- **Batches**: `summarizeErrors=false` returns per-element `StatusAttributeString` and `ValidationErrors`. Otherwise one invalid element fails the whole request with `ValidationException` (ErrorNumber 10) and nothing is written.

### Error responses

| code | HTTP | body |
|---|---|---|
| `VALIDATION_EXCEPTION` | 400 | `{ ErrorNumber: 10, Type: "ValidationException", Message, Elements: [{ …, ValidationErrors: [{ Message }] }] }` |
| `QUERY_PARSE_EXCEPTION` | 400 | `{ ErrorNumber: 16, Type: "QueryParseException", Message }` |
| `POST_DATA_INVALID` | 400 | `{ ErrorNumber: 17, Type: "PostDataInvalidException", Message }` (non-object bodies, nesting over 512 levels, `constructor`/`prototype` keys). A `__proto__` key is removed while the HTTP layer parses JSON, before the Tool sees the body, so a body carrying one is processed without that key rather than rejected |
| `UNAUTHORIZED` / `FORBIDDEN` | 401 / 403 | `{ Type: null, Title, Status, Detail: "AuthorizationUnsuccessful", Instance, Extensions }` |
| `NOT_FOUND` | 404 | `text/plain` "The resource you're looking for cannot be found" |
| `RATE_LIMITED` | 429 | `text/plain` "Rate Limit Exceeded", `Retry-After: 60`, `X-Rate-Limit-Problem: minute` (fault only) |
| `SERVICE_UNAVAILABLE` | 503 | `text/plain` "Service Unavailable", `Retry-After: 30` (fault only) |
| `STATE_BOUND_EXCEEDED` | 500 | `{ ErrorNumber: 500, Type: "UnknownErrorException", Message }` |

## Events and faults

| id | kind | details |
|---|---|---|
| `invoice.changed` | event | Xero webhook vocabulary: `{ resourceUrl: "/api.xro/2.0/Invoices/{id}", resourceId, eventDateUtc, eventType: CREATE\|UPDATE, eventCategory: INVOICE, tenantId, tenantType: ORGANISATION, status }`. `status` is a Firedrill addition. Emitted once per invoice written by saves, MCP create/update and e-mail, and by payment create/delete. |
| `contact.changed` | event | Same shape with `eventCategory: CONTACT`. Emitted per contact written, including contacts auto-created from `Contact { Name }` on an invoice. |
| `rate-limited` | fault (before) | All 20 operations → 429 `Rate Limit Exceeded`. |
| `write-outage` | fault (before) | The 10 write operations → 503, and nothing is written. |
| `payment-response-lost` | fault (after commit) | `payments.create` and `payments.record` commit the payment and emit `invoice.changed`, but the caller sees 503. This is the retry/double-payment hazard: a retry with the same `Idempotency-Key` gets Firedrill's recorded outcome, while a blind retry is refused because the invoice is already PAID. |

No subscriptions or callbacks are declared: webhook delivery, `x-xero-signature` and the intent-to-receive handshake are not simulated.

## Connections

`manifest.connections` describes two test-side seams. `xero-rest` maps `XERO_BASE_URL` / `XERO_ACCESS_TOKEN` to the Firedrill HTTP binding (append `/api.xro/2.0`). `xero-mcp` maps `XERO_MCP_URL` / `XERO_MCP_TOKEN` to the MCP binding. Official Xero SDKs hard-code the API host, so the client must be configured to use a different base path.

## Compatibility

**Not verified against a real client.** `manifest.compatibility` is empty. Paths, parameter names, field names, the
status workflow and the ValidationException / QueryParseException bodies follow the public Xero Accounting API
OpenAPI description. The Xero MCP server's tool names and argument names are matched, but the aliases return JSON
entities rather than that server's formatted text and deep links. Neither xero-node nor the Xero MCP server has been
run against `firedrill serve`.

Approximations (not captured from the live service): the 401/403/404/429/500/503 bodies, the
`PostDataInvalidException` ErrorNumber, and several validation message texts. Among them: archived contact, voiding with
payments, reconciled payment deletion, lock-date wording, Idempotency-Key length. Framework-level rejections keep the
framework's own responses: an operation input that fails schema validation answers 400 with a ValidationException-shaped
body built from the framework message; a JSON body on a GET route, a wrong content type or unparseable JSON answers the
framework's 400/415 envelope; an undeclared route answers 404 or 405.

## Browser app

Declared as `"ui": { "root": "app/site", "entry": "index.html" }`. `firedrill serve` prints its link (Tools → Open app).
Every screen calls this Tool's own operations through `/_firedrill/client.js`, so a change made in the app is visible
over HTTP and MCP and the reverse; the app re-reads when the world revision changes (unless a form has unsaved input).

- **Chrome**: dark navy top bar with the Xero mark, organisation menu, Home · Sales · Purchases · Reporting · Payroll ·
  Accounting · Tax · Contacts · Projects menus, Create new (+), search, notifications, help and profile.
- **Home**: bank account cards (balance computed from payments recorded in this Tool), Invoices owed to you and Bills to
  pay (draft / awaiting approval / awaiting payment / overdue with amounts and due-date bars).
- **Sales → Invoices** and **Purchases → Bills to pay**: All · Draft · Awaiting Approval · Awaiting Payment · Paid tabs
  with counts, search by contact, number or reference (compiled to `where`), sortable columns, real paging.
- **Invoice / bill view**: status, line table with account and tax-rate names, totals, Approve / Submit for approval,
  Email (confirmation; recorded, never delivered), Void and Delete (confirmations), Make a payment, Remove payment.
- **New / edit invoice or bill**: contact typeahead (paged search; a new name creates the contact on save), dates,
  number, reference, Amounts are, line grid with live totals; Save as draft, Save & submit, Approve, Approve & email.
  Validation errors from `invoices.save` (`summarizeErrors=false`) are shown in place.
- **Contacts**: All · Customers · Suppliers · Archived, search, You owe / They owe, New contact and Edit dialogs,
  contact detail with balances and paged transactions, Archive / Restore.
- **Accounting → Chart of accounts** (read-only, by class), **Bank accounts** (paged payments), **Settings →
  Organisation details** (read-only).

Loading, empty, error and permission-denied states are rendered on every screen; every mutation carries a fresh
idempotency key per attempt and disables its buttons while pending. "Today" and overdue status come from the
response `DateTimeUTC` (world virtual time), never the browser clock.

Rendered but **not simulated** (they open a "not simulated by this Tool" panel or are disabled): Reporting, Payroll,
Tax, Projects, Sales overview, Online payments, Quotes, Products and services, Purchase orders, Expense claims, Bank
rules and reconciliation, Fixed assets, Manual journals, Find and recode, Smart lists, Contact groups, Repeating
invoices, credit notes, Import / Export, Send statements, Print PDF, date filters, notifications, help, profile,
Files, My Xero, history and notes, homepage editing, Net profit or loss / Cash in and out / Tasks cards, item
codes and line discounts in the editor, and the Save button on organisation settings.

App assets: the Xero logo from https://logos.lndev.me/logos/xero.svg and the Inter font (SIL OFL 1.1), with sources
and licence in `firedrill/tools/xero/app/assets/`. Xero's own typeface is proprietary; Inter stands in for it.

## Limitations

- One organisation (tenant) and NZD only: no multicurrency, `CurrencyRate` is always 1, and `unitdp` only changes `UnitAmount` precision.
- The organisation's zone is a fixed +12:00. New Zealand daylight saving is not applied, so "today" and overdue status can be one hour early during NZDT.
- Not implemented (the routes do not exist): items, credit notes, prepayments, overpayments, allocations, quotes, purchase orders, bank transactions and transfers, batch payments, manual journals, repeating invoices, tracking categories, contact groups and persons, branding themes, attachments, history and notes, online invoice links, invoice PDF, reports, users, currencies, account and tax-rate writes, payroll, projects, files, assets, bank feeds, webhooks, connections and OAuth endpoints. `ItemCode` is stored as given and never used for pricing.
- Accounts and tax rates are read-only. Line discounts, compound taxes and multi-component taxes are not modelled, and tax is rounded per line.
- The expected/planned payment date workflow, "invoice only" user approval permissions, CIS and cash-basis GST are not modelled.
- `createdByMyApp=true` is refused. `includeArchived` on invoices is accepted and has no effect, and `summaryOnly` omits lines, payments and contact status. Default sort orders are this Tool's choice: contacts by Name, invoices by Date then InvoiceNumber, payments by Date, accounts by Code, tax rates by Name; ties break by id.
- `where` supports only the grammar listed above: no `ToLower()`, `Any()`, arithmetic or `DateTime` with offsets.
- Rate limiting exists only as a fault scenario. Minute, daily and concurrent limits and their `X-*Limit-Remaining` headers are not tracked.
- "Email invoice" writes a synthetic log row (`invoice-emails`) and sets `SentToContact`. Nothing is delivered, and the daily e-mail limit is modelled only as 9,999 sends per invoice.
- Scans are bounded by `meta/limits.maxScanRows` (default 5,000, maximum 10,000). Past the bound, and for responses that would exceed about 900 KB, calls fail with `STATE_BOUND_EXCEEDED` instead of truncating.

## Conformance

The package ships its conformance project (`firedrill.json`, `firedrill/`, `test/conformance.mjs`): 7 actors, 5
scenarios (`baseline`, `rate-limited`, `write-outage`, `payment-response-lost`, `tight-limits`) and 14 drills. Together
they exercise all 20 operations, every declared error of every operation, both events and all three faults.

```sh
firedrill tool test xero
```

The conformance target is a scripted Tool test, not a model-driven agent.

## Trademarks

Xero, the Xero logo and related names are trademarks of Xero Limited. The product name and the logo files shipped in
the app belong to their owner and are used only to identify the simulated service in a test environment. This package
is not affiliated with, endorsed by or sponsored by Xero.

## License

Apache-2.0. See `LICENSE`.
