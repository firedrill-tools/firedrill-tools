# @firedrill-tools/tool-stripe

A synthetic **Stripe account in test mode** for [Firedrill](https://firedrill.run): customers, synthetic card
payment methods, PaymentIntents with the full status machine, charges, refunds, products, prices, invoice items,
invoices (draft → open → paid | void), subscriptions and a computed balance, exposed through a bounded subset of
the Stripe REST API v1 (`/v1/…`, form-encoded requests, API-version `2026-08-26.dahlia` object shapes, the Stripe
error envelope, `Idempotency-Key`) and through the per-resource tool names of Stripe's agent toolkit MCP server.
Agents that talk to Stripe through `stripe-node`/`stripe-python`-style REST calls or over MCP can be exercised
against it without a Stripe account, a secret key or network access.

Everything is computed from the world's state: ids come from a counter row, timestamps from Firedrill's virtual
clock, card outcomes from a fixed test-card catalogue. Nothing here contacts Stripe or a card network; no e-mail,
receipt, PDF or hosted page is ever sent or served.

Package id `stripe`, version `0.1.0`, engine `>=0.1.0 <0.2.0`, license Apache-2.0. The package ships a **browser
app**: a recreation of the Stripe Dashboard (sandbox) that drives the same operations — see "Browser app" below.

## Install

```sh
firedrill tool add ./firedrill-tools-tool-stripe-0.1.0.tgz --install   # or the npm name once published
firedrill serve --scenario baseline --no-open
```

`firedrill serve` prints the HTTP and MCP endpoints and their tokens. A new world receives the starter data and
the grants below. Existing worlds do not change silently: add the grants and (optionally) the `starter.json` rows
to your own world or scenario.

### Grants and identities

Every actor that should use the Tool needs the grants for the operations it may call (`packageId: "stripe"`):

```
balance.retrieve  dashboard.context
customers.create  customers.retrieve  customers.update  customers.list
payment_methods.list  payment_methods.attach  payment_methods.detach
payment_intents.create  payment_intents.retrieve  payment_intents.list  payment_intents.confirm
payment_intents.capture  payment_intents.cancel
charges.retrieve  charges.list  refunds.create  refunds.list
products.create  products.retrieve  products.update  products.list  prices.create  prices.retrieve  prices.list
invoice_items.create  invoices.create  invoices.retrieve  invoices.list  invoices.finalize  invoices.pay  invoices.void
subscriptions.create  subscriptions.retrieve  subscriptions.list  subscriptions.update  subscriptions.cancel
```

A Stripe secret key is account-wide, so there is no per-user record ownership. Actor **attributes** model what
varies per key; every attribute is optional and a fresh actor without any attribute behaves as a full test-mode
secret key:

| attribute | meaning |
|---|---|
| `livemode` (boolean, default `false`) | Every object the actor reads or creates is stamped with this `livemode`. Stripe's test payment method ids (`pm_card_visa`, …) resolve only in test mode; a live-mode key gets `404 resource_missing` (`No such PaymentMethod: 'pm_card_visa'`). Rows are shared across actors regardless of mode (one account, one dataset). |
| `permissions` (object) | Restricted-key permissions: keys are the resource groups `balance`, `customers`, `payment_methods`, `payment_intents`, `charges`, `refunds`, `products` (products and prices), `invoices` (invoices and invoice items), `subscriptions`; values `none`, `read` or `write`. Absent attribute = a full secret key. A missing key inside the object = `none`. An operation needing a level the key lacks fails `PERMISSION_DENIED` (HTTP 403, `invalid_request_error`, "This API key does not have the required permissions for this endpoint on account … Having the '<group>: <level>' permission would allow this request to continue."). Cross-resource operations need several groups (`refunds.create`: `refunds: write` + `charges: read`; `subscriptions.create`: `subscriptions: write`, `customers: read`, `products: read`, `invoices: write`, `payment_intents: write`). |
| `keyName` (string) | Display only; never rendered into responses. |

Framework grants decide whether an actor may call an operation at all (framework `denied` → 403 in the Stripe
envelope); the attributes decide what the call may do.

### Connections

Two connection recipes are declared: `stripe-sdk` (`STRIPE_SECRET_KEY` = the HTTP binding token, sent as
`Authorization: Bearer …`; `STRIPE_API_BASE` = the HTTP binding URL) and `stripe-agent-toolkit-mcp`
(`STRIPE_MCP_URL` / `STRIPE_MCP_TOKEN` for the MCP binding). The values are isolated world tokens for test
processes only.

## Starting data

`starter.json` (and the conformance `firedrill/world.json`) contain 109 fictional rows and set `virtualTimeUs`
`1789376400000000` (2026-09-14T09:00:00Z), which `firedrill tool add` copies into a new project's world, so objects
created in a fresh install are stamped 2026-09-14 and sort after the seeded data: account `acct_1S00Q1HxKLumenTr` **Lumen Trail Supply Co.** (US, `usd`, statement
descriptor `LUMEN TRAIL`), an outdoor-gear shop selling one-off orders and two membership plans, with 12
customers (one without e-mail, two sharing an e-mail, a mixed-case e-mail, non-ASCII names, a GB customer with
`tax_exempt: reverse`, a customer with three cards, one without any payment method, one whose default card
declines, one whose card requires 3D Secure, one delinquent with a past-due invoice, one with three pending invoice
items in two currencies), 14 materialised test cards (one unattached), 6 products (one inactive), 10 prices (four
one-time incl. `gbp` and a zero amount, five recurring incl. a 14-day trial and an inactive legacy plan, lookup
keys `summit_monthly`/`summit_yearly`), 21 PaymentIntents in every status (three charges inside the two-day
pending window, one uncaptured, one declined with `last_payment_error`, one 3DS `requires_action`, one canceled,
seven belonging to invoices), 13 charges, 4 refunds, 9 invoice items, 12 invoices (draft with lines, empty draft,
open `send_invoice`, open past due, paid manual and subscription invoices, void, uncollectible) and 6
subscriptions (`active` with two items, `trialing`, `past_due`, `active` with `cancel_at_period_end`, `canceled`,
`incomplete`; one anchored on the 31st). Starter ids use object sequences below 1000; created objects start at
sequence 1000 (`cus_0000RS…`).

## Operations

| operation | MCP alias (agent toolkit) | HTTP route |
|---|---|---|
| `balance.retrieve` | `retrieve_balance` | `GET /v1/balance` |
| `dashboard.context` | — | — (canonical operation only: `POST /v1/operations/stripe/dashboard.context`, MCP `stripe.dashboard.context`) |
| `customers.create` | `create_customer` | `POST /v1/customers` |
| `customers.retrieve` | — | `GET /v1/customers/{customer}` |
| `customers.update` | — | `POST /v1/customers/{customer}` |
| `customers.list` | `list_customers` | `GET /v1/customers` |
| `payment_methods.list` | — | `GET /v1/payment_methods?customer=` and `GET /v1/customers/{customer}/payment_methods` |
| `payment_methods.attach` | — | `POST /v1/payment_methods/{payment_method}/attach` |
| `payment_methods.detach` | — | `POST /v1/payment_methods/{payment_method}/detach` |
| `payment_intents.create` | — | `POST /v1/payment_intents` |
| `payment_intents.retrieve` | — | `GET /v1/payment_intents/{payment_intent}` |
| `payment_intents.list` | `list_payment_intents` | `GET /v1/payment_intents` |
| `payment_intents.confirm` | — | `POST /v1/payment_intents/{payment_intent}/confirm` |
| `payment_intents.capture` | — | `POST /v1/payment_intents/{payment_intent}/capture` |
| `payment_intents.cancel` | — | `POST /v1/payment_intents/{payment_intent}/cancel` |
| `charges.retrieve` | — | `GET /v1/charges/{charge}` |
| `charges.list` | — | `GET /v1/charges` |
| `refunds.create` | `create_refund` | `POST /v1/refunds` |
| `refunds.list` | — | `GET /v1/refunds` |
| `products.create` | `create_product` | `POST /v1/products` |
| `products.retrieve` | — | `GET /v1/products/{product}` |
| `products.update` | — | `POST /v1/products/{product}` |
| `products.list` | `list_products` | `GET /v1/products` |
| `prices.create` | `create_price` | `POST /v1/prices` |
| `prices.retrieve` | — | `GET /v1/prices/{price}` |
| `prices.list` | `list_prices` | `GET /v1/prices` |
| `invoice_items.create` | `create_invoice_item` | `POST /v1/invoiceitems` |
| `invoices.create` | `create_invoice` | `POST /v1/invoices` |
| `invoices.retrieve` | — | `GET /v1/invoices/{invoice}` |
| `invoices.list` | `list_invoices` | `GET /v1/invoices` |
| `invoices.finalize` | `finalize_invoice` | `POST /v1/invoices/{invoice}/finalize` |
| `invoices.pay` | — | `POST /v1/invoices/{invoice}/pay` |
| `invoices.void` | — | `POST /v1/invoices/{invoice}/void` |
| `subscriptions.create` | — | `POST /v1/subscriptions` |
| `subscriptions.retrieve` | — | `GET /v1/subscriptions/{subscription}` |
| `subscriptions.list` | `list_subscriptions` | `GET /v1/subscriptions` |
| `subscriptions.update` | `update_subscription` | `POST /v1/subscriptions/{subscription}` |
| `subscriptions.cancel` | `cancel_subscription` | `DELETE /v1/subscriptions/{subscription}` |

Canonical names are also reachable as `POST /v1/operations/stripe/<operation>` and as MCP tools
`stripe.<operation>`. `dashboard.context` is the one operation without a Stripe route: it returns the simulated
account (`account.id`, `business_name`, `country`, `default_currency`, `statement_descriptor`, `support_email`),
the world's virtual time (`now`, Unix seconds), `livemode`, the calling key's permission level per resource group
(`permissions.<group>` = `none | read | write`) and `api_version`. It never fails (a key without permissions gets
`none` everywhere) and exists so the browser app — or any client — can render "today" from the world clock rather
than the machine clock. Every operation takes the Stripe REST parameter names (snake_case, `expand[]`,
`metadata[key]`, `items[0][price]`, `created[gte]`, …) and returns the Stripe API object or list envelope
`{ object: "list", data, has_more, url }`.

Behaviour highlights, all computed from state:

- **Cards** are synthetic. Stripe's published test ids `pm_card_visa`, `pm_card_visa_debit`, `pm_card_mastercard`,
  `pm_card_amex`, `pm_card_chargeDeclined`, `pm_card_chargeDeclinedInsufficientFunds` and
  `pm_card_authenticationRequired` are accepted wherever a payment method is expected; attaching or confirming
  with one materialises a real `pm_…` object (the response id differs from the test id, as in Stripe's test mode).
  A materialised card keeps a private outcome that decides every later confirmation; the fingerprint reveals the
  underlying test card.
- **PaymentIntents** follow `requires_payment_method → requires_confirmation → requires_action | requires_capture |
  succeeded | canceled`. `confirm=true` on create, `/confirm`, `/capture` (partial capture supported, the remainder
  is released without a refund object) and `/cancel` (an uncaptured charge is released: `refunded: true`). Every
  attempt produces a charge with `payment_method_details.card`, `outcome`, `balance_transaction`, a `.test` receipt
  URL; successful captures emit `payment_intent.succeeded`.
- **Declines answer HTTP 402 `card_error`** with Stripe's error envelope (`type: card_error`, `code: card_declined`,
  `decline_code`, `message`, `doc_url`, `request_log_url`). **Unlike Stripe, the failed attempt is not persisted**
  by `payment_intents.create` (`confirm=true`), `payment_intents.confirm` or `invoices.pay`: Firedrill discards every
  state write of an operation that ends in a declared error, id counters included (framework constraint, see
  Limitations). The 402 body therefore names only objects that existed before the call:
  - **Creation-time declines** (`payment_intents.create` with `confirm=true`, and `subscriptions.create` with
    `payment_behavior=error_if_incomplete`) deliberately carry **no `payment_intent`, no `payment_method` and no
    object id** — Stripe would include the new intent, but here it was never created. Its id would answer 404 and
    be handed to the next object created, so an agent retrying with it would silently act on an unrelated record.
    Retry with a new create; list `GET /v1/payment_intents` to confirm nothing was stored.
  - **`/confirm` and `/pay` declines** name the **existing** PaymentIntent as the attempt would have left it
    (`requires_payment_method` with `last_payment_error`), but never a charge (`latest_charge: null`, no
    `last_payment_error.charge`) and the PaymentMethod only when it existed before the call (the intent's stored
    method or the customer's default); a catalogue test card such as `pm_card_chargeDeclined` passed to the call is
    materialised inside the rolled-back operation, so `payment_method` and `last_payment_error.payment_method` are
    omitted. A retrieve afterwards shows the pre-attempt state (e.g. `requires_confirmation` with the original
    `payment_method`, `last_payment_error: null`); after a `/pay` decline the invoice stays `open` with
    `attempt_count: 0`.

  No failed charge is stored and `payment_intent.declined` is not emitted by these three operations. Retrying
  `/confirm` or `/pay` with another `payment_method` works. The failed attempt *is* persisted (intent
  `requires_payment_method` with `last_payment_error`, a `failed` charge, invoice `attempt_count: 1`, event
  `payment_intent.declined`) where the call itself succeeds: `subscriptions.create` with `payment_behavior`
  `default_incomplete` (default) or `allow_incomplete`, which returns an `incomplete` subscription.
- **Refunds** by `charge` or `payment_intent`, partial or full; `amount_too_large` beyond the unrefunded amount,
  `charge_already_refunded` once fully refunded, `charge_not_captured` for authorisations, `charge_not_refundable`
  for failed charges. Each refund emits `charge.refunded`.
- **Balance** is computed per currency: `available` = captured charges older than two virtual days minus their
  refunds, `pending` = the same for the last two virtual days.
- **Customers** (`email` is not unique; the `email` filter is exact and case-sensitive), partial updates,
  metadata merge (`""` deletes a key; 50 keys / 40-char keys / 500-char values), `invoice_settings.default_payment_method`
  must be attached to the customer. `delinquent` is derived: `true` while an open invoice is past its `due_date`.
- **Products and prices**: `default_price` only through `products.update` with a price of that product;
  `lookup_key` unique among active prices (`resource_already_exists`); recurring intervals bounded to one year;
  prices are immutable (no `prices.update`).
- **Invoice items** are pending (`invoice: null`) until the customer's next `invoices.create` sweeps the ones in
  the invoice currency (`pending_invoice_items_behavior=exclude` skips them), or are appended to a given **draft**
  invoice (`invoice_not_editable` otherwise). `invoices.create` infers `send_invoice` when `days_until_due` is given.
- **Invoices**: `finalize` assigns `<customer prefix>-<sequence>`, `.test` hosted/PDF URLs and, for a positive
  total, opens the invoice with one `InvoicePayment` and a `requires_payment_method` PaymentIntent (nothing is
  attempted automatically); a zero total is `paid` immediately. `pay` confirms that intent with `payment_method`,
  the intent's method or the customer default (`invoice_no_payment_method` when none), or marks it
  `paid_out_of_band` (the intent is canceled). `void` cancels the intent (`cancellation_reason: void_invoice`). A
  PaymentIntent that belongs to an open invoice cannot be confirmed or canceled directly
  (`payment_intent_invoice_managed`).
- **Subscriptions**: every price must be active, recurring, and share one currency and interval; the first invoice
  (`billing_reason: subscription_create`, one `subscription_item_details` line per item) is finalized and — for
  `charge_automatically` with a positive total — paid in the same transaction: `active` on success, `incomplete`
  without a usable method or on a decline, `trialing` with `trial_period_days`/`trial_end` (a `$0` paid invoice),
  `active` with an open invoice for `send_invoice`. Item periods (`current_period_start/end`) live on the items;
  month/year steps clamp to the end of month. `update` edits items (add/change/remove, never all), 
  `cancel_at_period_end` (`cancel_at` = period end, `cancellation_details.reason: cancellation_requested`, status
  unchanged), `default_payment_method`, `trial_end` (`"now"` activates), metadata and `cancellation_details`;
  `proration_behavior` is accepted and ignored. `DELETE` cancels immediately (`ended_at`), voids an incomplete
  subscription's open invoice and emits `customer.subscription.deleted`; a second `DELETE` answers 404 as Stripe
  does. Listing hides `canceled`/`incomplete_expired` unless `status=all`, `ended` or the status is named.
- **Lists** are newest first with `limit` (1–100, default 10), `starting_after`/`ending_before` cursors that must
  name an existing object (`resource_missing` on the cursor otherwise), `created`/`due_date` range filters and the
  documented equality filters. `expand[]` (one level, `data.` prefix on lists) is allowed for: PaymentIntent
  `customer`, `payment_method`, `latest_charge`; Charge `customer`, `payment_intent`, `payment_method`, `refunds`;
  Refund `charge`, `payment_intent`; Customer `invoice_settings.default_payment_method`; PaymentMethod `customer`;
  Product `default_price`; Price `product`; InvoiceItem `customer`, `invoice`; Invoice `customer`,
  `default_payment_method`, `payments.data.payment.payment_intent`, `lines.data.pricing.price_details.price`,
  `parent.subscription_details.subscription`; Subscription `customer`, `default_payment_method`, `latest_invoice`,
  `latest_invoice.payments.data.payment.payment_intent`. Anything else: `This property cannot be expanded`.
- **Response size.** The framework refuses any HTTP response over 1 MiB, so list pages are filled by `limit` *and* by
  the encoded UTF-8 size of the objects returned, expansions included (at most 950,000 bytes of objects per page).
  A page the byte budget ends early answers `has_more: true`, and `starting_after` (its last object) or
  `ending_before` (its first object) resumes exactly at the first object not returned; backward pages are filled from
  the cursor outward. A single object, with its requested expansions, larger than 900,000 bytes of JSON answers 400
  `invalid_request_error` (`parameter_invalid`, "… is too large to return in one response …") instead of a partial
  body; `POST /v1/invoiceitems` refuses a line that would push its draft invoice past that bound (nothing is written).
  An expanded `charge.refunds` embeds the newest 10 refunds with `has_more` and `total_count`, as Stripe does; list
  the rest with `GET /v1/refunds?charge=`.

### Wire format

`POST` routes take `application/x-www-form-urlencoded` bodies in Stripe's bracket syntax (a JSON body gets the
framework's 415); `GET`/`DELETE` routes take query strings in the same syntax and no body. `Authorization: Bearer
<token>` is the only accepted auth (HTTP Basic, `curl -u sk_test_…:`, is rejected with the framework's 401).
`Idempotency-Key` is honoured by the framework: the same key replays the original response (including a replayed
503). Every response carries `Request-Id: req_…`, `Stripe-Version: 2026-08-26.dahlia` and echoes
`Idempotency-Key`. Errors use `{ error: { type, code?, message, param?, doc_url?, decline_code?, payment_intent?,
payment_method?, request_log_url } }`:

| tool error | HTTP | `type` / `code` |
|---|---|---|
| `INVALID_REQUEST` | 400 | `invalid_request_error` / `parameter_missing`, `parameter_invalid`, `parameter_invalid_integer`, `parameter_invalid_string`, `parameter_invalid_empty`, `parameter_unknown`, `parameter_invalid_boolean`, `email_invalid`, `resource_already_exists`, `amount_too_small`, `amount_too_large`, `state_bound_exceeded`\* |
| `INVALID_STATE` | 400 | `invalid_request_error` / `payment_intent_unexpected_state`, `charge_already_refunded`, `invoice_no_customer_line_items`, `invoice_not_editable`, `invoice_payment_intent_requires_action`, `subscription_canceled`, and this Tool's own codes\* `payment_method_already_attached`, `payment_method_unattached`, `payment_method_customer_mismatch`, `payment_intent_payment_method_missing`, `payment_intent_invoice_managed`, `charge_not_captured`, `charge_not_refundable`, `invoice_not_finalized`, `invoice_already_paid`, `invoice_void`, `invoice_no_payment_method`, `invoice_payment_intent_missing`, `customer_missing_payment_method` |
| `CARD_DECLINED` | 402 | `card_error` / `card_declined` with `decline_code` `generic_decline` or `insufficient_funds` |
| `PERMISSION_DENIED` | 403 | `invalid_request_error` (no code); a framework-denied actor gets the same shape |
| `RESOURCE_MISSING` | 404 | `invalid_request_error` / `resource_missing`, `param` names the parameter |
| `RATE_LIMITED` | 429 | `invalid_request_error` / `rate_limit` |
| `API_ERROR` | 503 | `api_error` |
| framework schema rejection | 400 | `invalid_request_error` / `parameter_invalid` with the framework message (`arguments do not match stripe.<operation>`) — an unknown parameter or a non-integer `amount` lands here; the offending parameter is not named |
| form/query decoding refused | 400 | `invalid_request_error` / `parameter_unknown` "Received unknown parameter: <key>" for a bracket segment `__proto__`, `constructor` or `prototype` (in any position, including `metadata[...]`); `parameter_invalid` "Invalid array: <key>…" for an array index above 999 or more than 1,000 `[]` entries; `parameter_invalid` "Invalid parameter: <key> is nested more than 20 levels deep." — `param` names the (truncated) key. These messages are this Tool's wording\* |

Codes marked \* are this Tool's naming where Stripe's exact code was not verified.

**Malformed percent-encoding.** The framework decodes query strings and form bodies leniently: a broken escape such as
`%E0%A4%A` becomes U+FFFD (`%ZZ` stays literal, and a broken escape in a *path* segment is a 404). A filter value that
carries U+FFFD is a mangled request, not a value that legitimately matches nothing, so every free-text list filter —
`email` (customers), `customer`, `type` (payment methods), `ids` (products), `product`, `lookup_keys`, `currency`
(prices), `customer`, `subscription` (invoices), `customer`, `price` (subscriptions), `customer` (payment intents),
`customer`, `payment_intent` (charges) and `charge`, `payment_intent` (refunds) — answers
`400 invalid_request_error / parameter_invalid` "Invalid `<param>`: the value contains an
invalid character (U+FFFD); check the percent-encoding of the request." with `param` naming the parameter, over both the
`/v1/...` routes and the canonical `/v1/operations/stripe/<operation>` path. A correctly encoded U+FFFD (`%EF%BF%BD`) is
rejected the same way. Correctly encoded non-ASCII text (`caf%C3%A9`, CJK, emoji) is unaffected and still matches.
The five closed-enum filters (`type` on
prices, `status` and `collection_method` on invoices and on subscriptions) never reach that guard: the declared enum
schema rejects a mangled value first, so they answer `400 invalid_request_error / parameter_invalid` with the generic
framework message (`arguments do not match stripe.<operation>.list`) and **no** `param` field.
`starting_after`/`ending_before` cursors and `expand[]` entries already answer `resource_missing` (404) and
"This property cannot be expanded" (400) for such values, so they are left as they are.

The form decoder (`lib/form.mjs`) is bounded and never throws: it builds null-prototype maps, rejects reserved
segments, caps nesting depth (20 bracket segments) and array indices (0–999, leading zeros not significant, so `items[0001]`
is index 1), and does work proportional to the request size. A codec cannot return a response from `decode` (a throw becomes the framework's
`HTTP_REQUEST_MAPPING_FAILED`), so a refused form travels to `encode` as the single argument `firedrill:form_error`,
which every closed input schema rejects before any handler runs; `encode` renders it as the row above. Such a request
is never executed and forwards no `Idempotency-Key`. Canonical JSON arguments are parsed by the framework, which drops
a `__proto__` member before the handler sees it. Paths outside the table above
get the framework 404 (`{"error":"route not found"}`, not Stripe's `Unrecognized request URL`).

## Events and faults

Events: `payment_intent.succeeded` (once per intent reaching `succeeded`), `payment_intent.declined` (once per
persisted decline — a Tool-specific name; Stripe's analogue is `payment_intent.payment_failed`), `invoice.paid`,
`charge.refunded` (once per refund, with `fully_refunded`) and `customer.subscription.deleted`. Consumers can attach
callbacks to them in their own world.

Faults (select them in a scenario with `faults: [{ packageId: "stripe", faultId }]`):

| fault | timing | effect |
|---|---|---|
| `rate-limited` | before, the 37 Stripe-shaped operations (not `dashboard.context`) | `429 rate_limit` "Request rate limit exceeded…"; nothing runs. |
| `api-unavailable` | before, every write (20 operations) | `503 api_error`; nothing is written, reads keep working. |
| `refund-committed-lost` | after commit, `refunds.create` | The refund **is** created (charge `amount_refunded` advanced, `charge.refunded` emitted) yet the caller sees 503. A retry with the **same** `Idempotency-Key` replays the 503 without a second refund; a retry with a **new** key refunds again — a partial-amount retry double-refunds silently, a full-amount retry hits `400 charge_already_refunded`. Exactly the trap an agent must handle. |

## Conformance

`firedrill tool test stripe` runs ten drills twice over the HTTP and MCP bindings (a scripted target,
`test/conformance.mjs`, Node built-ins only): the full REST flow (every route, error path and edge case), the MCP
aliases, a read-only restricted key, a key without permissions, a live-mode key, a framework-denied actor, large
byte-bounded pages walked both ways (the "Response size" rules), and one drill per fault. Together they observe every operation, every declared error of every operation, all five events
and all three faults, and the repeat pass proves determinism.

## Protocol compatibility

The HTTP surface follows the Stripe API reference field-by-field for the routes above (form encoding,
`Idempotency-Key`, list envelope, error envelope, statuses, API-version `2026-08-26.dahlia` object shapes), so
`stripe` (npm 22.x) constructed with `host`/`port`/`protocol` from the HTTP binding and `stripe` (PyPI) with
`stripe.api_base` are the intended clients — but **no official client has been run against this Tool**:
compatibility is by reference, not verified against a real client, and the manifest `compatibility` array is
empty. The sixteen MCP aliases reproduce the per-resource tool names of `@stripe/agent-toolkit` 0.7.9 / `@stripe/mcp`
≤ 0.2.x and accept those tools' argument names; they return the full REST object or list (a superset of the
toolkit's trimmed results). Stripe's current remote MCP server (`mcp.stripe.com`, `@stripe/mcp` 0.3.x,
`@stripe/agent-toolkit` 0.9.x) exposes generic `stripe_api_read` / `stripe_api_write` / `stripe_api_search` /
`get_stripe_account_info` tools instead; those, and the toolkit's payment-link, coupon, dispute and documentation
tools, are not provided.

## Limitations

- A bounded synthetic subset: 38 operations (37 Stripe-shaped + `dashboard.context`), 38 routes, eleven resource types. No Checkout Sessions, Payment Links,
  SetupIntents, Sources/Tokens/legacy cards, Coupons, Disputes, Payouts, Transfers/Connect (`Stripe-Account` is
  ignored), Balance transactions, Events, Webhook endpoints, Search endpoints, Tax, Billing portal, Quotes, Credit
  notes, Subscription schedules, metered billing, API v2 or OAuth. `payment_intents.update`,
  `invoices.update/delete/send/mark_uncollectible`, `customers.delete`, `payment_methods.create`, `products.delete`
  and `prices.update` are absent.
- Byte-bounded responses: pages may hold fewer than `limit` objects when the objects are large (see "Response size");
  the 900,000-byte single-object bound and its error message are this Tool's, not Stripe's (Stripe bounds objects
  through its own field limits).
- Form and query parameters: the segments `__proto__`, `constructor` and `prototype` are refused everywhere (Stripe
  would accept them as `metadata` keys), nesting is capped at 20 bracket segments and arrays at 1,000 entries
  (indices 0–999); the error messages for these refusals are this Tool's wording, not Stripe's.
- Cards are the only payment method type and come from a seven-entry test catalogue; no raw card numbers, tokens,
  wallets, bank debits or 3D Secure completion (a `requires_action` intent can only be canceled).
  `automatic_async` capture behaves like `automatic`.
- **Declined confirmations are not persisted — a framework constraint.** Stripe answers 402 *and* stores the
  attempt. A Firedrill operation either commits, and then its HTTP status is always the route's 2xx
  `successStatus` (`@firedrill-tools/protocol-http` `src/wire.ts:423-424`; the codec's `ToolHttpResponse` has no status
  field, `@firedrill-tools/tool-sdk` `src/types.ts:105-108`; `successStatus` is limited to 200–299,
  `@firedrill-tools/contracts` `src/operation.ts:278`), or fails with a declared error, which the kernel turns into an
  abort of the state transaction the handler ran in (`@firedrill-tools/world-kernel` `src/world-kernel.ts:424-433` and
  `:794-811`; `ToolFailureOptions` has no commit option, `@firedrill-tools/tool-sdk` `src/failure.ts:6-11`). A 402 with
  persisted state is therefore not expressible, and `payment_intents.create/confirm` and `invoices.pay` declines
  roll back as described under Operations. Failed attempts are persisted only through `subscriptions.create`.
  Because the rollback also resets the id counters, a creation-time decline body (`payment_intents.create` with
  `confirm=true`, `subscriptions.create` with `error_if_incomplete`) deliberately omits the PaymentIntent — it was
  never created, and its id would 404 and then be reassigned to the next object — so it carries the error envelope
  only, unlike Stripe's body; `/confirm` and `/pay` decline bodies name only the existing intent and pre-existing
  PaymentMethod. Assert declines through the 402 envelope, through `subscriptions.create` state or through
  `payment_intent.declined`.
- Money: integer minor units; the 50-minor-unit minimum applies to every currency (no per-currency minimums, no
  zero-decimal handling beyond accepting `jpy` amounts as-is); twelve supported currencies; no conversion; customer
  `balance` credit is shown but never applied; no taxes, discounts, coupons, shipping or application fees
  (`total == subtotal`); partial capture does not create the release refund object.
- Invoices: `auto_advance` is stored but nothing advances automatically; no dunning, retries,
  `next_payment_attempt`, e-mail, PDF or hosted page (`.test` URLs resolve nowhere); `paid_out_of_band` cancels the
  intent instead of recording an out-of-band payment object; ad-hoc items carry `pricing: null`; `uncollectible`
  is reachable only through starter data; the customer snapshot is refreshed at finalization.
- Subscriptions: no renewal cycling, no `past_due`/`unpaid`/`paused`/`incomplete_expired` transitions (starter
  data only), no proration invoice items, one interval per subscription, `trial_end: "now"` activates without an
  invoice, `cancel_at` is stored but never fires, `DELETE` accepts no body (`invoice_now`/`prorate`/
  `cancellation_details` on cancel get the framework's 400 `HTTP_BODY_NOT_ALLOWED`), `billing_mode` is always
  `flexible`.
- Balance uses a fixed two-day pending window attributed by charge date (a refund reduces its charge's bucket);
  no payouts, fees or `instant_available`; `txn_…` ids have no object behind them.
- Lists scan the namespace with a bound of 10 000 rows and fail `400 state_bound_exceeded` rather than truncate.
  `url` in list envelopes is a relative path.
- Authentication is the world token as `Authorization: Bearer`; restricted-key permissions are nine coarse groups
  (no Stripe-granular scopes); the 403 wording is modelled on, not verified against, Stripe's. `Stripe-Version`,
  `Stripe-Account` and `Stripe-Context` headers are accepted and ignored.
- Framework-level rejections (unknown parameters, schema type mismatches, `Idempotency-Key` longer than 255
  characters, a body on `DELETE`) carry the framework's messages, not Stripe's `parameter_unknown` with `param`.
- Rate-limit and outage faults are scenario-selected only — no real per-second accounting.
- The browser app is a recreation of the Dashboard's core screens, not the whole product. Chrome for features outside
  this Tool renders in place with its glyph, hover state and a "(not simulated)" tooltip, and opens a short
  "… is not simulated by this Tool" panel instead of inventing data. Not simulated: sidebar Connect (Overview,
  Connected accounts, Transfers), Payments › Analytics, Disputes, Radar, Payment Links, Terminal, Billing › Overview,
  Usage-based, Revenue recovery, Reporting (Reports, Sigma, Revenue Recognition, Data management), More (Workflows,
  Tax, Identity, Issuing, Financial Connections, Capital, Climate); the sandbox banner's "Switch to live account";
  account menu "Switch to sandbox", "Manage sandboxes", "Create account"; top-bar Apps; Create menu "Payment link",
  "Coupon", "Quote"; help menu "Documentation", "Contact support"; settings menu "Personal details", "Team and
  security", "Branding", "Billing settings"; every list's "Export", "Edit columns" (plus Customers "Analyze" and
  Product catalog "Export prices"); filter chips other than Payments "Date and time" and the Invoices customer
  filter (Amount, Currency, Status, Payment method, Card, Created date, Due date, Type, Customer, Product, Price, More
  filters); Customers segment cards other than All (Top customers, First-time customers, Repeat customers, Recent
  customers, High refunds, High disputes: shown with a "–" count because segment analytics are not computed; All
  counts `customers.list`); Product catalog section tabs Coupons, Shipping rates, Tax rates and Pricing tables (the
  Products tab and its All / Active / Archived cards are live); Home "Add"/"Edit" widgets, the date-range, granularity
  and comparison chips (the overview is fixed to 7 daily points), the "Dispute activity" and "MRR" overview widgets
  and the Payouts card; payment "Add note" and "Events and logs"; customer "Events"; and the bulk actions on selected list rows ("Export selected", "Edit", "Delete" on Payments, Customers, Product catalog, Invoices and Subscriptions) — the row and header checkboxes select and deselect rows for real, but no bulk operation exists behind them. The Home "Net volume" widget is
  captured charge volume minus succeeded refunds per day; Stripe fees are not modelled, so no fee is subtracted. Search matches
  names, e-mails, descriptions and invoice numbers of the newest 1,000 records of each type (a note names every
  group that stopped at that bound) and jumps to pasted ids (no full-text search). Payment status tabs count and filter a client-side index because the API has no status filter
  for PaymentIntents. Shortcuts (pinned and recently visited pages) are a per-browser preference in localStorage.
  Card brands are text chips, not network logos. Dates render in UTC. The sandbox banner's exact colours and copy are
  modelled on Stripe's documented "banner at the top of the Dashboard", not verified pixel-for-pixel.

## Browser app

`firedrill serve` also serves a **Stripe Dashboard look-alike** (declared as `ui: { root: "app/site" }`): the
sandbox banner across the top ("You're testing in a sandbox…"), the account switcher, the left navigation (Home ·
Balances · Transactions · Customers · Product catalog, Shortcuts with pinned and recent pages, the Products groups
Connect · Payments · Billing · Reporting · More, Developers), the sidebar search with `/` (directly under the account switcher, as the current Dashboard places it) and the Collapse control at the sidebar foot that turns the navigation into an icon rail (remembered per browser; a Search button in the header opens the navigation on narrow screens), Developers, help (`?`), Apps,
notifications, settings and the round "+" Create menu, list pages with status cards, dashed filter chips, Export /
Edit columns, row-selection checkboxes with a floating "N selected" action bar, and cursor pagination (Payments, Customers,
Product catalog, Invoices, Subscriptions, Refunds, Transactions), detail pages with meta bar, timeline and
key/value sections (payment, customer with a right-hand Details rail, product, invoice, subscription), Home with a
Today gross-volume chart (hourly, virtual time), balance card and "Your overview" widgets (Gross volume, Successful
payments, Failed payments, Net volume and New customers computed from charges, refunds and customers), Customers
segment cards, Product catalog section tabs with All / Active / Archived counts, and the create flows: "Create a payment"
(customer picker, saved cards + Stripe's test cards, confirm/capture options, 402 declines shown inline),
"Add customer", "Add a product" with its first price, "Add a price", "Create an invoice" → draft editor (add
catalog or one-off items, finalize, charge, void, mark paid out of band), "Create a subscription" (multiple
prices, trial, collection method, payment behaviour), refund / capture / confirm / cancel dialogs, payment-method
attach/detach/default, subscription update/cancel/resume. No list stops silently at one request or at a bound.
Transactions "All activity" merges `charges.list` and `refunds.list` server-side page by page (one
`starting_after` cursor per stream, Previous / Next), so every charge and refund is reachable. A customer's payments,
subscriptions and invoices and a subscription's invoices have Previous / Next pagination. Where the app reads a
client-side index (a product's prices, a payment's refunds, a customer's cards, the Home overview metrics, payment
status tabs, the price, customer and card pickers and search), the index is read page by page with `starting_after`
up to 1,000 records. When that bound is reached the app says so: a `+` on counts and totals, "Partial: first N …" on
Home widgets, "Showing the first N …; more exist" on sections and pickers. The customer picker then looks up an exact
e-mail (`customers.list?email=`) or `cus_…` id on the server. Price pickers filter currency on the server and
expand `data.product`. Every control calls the same operations as the REST
and MCP surfaces through `/_firedrill/client.js` with idempotency keys on mutations; the page polls the world
revision and re-reads after external changes without discarding a form being edited. Restricted keys see
"This key does not have … permission" panels; framework-denied actors see a denied panel; faults surface as the
Dashboard's error banners. Every form label is linked to its control (`for`, or `aria-labelledby` on composite
controls such as the amount + currency group and the payment-method radio group), hints and field errors are
attached with `aria-describedby`, and ids come from a counter. "Today" and every date come from `dashboard.context.now` (virtual time), never from
the browser clock. The app bundles **Inter** (OFL) as the closest permissive match to Stripe's proprietary Söhne
face and the official Stripe marks downloaded from the `logos-apps` library; sources are listed in
`firedrill/tools/stripe/app/assets/ATTRIBUTION.md`.

## Trademarks

Stripe, the Stripe "S" icon and the Stripe wordmark are trademarks of Stripe, Inc. They are used only to identify
the service this package simulates in a test environment; there is no affiliation with or endorsement by Stripe.
Card network names (Visa, Mastercard, American Express) appearing as text labels are trademarks of their
respective owners and are used descriptively only.
