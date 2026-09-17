# @firedrill-tools/tool-documenso

A synthetic **Documenso** e-signature service for [Firedrill](https://firedrill.run): one organisation with two teams, served through a
subset of the Documenso **public API v2** (`/api/v2/...`). Agents under test can create documents, add recipients and fields, send them,
follow the signing lifecycle, use templates and read audit logs against realistic, stateful, deterministic data. Nothing is e-mailed,
rendered to PDF or signed cryptographically, and no Documenso service is ever contacted.

It also ships a **browser app** that recreates the Documenso web app (documents, draft editor, document page, templates and the
signing page) on the same operations and state; see [Browser app](#browser-app).

## Install

```sh
firedrill tool add /absolute/path/to/firedrill-tools-tool-documenso-0.1.0.tgz --install
firedrill serve
```

A new world receives the starting data below and grants for every operation. An existing world keeps its own data and grants: add the
starter rows and grant each operation id listed below to the actors that should use it (`documenso.<operation id>`).

Point a test process's Documenso client at `FIREDRILL_HTTP_URL` + `/api/v2` and send `FIREDRILL_HTTP_TOKEN` as the raw `Authorization`
header value (no `Bearer` prefix), exactly as Documenso API keys are sent. The manifest's `documenso-api-client` connection recipe maps
these to `DOCUMENSO_HOST` and `DOCUMENSO_API_KEY`.

## Identities

A Documenso API key acts as its creator inside one team. The Tool models that with two optional actor attributes:

| attribute | meaning | when absent |
|---|---|---|
| `documensoUserId` | the user the key acts as | the organisation's default user, **1 (Priya Raman)** |
| `documensoTeamId` | the team the key belongs to | that user's first team by id (user 1 → **team 1, Northwind Legal, ADMIN**) |

An actor added by `firedrill tool add` has no attributes and therefore sees Northwind Legal's seeded documents as its ADMIN. A claimed
user that does not exist, or a team the user is not a member of, answers `401 UNAUTHORIZED` ("Invalid API key") on every API operation.

Team rules: other teams' documents, templates, recipients and fields answer `404`. Document visibility is enforced by team role
(`EVERYONE` for MEMBER, `MANAGER_AND_ABOVE` for MANAGER, `ADMIN` for ADMIN); owners and recipients always see their documents. Setting a
visibility above your role, or deleting, cancelling or rejecting on behalf on someone else's document as a MEMBER, answers `403 FORBIDDEN`.
The signing operations are authorised by the recipient's signing token instead of the actor.

## Starting data

Virtual time 2026-09-15T09:00:00Z. Organisation "Northwind Group" with users 1 Priya Raman, 2 Tomas Okafor, 3 Lena Park (team 1 ADMIN,
MANAGER, MEMBER) and 4 Sam Reyes (team 2 ADMIN; user 1 is also a MEMBER of team 2). Team 1 "Northwind Legal" is unlimited; team 2
"Harbor Studio" is on a free plan with 5 documents a month and has used 4.

- 16 team 1 documents (ids 1001–1016) covering DRAFT (ready to send, no recipients, a signer without a signature field, ADMIN-only, a
  3-page file), PENDING (parallel with one signature, sequential signing order, distribution method NONE, opened with a CC, manager-only),
  COMPLETED (one created from a template, one French and one Japanese title), REJECTED, CANCELLED and one soft-deleted document.
- 2 team 2 documents, 4 templates (2001–2004, one PUBLIC, one MANAGER_AND_ABOVE), 33 recipients, 41 fields and 108 audit-log entries.
- Seeded signing tokens follow `tok_<documentId>_<n>` padded with `x` to 21 characters, for example `tok_1006_2xxxxxxxxxxx`.
- E-mail addresses use `example.com` and `northwind.test` only. All names are fictional.

## Operations

All routes use `Authorization: <token>`, JSON bodies with camelCase fields, numeric `id`s plus string `envelopeId`s, page pagination
(`page`, `perPage` ≤ 100 → `{ data, count, currentPage, perPage, totalPages }`) and the error envelope `{ message, code, issues? }`.

| operation id | HTTP route | notes |
|---|---|---|
| `documents.find` | `GET /api/v2/document` | `query` (title, recipient e-mail or name), `status`, `source`, `templateId`, `orderByDirection` |
| `documents.get` | `GET /api/v2/document/{documentId}` | text content in `documentData.data`, meta, recipients, fields |
| `documents.create` | `POST /api/v2/document/create` | multipart: `payload` JSON part + UTF-8 text `file` part (pages split by form feed) |
| `documents.update` | `POST /api/v2/document/update` | `data` (title on drafts, externalId, visibility, auth options), `meta` on drafts |
| `documents.delete` | `POST /api/v2/document/delete` | drafts are removed; sent documents become hidden (pending ones cancelled) |
| `documents.duplicate` | `POST /api/v2/document/duplicate` | new DRAFT with fresh signing tokens and empty fields |
| `documents.distribute` | `POST /api/v2/document/distribute` | DRAFT → PENDING; emits `document.sent` |
| `documents.redistribute` | `POST /api/v2/document/redistribute` | records a resend for unsigned recipients |
| `envelopes.cancel` | `POST /api/v2/envelope/cancel` | PENDING → CANCELLED |
| `envelopes.audit_log` | `GET /api/v2/envelope/{envelopeId}/audit-log` | newest first by default |
| `recipients.get` | `GET /api/v2/document/recipient/{recipientId}` | includes the recipient's fields |
| `recipients.create_many` | `POST /api/v2/document/recipient/create-many` | at most 25 recipients per document, unique e-mails |
| `recipients.update` | `POST /api/v2/document/recipient/update` | unsigned recipients only |
| `recipients.delete` | `POST /api/v2/document/recipient/delete` | removes the recipient's fields too |
| `recipients.reject` | `POST /api/v2/envelope/recipient/{recipientId}/reject` | reject on behalf, optional `actAsEmail` of a team member; emits `document.rejected` |
| `fields.get` | `GET /api/v2/document/field/{fieldId}` | |
| `fields.create_many` | `POST /api/v2/document/field/create-many` | SIGNATURE, INITIALS, NAME, EMAIL, DATE, TEXT, CHECKBOX; percent coordinates; at most 200 per document |
| `fields.delete` | `POST /api/v2/document/field/delete` | not once filled in |
| `templates.find` | `GET /api/v2/template` | `query`, `type` |
| `templates.get` | `GET /api/v2/template/{templateId}` | |
| `templates.use` | `POST /api/v2/template/use` | maps placeholder recipients, `override`, optional `distributeDocument` |
| `signing.get` | canonical only | opens a signing link by token (marks it opened once) |
| `signing.complete` | canonical only | sign/approve/view with field values, or `reject`; completes the document and emits `document.completed` |
| `workspace.context` | canonical only | caller, current team and role, all teams, monthly usage and virtual `now` |

Canonical operations are also reachable at `/v1/operations/documenso/<operation id>` and as MCP tools named `documenso.<operation id>`.
No MCP aliases are declared: there is no official Documenso MCP server whose tool names could be matched.

Lifecycle: a document can be sent when it has at least one signer, approver or viewer and every signer has a signature field. With
`signingOrder: SEQUENTIAL` only the lowest unsigned signing order may sign. The document completes when every signer, approver, viewer
and assistant has signed; any of them rejecting rejects it. Creating, duplicating and using a template count toward the team's monthly
document limit (`LIMIT_EXCEEDED`).

## Events and faults

| id | kind | when |
|---|---|---|
| `document.sent` | event | a document is distributed (also `templates.use` with `distributeDocument`) |
| `document.completed` | event | the last acting recipient signs |
| `document.rejected` | event | a recipient rejects, or someone rejects on their behalf |
| `api-rate-limited` | fault (before) | `documents.create`, `documents.distribute`, `templates.use` answer `429 TOO_MANY_REQUESTS` with `Retry-After: 60` and write nothing |
| `distribution-outage` | fault (after commit) | `documents.distribute` sends the document, then answers `500 UNKNOWN_ERROR`; a retry answers `400 Document is not a draft` |

## Compatibility

Not verified against a real client. The route paths, field names, pagination and error envelope follow Documenso's published API v2
reference for the implemented subset; `compatibility` in the manifest is empty. Known differences:

- Documents are UTF-8 text, not PDFs. A binary PDF upload is rejected by the framework (400), and there are no downloads, certificates or
  sealing. `documentData.data` carries the text itself instead of a storage reference.
- Only the listed routes exist; everything else (`/api/v1`, envelope create/update/items, folders, attachments, template authoring,
  direct links, embedding, webhooks, single recipient/field create, field update) answers 404. `prefillFields`, `customDocumentData`,
  `folderId`, `emailSettings`, `envelopeExpirationPeriod` and RADIO/DROPDOWN/NUMBER fields answer `400 BAD_REQUEST`.
- Access and action auth values (`ACCOUNT`, `PASSKEY`, `TWO_FACTOR_AUTH`, `PASSWORD`) are stored and returned but never enforced.
  Signing uses typed text only. There are no hosted signing links or signing e-mails; the bundled app's signing page is the only signing UI. There is no reminder, expiry or dictate-next-signer behaviour.
- API keys are not modelled: HTTP auth is the Firedrill world token, identity comes from the actor attributes above.
- Rate limits are not counted; 429 appears only through the `api-rate-limited` fault, and the `X-RateLimit-Reset` header is not sent.
- A page whose encoded body would exceed 900 KB (or the lower `meta/limits.responseBytes` when a world sets one) answers
  `400 LIMIT_EXCEEDED` "Response too large, request a smaller perPage" rather than a shorter page, because page-number clients would skip rows.
- A write that would make a document's JSON representation larger than 900 KB (JSON escaping included) answers
  `400 INVALID_REQUEST` "Document is too large"; stored records that are already larger (authored starting data) answer `500 UNKNOWN_ERROR`.
- State scans are bounded by `meta/limits.maxScanRows` (default 5,000): an operation that needs more rows fails with
  `500 UNKNOWN_ERROR` "state exceeds the supported bound of N rows" instead of returning partial results.
- Time zones are a bundled list of 45 fixed-offset zones without daylight saving; DATE fields use that offset.
- Error messages, the `envelope_` id format, signing-token format, audit-log `data` keys and the visibility `FORBIDDEN` rule approximate the
  public documentation. Framework denials and requests that cannot be mapped still use the same `{ message, code }` envelope.

## Browser app

`firedrill serve` prints an app link for this Tool (declared as `"ui": { "root": "app/site", "entry": "index.html" }`). The app acts as
the selected actor, calls only this Tool's operations through `/_firedrill/client.js`, and re-reads records after each write and whenever
the world revision changes (it never overwrites a dialog or an editor step with unsaved input). Dates come from `workspace.context.now`
and are shown in UTC, so a replayed world renders identically.

| Screen | Route | Operations |
|---|---|---|
| Documents (home): folder row, heading, search, Status filter with counts, table (Created, Title, Sender, Recipient avatars with status tooltip, Status, Actions), pagination | `#/documents?status=&query=&page=&perPage=` | `documents.find` (Inbox = pending documents where the actor's e-mail still has to act, collected page by page), `workspace.context` |
| Row actions: Edit / Sign / Approve / View / Download button and the ⋯ menu (Duplicate, Signing Links, Resend, Cancel, Delete with confirmation) | table and document page | `documents.duplicate`, `documents.redistribute`, `envelopes.cancel`, `documents.delete` |
| Upload Document dialog (UTF-8 text file or pasted text) | header of the Documents page | `documents.create` |
| Draft editor: General → Add Signers → Add Fields (click-to-place, remove) → Distribute Document | `#/documents/<id>/edit` | `documents.get`, `documents.update`, `recipients.create_many/update/delete`, `fields.create_many/delete`, `documents.distribute` |
| Document page: viewer with fields, status card, Information, Recipients, Recent activity | `#/documents/<id>` | `documents.get`, `envelopes.audit_log`, `documents.find` (sender name) |
| Audit log | `#/documents/<id>/logs` | `envelopes.audit_log` (paged) |
| Templates: list, view, Use Template (recipients, "Send document") | `#/templates` | `templates.find`, `templates.get`, `templates.use` |
| Signing page: highlighted own fields, typed signature, Complete confirmation, Reject Document | `#/sign/<token>` | `signing.get`, `signing.complete` |

Mutations send a fresh idempotency key per user action (reused if the same dialog retries), disable concurrent writes, and show declared
errors (for example "Signers must have at least one signature field") inline. Framework denials render a permission panel.

Chrome that is present but **not simulated** (each opens a short "not simulated by this Tool" dialog and changes nothing): Create folder /
folders and Move to Folder, Sender and period filters, Download / Download Original (no PDFs exist), Save as Template, New Template and
template Edit / Direct link / Move / Duplicate / Delete, team switching (the team comes from the actor's `documensoTeamId`), organisation,
team and user settings, Sign Out, drawn or uploaded signatures, and the Number / Radio / Dropdown field types. Row selection and bulk
actions are not rendered. The Search button in the header focuses the documents search box instead of opening a command palette.

## Conformance

`firedrill tool test documenso` runs 18 drills (6 scenarios) through `test/conformance.mjs`, which uses Node built-ins only and calls the
provider routes and canonical operations. They exercise every operation, every declared error, all three events and both faults.

## Trademarks

Documenso and the Documenso logo are trademarks of their owner. The name and the logo files under
`firedrill/tools/documenso/app/site/assets/` are used only to identify the simulated service in a local test environment; this package is
not affiliated with, sponsored by or endorsed by Documenso. Sources and licences of every bundled logo and font are recorded in
`firedrill/tools/documenso/app/assets/ATTRIBUTION.md`.

## License

Apache-2.0.
