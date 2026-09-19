# @firedrill-tools/resend

A synthetic **Resend** team for [Firedrill](https://firedrill.run): send and batch-send e-mails with deterministic synthetic
delivery, manage sending domains with generated DNS records, API keys, segments and contacts — through Resend-shaped REST
routes, canonical `resend.<operation>` calls and Resend MCP tool names. All state lives in the Firedrill world; nothing is
delivered, no DNS is queried and no real service is ever contacted.

A browser app that recreates the Resend dashboard (Emails, Domains, API Keys, Audience) ships with the Tool; see
[Browser app](#browser-app).

## Install

```sh
firedrill tool add @firedrill-tools/resend --install
firedrill serve
```

A new world receives the starter data below and grants for every operation. For an existing world, grant the operations
you need to your actor (`packageId: "resend"`, operation ids from the table) and add the starter rows yourself.

## Identities

The calling API key is modelled with one actor attribute:

| attribute | meaning |
|---|---|
| `resendApiKeyId` (UUID, optional) | Row of `api-keys` the actor calls with. **Absent** → the team's default key (`Production`, full access), so an actor created by `firedrill tool add` sees the seeded team. **Present but unknown** (never existed or removed) → every operation fails `invalid_api_key` (403). |

A `sending_access` key may call only `emails.send`, `emails.send_batch` and `workspace.context`; everything else fails
`restricted_api_key` (401). A `sending_access` key with a domain may send only from that domain (403 `validation_error`).
The team's default key (`Production`) cannot be removed (422 `validation_error`), because it is the identity of actors
without `resendApiKeyId`; any other key, including one an actor explicitly calls with, can be removed, after which that
actor's calls fail `invalid_api_key`. HTTP authentication itself uses the Firedrill world token (`FIREDRILL_HTTP_TOKEN`); `re_…` tokens are never validated.

## Starting data

Virtual time 2026-09-15T14:00:00Z. Team "Northwind Labs" (free plan, daily quota 100, 7 sent today); 4 domains
(`mail.northwind.test` and `updates.northwind.test` verified, `billing.northwind.test` not started,
`legacy.northwind.invalid` failed); 3 API keys (`Production`, `Marketing sender` restricted to `updates.northwind.test`,
`Staging CI`); 23 e-mails (delivered, bounced, 3 pending scheduled, 1 scheduled for 13:30 that is already due, 2 canceled,
a 3-email batch, a 50-recipient newsletter, a Unicode subject); 3 segments ("Newsletter" 9 members, "Beta testers" 5,
"Empty segment"); 14 contacts with names, properties and unsubscribes. All addresses are fictional (`example.com`,
`.test`, `.invalid`).

## Operations

Canonical inputs use camelCase argument names (the MCP tool argument names); REST routes take Resend's snake_case JSON
bodies and query parameters. Mutations accept `Idempotency-Key` (REST) — see *Idempotency*.

| operation | MCP alias | REST route | notes |
|---|---|---|---|
| `emails.send` | `send-email` | `POST /emails` | `from`, `to` (≤ 50), `subject`, `html`/`text`, `cc`, `bcc`, `reply_to`, `headers`, `tags`, `scheduled_at` (ISO 8601 with zone, ≤ 30 days) |
| `emails.send_batch` | `send-batch-emails` | `POST /emails/batch` | JSON array of 1–100 emails, all-or-nothing, no `scheduled_at` |
| `emails.list` | `list-emails` | `GET /emails` | `limit`, `after`, `before`; canonical-only `query` (to/subject substring) and `status` |
| `emails.get` | `get-email` | `GET /emails/{email_id}` | |
| `emails.update` | `update-email` | `PATCH /emails/{email_id}` | reschedule a pending scheduled email |
| `emails.cancel` | `cancel-email` | `POST /emails/{email_id}/cancel` | |
| `domains.create` | `create-domain` | `POST /domains` (201) | `name`, `region`, `custom_return_path`, `open_tracking`, `click_tracking`, `tls`, `capabilities` |
| `domains.list` | `list-domains` | `GET /domains` | |
| `domains.get` | `get-domain` | `GET /domains/{domain_id}` | includes DNS `records` |
| `domains.verify` | `verify-domain` | `POST /domains/{domain_id}/verify` | |
| `domains.remove` | `remove-domain` | `DELETE /domains/{domain_id}` | |
| `api_keys.create` | `create-api-key` | `POST /api-keys` (201) | `name`, `permission`, `domain_id`; token returned once, never stored |
| `api_keys.list` | `list-api-keys` | `GET /api-keys` | |
| `api_keys.remove` | `remove-api-key` | `DELETE /api-keys/{api_key_id}` | |
| `segments.create` | `create-segment` | `POST /segments` (201) | |
| `segments.list` | `list-segments` | `GET /segments` | |
| `segments.remove` | `remove-segment` | `DELETE /segments/{id}` | also removes memberships |
| `contacts.create` | `create-contact` | `POST /contacts` (201) | `email`, `first_name`, `last_name`, `unsubscribed`, `properties`, `segments: [{ id }]` |
| `contacts.list` | `list-contacts` | `GET /contacts` | `segment_id`; canonical-only `query` |
| `contacts.get` | `get-contact` | `GET /contacts/{id}` | `{id}` is a UUID or an e-mail address (case-insensitive) |
| `contacts.update` | `update-contact` | `PATCH /contacts/{id}` | body `email` changes the address (canonical `newEmail`) |
| `contacts.remove` | `remove-contact` | `DELETE /contacts/{id}` | |
| `contacts.add_segment` | `add-contact-to-segment` | `POST /contacts/{contact_id}/segments/{segment_id}` | |
| `contacts.remove_segment` | `remove-contact-from-segment` | `DELETE /contacts/{contact_id}/segments/{segment_id}` | |
| `contacts.list_segments` | `list-contact-segments` | `GET /contacts/{contact_id}/segments` | |
| `workspace.context` | — | — (canonical only) | team, calling key, virtual `now` |

Lists are newest first with Resend's cursor pagination: `limit` 1–100 (default 20), exclusive `after`/`before` object
ids, response `{ "object": "list", "has_more": …, "data": [...] }`. Unknown or malformed cursors fail `validation_error`.

## Synthetic behaviour

- **Delivery.** An immediate send is `delivered`, or `bounced` when any `to`/`cc`/`bcc` address is in the reserved
  `.invalid` TLD; the same operation emits `email.sent` and then `email.delivered` or `email.bounced`. A scheduled send is
  `scheduled`; once its time has passed, reads show `delivered`/`bounced` by the same rule, but **no event is emitted at
  that moment** and it can no longer be updated or canceled.
- **Domains.** Records are generated from the name and region (SPF MX/TXT on `send.<name>`, DKIM TXT with a random key,
  a Receiving MX when receiving is enabled). Verification is instant: `verified`, or `failed` for names ending in
  `.invalid`. Sending requires the `from` domain to exist, be verified and have sending enabled.
- **Quota.** The team's daily quota (100) counts accepted e-mails per virtual UTC day; a batch that would exceed it is
  rejected whole with 429 `daily_quota_exceeded`.
- **Bounds.** Scanning operations read at most `meta/limits.maxScanRows` rows (5000 by default, ≤ 10000) and fail with
  500 `application_error` ("state exceeds the supported bound of N rows") instead of returning a truncated list.
- **Nesting.** JSON request bodies nested deeper than 512 levels are refused with 400 before validation.

## Errors

REST errors use Resend's envelope `{ "statusCode", "message", "name" }`:

| declared code | status | `name` |
|---|---|---|
| `VALIDATION_ERROR` | 422 | `validation_error` |
| `MISSING_REQUIRED_FIELD` | 422 | `missing_required_field` |
| `INVALID_PARAMETER` | 422 | `invalid_parameter` (malformed id or e-mail in a path) |
| `INVALID_IDEMPOTENCY_KEY` | 400 | `invalid_idempotency_key` |
| `RESTRICTED_API_KEY` | 401 | `restricted_api_key` |
| `INVALID_API_KEY` | 403 | `invalid_api_key` |
| `DOMAIN_NOT_VERIFIED` | 403 | `validation_error` |
| `NOT_FOUND` | 404 | `not_found` |
| `DAILY_QUOTA_EXCEEDED` | 429 | `daily_quota_exceeded` |
| `RATE_LIMIT_EXCEEDED` | 429 | `rate_limit_exceeded` (+ `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`, `retry-after`) |
| `APPLICATION_ERROR` | 500 | `application_error` |

Framework outcomes keep the framework's HTTP status and get a Resend-shaped body: a request whose field has the wrong
JSON type (for example a non-object batch entry) fails schema validation with **400** `validation_error` (Resend would usually answer 422); a call the actor is
not granted answers 403 `invalid_access`; unknown paths are the framework's 404. Validation messages, the 30-day
scheduling window, "Contact already exists", `object: "contact_segment"` and the 201 statuses of create routes are
approximations of the public documentation.

## Events and faults

| id | kind | when |
|---|---|---|
| `email.sent` | event | every accepted immediate e-mail (`email_id`, `from`, `to`, `subject`, `created_at`, `batch_id`) |
| `email.delivered` | event | after `email.sent` when no recipient is in `.invalid` |
| `email.bounced` | event | after `email.sent` when a recipient is in `.invalid` (`bounce.type: "Permanent"`) |
| `send-rate-limited` | fault, before | `emails.send`, `emails.send_batch` → 429 `rate_limit_exceeded`; nothing is written |
| `contacts-create-unavailable` | fault, after commit | `contacts.create` → 500 `application_error` although the contact **was created**; a retry answers 422 "Contact already exists" |

## Idempotency

`Idempotency-Key` values of 1–128 characters become the Firedrill idempotency key (a replay returns the first result
without a second write). Keys of 129–256 characters are accepted **without deduplication** because Firedrill records
keys of at most 128 characters. Empty keys and keys over 256 characters fail 400 `invalid_idempotency_key`. Over MCP or
the canonical endpoint, an `idempotencyKey` argument is only length-checked; use the framework's idempotency key there.
Reusing a key with a different request body fails **400** `validation_error` ("Invalid request: the idempotency key was already used with different arguments") and writes nothing; Resend answers 409 `invalid_idempotent_request`, but HTTP statuses of framework-rejected requests are framework-owned.

## Compatibility

The routes, field names, pagination and error envelope follow Resend's public API reference for the implemented subset.
**Not verified against a real client**: the manifest's `compatibility` block is empty and no official SDK or the Resend
MCP server has been exercised against this Tool. MCP aliases reuse the Resend MCP server's tool names and argument names
but return JSON results. Response headers cannot depend on request headers (Firedrill encoders see only the invocation),
and `User-Agent` is not required.

## Not implemented

Received e-mails, attachments (sending or listing; `attachments` in a send → 422), templates (`template` → 422),
broadcasts, automations, custom events, topics (`topic_id`/`topics` → 422), contact property definitions (properties are
free-form: ≤ 20 lowercase keys with string ≤ 500 characters, number or null values), contact imports, suppressions,
webhooks and callbacks, logs, metrics, OAuth grants, `/audiences` (deprecated upstream; use segments), segment `filter`,
`GET`/`PATCH /segments/{id}`, `PATCH /domains/{id}`, `PATCH /api-keys/{id}`, tracking subdomains, open/click tracking
effects, batch `x-batch-validation: permissive`, natural-language `scheduled_at`, monthly quotas and real request-rate
counting (429 `rate_limit_exceeded` only comes from the fault). Unimplemented endpoints do not exist (404).

## Conformance

`firedrill tool test resend` runs 12 drills (`test/conformance.mjs`, Node built-ins only) across the actors `owner`,
`fresh`, `sender`, `revoked` and `no-grants` and the scenarios `baseline`, `rate-limited`, `contacts-outage`,
`quota-exhausted` and `tight-limits`, covering every operation, declared error, event and fault.

## Browser app

`firedrill serve` prints the app link (inspector: **Tools → Open app**). The app is a dark dashboard in the Resend layout:
sidebar with the team switcher, navigation and daily-usage card; every screen calls this Tool's operations for the selected
actor, so app writes are visible over HTTP and MCP and vice versa.

| screen | what works | operations |
|---|---|---|
| Emails (Sending) | table To · Status · Subject · Sent, search (recipient/subject), status filter, Previous/Next pages | `emails.list`, `workspace.context` |
| Email detail | From, Subject, To, ID (copy), Cc/Bcc/Reply-To/tags, event timeline, Preview / Plain Text / HTML tabs; Cancel (confirm) and Reschedule for scheduled emails | `emails.get`, `emails.cancel`, `emails.update` |
| Domains | list, Add domain (name, region), domain page with DNS records (copy), Verify DNS Records, Delete (confirm) | `domains.list/create/get/verify/remove` |
| API Keys | list, Create API Key (name, permission, domain for sending access) with the token shown once, Delete (confirm) | `api_keys.list/create/remove`, `domains.list` |
| Audience › Contacts | table, search, segment filter, Add contacts (with segments), contact panel: names, subscription, segment membership, properties, Delete | `contacts.list/create/get/update/remove/add_segment/remove_segment/list_segments`, `segments.list` |
| Audience › Segments | list, Create segment, Delete (confirm), open a segment's contacts | `segments.list/create/remove` |

Relative dates ("2 days ago") use the world's virtual time from `workspace.context`, never the browser clock; absolute
times are shown in UTC. Mutations send a fresh idempotency key per action; screens re-read after writes and when the
world revision changes. Loading, empty, error and denied states are rendered from the real outcomes. Email HTML is
previewed by rebuilding an allowlisted, attribute-free DOM (links never navigate).

**Not simulated** (visible, open a short "not simulated by this Tool" note): Broadcasts, Templates, Audience Topics and
Properties, Metrics, Logs, Webhooks, Settings, the Emails "Receiving" tab, the date-range and API-key filters, Export,
the Insights tab, Docs, Help, the team switcher and the account menu. The API Keys **Permission** column shows the
permission of the calling key only (the list response carries no permission field); other rows show "—". Tokens are
masked in the list (the list response carries no token); a new token is shown once in the create dialog.

## Trademarks

Resend and the Resend logo are trademarks of their owner. The name and the official logo files bundled in the app (sources in
`firedrill/tools/resend/app/assets/ATTRIBUTION.md`) are used only to identify the simulated service in a test environment;
this package is not affiliated with or endorsed by Resend. The bundled fonts (Inter, JetBrains Mono) are licensed under the
SIL Open Font License 1.1.

## License

Apache-2.0
