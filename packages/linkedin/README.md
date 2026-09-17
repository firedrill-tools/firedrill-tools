# LinkedIn Tool for Firedrill

`@firedrill-tools/tool-linkedin` simulates **one LinkedIn member's network** as seen by an application holding that member's
OAuth token: identity, posts, comments, reactions, social counts, the organization pages the member administers and the member's
first-degree connections. It follows LinkedIn's versioned Community Management REST API under `/rest` and the older `/v2`
consumer endpoints that many agents still call. Everything is synthetic: nothing is ever sent to LinkedIn, and "publishing" writes a row
in the Firedrill world.

The package also ships a **browser app** that recreates the LinkedIn desktop web client (feed, post composer, comments, reactions,
profile activity, connections, company pages). It calls the same operations as agents, so app and API share one world. See "Browser app".

## Install

```sh
firedrill tool add /path/to/firedrill-tools-tool-linkedin-0.1.0.tgz --install
firedrill serve
```

`tool add` creates a world with the starter data and grants the default actor every operation. For an existing world, add grants for
the `linkedin` operations listed below and copy the rows from `starter.json` (set `virtualTimeUs` from the same file so seeded relative
times make sense).

## Identities and scopes

| actor attribute | meaning |
|---|---|
| `linkedinPersonId` | The member the token belongs to (10-character LinkedIn-style id). **Absent** → the network's default member, **Maya Okafor** (`mOk4f0rPx1`), so a fresh actor sees the seeded network. **Present but unknown** → every operation answers `401 INVALID_ACCESS_TOKEN` (`serviceErrorCode` 65600). |
| `linkedinScopes` | OAuth scopes of the token (string array). **Absent** → `openid, profile, email, w_member_social, r_member_social, rw_organization_admin, r_organization_social, w_organization_social, r_1st_connections_size`. |

Scope checks: userinfo needs `openid` and `profile` (e-mail fields need `email`); `/v2/me` and `/v2/people` need `profile`; writes need
`w_member_social` (as a person) or `w_organization_social` (as an organization); reads of member threads need `r_member_social`,
organization threads `r_organization_social`; organization records and role lists need `rw_organization_admin`; connection counts and
the connection list need `r_1st_connections_size`. A missing scope answers `403 ACCESS_DENIED` ("Not enough permissions to access: …").

Row rules enforced from state:

- Organization roles come from `organization-acls` rows in state `APPROVED`. Posting, commenting or reacting as an organization needs
  `ADMINISTRATOR`, `CONTENT_ADMINISTRATOR` or `DIRECT_SPONSORED_CONTENT_POSTER`; finding an organization's posts also accepts `ANALYST`
  and `CURATOR`; full organization records and `q=organization` role lists need `ADMINISTRATOR`.
- `CONNECTIONS` posts are visible to the author and the author's connections (others get `403`); drafts exist only for their author
  under `viewContext=AUTHOR` (otherwise `404`); deleted posts answer `404`. Comments, reactions and social metadata inherit this.
- Only the author (or a poster of the authoring page) may edit or delete a post, open or close its comments; a comment may be edited
  only by its actor and deleted by its actor or the post's author; `q=author` for a person returns only the caller's own posts.

## Starting data

`starter.json` (109 rows, virtual time 2026-09-15T14:00:00Z), all fictional (`@example.com`, `media.example.com`): 12 members
(Maya Okafor and her 7 connections, plus members outside her network, one without an e-mail address), 3 organizations (Northwind
Analytics, Brightline Robotics, Lakeview Institute of Technology, a school) with approved, requested and revoked roles, 19 posts (text,
article, hashtag, mention, connections-only, logged-in-only, edited, comments-closed, 3000-character, legacy ugcPost, reshare,
reshare-disabled, a draft and a deleted tombstone), 12 comments with replies, a mention and an organization actor, and 14 reactions of
every current type.

## Operations

Canonical names are `linkedin.<operation>`; no MCP aliases are declared (LinkedIn publishes no MCP tool contract).

| operation | HTTP route(s) | notes |
|---|---|---|
| `profile.userinfo` | `GET /v2/userinfo` | OpenID Connect claims; `email`/`email_verified` only with the `email` scope |
| `profile.me` | `GET /v2/me` | lite profile |
| `people.get` | `GET /v2/people/(id:{personId})` | lite profile of a member in state |
| `posts.create` | `POST /rest/posts` (201, `x-restli-id`), `POST /v2/ugcPosts` (201, body `{ id }`) | text, article link or reshare; as a person or an organization |
| `posts.get` | `GET /rest/posts/{postUrn}` | `viewContext=READER\|AUTHOR` |
| `posts.list_by_author` | `GET /rest/posts?q=author&author=…` | `sortBy=LAST_MODIFIED\|CREATED`, `start`/`count` ≤ 100 |
| `posts.update` | `POST /rest/posts/{postUrn}` + `X-RestLi-Method: PARTIAL_UPDATE` (204) | `patch.$set` of `commentary` or `lifecycleState: PUBLISHED` |
| `posts.delete` | `DELETE /rest/posts/{postUrn}`, `DELETE /v2/ugcPosts/{urn}` (204) | idempotent; removes the post's comments and reactions |
| `feed.list` | canonical only | reverse-chronological home feed with `serverTime` from virtual time |
| `comments.create` | `POST /rest/socialActions/{target}/comments` (201) | top-level or one reply level; mention attributes |
| `comments.list` | `GET /rest/socialActions/{target}/comments` | post target: top-level comments; comment target: replies; oldest first |
| `comments.get` | `GET /rest/socialActions/{target}/comments/{commentId}` | |
| `comments.update` | `POST …/comments/{commentId}` + `PARTIAL_UPDATE` (200, `x-resourceidentity-urn`) | `?actor=` for organization comments |
| `comments.delete` | `DELETE …/comments/{commentId}` (204) | deletes replies too |
| `reactions.create` | `POST /rest/reactions?actor=…` (201) | a different type replaces the actor's reaction; `MAYBE` is rejected |
| `reactions.list` | `GET /rest/reactions/(actor:…,entity:…)` (bare reaction) and `GET /rest/reactions/(entity:…)?q=entity` | `sort=(value:CHRONOLOGICAL\|REVERSE_CHRONOLOGICAL\|RELEVANCE)` |
| `reactions.delete` | `DELETE /rest/reactions/(actor:…,entity:…)` (204) | |
| `social_metadata.get` | `GET /rest/socialMetadata/{entity}` | reaction summaries, comment summary, comments state |
| `social_metadata.set_comments_state` | `POST /rest/socialMetadata/{entity}?actor=…` (202) | closing deletes existing comments |
| `organizations.get` | `GET /rest/organizations/{id}` | approved administrators only |
| `organizations.find_by_vanity_name` | `GET /rest/organizations?q=vanityName&vanityName=…` | non-admin fields, case-insensitive |
| `organization_acls.list` | `GET /rest/organizationAcls?q=roleAssignee\|organization` | `role`, `state`, paging |
| `network_sizes.get` | `GET /rest/networkSizes/{orgUrn}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, `GET /v2/connections/{personUrn}` | follower count or the caller's connection count |
| `connections.list` | canonical only | first-degree connections, newest first, name/headline search |

## Wire behaviour

- Authentication is `Authorization: Bearer <FIREDRILL_HTTP_TOKEN>`; LinkedIn access tokens are not parsed.
- `/rest` routes require `LinkedIn-Version`: absent → `400 VERSION_MISSING`; anything outside the fixed active list 202509–202608 →
  `426 NONEXISTENT_VERSION`. `X-RestLi-Method` is required (`PARTIAL_UPDATE`) on the post and comment update routes and, when sent
  elsewhere, must name the route's method, otherwise `400 BAD_REQUEST`. `X-Restli-Protocol-Version` is accepted but not enforced;
  responses carry `x-restli-protocol-version: 2.0.0`.
- Errors use LinkedIn's envelope `{ status, serviceErrorCode, code, message }` on `/rest` routes and `{ status, serviceErrorCode, message }`
  (no `code`) on `/v2` routes. `serviceErrorCode` is 65600 for invalid tokens, 100 for access denied and 0 otherwise.
- URNs in paths and query values are Rest.li-encoded (`urn%3Ali%3Ashare%3A…`); complex keys use `(actor:…,entity:…)`. Batch get
  (`ids=List(…)`), query values with mangled percent-encoding, more than 20 repeats of a query parameter, JSON bodies nested deeper than
  512 levels, `__proto__`/`constructor`/`prototype` keys and unknown body fields answer `400 BAD_REQUEST`.
- Hashtags are stored and returned in LinkedIn's `{hashtag|\#|tag}` template form; `@[Name](urn)` mention annotations are kept verbatim.
- Post, activity and comment ids are 19-digit numbers whose high bits carry the creation time (`id >> 22` is epoch milliseconds).
- Collections return `{ paging: { start, count, links, total }, elements }`; `next`/`prev` links are included, and a page also ends
  early (with a `next` link) before its body passes about 900 KB counted in UTF-8 bytes.
- Canonical, MCP and app callers do not send headers, so the version and method checks apply only to HTTP routes.

## Events and faults

| id | kind | when |
|---|---|---|
| `post.published` | event | every accepted post create (both routes) and a draft published by `posts.update` |
| `comment.created` | event | every accepted comment create |
| `reaction.created` | event | a reaction row is created or its type changes (`previousReactionType`) |
| `comment-create-throttled` | fault, before | `comments.create` → `429 TOO_MANY_REQUESTS`, nothing written |
| `post-create-lost-response` | fault, after commit | `posts.create` → `500 INTERNAL_SERVER_ERROR` **after** the post is saved; LinkedIn has no idempotency header, so a blind retry publishes a duplicate |
| `reactions-unavailable` | fault, before | `reactions.create` and `reactions.delete` → `503 SERVICE_UNAVAILABLE` |

## Conformance

`firedrill tool test linkedin` runs the packaged suite (20 drills, 8 actors, 5 scenarios). `test/conformance.mjs` uses Node built-ins
only and checks statuses, headers, envelopes and bodies of every route, every declared error of every operation, the three events and
the three faults. Actors: `member` (Maya), `fresh` (no attributes), `connection` (Sam Whitfield), `stranger` (Tomás Ibáñez), `limited`
(`openid, profile, w_member_social`), `openid-only`, `revoked` (unknown member id) and `no-grants`. Scenario `tight-limits` sets
`meta/limits.maxScanRows` to 1 so every scanning operation proves it fails instead of truncating.

## Browser app

`firedrill serve` prints the app link (declared as `ui: {root: "app/site", entry: "index.html"}`). The app calls only declared operations
through `/_firedrill/client.js`, renders record text with `textContent`, sends an idempotency key with every mutation, and re-reads the
open view when the world revision changes (if you are typing a comment or have a dialog open it shows a "New posts" button instead).
Relative times ("2h", "3d") come from `feed.list.serverTimeMs` (world virtual time, UTC), never from the browser clock.

| Screen | What works | Operations |
|---|---|---|
| Home | Identity card (name, headline, first managed page, connection count), "Start a post", reverse-chronological feed with "Show more feed updates" paging, post cards with hashtags and mentions, article and reshare frames, reaction badges and counts, "…more" | `feed.list` |
| Post actions | Like click toggles LIKE; hovering Like (or ArrowUp) opens the six-reaction picker (Like, Celebrate, Support, Love, Insightful, Funny); Repost opens the composer with the embedded post (disabled when resharing is off or the post is not public); "…" menu: Edit post, Delete post (confirmation), Turn commenting off/on (confirmation warns that comments are deleted), Copy link | `reactions.create/delete`, `social_metadata.get`, `posts.create/update/delete`, `social_metadata.set_comments_state` |
| Composer | Post as the member or a page the member can post for, visibility Anyone / Connections only, 3000-character counter, "Add a link" article, inline errors; an `INTERNAL_SERVER_ERROR` on create warns that the post may already exist | `posts.create`, `posts.update` |
| Comments | Paged "Load more comments", replies (one level), comment as a page, @mention picker over connections (writes mention attributes), Like on comments, Edit (own) and Delete (own or on managed posts, confirmation), closed-comments notice, throttled message | `comments.list/create/update/delete`, `reactions.create/delete`, `connections.list` |
| Reactions dialog | All and per-type tabs with counts, rows with reaction badge, paged | `reactions.list`, `people.get`, `organizations.get` |
| Profile | Own profile: top card, Contact info (e-mail from userinfo), Activity with Posts/Drafts chips and Publish for drafts; other members: top card only | `profile.me`, `profile.userinfo`, `people.get`, `posts.list_by_author`, `posts.update` |
| My Network | "N Connections", name search, Recently added list with connection dates, paging | `connections.list` |
| Company page | Header with followers; administrators also see About and approved Page admins and can post as the page | `organizations.find_by_vanity_name`, `organizations.get`, `network_sizes.get`, `organization_acls.list`, `posts.list_by_author` |
| Search | Typeahead over connections and an exact company vanity-name match | `connections.list`, `organizations.find_by_vanity_name` |

States: skeleton loading cards, empty feed ("Start a conversation"), error cards with Retry, toasts for failed writes, an expired-session
screen for `INVALID_ACCESS_TOKEN` and an access screen for denied actors.

Visible but **not simulated** (they open a "Not simulated by this Tool" panel and change nothing): Jobs, Messaging, Notifications,
For Business, Premium, Send, Save, Hide post, Not interested, Profile viewers, Post impressions, Saved items, Groups, Newsletters, Events,
LinkedIn News, hashtag feeds, external link opening, photo/video/event/poll post types, emoji keyboard, comment images, reporting,
profile editing, Follow/Message on pages, feed sort options, full search results and footer links. Sign Out is shown disabled.

Avatars are initials on a colour derived from the member or organization id (no pictures are stored). The interface font stack matches
the real web client (platform UI fonts) with Fira Sans bundled as the offline fallback (SIL OFL 1.1); logos and font sources are listed
in `firedrill/tools/linkedin/app/assets/ATTRIBUTION.md`.

## Compatibility

Routes, headers, field names and error envelopes follow LinkedIn's public API documentation for the implemented subset. **Not verified
against a real client**: no official SDK (for example LinkedIn's Rest.li API client) has been run against `firedrill serve`, so
`compatibility` in the manifest is empty. The connection recipe `linkedin-rest-client` exposes `LINKEDIN_API_BASE_URL` and
`LINKEDIN_ACCESS_TOKEN` for a test process.

## Limitations

- Synthetic network only: no feed ranking (the home feed is reverse-chronological over the caller, its connections and followed or
  managed organizations), notifications, analytics, follows, invitations, messaging, search APIs or jobs. Follower counts are stored numbers.
- No OAuth flows, token refresh, expiry or introspection; identity and scopes come from actor attributes. Rate limits are not counted:
  429 and 503 come only from the faults.
- Posts: text, article-link and reshare posts only. No images, videos, documents, multi-image, polls, carousels, sponsored or targeted
  posts, call-to-action edits, `GET /v2/ugcPosts`, batch get or the ad-account finder. Only hashtag templating and verbatim mentions of
  the little text format are handled.
- Comments: one reply level, oldest-first order (no relevance order), no comment images (a `content` field answers `403`).
- Reactions: reacting again with a different type replaces the earlier reaction (the API's exact answer in that case is an approximation);
  the entity of a post reaction is stored and returned as the post's activity URN; `RELEVANCE` is served reverse-chronologically.
- Organizations and role assignments are read-only; no logos, page edits, brand or parent finders.
- `feed.list` and `connections.list` have no LinkedIn endpoint and use Firedrill-defined shapes (canonical operations only).
- Error codes and messages follow LinkedIn's published tables where they exist; business-rule messages, most `serviceErrorCode` values,
  `403` (rather than `404`) for hidden connections-only posts and the `/v2` envelope details are approximations. Framework denials
  (missing grants) and schema-invalid arguments are rendered in the LinkedIn envelope as `403`/`400`; requests the framework cannot route
  (unknown paths, undecodable path segments, bodies over 1 MiB) answer in the Firedrill envelope.
- Scans are bounded by `meta/limits.maxScanRows` (default 5000, at most 10000) and fail with `500 INTERNAL_SERVER_ERROR`
  ("state exceeds the supported bound of N rows") instead of returning partial results.

## Trademarks

LinkedIn, the "in" logo and the LinkedIn wordmark are trademarks of their owner. The name and the unmodified logo files bundled in the
app are used only to identify the simulated service in a test environment; this package is not affiliated with or endorsed by LinkedIn.
The logo sources are recorded in `firedrill/tools/linkedin/app/assets/ATTRIBUTION.md`.

## License

Apache-2.0. See `LICENSE`.
