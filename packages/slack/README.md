# @firedrill-tools/slack

A synthetic **Slack workspace** for [Firedrill](https://firedrill.run) drills. It simulates one workspace behind a
bounded subset of the **Slack Web API** (`/api/<method>`, the same paths, argument names, form encoding and response
bodies the official SDKs use) and exposes the eight tool names of the archived reference **Slack MCP server** as aliases.
It ships a **browser app that recreates the Slack desktop client** (see Browser app) over the same operations. Everything
lives in the Firedrill world: posting a message stores a row that other members of the same synthetic workspace can read.
No Slack service is ever contacted and no real workspace can be reached.

Tool id `slack` · package version `0.1.1` · engine `>=0.1.0 <0.2.0` · Apache-2.0.

## Install

```sh
firedrill tool add @firedrill-tools/slack --install
firedrill serve
```

`tool add --install` on a fresh project creates the `local-dev` actor with every operation granted and copies the 87
starter rows (one workspace). In an existing project it changes nothing silently: add the exact grants you want to the
actor that represents your agent and, optionally, the attribute that selects which workspace member it acts as:

```json
{
  "id": "agent",
  "attributes": { "userId": "U01DANA0001", "teamId": "T01EXAMPLE0" },
  "grants": [
    { "packageId": "slack", "operationId": "auth.test" },
    { "packageId": "slack", "operationId": "conversations.list" },
    { "packageId": "slack", "operationId": "conversations.history" },
    { "packageId": "slack", "operationId": "chat.post-message" }
  ]
}
```

### Identities

The actor attribute `userId` selects the member the actor acts as and must be the id of a `users` row; an actor whose
`userId` matches no member fails every operation with `INVALID_AUTH` (HTTP 401, Slack `invalid_auth`), which is what a
token that resolves to no workspace member does. **Without the attribute the actor acts as the workspace's first active
human member in `users` row-id order** (deactivated and bot users are skipped; Dana Reyes, `U01DANA0001`, in the starter
data), so the grant-only `local-dev` actor that `tool add --install` creates is a member from its first call and needs
nothing added by hand; only a workspace without any active human member answers `invalid_auth` for such an actor. Set
`userId` explicitly to act as someone else. `teamId` is optional and must equal the workspace id when present. The 25
operation ids that can be granted are listed in the table below.

## Starting data

`starter.json` (and the author world in `firedrill/world.json`) describes the fictional workspace **Example Team**
(`T01EXAMPLE0`, `https://example-team.slack.com/`) at virtual time 2026-09-14T09:00Z:

- **6 members**: Dana Reyes (`U01DANA0001`, admin/owner), Sam Okafor, Priya Natarajan (contractor, member of `#general`
  and `#random` only), Lee Marsh (deactivated), Ops Bot (`is_bot`, `B01OPSBOT01`) and Mira Chen (Singapore time zone,
  status `:palm_tree:`). Addresses use `example.test`.
- **10 conversations**: `#general` (cannot be archived, one pinned welcome message), `#engineering` (15 messages: a
  four-reply thread with one `thread_broadcast`, an edited message, `+1`/`eyes` reactions, a bot message with Block Kit
  `blocks`; exactly three pages with `limit=5`), `#incidents` (private, a two-reply alert thread, one pinned runbook),
  `#random`, `#launch-q3` (archived), `#design` (public, Dana is not a member), `#leadership` (private, invisible to Dana),
  a Dana ↔ Sam IM, a Dana/Sam/Mira group DM and the empty `#onboarding`.
- **38 messages**, **30 memberships**, **2 pins**; the workspace `id_sequence` starts at 50, so generated ids
  (`C000000001F`, `D000000001G`, …) never collide with authored rows. `message_sequence` is the six-digit `ts` fraction
  and restarts in every virtual second (`message_second` records which second it belongs to; authored data may omit it),
  so the first generated `ts` is `1789376400.000001`. An allocation skips any fraction an authored row already occupies.

Replace it with your own scenarios whenever you like — nothing in the behavior depends on these rows.

## Operations

Canonical MCP names are `slack.<operation>`; the alias column lists the reference Slack MCP server tool name exposed in
addition. Read methods exist as `GET` (query string) **and** `POST`, write methods as `POST`. A `POST` body is
`application/x-www-form-urlencoded` (what `@slack/web-api` and `slack_sdk` send; also assumed when no content type is
given) **or** an `application/json` object, as the Web API accepts with a bearer token: `blocks` may then be a real array
and booleans real booleans.

| operation | MCP alias | HTTP route | notes |
|---|---|---|---|
| `auth.test` | — | `GET`/`POST /api/auth.test` | `url`, `team`, `user`, `team_id`, `user_id`, `bot_id` for bot users |
| `users.list` | `slack_get_users` | `GET`/`POST /api/users.list` | `limit` (≤ 1000), `cursor`; deactivated and bot users included |
| `users.info` | — | `GET`/`POST /api/users.info` | `user` |
| `users.profile.get` | `slack_get_user_profile` | `GET`/`POST /api/users.profile.get` | `user` optional (defaults to the acting member) |
| `conversations.list` | `slack_list_channels` | `GET`/`POST /api/conversations.list` | `types` (public_channel, private_channel, mpim, im), `exclude_archived`, `limit`, `cursor` |
| `conversations.info` | — | `GET`/`POST /api/conversations.info` | `include_num_members`; `is_member` always computed |
| `conversations.members` | — | `GET`/`POST /api/conversations.members` | `limit`, `cursor` |
| `conversations.create` | — | `POST /api/conversations.create` | `name` (leading `#` stripped, lower-cased), `is_private`; emits `channel.created` |
| `conversations.join` | — | `POST /api/conversations.join` | public channels only; repeat join returns `warning: already_in_channel` |
| `conversations.invite` | — | `POST /api/conversations.invite` | `users` comma list; all-or-nothing; one `channel_join` message per invitee |
| `conversations.open` | — | `POST /api/conversations.open` | `users` (1 → IM, 2–8 → group DM) or `channel`; `return_im` |
| `conversations.archive` | — | `POST /api/conversations.archive` | not `#general`, not IMs; no unarchive |
| `conversations.set-topic` | — | `POST /api/conversations.setTopic` | `topic` ≤ 250 characters |
| `conversations.history` | `slack_get_channel_history` | `GET`/`POST /api/conversations.history` | newest first, `limit` (≤ 999), `cursor`, `oldest`/`latest`/`inclusive`, `has_more`, `pin_count` |
| `conversations.replies` | `slack_get_thread_replies` | `GET`/`POST /api/conversations.replies` | parent first then replies oldest first; `ts`; `limit`, `cursor`, `oldest`/`latest` |
| `chat.post-message` | `slack_post_message` | `POST /api/chat.postMessage` | `text` and/or `blocks` (JSON string in a form body, real array in a JSON body), `thread_ts`, `reply_broadcast`; emits `message.posted` |
| `chat.reply` | `slack_reply_to_thread` | — (use `chat.postMessage` with `thread_ts`) | the reference server's threaded-reply contract |
| `chat.update` | — | `POST /api/chat.update` | own messages only; sets `edited` |
| `chat.delete` | — | `POST /api/chat.delete` | own messages, or anyone's for `is_admin`; a parent with replies becomes a `tombstone`; emits `message.deleted` |
| `reactions.add` | `slack_add_reaction` | `POST /api/reactions.add` | `name` with or without colons; 50 distinct reactions per message; emits `reaction.added` |
| `reactions.remove` | — | `POST /api/reactions.remove` | |
| `pins.add` / `pins.remove` | — | `POST /api/pins.add`, `…/pins.remove` | keeps `pinned_to` on the message in sync; `pins.add` refuses the 101st pin of a conversation with `too_many_rows` (Slack's limit is 100 pins) |
| `pins.list` | — | `GET`/`POST /api/pins.list` | newest pin first, with `permalink` and `pinned_to` |
| `search.messages` | — | `GET`/`POST /api/search.messages` | `query`, `count` (≤ 100), `page`, `sort` score/timestamp, `sort_dir` |

The MCP aliases accept the argument names of the reference server (`channel_id`, `user_id`, `thread_ts`, `timestamp`,
`reaction`, `limit`, `cursor`); the canonical operations accept both those spellings and the Web API ones (`channel`,
`user`, `ts`, `name`) and fail with `INVALID_ARGUMENTS` when both are given. Every success body carries `"ok": true` and is
returned verbatim over HTTP; MCP structured content is the same object.

### Access model (bot-token shaped)

- Public channels are visible to every member (`list`, `info`, `members`); private channels, IMs and group DMs only to
  their members — for anyone else they are `channel_not_found`.
- Reading history/replies/pins and every write requires membership (`not_in_channel`). `conversations.join` is the way
  into a public channel; it is `method_not_supported_for_channel_type` for private channels, IMs and group DMs.
- Archived conversations stay readable and refuse every write (`is_archived`).
- `chat.update` needs authorship (`cant_update_message`); `chat.delete` needs authorship or `is_admin`
  (`cant_delete_message`). Deactivated members cannot be invited or messaged (`user_not_found`).
- Framework grants authorize calling an operation; a grant-less actor gets `denied` (HTTP 403 with a Slack-shaped
  `missing_scope` body naming the operation).

### Errors and status codes

Error bodies are Slack-shaped: `{ "ok": false, "error": "<snake_case>", "response_metadata": { "messages": ["…"] } }`
(the `messages` array only when the handler adds detail, e.g. `invalid_arguments`). **The HTTP status is 4xx/5xx**, not
Slack's usual 200 — see [Protocol compatibility](#protocol-compatibility). Mapping: 400 `invalid_arguments`,
`invalid_cursor`, `invalid_name`, `no_text`, `no_query`, `is_archived`, `already_archived`,
`method_not_supported_for_channel_type`, `cant_invite_self`, `too_many_reactions`, `invalid_blocks_format` (a `blocks`
form field that is not JSON), `invalid_blocks` (JSON that is not an array of at most 50 typed block objects, nests deeper
than 32 levels or encodes to more than 100 KB), `response_too_large` (this package's own error: one message, match or pin
set alone exceeds the response byte budget — see Limitations), `too_many_rows` (this package's own
error, not a Slack one: a bounded read found more rows than the workspace's bound — including the lookup a reply to a thread
with a full `reply_users` list makes — or a conversation is at its pin bound —
see Limitations) · 401 `invalid_auth` · 403 `not_in_channel`, `cant_update_message`, `cant_delete_message` · 404
`channel_not_found`, `user_not_found`, `message_not_found`, `thread_not_found`, `no_reaction`, `not_pinned` · 409
`name_taken`, `already_in_channel`, `already_reacted`, `already_pinned` · 429 `ratelimited` (+ `Retry-After: 30`) · 503
`service_unavailable`. Framework outcomes are rendered Slack-shaped too: schema violations → 400 `invalid_arguments`,
missing grant → 403 `missing_scope`, unknown method → 404 `framework.HTTP_ROUTE_NOT_FOUND` (the framework's own body),
`GET` on a write route → 405. A `POST` body that cannot be mapped to a call at all — JSON that does not parse
(Slack: `invalid_json`), a JSON value that is not an object (`json_not_object`), or a content type other than form or
JSON — answers the framework's 400 `framework.HTTP_REQUEST_MAPPING_FAILED` body, whose text names the Slack error; the
Tool cannot declare those as Slack-shaped errors because the request never reaches an operation.

### Search query subset

Whitespace-separated terms (case-insensitive substring of `text`, all must match), `"quoted phrases"`, `-negation`, and
the modifiers `in:#name` / `in:name` / `in:<#C…>` / `in:@handle` (IM), `from:@handle` / `from:<@U…>` / `from:me`,
`is:thread`, `has:pin`, `has:reaction`, `has::emoji:`, `before:` / `after:` / `on:` (`YYYY-MM-DD`, UTC) and
`during:YYYY-MM`. Only conversations the acting member belongs to are searched; `tombstone` and `channel_join` messages are
skipped. Score = 10 per matching term, +5 for a whole-word match, +1 for a top-level message; ties break by `ts`
descending. Any other modifier (`to:`, `has:link`, `has:file`, `is:saved`, `with:`, `during:` with a day, …) fails with
400 `invalid_arguments` — real Slack treats unknown modifiers as text. A `query` holding U+FFFD (the framework decodes
malformed percent-encoding such as `%E0%A4%A` in query strings and form bodies to U+FFFD; a correctly encoded
`%EF%BF%BD` is rejected the same way) fails with 400 `invalid_arguments` instead of an empty result; `%ZZ` stays literal
text, and non-ASCII searches (`café`, `漢字`, emoji) work. `conversations.list` `types` is an enumerated list, so a
mangled value is already `invalid_arguments`; `users.list` has no free-text filter. Pagination is page-based (`count`/`page`); a page
past the end returns an empty page.

## Protocol compatibility

- **HTTP**: paths, methods, argument names, form encoding, success bodies, cursors (`response_metadata.next_cursor`,
  `""` on the last page) and error strings follow the public Slack Web API documentation for the subset above.
  **Not verified against `@slack/web-api` or `slack_sdk`**; the manifest's `compatibility` list is empty. The
  `slack-web-api` connection recipe maps `SLACK_API_URL` / `SLACK_BOT_TOKEN` to the world's HTTP URL and token for a
  test process (`@slack/web-api`: `slackApiUrl = SLACK_API_URL + "/api/"`; `slack_sdk`: `base_url`).
- **MCP**: the eight tool names and argument names follow the README of the archived reference Slack MCP server
  (`modelcontextprotocol/servers-archived`, `src/slack`) as read on 2026-09-14; outputs are the Slack bodies it returned
  verbatim. **Not verified against that server or against Slack's hosted MCP server**; the conformance suite drives the
  aliases with raw JSON-RPC over Streamable HTTP.

### Error envelope: HTTP status versus Slack's `ok: false`

Real Slack answers **HTTP 200** with `{"ok":false,"error":"…"}` for every platform error except rate limits (HTTP 429)
and outages (5xx). This package cannot reproduce that. The framework's manifest contract for HTTP routes
(`@firedrill-run/contracts`, `HttpRouteContractSchema`: `response.errors[].status` is `z.number().int().min(400).max(599)`)
requires every declared error of a route to map to a status between 400 and 599, and the manifest validator refuses a
route whose error map does not cover the operation's declared errors — so a 200 cannot be declared for an error and the
framework, which owns status codes, sends the mapped 4xx. What this package does instead: the **body** is Slack's exactly
(`{"ok":false,"error":"channel_not_found"}`, `response_metadata.messages` where Slack adds detail, `Retry-After` on 429)
while the status is the 4xx listed under "Errors and status codes". Effect on the official SDKs, read from their published
source and **not exercised here** (the `compatibility` list stays empty):

- **`@slack/web-api` (Node)**: `WebClient` treats a non-200 response that is not a 429 as an HTTP-level failure and rejects
  with an error whose `code` is `slack_webapi_http_error` (`ErrorCode.HTTPError`, carrying `statusCode`, `statusMessage`,
  `headers` and the parsed `body`), not the `slack_webapi_platform_error` (`ErrorCode.PlatformError`) whose `data.error`
  holds the Slack error string. Code that branches on `error.code === ErrorCode.PlatformError` or reads `error.data.error`
  therefore does not see `is_archived`, `channel_not_found` and friends; read `error.body.error` instead, and expect the
  client's retry policy to treat such responses as it treats any HTTP error before rejecting. 429 (`ratelimited` +
  `Retry-After`) and 503 (`service_unavailable`) behave as with Slack itself.
- **`slack_sdk` (Python)**: `WebClient` raises `SlackApiError` both for a non-200 status and for `ok: false`, so the
  exception type is the same as with Slack and `e.response["error"]` still holds the Slack error string; only
  `e.response.status_code` differs (4xx instead of 200).
- Agents and hand-written clients that branch on `body.ok`/`body.error` keep working; agents that treat any non-200 as a
  transport failure do not — that is the deviation to plan for.

## Browser app

`firedrill serve` prints an app link (also **Tools → Open app** in the inspector). The app is a faithful recreation of the
Slack desktop web client in its default *Aubergine* theme, built so that a daily Slack user recognises every screen: the
44 px top bar with back/forward/history controls, the centred search field ("Search Example Team", `Ctrl/⌘ K`) and help;
the 70 px workspace switcher rail (workspace tile, Home / DMs / Activity / More, the round **+** and your avatar with a
presence dot); the 260 px sidebar with the workspace name menu, filter and compose buttons, collapsible **Channels**
(`#` / lock glyphs, bold for conversations with activity since you last opened them, "Add channels" → create or browse)
and **Direct messages** (avatars with presence, group DMs with a member-count tile, "New message"); the white
conversation pane with the `# channel ▾` header (opens channel details), topic, member pill with stacked avatars,
**Messages / Pins** tabs, day-divider pills ("Today", "Yesterday", weekdays, "Thu, Aug 20th"), 36 px rounded-square letter
avatars, bold sender names with an **APP** badge for bots, hover times on consecutive messages, "(edited)" markers,
"replied to a thread:" preambles for broadcast replies, grey system lines for joins, italic tombstones, reaction pills
(your own in blue), "N replies · Last reply …" thread footers with reply avatars, the hover toolbar (✅ 👀 🙌 quick
reactions, add reaction, reply in thread, more → pin/unpin, copy link, edit, delete) and Slack's channel intro card;
the composer with the formatting toolbar (bold, italic, strike, link, lists, quote, code, code block as mrkdwn
markers), `+`, formatting toggle, emoji picker, `@` mention menu and the green send button (Enter sends, Shift+Enter
newline, `↑` edits your last message, Esc cancels); the 400 px **Thread** panel with the "N replies" divider and a
reply composer with "Also send to #channel"; the right-hand **Profile** panel (large avatar, title, status, local time,
Message button, contact information); the channel **details modal** (About with editable topic, Members with search and
"Add people", Settings with "Archive channel"); **Create a channel** (name with `#` prefix and 80-character counter,
Public/Private), **Edit topic**, **Add people** / **New message** pickers with chips, blue-highlight context menus and
Slack-red confirmations for delete and archive; the **Search** results view (query heading, Messages tab with count,
In / From / Pinned filter chips, Most relevant / Most recent sort, highlighted terms, `1–20 of N` pager, click to jump
and flash the message); **Browse channels** (All channels, search, member counts, Join / Joined ✓, Archived badge);
a **People** directory; and the "About this workspace" panel showing the official Slack mark and wordmark. Routes
mirror the client's conversation ids (`#C…`, `#C…/thread/<ts>`, `#search/<query>`, `#browse`, `#people`, `#pins`).
Below 768 px the rail hides behind a hamburger, the sidebar becomes a drawer and the thread/profile panel a full-width
sheet, so nothing scrolls horizontally at 375 px.

Every control calls the Tool's own operations through `/_firedrill/client.js`: history, replies, members and users
paginate with the Web API cursors ("Load older messages"), search sends the typed query verbatim (an unsupported
modifier surfaces the operation's `invalid_arguments` inline), every mutation carries a fresh idempotency key that is
reused only when the same uncertain action is retried, the page polls `getContext().revision` every 2 s and refreshes
the sidebar, the open conversation, thread or search without discarding composer text, and loading skeletons, empty
states (channel intro, "No pinned items yet", "No results"), errors (503 fault card with Retry, 429 fault note under the
composer that keeps your text), join bars for public channels you are not in, archived banners, `invalid_auth` and
permission-denied (`missing_scope`) states are rendered. All record text goes through `textContent`; mrkdwn markers,
`<@U…>` mentions, `<#C…>` channel links, `<url|label>` links and `:shortcodes:` are rendered from text nodes and styled
spans only. Presence is not modelled by the backend, so other members show the hollow "away" dot and only you show
active; "unread" bold is a per-tab convenience (activity since you last opened the conversation in this tab), not a
server-side `last_read`. A UI write is visible over HTTP/MCP and vice versa because both hit the same operations; reset
restores both.

The app is served from `firedrill/tools/slack/app/site/` (`ui.root`), which bundles Lato 400/700/900 (SIL OFL 1.1) and
the official Slack mark and wordmark; `firedrill/tools/slack/app/assets/ATTRIBUTION.md` records every asset's source
URL, hash and licence (the framework serves only html/css/js/json/image/font files, so the Markdown record and the
licence text sit beside, not inside, the served root). Screenshots live in the author repository (`specs/slack/*.png`),
not in the package.

## Faults and events

| id | kind | effect |
|---|---|---|
| `post-rate-limited` | fault on `chat.post-message`, `chat.reply`, `chat.update` | 429 `ratelimited`, `Retry-After: 30`; nothing is stored, no event |
| `history-unavailable` | fault on `conversations.history`, `search.messages` | 503 `service_unavailable`; replies, info, pins keep working |
| `message.posted` | event | `{ channel, ts, user, thread_ts?, subtype?, text }` from `chat.post-message` / `chat.reply` (not for `channel_join` system messages) |
| `message.deleted` | event | `{ channel, ts, user, tombstoned }` |
| `reaction.added` | event | `{ channel, ts, user, reaction }` |
| `channel.created` | event | `{ channel, name, creator, is_private }` (from `conversations.create`, not from `conversations.open`) |

Activate a fault in a scenario with `"faults": [{ "packageId": "slack", "faultId": "post-rate-limited" }]`.

## Conformance

`firedrill tool test slack` runs fourteen drills twice (Web API flow over GET and POST routes with form and JSON bodies, MCP aliases, member
visibility, denied actor, `invalid_auth` actor, both faults, a fresh-install actor without identity attributes, the
workspace bounds — scenario `bounds` lowers every bound of the `workspace` row below the authored rows — the member
bound of `conversations.open` — scenario `open-member-bound` sets `limits.members` to 2 — and group DMs of members with
21-character handles — scenario `open-long-handles` — a thread that already has 50 distinct repliers — scenario
`thread-many-repliers` — and a 4,000-byte response budget — scenario `response-budget` sets `limits.response_bytes`, and
the drill pages users, conversations, history, replies and search with multi-byte text, checks every page stays within
the budget and returns every item exactly once, then gets `response_too_large` from an oversized message and pin set —
and a full `ts` second — scenario `ts-sequence-full` seeds `message_sequence 999997` in the frozen virtual second with an
authored message at `.999998`; the drill posts the last `.999999` and then gets `too_many_rows` from posting, replying,
joining and inviting with nothing written)
from `firedrill/`
with the Node-only target
`test/conformance.mjs`, checks that every operation, declared error, event and fault was observed, and compares the two
passes. Author-written checks are not certification of Slack fidelity.

## Limitations

- A bounded subset: 25 operations, 24 Slack methods, 35 HTTP routes. Every other method (`conversations.leave/rename/
  setPurpose/kick/unarchive/mark/close`, `chat.postEphemeral/scheduleMessage/getPermalink/meMessage`, `reactions.get/
  list`, `files.*`, `bookmarks.*`, `canvases.*`, `usergroups.*`, `users.lookupByEmail/setPresence/getPresence/profile.set`,
  `team.info`, `emoji.list`, `views.*`, `apps.*`, `oauth.*`, `admin.*`, `search.all/files`, `rtm.*`) returns the framework
  404; a `GET` on a declared write path returns 405. Events API, Socket Mode, interactivity payloads, Block Kit
  rendering, Slack Connect and Enterprise Grid are not emulated.
- **Errors use HTTP 4xx/5xx status codes** with Slack-shaped `{ ok: false, error }` bodies. Real Slack answers HTTP 200 for
  `ok: false` (except 429 and 5xx); the framework's route contract only allows 400–599 for declared errors, so this cannot
  be reproduced — see "Error envelope" under Protocol compatibility for the exact constraint and what each official SDK
  does with it.
- `POST` bodies are form-encoded or JSON objects only; `multipart/form-data` (Slack accepts it) is refused with the
  framework 400 described above. The legacy `token` form/query parameter is not accepted; the bearer token is the
  isolated world token. OAuth scopes, `xoxb`/`xoxp` token types, app installation and per-method `missing_scope` are not
  emulated — a grant-less actor gets `missing_scope` for everything.
- Not verified against `@slack/web-api`, `slack_sdk`, Slack's hosted MCP server or the archived reference MCP server.
- Access is bot-token shaped: membership is required to read history/replies/pins and to write; user-token nuances
  (reading public channels without joining, admin visibility of private channels, `account_inactive` for deactivated
  actors) are not modelled. A thread's `reply_users` lists at most its first 50 distinct repliers; replies from
  further participants are still posted and counted in `reply_count` and `reply_users_count` (which counts every distinct
  replier), they are just not added to the list.
- `ts` values are unique and ordered but the fractional part is a per-second sequence, not sub-second wall time; all
  times are virtual. One virtual second holds at most **999,999** message timestamps; when the clock does not advance,
  the next `chat.postMessage`, `chat.reply`, `conversations.join` or `conversations.invite` fails with 400
  `too_many_rows` ("message ts limit reached …") and writes nothing. `edited.ts` is the virtual second with a `.000000`
  fraction.
- Search is substring-based over the documented modifier subset; unsupported modifiers fail with 400 instead of being
  treated as text; no ranking parity, stemming, `to:`, file/link filters, `search.all`, or cursor pagination.
- Messages store `text` and opaque `blocks`; no mrkdwn parsing, link unfurling, mention resolution on the server
  (`<@U…>` is stored verbatim), attachments, files, edit history, message metadata or permalink resolution (permalinks
  are string literals built from the workspace row and resolve nowhere).
- Tombstoning, `channel_join` system messages and reply counters follow Slack loosely; there are no `channel_leave`,
  `channel_topic` or `channel_archive` system messages, no unread/`last_read` tracking, no typing or presence.
- **Row bounds, never silent truncation.** The workspace serves at most 1,000 users, 1,000 conversations, 1,000 members
  per conversation, 10,000 messages per conversation and 100 pins per conversation (Slack's own pin limit); a world may
  set its own with `limits: { users, conversations, members, messages, pins }` on the `workspace` row (each 1–10,000).
  Every operation that has to read a whole set — `users.list`, `conversations.list`, `conversations.info` with
  `include_num_members`, `conversations.members`, `conversations.create`, `conversations.join`, `conversations.invite`,
  `conversations.open`, `conversations.set-topic` on an IM or group DM, `conversations.history`, `conversations.replies`,
  `chat.delete` of a reply (it recounts the thread), a threaded `chat.postMessage` to a thread whose `reply_users` list is
  already full (it looks for an earlier reply by the caller, before the new `ts` is allocated), `pins.add`, `pins.list` and `search.messages` — reads one row past
  the bound and fails with 400 `too_many_rows` ("messages in C01GENERAL1 exceed the supported bound of N rows") when the
  authored data exceeds it, instead of returning the first N rows; `pins.add` also refuses to exceed the pin bound.
  `conversations.open` refuses to create an IM or group DM whose member count (the requested users plus the caller)
  exceeds the member bound, before any id is allocated and whether or not `return_im` is set: 400 `too_many_rows`
  ("members of the requested conversation (3) exceed the supported bound of 2 rows (workspace.limits.members)"). A
  refused call stores nothing and consumes no id, and no error names a conversation id the call would have created;
  `conversations.create` and `conversations.open` build the returned channel from the rows they just wrote instead of
  rescanning them. Reads
  and writes by id (`auth.test`, `users.info`, `users.profile.get`, `conversations.info` without a member count,
  `chat.postMessage` (other than the full-thread case above), `chat.update`, `reactions.*`, `pins.remove`, `conversations.archive`) never scan and keep working.
  `too_many_rows` is this package's error string, not Slack's.
- **Response byte budget, never an oversized body.** Every list and read sizes its page by the UTF-8 bytes of the encoded
  JSON body (computed from code points, so CJK and emoji text count 3–4 bytes) as well as by count: 900 KB by default,
  lower when the `workspace` row sets `limits.response_bytes` (1,024–900,000). `users.list`, `conversations.list`,
  `conversations.members`, `conversations.history` and `conversations.replies` stop filling a page before the budget and
  return `has_more` / `response_metadata.next_cursor`, so a page can hold fewer items than `limit` and the cursor returns
  every item exactly once. `search.messages` keeps page arithmetic uniform: `per_page` / `paging.count` is the requested
  `count`, lowered only as far as needed for every page of the result set to fit, so `page` N+1 starts where page N ended.
  `pins.list` has no pagination in the Web API, so a pin set whose body exceeds the budget answers 400
  `response_too_large`; a single message or match that alone exceeds the budget does the same in history, replies and
  search (users, conversations and member ids with `too_many_rows`; unreachable within the stored schema bounds). With
  the default budget a single message exceeds it only in extreme cases (`text` is at most 40,000 characters and
  `blocks` at most 100 KB, so it takes reaction lists naming thousands of users).
- **Group DM names stay within 80 characters.** A group DM is named `mpdm-<handle>--<handle>-1` from its members' sorted
  handles, as in Slack. Handles may be 21 characters and a group DM may have nine members, so that form can exceed the
  80-character conversation name; such names keep the first 69 characters of the plain form (trailing `-`/`.` removed)
  and end with `-<8 hex digits>-1`, an FNV-1a digest of the full handle list
  (`mpdm-dana.reyes--longhandle1xxxxxxxxxx--longhandle2xxxxxxxxxx--longha-98de6b61-1`). Different member sets keep
  distinct names; Slack's own naming of very large group DMs is not reproduced.
- The browser app covers the 25 operations only: no huddles, canvases, files, bookmarks, "Later", saved items,
  notifications/Activity feed, presence, typing indicators, server-side unread counts, message forwarding, custom
  emoji, Block Kit rendering (blocks are stored opaque and the message `text` is shown), channel rename/leave/unarchive
  or purpose editing (the backend has no such operations).
- **Client chrome that is rendered but not simulated.** These controls sit where Slack puts them, with Slack-style glyphs,
  hover states and tooltips, and open a short "Not simulated by this Tool" panel instead of acting: the rail's **Later**
  tab; sidebar **Threads**, **Huddles**, **Drafts & sent** and **Add apps**; the channel **Files** tab and **+** (add tab);
  the **huddle** button and its caret; the message toolbar's **Forward** and **Save for later**; the composer's **video
  clip**, **audio clip** and **shortcuts** (slash) buttons and the send button's **schedule** caret, in both the channel
  composer and the thread reply composer (which carries the same formatting toolbar, +, format toggle, emoji and mention
  controls as the channel composer); and the rail **Activity** tab, which has no activity or notification feed.
  **Directories** opens a People / Channels menu (over `users.list` and `conversations.list`). The **+** attach menu's
  "Attach files" row is visibly disabled because `files.*` is not part of this Tool.
  Nothing in these panels calls an operation or invents workspace data.
- All data is fictional; the package contains no real workspace, member, token or copied content and must never be
  pointed at a production Slack workspace.

## Trademarks

Slack and the Slack logo are trademarks of Slack Technologies, LLC, a Salesforce company. They are used here only to
identify the service this package simulates inside a test environment; this package is an independent Firedrill Tool and
is not affiliated with, sponsored by or endorsed by Slack or Salesforce. The logo files under
`firedrill/tools/slack/app/` are unmodified official assets whose sources are listed in
`firedrill/tools/slack/app/assets/ATTRIBUTION.md`; the bundled Lato font is licensed under the SIL Open Font License 1.1
(`firedrill/tools/slack/app/assets/fonts/OFL.txt`).
