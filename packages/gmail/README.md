# @firedrill-tools/tool-gmail

A synthetic **Gmail** for [Firedrill](https://firedrill.run) drills. It simulates one Google Workspace mail account
per actor behind a bounded subset of the **Gmail API v1** (`/gmail/v1/users/{userId}/…`), exposes the twelve tool names of
Google's published **Gmail MCP** contract as aliases, and ships a browser mail client that uses the very same operations
and records. Everything lives in the Firedrill world: sending stores a `SENT` copy and delivers `INBOX` copies only to
mailboxes that exist in the same world. No Google service is ever contacted and no real mailbox can be reached.

Tool id `gmail` · package version `0.1.1` · engine `>=0.1.0 <0.2.0` · Apache-2.0.

## Install

```sh
firedrill tool add /absolute/path/to/firedrill-tools-tool-gmail-0.1.2.tgz --install
firedrill serve
```

`tool add --install` on a fresh project creates `local-dev` with every operation granted and copies the 48 starter rows
(two mailboxes). In an existing project it changes nothing silently: add the exact grants you want to the actor that
represents your agent, for example

```json
{ "id": "agent", "attributes": { "email": "dana.reyes@example.test", "displayName": "Dana Reyes" },
  "grants": [ { "packageId": "gmail", "operationId": "threads.list" }, { "packageId": "gmail", "operationId": "threads.get" } ] }
```

### Identities

The actor attribute `email` selects the mailbox (rows are keyed by that address). **Without it the actor acts as the
world's primary seeded mailbox**: the `mailboxes` row with the lowest row id (row ids are the addresses, so the
alphabetically first account — `dana.reyes@example.test` in the starter data), and the row's `displayName` becomes the
`From` display name. That is what the grant-only `local-dev` actor that `tool add --install` creates gets, so a fresh
install opens the seeded inbox with no manual step. A world with no `mailboxes` row at all falls back to
`<actorId>@example.test`, an empty account that is materialised on its first write. An explicit `email` always wins: an
address that has no rows yet is an empty mailbox, exactly as before. Until that first write the address owns no
`mailboxes` row, and `deliver()` skips it: mail sent to it by another actor is not copied into its `INBOX` (see
Limitations, "Sending never leaves the world"). `displayName` on the actor overrides the row's
name. Two actors with different `email` values never see each other's rows; an actor whose `userId` path segment is
neither `me` nor its own (resolved) address gets `FORBIDDEN` (HTTP 403, Gmail `forbidden` envelope).

## Starting data

`starter.json` (and the author world in `firedrill/world.json`) contains two fictional mailboxes at virtual time
2026-09-14T09:00Z:

- **dana.reyes@example.test** — 20 messages in 12 threads (a three-message refund escalation with a reply draft, an invoice
  with a PDF attachment, a newsletter with an HTML part, a starred interview thread with a hidden label, a six-week outage
  post-mortem thread, an empty-subject message, one trashed and one spam message, an archived thread, a bcc-only sent
  message, a fresh draft, a legal notice with a zero-byte attachment), user labels `Customers`, `Invoices`, `Recruiting`
  (hidden), `Customers/Escalations`, two drafts, two attachments.
- **sam.okafor@example.test** — 3 messages in 2 threads and a `Team` label. All three of Sam's message ids
  (`18f0000000000101`, `18f0000000000102`, `18f0000000000103`) equal three of Dana's, and Sam's thread id `18f0000000000101`
  equals Dana's, on purpose: ids are scoped per mailbox (state rows are keyed `<address>:<id>`), so each actor reading
  `18f0000000000101` gets a different message and ownership isolation is exercised by the `gmail-isolation` drill.

All addresses use `example.test`, `example.com` or `example.org`; the content is invented. Replace it with your own
scenarios whenever you like — nothing in the behavior depends on these rows.

## Operations

Canonical MCP names are `gmail.<operation>`; the alias column lists the Google Gmail MCP tool name exposed in addition.

| operation | MCP alias | HTTP route | notes |
|---|---|---|---|
| `profile.get` | — | `GET /gmail/v1/users/{userId}/profile` | address, counts, `historyId`; the canonical/MCP result also carries `serverTime` (the world's virtual now, RFC 3339 UTC) — the REST route strips it because Gmail's Profile has no such field |
| `labels.list` | `list_labels` | `GET …/labels` | REST returns every system + user label in one response (unpaged, like Gmail); the alias returns user labels with `threadsTotal`/`threadsUnread`, paged (`pageSize` default 20, max 10000) |
| `labels.create` | `create_label` | `POST …/labels` | nested `A/B` names, optional `#rrggbb` colours; refused with `FAILED_PRECONDITION` once the mailbox holds its label bound (500 by default) |
| `labels.update` | `update_label` | `PATCH` and `PUT …/labels/{id}` | rename / recolour / visibility; system labels refused |
| `labels.delete` | `delete_label` | `DELETE …/labels/{id}` (204) | removes the label from every message and thread |
| `messages.list` | — | `GET …/messages` | `q`, repeatable `labelIds`, `maxResults` (≤100), `pageToken`, `includeSpamTrash` |
| `messages.get` | — | `GET …/messages/{id}` | `format=minimal|metadata|full`, repeatable `metadataHeaders`; `raw` → 400 |
| `messages.modify` | — | `POST …/messages/{id}/modify` | `addLabelIds` / `removeLabelIds`; `DRAFT`/`SENT` refused |
| `messages.batch-modify` | — | `POST …/messages/batchModify` (204) | all-or-nothing; an unknown id fails the whole call |
| `messages.label` / `messages.unlabel` | `label_message` / `unlabel_message` | — | Google MCP shapes |
| `messages.trash` / `messages.untrash` | — | `POST …/messages/{id}/trash`, `…/untrash` | trash removes `INBOX`, untrash restores it |
| `messages.send` | — | `POST …/messages/send` | `{ raw, threadId? }` or structured `to/cc/bcc/subject/body/htmlBody/replyToMessageId`; a raw `In-Reply-To` or `References` id over 300 characters → 400 `invalidArgument`, `References` keeps its latest 20 ids; `FAILED_PRECONDITION` when the sender's mailbox or an in-world recipient's mailbox is at its message bound, or when the target thread (sender's or recipient's) already holds 200 messages |
| `attachments.get` | — | `GET …/messages/{messageId}/attachments/{id}` | `{ attachmentId, size, data }` (base64url) |
| `threads.list` | `search_threads` | `GET …/threads` | a thread matches when any visible message matches; `withoutMessages: true` returns id, snippet and historyId only (the REST shape) |
| `threads.get` | `get_thread` | `GET …/threads/{id}` | `MINIMAL` / `FULL_CONTENT`; `restFormat` minimal (REST minimal fields only) / metadata / full; REST `format` minimal/metadata/full; `FAILED_PRECONDITION` when the thread does not fit the 900 KB response budget |
| `threads.modify` | — | `POST …/threads/{id}/modify` | applies to every message |
| `threads.label` / `threads.unlabel` | `label_thread` / `unlabel_thread` | — | Google MCP shapes |
| `threads.trash` | — | `POST …/threads/{id}/trash` | |
| `drafts.list` | `list_drafts` | `GET …/drafts` | `q`, `maxResults`, `pageToken` |
| `drafts.get` | — | `GET …/drafts/{id}` | |
| `drafts.create` | `create_draft` | `POST …/drafts` | `{ message: { raw } }` or structured fields; attachments refused; `FAILED_PRECONDITION` when the mailbox is at its draft or message bound or the target thread holds 200 messages |
| `drafts.update` | — | `PUT …/drafts/{id}` | full replacement, same draft and message id; `threadId` (or `replyToMessageId`) moves the draft into that existing thread and sets `In-Reply-To`/`References`; `FAILED_PRECONDITION` when that thread holds 200 messages |
| `drafts.send` | — | `POST …/drafts/send` | the draft disappears; the sent message gets a new id in the same thread |
| `drafts.delete` | — | `DELETE …/drafts/{id}` (204) | |

Errors use the Gmail envelope `{ "error": { "code", "message", "errors": [{ "message", "domain", "reason" }], "status" } }`:
`INVALID_ARGUMENT`/`INVALID_PAGE_TOKEN` → 400 `invalidArgument`, `FAILED_PRECONDITION` → 400 `failedPrecondition`,
`FORBIDDEN` → 403 `forbidden`, `NOT_FOUND` → 404 `notFound`, `ALREADY_EXISTS` → 409 `aborted`, `RATE_LIMITED` → 429
`usageLimits/rateLimitExceeded` with `Retry-After: 60`, `BACKEND_ERROR` → 503 `backendError`. Framework outcomes are also
rendered in that envelope: a grant refusal is 403 `forbidden`, an input-schema violation 400 `badRequest`. A path that is
not declared at all (for example `…/history` or `…/settings/filters`) gets the framework's own 404 (`synthetic API route
not found`); a declared path called with a method this package does not implement (for example `DELETE …/messages/{id}`)
gets the framework's 405 — never a plausible stub.

Every route uses the world's bearer token (`Authorization: Bearer`). An optional `Idempotency-Key` header becomes the
operation idempotency key; Google clients do not send one, so every mutation declares `idempotency: optional`.

### Search operators (`q` / `query`)

`from:` `to:` `cc:` `bcc:` `subject:` (substring, case-insensitive) · `label:<id or name>` · `in:inbox|sent|drafts|trash|spam|starred|important|anywhere|archive`
· `is:unread|read|starred|unstarred|important` · `has:attachment|userlabels|nouserlabels` · `newer_than:Nd|Nm|Ny` `older_than:` ·
`after:` `before:` `newer:` `older:` (`YYYY/MM/DD`, `YYYY-MM-DD` or epoch seconds) · `filename:` · `rfc822msgid:` · bare words
(subject, snippet, body, from, to) · `"quoted phrases"` · `-term` · `a OR b` · `( … )` · `{a b}`.
`label:` resolves a system name first (`inbox`, `sent`, `draft(s)`, `trash`, `spam`, `unread`, `starred`, `important`,
`chat`), then a user label by id, exact name or its dashed form. Names that happen to be JavaScript object members
(`constructor`, `__proto__`, `toString`, …) are ordinary user-label names: `label:constructor` matches messages carrying a
user label called `constructor`, and matches nothing when no such label exists.
`TRASH`/`SPAM` are excluded unless the query names them (`in:trash`, `in:spam`, `in:anywhere`) or `includeSpamTrash` is set.
Any other operator (`category:`, `size:`, `larger:`, `deliveredto:`, `list:`, `AROUND`, …) fails with 400
`Unsupported search operator` instead of being silently ignored the way real Gmail does.

Dates and durations are validated, never normalised. A calendar date must name a real day: month `01`–`12`, a day that
exists in that month (leap years honoured) and one separator style, so `after:2024/13/45`, `after:2024/00/10`,
`before:2024/02/30`, `older:2023/02/29` or `after:2024-01/05` fail with 400 `invalidArgument` ("is not a valid calendar
date" / "Unsupported date value") instead of rolling over into a later real date. Gmail's public documentation does not
say what an impossible date does, so this package refuses it with its declared invalid-query error. Years are taken
literally (`0024` is year 24, not 1924). Calendar dates mean midnight **UTC**; Gmail's API guide says midnight in the PST
time zone, so pass epoch seconds for exact instants. A 9–11 digit value is epoch seconds, a 12–13 digit value epoch
milliseconds. `newer_than:`/`older_than:` take `N` from `0` to `9999` with `d`, `m` (30 days) or `y` (365 days); longer
numbers such as `newer_than:99999999999999999999d` fail with 400 `invalidArgument`, and `older_than:0d` means "before the
world's virtual now".

A search expression containing U+FFFD (the replacement character) fails with 400 `invalidArgument` ("contains U+FFFD"):
the HTTP layer decodes query strings leniently, so malformed percent-encoding such as `q=from%3A%E0%A4%A` arrives as
U+FFFD, and running that search would silently match nothing. A correctly encoded U+FFFD (`%EF%BF%BD`, or U+FFFD in an
MCP/canonical `query`) is refused the same way, because the Tool cannot tell the two apart. The same rule applies to
`metadataHeaders` on `messages.get`; `labelIds` with U+FFFD already fail the label-id pattern (400 `badRequest`) and a
`pageToken` with U+FFFD is an invalid page token (400 `invalidArgument`, "Invalid pageToken"). **Framework limitation:** a
malformed escape that is not a byte sequence (`q=%ZZ`) reaches the Tool as the literal text `%ZZ`, identical to a
correctly encoded `%25ZZ`, because query strings are decoded with `url.searchParams`
(`repositories/firedrill/packages/protocol-http/src/wire.ts:216-222`); such a query is searched as the literal word
`%ZZ` (200, usually no matches).

## Protocol compatibility

- **HTTP**: route paths, methods, JSON field names, pagination fields and error envelopes follow the Gmail API v1 discovery
  document for the subset above. **Not verified against the `googleapis` Node client or `google-api-python-client`**; the
  manifest's `compatibility` list is therefore empty. The `googleapis-http` connection recipe maps `GMAIL_API_BASE_URL` /
  `GMAIL_ACCESS_TOKEN` to the world's HTTP URL and token for your test process.
- **MCP**: tool names and argument names match Google's Gmail MCP tool schemas as captured on 2026-09-13; outputs are
  supersets of Google's (extra fields such as `threadId`, `historyId`, `internalDate`, `date` on drafts). **Not verified
  against Google's real MCP server**; the conformance suite drives the aliases with raw JSON-RPC over Streamable HTTP.

## Browser app

`firedrill serve` prints an app link (also **Tools → Open app** in the inspector). The app is a faithful recreation of the
Gmail web client, built so that a daily Gmail user recognises every screen:

- **Header**: main menu, the official Gmail mark (the gradient "M" Google introduced on 19 May 2026) beside the grey
  "Gmail" wordmark, the rounded search field with its search-options panel, Support (?) menu (Help, Training, Updates,
  Send feedback), Settings gear (quick settings), Google apps grid and the account avatar with Gmail's account card.
- **Navigation**: the light-blue **Compose** button, Inbox (unread count), Starred, Snoozed, Sent, Drafts (count) and
  **More** (Important, Scheduled, All Mail, Spam, Trash, Categories › Social / Updates / Forums / Promotions, Manage labels,
  Create new label), then a colour-coded **Labels** list with nested labels, `+` and a per-label menu (colour palette,
  edit, add sublabel, remove).
- **Side panel** on the right: Calendar, Keep, Tasks and Contacts (official marks), Get add-ons `+` and the hide / show
  arrow.
- **Conversation list**: the select checkbox with its All / None / Read / Unread / Starred / Unstarred menu, refresh,
  "More email options" (Mark all as read), the `1–5 of 5` pager; the **Primary / Promotions / Social / Updates** category
  tabs in the Inbox; 40 px rows (checkbox, star, importance marker, participants with the red *Draft* marker and message
  count, label chips, subject - snippet, attachment icon, date) that turn white when unread and reveal archive / delete /
  mark read / snooze on hover; the selection toolbar (archive, report spam, delete, read/unread, snooze, add to Tasks,
  Move to, Labels, More) with the "all conversations on this page are selected" banner; search result chips; the footer
  with the storage meter (`N GB of 15 GB used`), Terms · Privacy · Program Policies and "Last account activity"; the
  Spam and Trash notice about automatic deletion after 30 days above a non-empty list.
- **Conversation view**: back, archive, report spam, delete, mark unread, snooze, add to Tasks, Move to, Labels, More and
  the newer/older pager; subject with removable label chips, Print all and In new window; letter avatars, collapsed and
  expanded messages, "to me ▾" details, trimmed quotes, attachment cards with a full-screen text preview; per-message
  star / emoji reaction / reply / more menu; Reply / Reply all / Forward pills and the reaction button.
- **Compose window**: Material 3 light title bar (minimize, full screen, save & close), To with Cc/Bcc, Subject, body,
  autosaving draft with a *Saved* status, the formatting bar (undo, redo, font, size, bold, italic, underline, text
  colour, align, lists, indent, strikethrough, remove formatting; toggled by "Formatting options"), the split **Send ▾**
  button, attach, link, emoji, Drive, photo, confidential mode, signature, more options and discard.
- **Quick settings** (See all settings, density, theme, inbox type, reading pane, conversation view, plus this app's page
  size and keyboard-shortcut list), Gmail-style snackbars with **Undo**, and Gmail's keyboard shortcuts (`c`, `/`,
  `j`/`k`, `Enter`, `u`, `e`, `#`, `r`, `f`, `s`, `x`).
- **Bulk actions never stop half-way.** Archive, Spam, Not spam, Move to Inbox and Mark as read/unread go through
  `messages.batch-modify` (100 ids per call). Trash, Label as and Discard drafts need one call per conversation
  (`threads.trash`, `threads.label`/`threads.unlabel`, `drafts.delete`): the app runs every call even when the Tool
  refuses one, skips client-side any conversation whose messages are all already in Trash (which `threads.trash`
  refuses with `FAILED_PRECONDITION`), and the snackbar reports the partial outcome — "2 of 5 conversations moved to
  Trash; 3 skipped: 1 conversation already in Trash; <the Tool's reason>" — with **Undo** offered only for the
  conversations that actually changed.

Routes mirror Gmail's hashes (`#inbox`, `#inbox/<threadId>`, `#category/promotions`, `#label/<name>`, `#search/<query>`,
`#drafts`, `#spam`, `#trash`, …). Below 768 px the layout collapses the way Gmail's mobile layout does: the search field
becomes an icon that expands into a full-width search bar with a back arrow, help, settings, apps and the side panel leave
the view, the navigation becomes a drawer, rows stack sender / subject / snippet on three lines, and the toolbars drop
secondary actions, so nothing scrolls horizontally at 390 px.

**Category tabs.** Promotions, Social and Updates list Inbox conversations carrying `CATEGORY_PROMOTIONS`,
`CATEGORY_SOCIAL` or `CATEGORY_UPDATES` (server-side `labelIds` filter with real pagination). Primary is the Inbox minus
those: the engine has no `category:` operator, so the app reads every Inbox page (up to 6,000 conversations) and pages
locally; a larger Inbox shows an error instead of a partial list. The Inbox unread count in the navigation is the whole
Inbox (`INBOX.threadsUnread`), not only Primary. "Move to" a category adds that category label and removes the other
category labels.

### Gmail controls that are not simulated

These render in place with Gmail's glyphs, hover states and tooltips, and open a short "Not simulated by this Tool" panel
(or are visibly disabled). They never write anything:

- Header: Google apps grid; Support › Training, Updates, Send feedback to Google; account card › Manage your Google
  Account, Add account, Sign out, Privacy Policy, Terms of Service.
- Navigation: Snoozed, More › Scheduled, More › Manage labels.
- Side panel: Calendar, Keep, Tasks, Contacts, Get add-ons.
- Lists and conversations: Snooze (row hover, selection and conversation toolbars), Add to Tasks, More › Filter messages
  like these, More › Mute, message menu › Filter messages like this and Print, Print all, In new window, emoji reactions.
- Compose: every formatting-bar control (undo, redo, font, size, bold, italic, underline, text colour, align, numbered and
  bulleted lists, indent less/more, strikethrough, remove formatting — the body is plain text), Send ▾ (schedule send),
  Attach files, Insert link, Insert emoji, Insert files using Drive, Insert photo, confidential mode, Insert signature,
  More options.
- Quick settings: See all settings, Theme › View all, inbox types other than Default, reading-pane splits, turning off
  conversation view (shown disabled).
- Footer: the storage meter link (Manage storage), Terms, Privacy, Program Policies, Last account activity › Details.
- Spam and Trash: "Delete all spam messages now" and "Empty Trash now" in the 30-day notice (no permanent deletion).

Every control calls the Tool's own operations through `/_firedrill/client.js`: lists paginate with `pageToken`, search
sends the typed query verbatim (unsupported operators surface the operation's error inline), every mutation carries a fresh
idempotency key that is reused only when the same uncertain action is retried, the page polls `getContext().revision` and
refreshes without discarding an open compose window, and loading, empty, error (503 fault), rate-limited (429 fault) and
permission-denied states are rendered. All record text goes through `textContent`; HTML message parts are shown as text,
never injected. A UI write is visible over HTTP/MCP and vice versa because both hit the same operations.

The app is served from `firedrill/tools/gmail/app/site/` (`ui.root`), which bundles the Roboto font (OFL 1.1) and the
official Gmail mark; `firedrill/tools/gmail/app/assets/ATTRIBUTION.md` records every asset's source URL and licence
(the framework serves only html/css/js/json/image/font files, so the Markdown record and the licence text sit beside,
not inside, the served root). Screenshots live in the author repository (`specs/gmail/*.png`), not in the package.

## Faults and events

| id | kind | effect |
|---|---|---|
| `send-rate-limited` | fault on `messages.send`, `drafts.send` | 429 `RATE_LIMITED`, `Retry-After: 60`; nothing is stored |
| `mailbox-unavailable` | fault on `messages.list`, `threads.list` | 503 `BACKEND_ERROR` / `UNAVAILABLE`; reads by id keep working |
| `message.sent` | event | `{ mailbox, messageId, threadId, to, cc, subject, deliveredTo }` |
| `message.trashed` | event | `{ mailbox, messageIds, threadId }` |
| `message.labels-changed` | event | `{ mailbox, messageIds, addLabelIds, removeLabelIds }` (modify, batchModify, label/unlabel) |

Activate a fault in a scenario with `"faults": [{ "packageId": "gmail", "faultId": "send-rate-limited" }]`.

## Conformance

`firedrill tool test gmail` runs eight drills twice (REST flow, MCP aliases, ownership isolation, denied actor, both faults,
a fresh-install actor without identity attributes, and an over-bound mailbox) from `firedrill/` with the Node-only target
`test/conformance.mjs`, checks that every operation, declared error, event and fault was observed, and compares the two
passes. The over-bound drill uses the `mailbox-over-bound` scenario, whose mailbox rows carry `limits` below their authored
row counts, to prove that whole-mailbox reads and capacity-checked writes refuse with `FAILED_PRECONDITION` while reads and
label changes by id keep working and nothing is stored. Author-written checks are not certification of Gmail fidelity.

## Limitations

- A bounded subset: 27 operations / 24 REST routes. There is no `history`, `watch`/Pub/Sub push, `settings.*` (filters,
  forwarding, delegates, sendAs, vacation, IMAP/POP, S/MIME, CSE), `messages.insert`/`import`, permanent delete,
  `batchDelete`, `threads.delete`/`untrash`, `labels.get`, upload endpoints, `format=raw`, `fields` masks, discovery document
  or OAuth flow. Undeclared paths return the framework 404; declared paths called with an unimplemented method return
  the framework 405.
- JSON request bodies may nest at most 512 levels: a deeper body is refused with `400` in the route codec (depth is
  measured iteratively) before argument validation. Caller text quoted back in error messages (label ids and names,
  addresses, `userId`, search operators and values) is clipped to 200 characters with an ellipsis.
- Authentication is the isolated world bearer token; scopes, consent and domain-wide delegation are not emulated, and
  `userId` other than `me`/own address is refused.
- Search is substring-based over the documented operators; unsupported operators fail instead of being ignored; no ranking,
  stemming, `category:`, size operators or exact-word `+` matching. `newer_than:Nm` counts 30-day months and `Ny` 365 days.
- Sending never leaves the world; copies are delivered only to recipient addresses that own a `mailboxes` row at the moment
  of the send (`INBOX`+`UNREAD`, bcc stripped). A `mailboxes` row exists when the starter data authors it or after the
  mailbox's **first write** (`saveMailbox` runs only in mutating operations: any send, draft, label or label-change
  call); reads such as `profile.get` or `messages.list` materialise nothing. So a second actor whose mailbox is not in
  the starter data and that has only read so far receives nothing (the sender's `SENT` copy still records the
  address, and `message.sent.deliveredTo` omits it) until that actor writes once. No bounces, aliases (`sendAs`),
  scheduled send, spam classification, importance inference or category assignment.
- Raw RFC 2822 input supports `text/plain`, `text/html` or a two-part `multipart/alternative` in UTF-8/ASCII with
  7bit/8bit/quoted-printable/base64. Attachments cannot be created (Google's own `create_draft` has the same limit); the
  authored attachments are read-only. `Date`, `Message-ID` and `From` are always generated from the world clock and actor.
- REST `Message.payload` is synthesised from stored text/html: headers, boundaries, `partId`s and `sizeEstimate` are
  plausible, not byte-identical to Gmail. Label thread counts are computed per call: `threadsTotal` counts threads that
  hold the label, `threadsUnread` counts threads with at least one unread message that itself carries the label (the
  message-label intersection, as Gmail counts); `messagesTotal`/`messagesUnread` per label are not reported.
- Pagination is live (not a snapshot); tokens are bound to the mailbox and exact query; `maxResults` above 100 is clamped.
- **Page tokens are caller input.** `nextPageToken` is opaque (a base64url payload), but it comes back from the caller and
  can be rewritten, so every layer is validated before anything in it is used: the declared 2,048-character bound, the
  base64url alphabet and length class (no padding, no whitespace, none of the standard alphabet's `+/`), strict UTF-8,
  the decoded payload's length and its nesting depth (measured iteratively, never by recursion), and finally the exact
  shape this Tool writes — a scope hash bound to the mailbox, list kind and query, plus either an `[internalDate, id]`
  anchor whose two parts must match the declared `messages.internalDate` (`^[0-9]{1,16}$`) and row-id
  (`^[A-Za-z0-9_-]{1,64}$`) patterns, or a finite non-negative integer offset for `labels.list`. Anything else — a
  deeply nested array in place of an id, a number or object where a string belongs, extra or `__proto__` keys, another
  query's scope, a token from a different list kind, invalid base64 or invalid UTF-8 — is refused with
  `INVALID_PAGE_TOKEN` (400 `invalidArgument`, "Invalid pageToken"). No forged value ever reaches a string coercion,
  a comparison or a row-id lookup, and the reason is never disclosed. Tokens are not portable between queries,
  mailboxes or list kinds. A token longer than the declared 2,048 characters never reaches the handler at all: the
  framework's argument validation refuses it first, so the REST routes answer 400 `badRequest` ("arguments do not
  match gmail.messages.list") in the Gmail envelope rather than "Invalid pageToken", and the canonical endpoint
  answers `framework.INVALID_OPERATION_INPUT` — the same refusal the `labelIds` pattern gives, one layer earlier.
- **Response size budget.** The framework refuses HTTP responses over 1 MiB, so every route that can return large content
  measures the UTF-8 bytes of the JSON it would return (computed from code points, so CJK text and emoji count fully)
  against a 900,000-byte budget. `threads.list`, `messages.list`, `drafts.list` and canonical `labels.list` pages stop
  before the budget (possibly with fewer entries than `maxResults`/`pageSize`) and carry a real `nextPageToken`; every
  entry is measured in the shape actually returned (REST `GET …/threads` pages on `{ id, snippet, historyId }`, which
  canonical callers get with `withoutMessages: true`). A canonical `threads.list` entry whose message summaries alone
  pass the budget (a very wide thread: dozens of messages each carrying 50 long recipients) is refused with
  `FAILED_PRECONDITION` naming the thread, never returned above the budget; list with `withoutMessages: true` and read
  its messages one at a time. The app does exactly that for such a folder page: it re-reads the page with
  `withoutMessages` and each row's summaries on their own, so every other conversation still shows; the one conversation
  too large even alone is listed from `threads.get` with `restFormat: "minimal"` plus its latest From/Subject headers,
  marked "Too large", keeps row actions for all of its messages, and opens to a "too large to open here" notice. Gmail's
  `threads.get` is unpaged: its budget is measured on the value the operation returns (what MCP and app callers receive)
  and, when `restFormat` is given, also on that REST `Message` rendering, whichever is larger. `restFormat: "minimal"`
  returns only the REST minimal fields of each message (id, threadId, labelIds, snippet, historyId, internalDate,
  sizeEstimate), for every caller; and a thread that does not fit (for example six maximum-size CJK messages in
  `format=full`) is refused with 400 `failedPrecondition`, "Response too large for this Tool: …", whose advice names
  only the lighter formats that do fit, or `messages.get` one message at a time. `GET …/labels` is unpaged too and answers
  the same error when the whole label list exceeds the budget (only reachable with an authored `limits.labels` far above
  the default 500). A single message, draft or attachment always fits: the largest storable message (65,536-unit
  text body, 131,072-unit HTML body, 50 recipients, 998-character subject) encodes to about 807 KB in `format=full`.
- **Mailbox bounds, never silent truncation.** A mailbox holds at most 5,000 messages, 500 user labels and 500 drafts
  (per-mailbox override: `limits: { messages, labels, drafts }` on its `mailboxes` row, each 1–10,000). Every operation
  that has to read a whole namespace of the mailbox — `labels.list`, `labels.create`, `labels.update`, `messages.list`,
  `threads.list`, `drafts.list`, `drafts.create`, `messages.send` and `drafts.send` (delivery looks up the recipient's
  thread), `labels.delete` — reads one row past the bound and fails with `FAILED_PRECONDITION` (400 `failedPrecondition`,
  "Mailbox … holds more than N … rows") when authored data exceeds it, instead of returning an incomplete list. Writes
  refuse to fill a mailbox further: `labels.create` at the label bound, `drafts.create` at the draft or message bound,
  `messages.send`/`drafts.create` when the sender's messages are at the bound, and `messages.send`/`drafts.send` when an
  in-world recipient's mailbox is at its message bound (real Gmail would accept and bounce later; bounces are not
  modelled). Reads by id (`messages.get`, `threads.get`, `drafts.get`, `attachments.get`, `profile.get`) and label
  changes by id (`messages.modify`, `batchModify`, `label`/`unlabel`, `threads.modify`, trash/untrash) never scan and
  keep working. Label counts in `labels.list` are computed per call over the (bounded) message rows.
- Trash semantics are simplified: trash removes `INBOX`, untrash restores `INBOX`; no 30-day purge and no permanent
  deletion, although the app shows Gmail's 30-day notice above Spam and Trash.
- The footer storage meter sums `sizeEstimate` over every message in the mailbox (Spam and Trash included, read
  through `threads.list`); "15 GB" is Gmail's standard free allowance shown as a label, and no quota is enforced. "Last
  account activity" is the world time of the app's latest mailbox read, so it reads "0 minutes ago" while the page is
  open; sign-in sessions are not modelled.
- A thread holds at most 200 messages, the declared bound of every thread output and event payload. Gmail's
  conversation view starts a new conversation after 100 messages; this simulation instead refuses the 201st message
  with a declared `FAILED_PRECONDITION` (`messages.send`, `drafts.create`, `drafts.send`, a `drafts.update` move, and
  a recipient's copy in `deliver()`), so a thread at the bound still reads, modifies and trashes in full.
- The app recreates Gmail's look, layout and interactions but not everything Gmail does. The controls listed under
  "Gmail controls that are not simulated" change nothing; beyond them there is no rich-text formatting, attachment
  upload, undo-send, offline mode, Chat/Meet rail, settings pages beyond the quick-settings panel, "N new"
  tab badges or split reading pane. HTML bodies are shown as plain text and binary attachments show a placeholder instead
  of a rendered preview. "Today", relative dates ("3 days ago") and the list's time-versus-date choice come from the world's
  virtual time (`profile.get.serverTime`, re-read on every refresh), never from the browser clock, so replaying the same
  world on another day renders identically. Times and dates are displayed in UTC (the zone the date search operators use)
  rather than the browser's time zone, so the same world renders identically on every machine.
- All data is fictional. Never point this package at a production Gmail account; it cannot reach one.

## Trademarks

Gmail, the Gmail logo, Google, Google Calendar, Google Keep, Google Tasks, Google Contacts and their logos are trademarks of Google LLC. They are used here only to identify the service this
package simulates inside a test environment; this package is an independent Firedrill Tool and is not affiliated with,
sponsored by or endorsed by Google. The logo file under `firedrill/tools/gmail/app/` (`google-gmail-2026.svg`, the Gmail
"M" mark in use since 19 May 2026, downloaded from the ln-dev7/logos-apps library and cross-checked against Wikimedia
Commons `File:Gmail icon (2026).svg`) and the side-panel marks (`google-calendar-2026.svg`, `google-keep-2026.svg`, `google-tasks-2026.svg`,
`google-contacts.svg`, same library) are unmodified downloads whose sources are listed in
`firedrill/tools/gmail/app/assets/ATTRIBUTION.md`; the "Gmail" wordmark next to it is plain page text. The bundled Roboto
font is licensed under the SIL Open Font License 1.1 (`firedrill/tools/gmail/app/assets/fonts/OFL.txt`).

## Safety

Tool behavior and conformance targets are trusted local code, not a sandbox. Review before running. Keep generated
worlds, reports and app links (they contain short-lived local credentials) out of the package and your repository.
