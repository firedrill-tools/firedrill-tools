# @firedrill-tools/tool-discord

A synthetic, stateful **Discord HTTP API v10 subset** for [Firedrill](https://firedrill.run). REST-only agents and bots can be
pointed at it instead of the real service: guilds, channels, threads, messages, reactions, members, roles and direct messages live in
Firedrill state, so reads reflect writes, reset restores the starting data, and every call is recorded as evidence. Nothing is ever
sent to Discord or anyone else.

The package also ships a browser app that looks and behaves like the Discord desktop client (dark theme) and calls the same
operations, so a person or a browser agent can read and change the same world an API agent uses. See [Browser app](#browser-app).

## Install

```sh
firedrill tool add /absolute/path/to/firedrill-tools-tool-discord-0.1.1.tgz --install
firedrill serve
```

A new world receives the starting data (`starter.json`, virtual time 2026-09-14T16:00:00Z) and a default actor with grants for all
21 operations. For an existing world, add grants yourself, one per operation:

```json
{ "packageId": "discord", "operationId": "messages.create" }
```

Run the packaged conformance suite with `firedrill tool test discord`.

## Connecting a client

Routes are served under `/api/v10` on the Firedrill HTTP binding (`FIREDRILL_HTTP_URL`), mirroring `https://discord.com/api/v10`.
Authenticate with the world token (`FIREDRILL_HTTP_TOKEN`) using either `Authorization: Bot <token>` or `Authorization: Bearer <token>`.
A REST client with a configurable base URL can be used, for example `@discordjs/rest` configured with
`api: "<FIREDRILL_HTTP_URL>/api"` and `version: "10"`. There is no Gateway (WebSocket): clients that need a Gateway connection to work
(such as a full `discord.js` `Client`) are out of scope.

Canonical operations are also available through Firedrill's generic bindings (`POST /v1/operations/discord/<operationId>` with
`{ "arguments": { ... } }`, and MCP as `discord.<operationId>`). Canonical arguments use Discord's snake_case names; list operations
return an object wrapping the array (for example `{ "messages": [...] }`) where the wire route returns the bare array.

## Identities

| actor attribute | meaning |
|---|---|
| `userId` (snowflake string, optional) | The account behind the caller's token. It must match a non-deleted user in state; otherwise every operation answers **401** `{ "message": "401: Unauthorized", "code": 0 }`. |

When `userId` is absent (as for the actor `firedrill tool add` creates), the caller acts as `meta.default_user_id`: the seeded bot
**Fieldnote** in the starting data. If that row is missing, the lowest-id non-deleted bot user is used, then the lowest-id user.

Framework grants decide whether an operation may be called at all (a missing grant answers 403 `{ "message": "Missing Permissions",
"code": 50013 }`). Inside Discord, access is computed per call from state with Discord's documented permission algorithm: the guild
owner and `ADMINISTRATOR` get everything; otherwise `@everyone` plus the member's roles, then channel overwrites (`@everyone`, roles,
member). Threads use their parent channel's overwrites. Bits with behaviour: `ADD_REACTIONS`, `VIEW_CHANNEL`, `SEND_MESSAGES`,
`MANAGE_MESSAGES`, `READ_MESSAGE_HISTORY`, `MENTION_EVERYONE`, `MANAGE_THREADS`, `CREATE_PUBLIC_THREADS`, `CREATE_PRIVATE_THREADS`,
`SEND_MESSAGES_IN_THREADS`.

## Starting data

93 fictional rows (no real people, e-mail addresses or tokens):

- **Northwind Makers**, owned by Priya: roles `@everyone`, Moderator (Maya), Maintainer (Theo), Muted (Sam), the managed Fieldnote bot
  role; categories Information and Community; `#announcements` (only moderators can send; nobody else can add new reactions or start
  threads), `#rules` (read-only, empty), `#general` (9 messages: a join system message, a message from a deleted user, a question and
  its reply, an edited message, mentions, a message carrying the maximum 20 reactions), `#help`, `#mod-log` (moderators only), voice
  channel Lounge; threads *Build fails on arm64* (active), *Old release checklist* (archived) and *Duplicate: arm64 build* (locked);
  guild emojis `northwind_ok` and `solder`; Rio is a pending member.
- **Orbit Lab**, owned by Lee; the bot is not a member.
- A DM between Fieldnote and Maya. Lee shares no guild with the bot, so the bot can open a DM with Lee but cannot send in it.

## Operations and routes

No MCP aliases are declared (Discord publishes no MCP tool contract); canonical names are `discord.<operationId>`.

| operation | route | success |
|---|---|---|
| `users.get` | `GET /api/v10/users/{@me or user.id}` | 200 User (`@me` adds `mfa_enabled`, `locale`, `verified`, `email: null`) |
| `users.list-my-guilds` | `GET /api/v10/users/@me/guilds?before&after&limit&with_counts` | 200 array of partial guilds |
| `users.list-dm-channels` | `GET /api/v10/users/@me/channels` | 200 array of DM channels |
| `users.create-dm` | `POST /api/v10/users/@me/channels` `{ recipient_id }` | 200 DM channel (existing one reused) |
| `guilds.get` | `GET /api/v10/guilds/{guild.id}?with_counts` | 200 Guild with roles and emojis |
| `guilds.list-channels` | `GET /api/v10/guilds/{guild.id}/channels` | 200 array (threads excluded) |
| `guilds.list-active-threads` | `GET /api/v10/guilds/{guild.id}/threads/active` | 200 `{ threads, members }` |
| `guild-members.list` | `GET /api/v10/guilds/{guild.id}/members?limit&after` | 200 array (limit 1-1000, default 1) |
| `guild-members.get` | `GET /api/v10/guilds/{guild.id}/members/{user.id}` | 200 Member |
| `roles.list` | `GET /api/v10/guilds/{guild.id}/roles` | 200 array |
| `channels.get` | `GET /api/v10/channels/{channel.id}` | 200 guild channel, thread or DM |
| `messages.list` | `GET /api/v10/channels/{channel.id}/messages?around|before|after&limit` | 200 array, newest first |
| `messages.get` | `GET /api/v10/channels/{channel.id}/messages/{message.id}` | 200 Message |
| `messages.create` | `POST /api/v10/channels/{channel.id}/messages` | 200 Message |
| `messages.edit` | `PATCH /api/v10/channels/{channel.id}/messages/{message.id}` | 200 Message |
| `messages.delete` | `DELETE /api/v10/channels/{channel.id}/messages/{message.id}` | 204 |
| `reactions.add` | `PUT /api/v10/channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me` | 204 |
| `reactions.remove` | `DELETE /api/v10/channels/{channel.id}/messages/{message.id}/reactions/{emoji}/{@me or user.id}` | 204 |
| `reactions.list-users` | `GET /api/v10/channels/{channel.id}/messages/{message.id}/reactions/{emoji}?after&limit&type` | 200 array of users |
| `threads.create-from-message` | `POST /api/v10/channels/{channel.id}/messages/{message.id}/threads` | 201 Thread (id = message id) |
| `threads.create` | `POST /api/v10/channels/{channel.id}/threads` | 201 Thread (type 12 by default) |

Behaviour highlights:

- `messages.create`: `content` (at most 2000 characters) and/or `embeds` (at most 10, validated: title, description, url, color, timestamp
  with a zone, footer, author, fields; 6000-character total), `tts`, `flags` (0 or `SUPPRESS_EMBEDS` 4), replies with
  `message_reference` (`fail_if_not_exists`), `allowed_mentions`, and `nonce` + `enforce_nonce`: a repeat of the same nonce by the same
  author in the same channel within 300 seconds of virtual time returns the stored message without writing anything. Mentions
  (`<@id>`, `<@&id>`, `@everyone`/`@here` with `MENTION_EVERYONE`) are resolved against state. Sending in an archived, unlocked thread
  unarchives it; the sender joins the thread. `attachments`, `sticker_ids`, `components`, `poll` and `shared_client_theme` are rejected
  with `50035`.
- `messages.delete` removes the message and its reactions; replies to it then show `referenced_message: null`.
- Reactions: at most 20 distinct emoji per message (`30010`); joining an existing reaction needs no `ADD_REACTIONS`; custom emoji use
  `name:id` and must belong to the channel's guild; removing someone else's reaction needs `MANAGE_MESSAGES`; archived threads reject
  reaction changes (`50083`).
- Threads: public threads created without a starter message leave a type-18 system message in the parent channel.
- Ids are snowflakes derived from virtual time plus a monotone counter, so they are unique and ordered; timestamps come from virtual
  time in UTC.

## Errors

Every error body has Discord's shape `{ "message", "code" }`; `50035` adds the nested `errors` object
(`{ "content": { "_errors": [{ "code": "BASE_TYPE_MAX_LENGTH", "message": "..." }] } }`) and `429` adds `retry_after` and `global`.
JSON request bodies nested deeper than 512 levels are refused with 400 before validation.

| declared code | HTTP | Discord code |
|---|---|---|
| `UNAUTHORIZED` | 401 | 0 |
| `UNKNOWN_CHANNEL` / `UNKNOWN_GUILD` / `UNKNOWN_MEMBER` / `UNKNOWN_MESSAGE` / `UNKNOWN_USER` | 404 | 10003 / 10004 / 10007 / 10008 / 10013 |
| `UNKNOWN_EMOJI` | 400 | 10014 |
| `MAX_REACTIONS` | 400 | 30010 |
| `MISSING_ACCESS` | 403 | 50001 |
| `CANNOT_EDIT_OTHERS_MESSAGE` | 403 | 50005 |
| `CANNOT_SEND_EMPTY_MESSAGE` | 400 | 50006 |
| `CANNOT_SEND_TO_USER` | 403 | 50007 |
| `MISSING_PERMISSIONS` | 403 | 50013 |
| `SYSTEM_MESSAGE_ACTION` | 400 | 50021 |
| `INVALID_CHANNEL_TYPE` | 400 | 50024 |
| `INVALID_FORM_BODY` | 400 | 50035 |
| `THREAD_ARCHIVED` | 400 | 50083 |
| `THREAD_ALREADY_CREATED` | 400 | 160004 |
| `THREAD_LOCKED` | 403 | 160005 |
| `RATE_LIMITED` (fault only) | 429 | 20028 |
| `SERVICE_UNAVAILABLE` (fault only) | 503 | 0 |
| `STATE_BOUND_EXCEEDED` | 500 | 0 |

## Events and faults

| id | kind | details |
|---|---|---|
| `message.created` | event | `{ guild_id, channel_id, message_id, author_id, type, content, referenced_message_id }`; not emitted for a nonce de-duplicated return or for thread-created system messages |
| `message.deleted` | event | `{ guild_id, channel_id, message_id, deleted_by }` |
| `reaction.added` | event | `{ guild_id, channel_id, message_id, user_id, emoji: { id, name } }`, only when the reaction is new |
| `channel-write-rate-limited` | fault (`before`) | `messages.create`, `messages.edit`, `reactions.add` answer 429 with `retry_after: 1.5`, `Retry-After: 2` and `X-RateLimit-*` headers; nothing changes |
| `message-create-lost-response` | fault (`after_commit`) | `messages.create` commits (and emits its event) but answers 503; shows whether an agent's retry double-posts |

Activate a fault from a scenario: `"faults": [{ "packageId": "discord", "faultId": "channel-write-rate-limited" }]`.

## Compatibility

Not verified against any real client (`@discordjs/rest`, `discord-api-types`, `discord.py` or others); `manifest.compatibility` is
empty. Paths, field names, status codes and error shapes follow Discord's public OpenAPI description (API version 10) for the subset
above.

## Limitations

- Only the 21 routes above exist. Everything else answers the framework's 404/405, never a stub: Gateway events and intents,
  interactions and application commands, webhooks, attachments and multipart bodies (framework 415), stickers, polls, components,
  forum and media channels, voice, invites, bans/kicks/timeouts, member/role/channel writes, permission overwrite edits, pins, bulk
  delete, crosspost, typing, member search, thread member management, archived-thread lists, emoji management, audit log, OAuth2, and
  API versions other than 10.
- `@me` is a path parameter (the framework does not allow `@` in fixed path segments). Where Discord only accepts `@me`, another value
  answers 400 `50035` instead of Discord's 404.
- Framework-level outcomes keep framework statuses with Discord-shaped bodies: schema-invalid input is 400 `50035` (detail code
  `BASE_TYPE_INVALID`), a missing grant is 403 `50013`. A JSON body that is not an object answers the framework's 400
  `HTTP_REQUEST_MAPPING_FAILED`; a reaction path with malformed percent-encoding answers the framework 404. A request whose token is
  not the world token is rejected by the framework before any codec runs (401 with the framework body, not Discord's
  `{ "message": "401: Unauthorized", "code": 0 }`, which is returned only for an actor `userId` without an account).
- Rate limiting exists only as the injected fault: successful responses carry no `X-RateLimit-*` headers, there is no bucket accounting,
  global limit or `X-RateLimit-Reset`. Outages exist only as the lost-response fault.
- The token is the world token for both `Bot` and `Bearer`; identity comes from the actor. OAuth2 scopes, token types and privileged
  intents are not enforced, and human accounts may call the API.
- Permission rules cover the listed bits only. Role hierarchy, timeouts, slowmode (`rate_limit_per_user` is stored only), NSFW gates,
  verification level and member screening have no behaviour. Threads never auto-archive; `invitable` is stored only.
- DMs: a bot can send only to a non-bot, non-deleted user it shares a guild with.
- Messages: no attachments, link embeds or unfurls, message search, `mention_channels`, cross-channel references or forwards
  (`message_reference.type` 0 only); `@here` is treated like `@everyone`; deleting a message does not roll back `last_message_id`.
  Burst reactions are not modelled (`count_details.burst` is 0 and `type=1` lists are empty). Unicode emoji are recognised by a
  heuristic (at most 32 UTF-16 units containing a non-ASCII code point, ASCII limited to keycap bases).
- Nonce de-duplication is keyed per channel and nonce; a different author reusing a live nonce replaces the stored row.
- Every scan is bounded by `meta.limits.scan_rows` (default 5000, maximum 9999). A request that would need more rows fails with 500
  (`STATE_BOUND_EXCEEDED`) instead of returning partial results.
- Every response is bounded by `meta.limits.response_bytes` (default and maximum 900000, minimum 1024), counted as UTF-8 bytes of the
  JSON body including escapes, because the HTTP binding refuses bodies over 1 MiB. Paginated lists (`messages.list`,
  `guild-members.list`, `reactions.list-users`, `users.list-my-guilds`) stop filling a page before the budget, so a page can hold fewer
  than `limit` entries while more exist (for example about 70 messages of 2000 control characters each): keep paging with the last id as
  `before`/`after` until an empty page. Pages always fill outward from the cursor, so nothing is skipped or repeated. Lists without
  pagination (`guilds.list-channels`, `guilds.list-active-threads`, `roles.list`, `users.list-dm-channels`), a single entry larger
  than the budget and any other response over it fail with 500 (`STATE_BOUND_EXCEEDED`) instead of being cut short. Real Discord
  returns full pages and unpaginated lists whole, so this differs only for responses of several hundred kilobytes.
- Snowflakes use worker and process 0; ids generated faster than virtual time advances drift above their embedded millisecond.
- No friends, friend requests, presence or activities, Nitro, Shop, gifts, server creation or discovery, notification settings, pins,
  inbox, GIFs, stickers, voice or user settings are modelled. The browser app shows these Discord surfaces only as empty states,
  disabled controls or panels marked "not simulated by this Tool", and stores nothing for them (see [Browser app](#browser-app)).

## Browser app

`firedrill serve` prints the app link (also under **Tools → Open app** in the inspector). The app is static HTML, CSS and JavaScript in
`firedrill/tools/discord/app/site/`, declared as `"ui": { "root": "app/site", "entry": "index.html" }`. It calls only the 21 operations
above through `/_firedrill/client.js`, as the selected actor, so everything it shows comes from world state and every change it makes is
visible over the REST routes (and the reverse: it re-reads when the world revision changes, without clearing a message you are typing).

| surface | what it does | operations |
|---|---|---|
| Server rail | Direct Messages button with the Discord mark, one tile per server (initials, pill indicator, tooltip), separator, green Add a Server (+) and Discover (compass) buttons; Add a Server opens a note that creating or joining servers is not simulated, Discover opens a not-simulated page | `users.list-my-guilds` |
| Channel sidebar | server header popout (description, member counts, your roles, owner), collapsible categories, text/announcement/rules/private channel icons, joined active threads nested under their parent, voice channels shown but not openable; channels the actor cannot view are hidden using Discord's permission algorithm; unread channels in white | `guilds.get`, `guilds.list-channels`, `roles.list`, `guild-members.get`, `guilds.list-active-threads` |
| Channel header | Threads popout, Notification Settings menu (options shown disabled, marked not simulated), Pinned Messages, Inbox and Help popouts (not simulated), Show/Hide Member List toggle that removes and restores the member list in place, Search box shown disabled; tooltips below the icons | `guilds.list-active-threads`, `guild-members.list` |
| Chat | "Welcome to #channel!" start, day dividers, messages grouped per author within 7 minutes, role-coloured names, APP tag for bots, timestamps from world time in UTC, reply previews ("Original message was deleted"), `(edited)`, user/role/channel mentions, custom emoji as `:name:`, embeds, join and thread-created system messages, thread chips, mention highlight; older history loads on scroll (`before`, 50 per page) | `messages.list`, `messages.get`, `channels.get` |
| Message actions | hover toolbar (three quick reactions, Add Reaction, Edit on your own messages, Reply, Create Thread, More) and More menu (Copy Text, Copy Message ID, Delete Message with Discord's confirmation modal); inline edit (Escape cancels, Enter saves, Arrow Up edits your last message) | `reactions.add`, `messages.edit`, `messages.delete` |
| Reactions | pills with counts, your reactions highlighted, click to toggle, hover lists who reacted, emoji picker with search and the server's custom emoji, 20-reaction cap message | `reactions.add`, `reactions.remove`, `reactions.list-users` |
| Composer | `Message #channel` placeholder, Enter sends and Shift+Enter adds a line, reply bar with the mention on/off toggle, Gift, GIF, Sticker and Emoji buttons (Gift opens a not-simulated note; the other three open the expression picker on its GIFs, Stickers or Emoji tab, where GIFs and Stickers are marked not simulated), character counter near 2000; permission, locked-thread and muted states replace the input with Discord's notice; every send carries a `nonce` with `enforce_nonce` and an idempotency key, and Retry reuses both so a lost response never double-posts | `messages.create` |
| Threads | thread side panel with its own history and composer, Threads popout listing the channel's active threads, New Thread panel from a message or standalone (public or private, archive duration, starter message) | `threads.create-from-message`, `threads.create`, `messages.list`, `messages.create` |
| Member list | members grouped by hoisted role, role colours, APP tag, pending-screening note, "Load more members" paging (100 per page); profile popout with Member Since, server join date, roles and a Message button | `guild-members.list`, `guild-members.get`, `users.get`, `users.create-dm` |
| Home | Friends, Nitro and Shop rows above the DM list; Home opens on Friends: Online, All, Pending and Blocked tabs with empty states (the Tool has no friendships), the Add Friend form shown disabled with a "not simulated by this Tool" note, and an empty Active Now column; Nitro and Shop open not-simulated panels | — |
| User panel | avatar and names (profile popout); Mute and Deafen toggle local visual state only (red slashed icons, Deafen also mutes, remembered in this browser); User Settings opens a My Account screen read from the account, with every other section marked not simulated; Escape closes it | `users.get` |
| Direct messages | DM list, conversation start header, "Find or start a conversation" quick switcher (Ctrl/Cmd+K) across shared-server members and channels | `users.list-dm-channels`, `users.create-dm` |
| States | loading screen and skeletons, error bars with Retry, "You do not have permission to view this channel", full-screen card for an actor without grants or with an unknown `userId`, rate-limit toast and "Not delivered" message with Retry/Discard, narrow layout with a navigation drawer | — |

Shown but not simulated (the Tool has no such behaviour, so these controls open empty, disabled or "not simulated by this Tool"
states and store nothing): friends and friend requests, Active Now, Nitro, Shop, gifts, Add a Server, Discover, notification settings,
pinned messages, inbox, help, GIFs, stickers, mute/deafen (local visual state only), user settings, search (the header search box is
disabled) and uploads (the `+` button is disabled). Not in the app at all: voice and video calls, presence/online status (members are
grouped by role, not by online state), server settings and invites. Links in messages are not navigable. Custom emoji have no images in state and render as
`:name:` chips. Discord's gg sans font is proprietary; the app bundles Noto Sans (SIL OFL 1.1). Interface icons are original drawings in
Discord's style. Seeded accounts have no avatar images, so the app shows Discord's default avatars (the Discord mark on one of six
colours, chosen from the user id). Asset sources and hashes are listed in `firedrill/tools/discord/app/assets/ATTRIBUTION.md`.

## Trademarks

Discord, the Discord logo and the Clyde symbol are trademarks of Discord Inc. The name and the logo files in
`firedrill/tools/discord/app/` (downloaded unmodified, sources in `app/assets/ATTRIBUTION.md`) are used only to identify the simulated
service in a test environment; this package is not affiliated with, sponsored by or endorsed by Discord Inc.

## License

Apache-2.0. See `LICENSE`.
