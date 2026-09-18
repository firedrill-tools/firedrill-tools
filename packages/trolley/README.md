# @firedrill-tools/tool-trolley

A synthetic **Trolley payouts merchant account (sandbox mode)** for [Firedrill](https://firedrill.run). An agent that pays
freelancers, creators or suppliers through Trolley's REST API v1 can run against this Tool instead of the real service:
recipients, payout accounts, batches with FX quotes and processing, payments and balances behave statefully, with
Trolley's JSON field names, page-number paging and `{ ok: false, errors: [...] }` error envelope.

Nothing here contacts Trolley, a bank, PayPal, Venmo or a check printer. No money moves, no e-mail or webhook is sent,
and no identity or tax verification happens. All state lives in the Firedrill world (SQLite, reset, virtual time,
evidence); every operation computes its result from that state.

It also ships a browser app, a recreation of the Trolley merchant dashboard that reads and writes the same records as the API routes (see "Browser app").

## Install

```sh
firedrill tool add /absolute/path/to/firedrill-tools-tool-trolley-0.1.1.tgz --install
firedrill serve
```

A new world receives the starter data below and grants for all 24 operations. For an existing world, add the starter
rows you need and grant the operations (`packageId: "trolley"`, operation ids from the table below) to your actors.

Point your agent's Trolley client at the served HTTP binding (connection recipe `trolley-rest`):

| client variable | Firedrill value |
|---|---|
| `TROLLEY_API_BASE_URL` | `FIREDRILL_HTTP_URL` |
| `TROLLEY_ACCESS_TOKEN` | `FIREDRILL_HTTP_TOKEN` |

Requests authenticate with `Authorization: prsign <token>` or `Authorization: Bearer <token>` (see Compatibility).

## Identities and access

A Trolley API key belongs to one merchant and is account-wide, so access is modelled with actor attributes, not row owners:

| attribute | effect |
|---|---|
| `merchantId` | Optional. Must equal the seeded merchant id `M-4Lk9Qx2Rb7Tn3Vw8Yz1Ca6` (`meta/merchant.id`). A different value makes every operation answer **401 `invalid_api_key`**. |
| `accessLevel` | Optional, `full` (default) or `read_only`. A `read_only` key may list, get and summarise; every create, update, delete, generate-quote and start-processing answers **403 `not_authorized`**. Any other value is `invalid_api_key`. |
| `displayName` | Optional; not used by the backend. |

**Fresh-install fallback:** an actor with neither attribute (as created by `firedrill tool add`) is the seeded merchant with
full access. Framework grants still decide whether an actor may call an operation at all; a missing grant is a Firedrill
denial (HTTP 403, rendered in Trolley's envelope with code `not_authorized`).

## Starting data

`starter.json` (and `firedrill/baseline.scenario.json`) seed 89 fictional rows at virtual time 2026-09-15T14:00:00Z for the
merchant **Larkspur Creator Studio** (US, USD, sandbox). All names, e-mails (`@example.com`), phone numbers and bank data
are invented; account numbers exist only as their last four digits.

- `meta`: `merchant`, `counters` (`next: 1000`), `fx` (synthetic rates per USD: CAD 1.352, EUR 0.912, GBP 0.781,
  AUD 1.498, MXN 17.24), `fees` (fixed fee and route minimum per payout method, in USD).
- 3 balances: `paymentrails` USD 18,420.55 (primary), `paymentrails` CAD 2,150.00, `paypal` USD 640.00.
- 14 recipients: 8 active (US ACH bank, US business paid by check, CA EFT bank with a second PayPal account and a disabled
  former bank account, GB bank, DE IBAN bank, US PayPal, US Venmo, MX bank), 2 incomplete (no address; no payout method),
  1 archived (same e-mail as a newer active recipient), 1 suspended, 1 compliance-blocked, 1 disabled.
- 11 batches (two pages at the default page size): 6 open batches arranged to exercise every processing rule (ready to
  process; expired FX quote; insufficient funds; one payment to a recipient disabled after it was added; a check below the
  route minimum; empty), 4 complete August batches and 1 failed batch.
- 22 payments (plus 22 `payment_index` rows) with fees and FX computed by the Tool's own pricing rules.

Row ids follow Trolley's format `<prefix>-<22 characters>` (`R-` recipient, `A-` account, `B-` batch, `P-` payment); new ids
come from `meta/counters`, so runs are deterministic.

## Operations and routes

No MCP aliases are declared (Trolley publishes no MCP tool contract); MCP clients use the canonical `trolley.<operation>` tools.
Every route answers 200 on success with `ok: true`.

| operation | HTTP route | notes |
|---|---|---|
| `recipients.create` | `POST /v1/recipients` | optional `accounts` array; status derived (active needs address + primary account) |
| `recipients.get` | `GET /v1/recipients/{recipientId}` | computed `payoutMethod`, `primaryCurrency`, `routeType`, `routeMinimum`, `estimatedFees`, masked `accounts` |
| `recipients.update` | `PATCH /v1/recipients/{recipientId}` | `address` merged per field; `status: "active"` restores an archived recipient |
| `recipients.delete` | `DELETE /v1/recipients/{recipientId}` | archives; refused while the recipient has a pending payment in an open batch |
| `recipients.list` | `GET /v1/recipients` | `page`, `pageSize` (≤ 1000), `search`, `name`, `email`, `referenceId`, `status`, `complianceStatus`, `country`, `payoutMethod`, `currency`, `tags`, `orderBy`, `sortBy` |
| `recipient_accounts.create` | `POST /v1/recipients/{recipientId}/accounts` | `bank-transfer`, `paypal`, `check`, `venmo` |
| `recipient_accounts.list` | `GET /v1/recipients/{recipientId}/accounts` | active accounts, primary first |
| `recipient_accounts.get` | `GET /v1/recipients/{recipientId}/accounts/{accountId}` | includes disabled accounts |
| `recipient_accounts.update` | `PATCH /v1/recipients/{recipientId}/accounts/{accountId}` | `primary: true` demotes siblings; number, IBAN, type and country are immutable |
| `recipient_accounts.delete` | `DELETE /v1/recipients/{recipientId}/accounts/{accountId}` | disables the account |
| `batches.create` | `POST /v1/batches` | optional `payments` (≤ 1000) |
| `batches.get` | `GET /v1/batches/{batchId}` | computed `amount`, `totalPayments` |
| `batches.update` | `PATCH /v1/batches/{batchId}` | open batches only |
| `batches.delete` | `DELETE /v1/batches/{batchId}` | open batches only; removes their payments |
| `batches.list` | `GET /v1/batches` | `page`, `pageSize`, `search`, `status`, `currency`, `tags`, `orderBy` (`createdAt`, `amount`, `status`), `sortBy` |
| `batches.generate_quote` | `POST /v1/batches/{batchId}/generate-quote` | quote valid for 90 minutes of virtual time; 406 when the batch is not open |
| `batches.start_processing` | `POST /v1/batches/{batchId}/start-processing` | 409 when not open or empty; see processing rules |
| `batches.summary` | `GET /v1/batches/{batchId}/summary` | per payout method and total |
| `payments.create` | `POST /v1/batches/{batchId}/payments` | `recipient` `{ id \| email \| referenceId }`; `amount` + `currency` in the batch currency or the payout currency |
| `payments.list` | `GET /v1/batches/{batchId}/payments` | `page`, `pageSize`, `status`, `search` |
| `payments.get` | `GET /v1/batches/{batchId}/payments/{paymentId}`, `GET /v1/payments/{paymentId}` | |
| `payments.update` | `PATCH /v1/batches/{batchId}/payments/{paymentId}` | pending payments in open batches only |
| `payments.delete` | `DELETE /v1/batches/{batchId}/payments/{paymentId}` | pending payments in open batches only |
| `balances.list` | `GET /v1/balances`, `GET /v1/balances/{kind}` | `kind` is `paymentrails` or `paypal`; adds `serverTime` (virtual time) |

Errors use Trolley's envelope `{ "ok": false, "errors": [{ "code", "field"?, "message" }] }` with codes `invalid_api_key` (401),
`not_authorized` (403), `not_found` (404), `empty_field`, `invalid_field`, `expired_quote`, `non_sufficient_funds` (400),
`invalid_status` (409 on `start-processing`, 406 on `generate-quote`, 400 elsewhere), `rate_limit_exceeded` (429), `partner_integration_error`
and `internal_server_error` (500).
An `Idempotency-Key` request header (1 to 255 characters; blank is ignored) is forwarded as the Firedrill idempotency key, a Firedrill
addition: Trolley documents no idempotency header, so the outcomes are rendered with the closest documented code. Reusing a key with
the same body on the same route replays the recorded successful response; a call that failed with an error records nothing (the
framework rolls it back) and is re-executed on retry, so it may then succeed. Reusing a key with a different body answers
400 `invalid_field` on field `Idempotency-Key` ("Idempotency-Key was already used with a different request body"); sending it to a
read endpoint (every `GET`) or with more than 255 characters also answers 400 `invalid_field` on `Idempotency-Key`. Over the canonical
`/v1/operations/trolley/<operation>` path the same cases carry the framework codes `world.IDEMPOTENCY_CONFLICT` and
`framework.IDEMPOTENCY_NOT_SUPPORTED`.

### Processing rules

`start-processing` checks everything before writing, so a refused call changes nothing: the batch is open and has payments;
a payment needing currency conversion requires an unexpired quote (`expired_quote`); every attempted payment meets its route
minimum (`invalid_field` on `amount`); the `paymentrails` balance in the batch currency covers the sending amounts plus merchant
fees (`non_sufficient_funds`). The batch then settles in the same call: payments whose recipient is no longer active or has no
primary payout method fail with a `failureMessage`, the others are processed and debited, and the batch ends `complete` (at
least one processed) or `failed`.

Fees and minimums come from `meta/fees` (USD, converted at the `meta/fx` rate); `coverFees: true` moves the fee from the
recipient to the merchant. Cross rates are `rates[target] / rates[source]` rounded half up to six decimals; amounts round half up
to cents. PayPal payments pay in the batch currency.

## Events and faults

| id | kind | when |
|---|---|---|
| `batch.processing` | event | once per settled batch, payload `{ model: "batch", action: "processing", body: { batch } }` |
| `payment.processed` | event | per processed payment, `{ model: "payment", action: "processed", body: { payment } }` |
| `payment.failed` | event | per failed payment, `{ model: "payment", action: "failed", body: { payment } }` |
| `rate-limited` | fault (before) | `recipients.list`, `batches.list`, `payments.list` answer 429 `rate_limit_exceeded` |
| `payout-partner-outage` | fault (before) | `recipient_accounts.create`, `batches.generate_quote` answer 500 `partner_integration_error`; nothing changes |
| `processing-response-lost` | fault (after commit) | `batches.start_processing` settles the batch, debits the balance and emits events, then answers 500 `internal_server_error` |

The events mirror Trolley's webhook body so a consumer-declared callback can forward them; the package declares no callbacks.

## Browser app

`firedrill serve` prints the app link (also under **Tools → Open app**). The app is declared as `"ui": { "root": "app/site", "entry": "index.html" }`
and is plain local HTML/CSS/JS using `/_firedrill/client.js`; every screen calls the operations above, so a change made in the app is visible over
HTTP and MCP and vice versa, and a world reset restores both.

- **Chrome**: collapsible icon rail with the Trolley app tile (Overview, Recipients, Payments, Invoices, Balances, Tax Center, Reports, Approvals,
  Developers, Settings), top bar with page title, notification bell, the synthetic actor id with a `SANDBOX` pill, and the account menu.
- **Overview**: available Trolley balance, value of completed batches, recipient count and incomplete profiles, batches awaiting processing,
  recently completed batches.
- **Recipients**: status tabs, search (`search`), payout-method and country filters, sortable columns, page/pageSize paging, **Add recipient**.
- **Recipient profile**: details with **Edit**, payout methods (masked numbers, primary badge, **Make primary**, **Remove** with confirmation),
  **Add payout method** (bank transfer, Venmo, PayPal, check), **Archive** / **Restore recipient**.
- **Payments**: batch list with status tabs, search, sorting, paging and **Create batch**. **Batch detail**: status, amount, payment count and quote
  expiry computed from world virtual time (`balances.list` `serverTime`), payments table with search and paging, **Add payment** with a recipient
  search picker, edit/remove pending payments, **Generate quote**, **Review** (batch summary by payout method), **Process batch** confirmation
  showing the debit and available balance, **Delete batch**.
- **Balances**: Trolley and PayPal balances with kind tabs.

Every mutation sends a fresh idempotency key per confirmed action and is never retried silently; a 500 or partner error while processing tells the
user the result is unknown and re-reads the batch. Loading skeletons, empty states, error states with **Try again**, and `not_authorized` /
`invalid_api_key` panels are rendered from the real outcomes. The app refreshes when `getContext().revision` changes, except while a form is open.
All record text is rendered with `textContent`.

Not simulated (the controls are present and open a "not simulated by this Tool" panel, with no invented data): Invoices, Tax Center, Reports,
Approvals, Developers, Settings, the notification feed, account settings and live mode. The app cannot read actor attributes, so it shows the
actor id instead of `displayName`, and a read-only key is discovered when a write is refused. Logos are the vendor's own files (see
`firedrill/tools/trolley/app/assets/ATTRIBUTION.md`); the typeface is Inter (OFL) standing in for the proprietary face.

## Compatibility

**Not verified against a real Trolley client.** `compatibility` is empty. Trolley's official SDKs sign each request
(`Authorization: prsign <accessKey>:<HMAC signature>` plus `X-PR-Timestamp`). Firedrill's HTTP binding compares the credential
after the scheme exactly with the world token, so a caller must send `Authorization: prsign <FIREDRILL_HTTP_TOKEN>` (or
`Bearer`). Signed SDK requests cannot authenticate unmodified; timestamps and signatures are never checked.

Framework-owned outcomes (a missing grant, input that fails the declared schema, a request the codec cannot map) keep the
framework's HTTP status and are rendered in Trolley's envelope (`not_authorized`, `invalid_field`, `not_found`). A missing or
wrong token answers the framework's 401 (`framework.HTTP_UNAUTHORIZED`), and trailing-slash paths (`/v1/recipients/`) and
endpoints outside the table answer the framework's 404; those responses never reach the Tool, so they keep framework bodies.

`generate-quote` and `start-processing` accept an empty body or `{}` (the routes are declared as text bodies because the framework
rejects empty JSON bodies).

## Limitations

1. Processing settles synchronously: no `initiating` or `processing` status is observable over REST (only in the
   `batch.processing` event), and there are no delayed bank settlements, returns or `payment.returned` events.
2. Not simulated (404): bulk deletes, recipient logs and payment history, offline payments, invoices, verifications, tax forms and
   profiles, webhook subscription management, recipient widget or portal URLs, approval workflows, funding and deposits, live mode.
3. Withholding and returned amounts are always `"0.00"`; `debit-card`, `mobile-wallet` and `interac` accounts cannot be created.
4. FX rates, fees and route minimums are synthetic (`meta/fx`, `meta/fees`), not Trolley's pricing. Cross-currency payment amounts
   are always shown at the table rate; a quote locks them for 90 minutes of virtual time.
5. Balances are a seeded snapshot; processing debits only `paymentrails:<batch currency>`.
6. Recipient status uses a simplified rule (address + primary account + holds); country-specific bank rules are reduced to digit
   checks for account number, routing/transit/sort code and CA institution number, and an IBAN shape check.
7. Full account numbers and IBANs are never stored: only the last four characters, always shown masked.
8. Lists are page-number based. A page whose JSON would exceed 900 KB answers `invalid_field` on `pageSize`. Every state scan is
   bounded by 10,000 rows (lower with `meta/limits.maxRows`); exceeding it answers `internal_server_error` instead of truncating.
9. Unsupported list query parameters (for example `startDate`) answer `invalid_field` rather than being ignored.
10. The default exclusion of archived recipients from lists, e-mail uniqueness among non-archived recipients and several error
    messages are inferred from public documentation, not verified against the live API. Recipient responses omit `gravatarUrl`,
    `compliance`, `governmentIds` and similar fields that the Tool does not model.
11. `balances.list` adds `serverTime`, and idempotent replay via `Idempotency-Key` is a Firedrill addition (see "Operations and routes"
    for how key reuse and misuse are rendered). A replayed response carries the same values as the original, but the framework
    stores the recorded result in canonical form, so its JSON keys come back in alphabetical rather than Trolley's field order.

## Conformance

`firedrill tool test trolley` runs 12 drills (Node built-ins only, `test/conformance.mjs`) twice and checks determinism: recipients,
accounts, batch lifecycle, processing rules, read-only key, another merchant's key, fresh-install actor, framework denial, and one
scenario per fault plus a lowered scan bound. Together they observe every operation, declared error, event and fault.

## Trademarks

Trolley, the Trolley name and the Trolley logos are trademarks of their owner. The name and the unmodified logo files bundled in the
browser app (sources recorded in `firedrill/tools/trolley/app/assets/ATTRIBUTION.md`) are used only to identify the simulated service in a
test environment; this package is not affiliated with or endorsed by Trolley. PayPal and Venmo are named only as payout-method types.

## License

Apache-2.0
