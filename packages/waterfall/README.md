# @firedrill-tools/waterfall

A synthetic **Waterfall** account for [Firedrill](https://firedrill.run): contact, phone and company enrichment
jobs, Search Contact and Search Company, Job Change, Email Verification, the Account Reporter (v2) and API-key
management, exposed through Waterfall-shaped REST routes (`x-api-key` header, JSON bodies, snake_case fields, the
`{ status, message, error, category, code }` error envelope) and through canonical Firedrill operations.

Every answer is computed from a **seeded synthetic directory** kept in Tool state (8 companies, 32 persons, an
account with a master key and two sub-keys, a prepaid balance and unit prices). No data vendor, DNS or network is
consulted, nothing is looked up on the internet, and the same world replays identically on any machine. Backend only:
there is no browser app.

## Install

```sh
firedrill tool add @firedrill-tools/waterfall --install
firedrill serve
```

`firedrill tool add` copies `starter.json` (virtual time 2026-09-16T10:00:00Z) into a new world and grants the
default actor every operation. In an existing world add grants for the operations you need
(`packageId: "waterfall"`, `operationId` from the table below) and copy the starter rows yourself.

## Identities

The `x-api-key` header must carry the Firedrill world's HTTP token (`FIREDRILL_HTTP_TOKEN`); it does not select the
Waterfall key. The **calling Waterfall key** is the actor attribute:

| attribute | effect |
|---|---|
| `waterfallApiKey` absent | the actor calls with the seeded **master key** (`00000001-0000-4000-8000-000000000001`, "Northwind master"). This is what a `firedrill tool add` actor gets, so a fresh install sees the whole seeded account. |
| `waterfallApiKey` = an active key's `api_key` | that key: a sub-key cannot manage API keys (`AUTH_NEED_MASTER_API_KEY`), never sees unit prices, and its usage lands on its own `usage` rows. |
| `waterfallApiKey` = an unknown or **inactive** key | every operation answers 403 `AUTH_BAD_API_KEY`. |

Framework grants decide whether an actor may call an operation at all; a framework denial is rendered on the wire as
403 `PERMISSION_NEED_ADMIN_API_KEY`.

## Starting data

`starter.json` and `firedrill/baseline.scenario.json` carry the same 180 rows:

- **Account** "Northwind Labs": balance 250 USD, `job_delay_us` 0, unit prices (USD) contact enrichment 0.138
  (+0.32 with a phone), phone enrichment 0.32, company enrichment 0.10, search contact 0.04 per person, search
  company 0.05 per company, job change 0.10, e-mail verification 0.02.
- **API keys**: master "Northwind master" (`per_interval` 50), sub-key "Outbound team" (active, 30), sub-key
  "Legacy zap" (inactive, 10).
- **Companies** (`.test`/`.example`/`.invalid` domains): northwind.test (Software Development, United States,
  201-500, Google MX, 3 funding rounds), contoso-freight.test (Truck Transportation, Germany, catch-all),
  fabrikam.example (Software Development, France, catch-all, `founded` null), tailspin-toys.test (Retail),
  woodgrove-bank.test (Banking, United Kingdom), adventure-works.test (Canada), litware.example (1-10, no phones),
  proseware.invalid (a non-routable mail domain).
- **Persons**: 14 at Northwind (Sales 5, Engineering 4, C-Suite 2, Marketing 2, Operations 1; one new hire from
  2026-08-01; two mobile phones; one with a personal e-mail only; one whose seeded professional e-mail is still at
  Contoso, so Job Change reports `moved`), 7 at Contoso, 4 at Fabrikam, 2 at Tailspin, 2 at Woodgrove, 1 at
  Adventure Works, 1 at Litware, and one person who left Fabrikam (`company_id` null, Job Change `left`). All
  names and addresses are fictional; personal addresses use `@example.com`.
- **Jobs**: a SUCCEEDED contact enrichment (yesterday), a FAILED phone enrichment, a TIMED_OUT company
  enrichment, an ABORTED contact search, a RUNNING contact enrichment and a RUNNING phone enrichment that are
  already due (they complete on their first read) and a RUNNING company enrichment due tomorrow.
- **Usage**: eight daily rows across July, August and September 2026 for the three keys.

Seeded ids follow `0000000K-0000-4000-8000-0000000000NN` (K = 1 keys, 2 companies, 3 persons, 4 jobs); see
`test/seed.mjs`.

## Operations

No MCP aliases are declared (Waterfall publishes Agent Skills over its REST API, not an MCP contract); the canonical
`waterfall.<operation>` names are exposed on the MCP binding with the same snake_case arguments as the routes.

| operation | HTTP route | notes |
|---|---|---|
| `enrichment.contact.launch` | `POST /v1/enrichment/contact` | one identifier strategy: `email`, `linkedin`, `full_name`+`domain` or `first_name`+`last_name`+`domain`; optional `include_phones`, `webhook_url`, `custom_fields`; answers `{ job_id, start_date }` |
| `enrichment.contact.get` | `GET /v1/enrichment/contact?job_id=` | finder: `RUNNING`, or terminal with `output.person` (or `null`) and inline `usage` |
| `enrichment.phone.launch` | `POST /v1/enrichment/phone` | same strategies without `include_phones` |
| `enrichment.phone.get` | `GET /v1/enrichment/phone?job_id=` | `output.person.mobile_phone` / `phone_numbers` (E.164) when seeded |
| `enrichment.company.launch` | `POST /v1/enrichment/company` | exactly one of `domain` (URL accepted), `linkedin`, `name` |
| `enrichment.company.get` | `GET /v1/enrichment/company?job_id=` | `output.company` with the 20 documented fields, or `null` |
| `search.contact.run` | `POST /v1/search/contact` | synchronous; one mode (`contact_linkedin`; `domain`/`company_linkedin`/`company_name`; or `company_location_countries`/`company_industries`/`company_employee_ranges` with `title_filters` or `title_lists`), filters, `page_number`/`page_size` |
| `search.contact.get` | `GET /v1/search/contact?job_id=` | the stored result |
| `search.company.run` | `POST /v1/search/company` | `industries`, `location_countries`, `sizes` (at least one), paging (default `page_size` 20) |
| `search.company.get` | `GET /v1/search/company?job_id=` | the stored result |
| `job_change.run` | `POST /v1/job/change` | one person identifier with at most one company reference; `moved`, `left`, `no_change` or `unknown` |
| `job_change.get` | `GET /v1/job/change?job_id=` | the stored result |
| `verify.email.run` | `POST /v1/verify/email` | `valid`, `risky`, `invalid` or `unknown` (not billed) with `smtp_provider` and `mx_records` |
| `account.get` | `GET /v2/account` | `key_usage`, `account_usage` (current virtual month, `month=YYYY-MM`, or `start_date`+`end_date`), `balance_remaining_usd`, `server_date`, `price` (master key only) |
| `api_keys.list` | `GET /v1/api-keys` | master key only |
| `api_keys.create` | `POST /v1/api-keys` | `notes`, optional `per_interval` (default 50, at most the master's) |
| `api_keys.modify` | `PUT /v1/api-keys` | `api_key`, `notes`, `active`, optional `per_interval`; the master key cannot be edited |

Launches and runs take no idempotency key (a replay launches a new job, as upstream); `api_keys.create` and
`api_keys.modify` accept the framework's optional `idempotencyKey`.

## Synthetic behaviour

- **Jobs.** Every launch or run writes a `jobs` row (`RUNNING`, `due_at_us = now + job_delay_us`) and emits
  `job.launched`. A job **completes** inside the first operation that observes it at or after `due_at_us`: its
  result is computed from the directory, `output` and `usage` are stored, the balance is debited, the key's daily
  `usage` row is bumped and `job.completed` is emitted. With the default `job_delay_us` of 0 that is the launching
  call itself (the launcher still answers only `{ job_id, start_date }`); the four synchronous kinds (searches, job
  change, verification) always complete in their call and answer the full finder shape. With a positive delay
  (scenario `slow-jobs`) finders answer `RUNNING` until virtual time reaches the due instant; the virtual clock does
  not tick on its own, so such jobs stay `RUNNING` until time is advanced explicitly, and the finder that first reads
  a due job performs the completion write. New jobs only ever reach `SUCCEEDED`; `FAILED`, `TIMED_OUT` and `ABORTED`
  exist as seeded historical jobs. A finder called with a job of another kind answers 404.
- **Resolution.** `domain` is normalised (URL, `www.`, path stripped; hostname validated; free-mail domains answer
  `VALIDATION_BAD_DOMAIN_EMAIL_PROVIDER`, social networks `VALIDATION_BAD_DOMAIN_SOCIAL_MEDIA`); `linkedin` accepts a URL
  or a bare handle; `email` is validated by hand and role mailboxes (`info@`, `sales@`, …) are refused where the
  address identifies a person. Persons resolve by e-mail, LinkedIn id, or collapsed case-insensitive full name within
  a company; companies by domain, LinkedIn id or exact case-insensitive name. A miss answers `SUCCEEDED` with
  `person: null` / `company: null` and zero usage.
- **Search Contact.** Filters are AND-ed and OR-ed within a list; departments, seniorities, countries, sizes and
  industries match exactly (case-insensitively) against fixed enums; `included_names`/`excluded_names` are substrings
  of the full name; `experience_start_date` and `experience_start_date_new_hire` both mean "current role started on
  or after"; `title_lists` match a title exactly; `title_filters` use `"quoted terms"` or bare words with `AND`,
  `OR`, `NOT` and parentheses (NOT > AND > OR; a term is a case-insensitive substring; explicit operators are
  required between terms). Results are ordered by person id and paged with `page_number` (1–100) × `page_size`
  (1–250, default 10); a page past the end is `persons: []`. Search results never carry e-mails or phones.
- **Job Change.** `unknown` when the person is not seeded; `left` when their `company_id` is null; with a company
  reference, `no_change` when it is their current company else `moved`; with `professional_email` alone, the
  address's domain is compared with the current company's domain; with `contact_linkedin` alone, `no_change`.
- **Email Verification.** A seeded professional address is `valid`; an unknown address at a seeded catch-all
  domain is `risky`; at a seeded strict domain or any `.invalid` domain `invalid`; an unknown domain is `unknown`
  and not billed. `smtp_provider` / `mx_records` come from the seeded company.
- **Billing and usage.** Money is integer micro-USD in state and a USD number on the wire. Prices come from
  `meta/account.price_micros`; a contact enrichment that returns a phone is billed persons + phones. Daily `usage`
  rows (`usage/{api_key}/{YYYY-MM-DD}`) count requests at launch and billed records at completion; the Account
  Reporter sums them over the interval (`start_date` inclusive, `end_date` exclusive; custom intervals at most 12
  months and within the last 12 months). Four counters (`search_company_*`, `job_change_*`) are additions to the
  documented list so every billed kind is reported.
- **Bounds.** Scans are bounded by `meta/limits.max_scan_rows` (default 5000) and pages by
  `meta/limits.max_response_bytes` (default 900 000 UTF-8 bytes); both fail with 500 `INTERNAL_UNCLASSIFIED_ERROR`
  rather than truncate. Every list or search result is computed from state; nothing is canned.

## Errors

Waterfall's own `CATEGORY_DETAIL` codes are the declared Firedrill error codes, so the wire envelope
`{ "status": "error", "message", "error": [detail…], "category", "code" }` maps one to one (`category` is the code's
prefix; `error[]` carries pydantic-style details such as `["notes: Field required"]` where the handler produces them,
otherwise `[message]`).

| code | HTTP | raised by |
|---|---|---|
| `VALIDATION_MISSING_BODY` | 400 | a POST/PUT whose body is missing or not a JSON object (`null`, `[]`, a string) |
| `VALIDATION_BAD_REQUEST` | 400 | missing or conflicting fields, bad types or lengths, unknown fields, bad `custom_fields`, bad `webhook_url`, bad paging, malformed reporter intervals; also every request the framework's strict input validation refuses (see Compatibility) |
| `VALIDATION_MISSING_JOB_ID_PARAMETER`, `VALIDATION_BAD_JOB_ID` | 400 | finders without, or with a non-UUID, `job_id` (a repeated parameter counts as malformed) |
| `VALIDATION_BAD_DOMAIN`, `VALIDATION_BAD_DOMAIN_EMAIL_PROVIDER`, `VALIDATION_BAD_DOMAIN_SOCIAL_MEDIA` | 400 | domain inputs |
| `VALIDATION_BAD_EMAIL_INVALID`, `VALIDATION_BAD_EMAIL_ROLE` | 400 | e-mail inputs (role mailboxes only where the address identifies a person) |
| `VALIDATION_MISSING_TITLE_FILTERS`, `VALIDATION_BAD_TITLE_FILTER`, `VALIDATION_BAD_TITLE_FILTER_MISSING_STRING`, `VALIDATION_BAD_TITLE_FILTER_MISSING_RIGHT_PARENTHESIS`, `VALIDATION_BAD_TITLE_FILTER_EXTRA_RIGHT_PARENTHESIS` | 400 | Search Contact title filters |
| `VALIDATION_CANNOT_EDIT_MASTER_API_KEY`, `VALIDATION_SUBKEY_RATE_EXCEEDS_MASTER` | 400 | API-key management |
| `AUTH_BAD_API_KEY` | 403 | unknown or inactive calling key |
| `AUTH_NEED_MASTER_API_KEY` | 403 | a sub-key calling `api_keys.*` |
| `PERMISSION_NEED_ADMIN_API_KEY` | 403 | framework grant denial (codec-rendered) |
| `QUOTA_ACCOUNT_OVER_QUOTA` | 402 | a launch or run while the balance is ≤ 0 (finders, account and keys keep working) |
| `NOT_FOUND_JOB_NOT_FOUND`, `NOT_FOUND_API_KEY_NOT_FOUND` | 404 | unknown job (or a job of another kind), unknown key |
| `ROUTING_INVALID_PATH_OR_METHOD` | 404 | unsupported route (codec-rendered) |
| `RATE_LIMIT_RATE_LIMIT_EXCEEDED` | 429 | the `rate-limited` fault only; headers `x-ratelimit-limit: 50`, `x-ratelimit-remaining: 0`, `x-ratelimit-interval: 60`, `retry-after: 12` |
| `INTERNAL_UNCLASSIFIED_ERROR` | 500 | a bounded scan over `max_scan_rows`, a page over `max_response_bytes`, or the `enrichment-unavailable` fault |
| `INTERNAL_FAILED_CREATE_API_KEY` | 500 | the `key-create-lost` fault only |

## Events and faults

| id | kind | when |
|---|---|---|
| `job.launched` | event | every accepted launch or run |
| `job.completed` | event | a job completes (in the launching call, or in the finder that first reads a due job); carries `total_usd` and the counts |
| `api-key.created` | event | `api_keys.create` (also under the `key-create-lost` fault) |
| `rate-limited` | fault, `before` | all seven launch/run operations answer 429; nothing is written |
| `enrichment-unavailable` | fault, `before` | the three enrichment launches answer 500; search, job change and verification keep working |
| `key-create-lost` | fault, `after_commit` | `api_keys.create` commits the key and emits the event, then answers 500 — a blind retry creates a duplicate |

The conformance project (`firedrill/`) ships scenarios `baseline`, `rate-limited`, `enrichment-outage`,
`key-create-lost`, `over-quota` (balance 0), `slow-jobs` (`job_delay_us` 30 s) and `tight-limits`
(`max_scan_rows` 3 plus a fourth API key).

## Compatibility

Not verified against any client: Waterfall publishes no SDK, and `manifest.compatibility` is empty. The routes,
field names, enums, paging and error envelope follow the public API reference and OpenAPI document for the
implemented subset. Known deviations:

- Input schemas are strict, so an unknown top-level field, a wrong JSON type (for example `custom_fields` as an
  array) or an out-of-range page size is refused by the framework before the handler runs. The response is still
  400 `VALIDATION_BAD_REQUEST` in the Waterfall envelope, but `error[]` carries the framework's message rather than
  the upstream per-field text. Bodies with a `constructor` or `prototype` key anywhere are refused the same way;
  JSON nested deeper than 512 levels likewise. A `__proto__` key is different: the framework's HTTP body handling
  silently discards it before validation, so a body carrying one is processed as if the key were absent (for
  example `custom_fields: {"__proto__": {...}}` launches a job with empty `custom_fields`). Nothing is poisoned;
  the package guards against the two names that do reach it.
- Unparsable JSON, an unsupported content type and a missing or wrong `x-api-key` token keep Firedrill's own
  envelope (they are answered before the route codec runs). So do paths that no route declares: the framework
  answers 404 `route not found` (401 `invalid world token` when the request carries only `x-api-key`, because
  undeclared paths are authenticated with the bearer token) and 405 for a wrong method on a declared path; the
  codec's `ROUTING_INVALID_PATH_OR_METHOD` envelope is reached only for an `unsupported` operation outcome.
- Statuses for `AUTH_NEED_MASTER_API_KEY` (403), an inactive key (403 `AUTH_BAD_API_KEY`) and a finder reading a job
  of another kind (404) are approximations; the public references do not show those responses.
- `x-api-key` carries the world token, not a Waterfall key (see Identities).

## Not implemented

Routes that do not exist here are answered by the framework (404, see Compatibility), never stubbed: Prospector (`/v1/prospector`; the persona case is covered by Search
Contact's company-set mode), Company Reveal (`/v1/company-reveal`), Company Titles (`/v1/company-titles`), webhook
delivery and signing (`webhook_url` is validated and echoed in the task, never called; no callbacks are declared),
`/.well-known/jwks.json`, the `PERMISSION_*` feature gates, the finer domain/e-mail validation codes
(`*_DISPOSABLE`, `*_NO_MX`, …), sub-day usage reporting and real rate-limit accounting (`per_interval` is stored and
validated only; 429 comes solely from the `rate-limited` fault). Every active key of the account sees every job;
only `key_usage` is per key. The directory is exactly the seeded one: anything else is "not found".

## Conformance

`firedrill tool test waterfall` runs 16 drills over 6 actors (master, fresh, outbound, inactive, revoked,
no-grants) and 7 scenarios through `test/conformance.mjs` (Node built-ins only; Waterfall-shaped routes at
`FIREDRILL_HTTP_URL` with the `x-api-key` header), exercising every operation, every declared (operation, error)
pair, all three events and all three faults, then re-runs the suite to check determinism.

## Trademarks

Waterfall is a trademark of its owner. The name is used only to identify the service this Tool simulates for testing;
this package is independently maintained and is not affiliated with or endorsed by Waterfall.

## License

Apache-2.0 (see `LICENSE`).
