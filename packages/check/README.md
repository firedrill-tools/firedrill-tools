# @firedrill-tools/tool-check

A synthetic **Check payroll partner account (sandbox)** for [Firedrill](https://firedrill.run). An agent that runs payroll for client
companies through Check's REST API can run against this Tool instead of the real service: companies, workplaces, employees, earning
rates, pay schedules, payrolls and payroll items behave statefully, with Check's snake_case field names, cursor pages and
`{ "error": { "type", "message", "input_errors": [...] } }` envelope.

Nothing here contacts Check, a bank, the ACH network or a tax agency. No money moves, no tax is filed, no e-mail or webhook is sent,
and the tax engine is a small published table of synthetic flat rates — not tax law. All state lives in the Firedrill world (SQLite,
reset, virtual time, evidence); every operation computes its result from that state.

The package also ships a **browser app** — a recreation of the Check Console — served by `firedrill serve`; see "Browser app" below.

## Install

```sh
firedrill tool add /absolute/path/to/firedrill-tools-tool-check-0.1.2.tgz --install
firedrill serve
```

A new world receives the starter data below and grants for all 25 operations. For an existing world, add the starter rows you need
and grant the operations (`packageId: "check"`, operation ids from the table below) to your actors.

Point your agent's Check client at the served HTTP binding (connection recipe `check-rest`):

| client variable | Firedrill value |
|---|---|
| `CHECK_API_BASE_URL` | `FIREDRILL_HTTP_URL` |
| `CHECK_API_KEY` | `FIREDRILL_HTTP_TOKEN` |

Requests authenticate with `Authorization: Bearer <token>`. Paths carry no version prefix (`/companies`, `/payrolls/{id}/preview`),
as Check's do.

## Identities and access

A Check API key belongs to a partner and reaches every company that partner created, so access is modelled with actor attributes,
not row owners:

| attribute | effect |
|---|---|
| `companies` | Optional array of at most 100 `com_…` ids. Present → the key reaches only those companies; every other record behaves as if it did not exist (gets and creates naming it answer **404**, lists exclude it). Anything but an array of strings makes every operation answer **401 `authentication_error`**. |
| `accessLevel` | Optional, `full` (default) or `read_only`. A `read_only` key may list, get and list paydays; every create, update, delete, **preview** (it records preview state), approve and reopen answers **403 `permission_denied`**. Any other value is `authentication_error`. |
| `displayName` | Optional; not used by the backend. |

**Fresh-install fallback:** an actor with neither attribute (as created by `firedrill tool add`) reaches every seeded company with
full access. Framework grants still decide whether an actor may call an operation at all; a missing grant is a Firedrill denial
(HTTP 403) that the route codec renders in Check's envelope as `permission_denied` ("This API key is not granted this operation in
the Firedrill world.") with no `input_errors`.

Rule order in every handler: key (401, then 403 for writes) → input shape (400) → references and company scope (404) → state rules
(400, or 409 `preview_superseded`).

## Starting data

`starter.json` (and `firedrill/baseline.scenario.json`) seed **63 rows** at virtual time **2026-09-15T14:00:00Z** (a Tuesday). Every
person, company, address, phone number (`555-01xx`) and e-mail (`@example.com`) is invented; SSNs exist only as their last four
digits.

- `meta` (2): `counters` (`next: 1000`) and `tax_table` — the synthetic rates, in basis points: employee `fed_income` 1000,
  `social_security` 620, `medicare` 145, `state_income` CA 400 / OR 800 / NY 500; company `social_security` 620, `medicare` 145,
  `futa` 60, `sui` CA 340 / OR 210 / NY 410. Supported states: CA, OR, NY.
- 3 companies: **Juniper Street Bakery LLC** (Oakland CA, biweekly, two-day processing), **Harborview Dental Group PC** (Brooklyn NY,
  semimonthly, one-day), and **Quillmark Letterpress LLC** (inactive, hidden by the default `active=true` filter).
- 4 workplaces (Oakland CA, Portland OR, an inactive Emeryville kitchen, Brooklyn NY) and 11 employees — 8 at Juniper, so
  `limit=3` gives three cursor pages: hourly bakers, a Portland barista, a salaried manager on two workplaces, one terminated
  employee (2026-08-31, `active: false`) and one hired the day before with a direct-deposit preference, no bank account and no
  residence (`onboard.status: "blocking"`).
- 12 earning rates (one active per employee, plus one inactive old rate) and 2 pay schedules: Juniper "Every other Friday"
  (biweekly, first payday 2026-01-16 → … 2026-09-11, 2026-09-25) and Harborview "15th and last day" (semimonthly, `second_payday: 31`;
  Saturday 2026-10-31 moves to Friday 10-30).
- 7 payrolls and 22 payroll items, arranged so every lifecycle rule is reachable from the starting state: two paid Juniper payrolls,
  the **open draft J3** (payday 2026-09-25, 6 items, never previewed) for the main preview → approve path, an empty off-cycle draft,
  a pending Harborview payroll still inside its one-hour reopen window, a payroll that reads as `paid` because its payday has
  arrived, and a previewed draft whose approval deadline passed yesterday.

Ids use Check's prefixes with 20 base-62 characters (`com_`, `wrk_`, `emp_`, `rte_`, `psc_`, `pay_`, and `itm_` for items). New ids
render a shared counter through a fixed permutation, so a run is deterministic and repeatable.

## Operations and routes

25 operations, 25 provider-shaped routes. No MCP aliases are declared (Check publishes no MCP tool contract), so MCP clients use the
canonical `check.<operation>` tools. Deletes answer 204 with an empty body; approve answers `{}`.

| operation | HTTP route | notes |
|---|---|---|
| `companies.list` | `GET /companies` | `active` (default `true`), `id`, `limit` (≤ 25), `cursor`; adds `server_time` |
| `companies.get` | `GET /companies/{company}` | companies are read-only through the API |
| `workplaces.list` | `GET /workplaces` | `company`, `id`, `limit` (≤ 500), `cursor` |
| `workplaces.create` | `POST /workplaces` | 201; `address.state` must be a supported state |
| `employees.list` | `GET /employees` | `company`, `workplace` (comma list), `active`, `id`, `limit` (≤ 100), `cursor`; sorted by name |
| `employees.get` | `GET /employees/{employee}` | computed `active`, `bank_accounts`, `onboard` |
| `employees.create` | `POST /employees` | 201; `ssn` is reduced to `ssn_last_four` and never echoed |
| `employees.update` | `PATCH /employees/{employee}` | `termination_date` here; `id`, `company` and computed fields are read-only |
| `earning_rates.list` | `GET /earning_rates` | `company`, `employee`, `active`, `id`, `limit` (≤ 500), `cursor` |
| `earning_rates.create` | `POST /earning_rates` | 201; `amount` > 0, `period` `hourly`/`annually`/`piece` |
| `earning_rates.update` | `PATCH /earning_rates/{earning_rate}` | `name`, `active`, `metadata` only |
| `pay_schedules.list` | `GET /pay_schedules` | `company`, `id`, `limit` (≤ 25), `cursor` |
| `pay_schedules.create` | `POST /pay_schedules` | `first_period_end` ≤ `first_payday`; `second_payday` for semimonthly |
| `pay_schedules.paydays` | `GET /pay_schedules/{pay_schedule}/paydays` | `start` (default today), `end` (default +365 days, range ≤ 366); ≤ 400 entries |
| `payrolls.list` | `GET /payrolls` | `company`, `type`, `status` (derived), `approved`, `pay_schedule`, `payday_after`, `payday_before`, `is_void`, `include_items`, `id`, `limit` (≤ 25), `cursor`; payday descending |
| `payrolls.create` | `POST /payrolls` | optional inline `items` (needs `include_items=true`) |
| `payrolls.get` | `GET /payrolls/{payroll}` | totals recomputed on every read |
| `payrolls.preview` | `GET /payrolls/{payroll}/preview` | a GET that writes: records `preview { status, started_at, completed_at }` |
| `payrolls.approve` | `POST /payrolls/{payroll}/approve` | body `{}` or `{ preview_started_at }`; answers `{}` |
| `payrolls.reopen` | `POST /payrolls/{payroll}/reopen` | within the reopen deadline; clears the preview |
| `payrolls.delete` | `DELETE /payrolls/{payroll}` | 204; draft only; deletes its items |
| `payroll_items.list` | `GET /payroll_items` | `payroll`, `employee`, `id`, `limit` (≤ 500), `cursor` |
| `payroll_items.create` | `POST /payroll_items` | 201; one item per employee per payroll |
| `payroll_items.update` | `PATCH /payroll_items/{payroll_item}` | arrays are replaced whole; `payroll` and `employee` are immutable |
| `payroll_items.delete` | `DELETE /payroll_items/{payroll_item}` | 204 |

Error envelope: `{ "error": { "type", "message", "input_errors": [{ "field", "field_path", "message" }] } }` with types
`validation_error` (400), `not_found` (404), `authentication_error` (401), `permission_denied` (403), `preview_superseded` (409),
`throttled` (429, with `Retry-After: 1`), `service_unavailable` (503) and `internal_error` (500). `field_path` is the dotted path as
an array (`["items", "6", "payment_method"]`); errors with no field carry no `input_errors`. An `Idempotency-Key` request header is
forwarded as the Firedrill idempotency key (a Firedrill addition).

List pages are `{ next, previous, results }`. `next`/`previous` are **root-relative** URLs rebuilt from the normalized filters
(Check returns absolute URLs), and cursors are opaque, fully validated and tied to the filters they were issued with: reusing a
cursor with different filters is a `cursor` validation error. A page also stops at 900 KB with a real `next`.

## Payroll rules

- **Earnings.** Each earning sets either `amount` or `earning_rate`, never both. With a rate: it must be active and belong to the
  item's employee; `hourly` × `hours` (×1.5 `overtime`, ×2 `double_overtime`), `annually` ÷ periods per year of the payroll's
  frequency, `piece` × `piece_units`. The workplace must be active, in the employee's workplaces and in the same company.
- **Taxes and net pay.** Taxable gross is every earning except `cash_tips` (taxed, not paid through payroll). Each tax line is
  `round_half_up(gross × basis_points / 10000)`, state lines grouped by the earning's workplace state;
  `net_pay = gross − cash_tips − employee taxes + reimbursements`. `force_supplemental_withholding` on an off-cycle payroll raises
  `fed_income` to 2200 bp. Negative net pay is refused at preview.
- **Lifecycle.** The approval deadline is `processing_period` business days before payday at 21:00Z. Any item change requires a
  draft and clears the preview. Approve requires a current preview (send `preview_started_at` to get 409 `preview_superseded`
  instead of approving stale numbers), a deadline in the future, and a bank account for every direct-deposit item; it sets
  `pending`, `approved_at` and `reopen_deadline = min(now + 1 h, approval_deadline)`. Reopen returns the payroll to draft and drops
  the preview. `paid` and `processing` are **derived from virtual time on every read** and never written.

## Events and faults

| id | kind | when |
|---|---|---|
| `payroll.approved` | event | each successful approve; payload `{ event, data: payroll }` |
| `payroll.reopened` | event | each successful reopen |
| `throttled` | fault (before) | `companies.list`, `employees.list`, `payrolls.list` answer 429 `throttled`; single-record reads are unaffected |
| `funding-outage` | fault (before) | `payrolls.preview` and `payrolls.approve` answer 503 `service_unavailable`; nothing is written and no event is emitted |
| `approval-response-lost` | fault (after commit) | `payrolls.approve` commits and emits `payroll.approved`, then answers 500 `internal_error`; a careless retry is refused with "Only draft payrolls can be approved." |

The event payloads mirror a webhook-style body so a consumer-declared callback can forward them; the package declares no callbacks
and no subscriptions.

## Conformance

`firedrill tool test check` runs the 13 drills in `firedrill/conformance.suite.json` twice and compares state and Tool activity for
determinism. The target is `test/conformance.mjs` (Node built-ins only, no dependencies): it branches on the drill instruction and
fails loudly on any unexpected status, envelope, `input_errors` path or computed value — every payroll total it checks is recomputed
from the published rates rather than echoed.

| drill | scenario | covers |
|---|---|---|
| `check-directory` | baseline | every listing, cursor pages forward and back, filters, paydays, limit/cursor errors, one canonical operation call |
| `check-people-writes` | baseline | workplace, employee, earning-rate and pay-schedule creates and updates, immutability rules |
| `check-payroll-run` | baseline | the full J3 run: preview, item edits, direct-deposit and preview-superseded guards, approve, reopen, an off-cycle payroll created with inline items and deleted |
| `check-payroll-rules` | baseline | preview and approval preconditions, the reopen window, derived statuses in filters, payday and duplicate-period checks, unknown ids |
| `check-read-only` | baseline | a `read_only` key: 11 reads succeed, all 14 writes answer 403 |
| `check-company-scope` | baseline | a company-scoped key: other companies' records are invisible and answer 404 |
| `check-bad-key` | baseline | a malformed `companies` attribute: 401 on every operation |
| `check-fresh-install` | baseline | an actor with no attributes reaches every seeded company |
| `check-denied` | baseline | an actor with no grants: the framework denies before the Tool runs |
| `check-throttled` | throttled | the three throttled listings, the `Retry-After` header, and the reads that are unaffected |
| `check-funding-outage` | funding-outage | preview and approve answer 503 and commit nothing |
| `check-approval-lost` | approval-response-lost | approve commits and emits, the response is lost, the retry is refused |
| `check-resource-limits` | resource-limits | the scan bound and the id allocator: 18 operations answer 500 `internal_error` and commit nothing |

Together they observe all 25 operations, all eight declared error codes on every operation that declares them, both events and all
three faults.

## Browser app

`firedrill serve` publishes a browser app (`firedrill/tools/check/app/site`, declared as `"ui": { "root": "app/site", "entry":
"index.html" }`) that recreates the Check Console for the simulated surface. It is a plain ES-module app: no framework, no bundler, no
CDN and no remote request; every screen is wired to the Tool's own operations through `/_firedrill/client.js`, so a change made in the
app is immediately visible over the REST routes and vice versa, and `getContext().revision` refreshes the open screen after an
external write.

| screen | operations used |
|---|---|
| Company switcher + Home | `companies.list`, `pay_schedules.list`, `pay_schedules.paydays`, `payrolls.list`, `employees.list` |
| Companies | `companies.list` (paged), `companies.get` |
| Employees list | `employees.list` (status tab, workplace filter, cursor paging; the name/e-mail box filters the loaded page in the browser — the operation has no search input), `employees.create` |
| Employee detail | `employees.get`, `employees.update` (edit, terminate), `earning_rates.list/create/update` |
| Workplaces | `workplaces.list` (paged), `workplaces.create` |
| Pay schedules | `pay_schedules.list`, `pay_schedules.paydays`, `pay_schedules.create` |
| Payrolls list | `payrolls.list` (status tabs, type filter, cursor paging) |
| Payroll detail | `payrolls.get`, `payrolls.preview`, `payrolls.approve`, `payrolls.reopen`, `payrolls.delete`, `payroll_items.list/create/update/delete` |
| Run payroll | `payrolls.create` (from a schedule payday or off-cycle) |

Every mutation sends an idempotency key, destructive actions (delete draft, remove item, terminate, approve) confirm first, and each
screen renders explicit loading, empty, error and denied states — a `read_only` key sees the write buttons disabled with the Check
`permission_denied` message, and an invalid key sees an authentication screen rather than an empty account. Dates, "today" and
countdowns come from the world's virtual time returned by the API, never from the browser clock, so replaying a world renders
identically on any day.

Assets: the official Check logo files (icon, favicon, wordmark) downloaded from the vendor's own site, plus Inter (SIL OFL 1.1) as the
bundled interface font — checkhq.com's own face is commercial and cannot be redistributed. Sources, hashes and the substitution are
recorded in `firedrill/tools/check/app/assets/ATTRIBUTION.md`; the licence text is in `app/assets/fonts/OFL.txt`. All interface glyphs
are original SVG paths drawn for this package.

## Limitations

1. **Synthetic payroll only.** No money movement, ACH, funding, tax filing or real tax calculation. Taxes are flat basis-point rates
   from `meta/tax_table` for CA, OR and NY only: no wage bases (for example the Social Security cap), no W-4 withholding, no local
   taxes or reciprocity. Amounts will not match Check's.
2. 25 operations out of Check's much larger API. Not simulated, so the framework answers 404 (or 405): company create/update and
   onboarding, bank accounts and net-pay splits, SSN reveal, paystubs and documents, contractors, benefits, post-tax deductions and
   garnishments, tax overrides and withholding forms, corrections, amendments, voids, payroll update, bulk item update, single item
   retrieve, workplace and pay-schedule update/delete, earning codes, async preview, webhooks, reports, W-2/941 forms, holiday
   calendars and live mode. Item arrays for the absent features are always `[]` and override inputs are rejected.
3. Earning types are limited to the twelve named in Check's earnings guide. `cash_tips` is taxed but excluded from net pay
   (simplified). `is_void` is always `false` and `partially_paid`/`failed` never occur.
4. The approval deadline is business days before payday at 21:00Z: no US Eastern standard time and no bank holidays. Paydays only
   shift off weekends.
5. `paid` and `processing` are derived from virtual time on read; nothing is persisted and there is no `payroll.paid` event (the Tool
   declares no scheduling capability).
6. Reopening clears the preview (the public reference is silent on this). Preview is synchronous; `async=true` is a validation error
   rather than being ignored.
7. `next`/`previous` are root-relative URLs, not absolute, and cursors are Tool-specific. Every list uses the
   `{ next, previous, results }` page, including paydays, whose envelope the reference does not state.
8. **Unverified wire details** (inferred, not observed against the live API): the error `type` names other than `validation_error`,
   `throttled` and `preview_superseded`; the `itm_` item id prefix; 201 for employee and earning-rate creates; the event payload
   shape; several error message texts.
9. **Two error envelopes.** Everything the route codec sees is rendered in Check's envelope, including framework outcomes: a
   missing grant answers `403 permission_denied`, a body the codec cannot map (a non-object body, nesting deeper than 512, a
   non-integer `limit`) answers `400 validation_error`, and a body the framework's input-schema validation rejects (an unknown
   top-level field) answers `400 validation_error` with the issue under `non_field_errors`.
   Only responses the framework produces before any codec runs keep the Firedrill envelope
   (`{ "schemaVersion": 1, "code": "framework.…", "error": "…" }`): a body that is not valid JSON (400 `HTTP_BODY_INVALID`), a
   missing or wrong bearer token (401 `HTTP_UNAUTHORIZED`), an unknown path (404 `HTTP_ROUTE_NOT_FOUND`) and a wrong method on a
   known path (405 `HTTP_METHOD_NOT_ALLOWED`).
10. **`__proto__` in `metadata` is stripped, not rejected.** `constructor` and `prototype` metadata keys fail with
    `400 validation_error` ("Invalid key …"), but a `__proto__` key never reaches the Tool: the framework removes own `__proto__`
    keys while decoding the JSON body, so the request succeeds with that key silently absent from the stored `metadata`
    (framework behaviour, also over the canonical `/v1/operations` path). Metadata is stored as a plain object built from
    validated keys, so the shared realm cannot be poisoned either way.
11. API keys are modelled by actor attributes; the bearer token is the world's token, not a Check key. There are no per-key IP
    restrictions and no live mode.
12. Paths are unprefixed (`/companies`, `/employees`), so they can collide with another Tool that declares the same paths in one
    world.
13. `compatibility` is empty: **no official Check client or SDK was exercised.** Shapes come from the public API reference only.
14. Bounds: 10,000 rows per namespace (a declared `internal_error`, never truncation), 500 items per payroll, 20 earnings per item,
    900 KB per response page. A `meta/limits` row with `maxRows` may lower the scan bound; the `resource-limits` scenario uses it to
    exercise that error without seeding 10,000 rows.
15. The browser app covers only the simulated surface. Contractors, Documents, Taxes, Developers, Settings, Notifications and the
    account menu (Profile, API keys, Sign out) are present in the frame, as in the real Console, but open a short "not simulated by
    this Tool" panel instead of inventing data. The app reads the world's virtual time from the API (never the browser clock) and is
    English-only, light-theme only and desktop-width.

## Trademarks

Check, the Check name and the Check logo are trademarks of their owner. The name and the official logo files bundled under
`firedrill/tools/check/app/` (recorded with their source URLs in `app/assets/ATTRIBUTION.md`) are used only to identify the simulated
service inside a test environment; this package is not affiliated with or endorsed by Check. No Check source code, content or
customer data is included, and every record served by this Tool is fictional.

## License

Apache-2.0
