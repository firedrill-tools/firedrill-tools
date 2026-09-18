# @firedrill-tools/google-calendar

A synthetic **Google Calendar** for [Firedrill](https://firedrill.run) drills. It simulates Google Calendar for a small set
of synthetic Google Workspace users behind a bounded subset of the **Calendar API v3** (`/calendar/v3/…`) and exposes the nine
tool names of Google's published **Calendar MCP** contract as aliases. Each actor is one user with a primary calendar, may own
secondary calendars, and sees other calendars through a calendar list with an access role. Invitations to users and rooms that
exist in the same world are mirrored onto their calendars under the same event id, exactly as Google does; nothing leaves the
world — no invitation e-mail, no real Meet room, no Google service is ever contacted.

Tool id `google-calendar` · package version `0.1.1` · engine `>=0.1.0 <0.2.0` · Apache-2.0 · backend **and** a browser app
(a Google Calendar-shaped web client served by `firedrill serve`, see [Browser app](#browser-app)).

## Install

```sh
firedrill tool add @firedrill-tools/google-calendar --install
firedrill serve
```

`tool add --install` on a fresh project creates `local-dev` with every operation granted and copies the 43 starter rows. In an
existing project it changes nothing silently: add the grants you want to the actor that represents your agent, for example

```json
{ "id": "agent", "attributes": { "email": "dana.reyes@example.test", "displayName": "Dana Reyes" },
  "grants": [ { "packageId": "google-calendar", "operationId": "events.list" }, { "packageId": "google-calendar", "operationId": "events.insert" } ] }
```

### Identities

The actor attribute `email` is the user's address and primary calendar id (rows are keyed by it). **Without it the actor
acts as the world's primary seeded user**: the owner of the first primary, non-resource calendar in `calendars` row-id
order (`dana.reyes@example.test` in the starter data), and that calendar's `summary` ("Dana Reyes") becomes
`creator.displayName`/`organizer.displayName` on events the actor creates. That is what the grant-only `local-dev` actor
that `tool add --install` creates gets, so a fresh install shows the seeded week with no manual step. Only a world without
any primary calendar falls back to `<actorId>@example.test`. An explicit `email` always wins: an actor whose primary
calendar has no rows yet is served a virtual primary calendar (owner, colour 14, popup reminder) that is materialised on
its first write, exactly as before, and `displayName` on the actor overrides the seeded name. A full user needs all 23
grants (the operation ids in the table below).

## Starting data

`starter.json` (and the author world in `firedrill/world.json`) holds 43 fictional rows at virtual time 2026-09-14T09:00Z (a
Monday): 1 counter row, 5 calendars, 8 calendar-list entries, 2 settings rows and 27 event rows.

- **dana.reyes@example.test** (Europe/London, week starts Monday, 24-hour, 30-minute default events) — primary calendar with a
  working week (inbox triage, roadmap sync, coffee at "Cafe Lumen", hiring debrief, security training, budget check-in, a
  transparent lunch walk), a focus-time block, a cancelled vendor call, a monthly "Invoice run" series with one moved exception,
  a far-future annual review, a declined invitation from an external organizer, and mirrored copies of the team standup and of
  Sam's 1:1 (with a synthetic Meet link, Dana tentative).
- **sam.okafor@example.test** (America/New_York, week starts Sunday, 12-hour, 60-minute default events) — a private dentist
  appointment, a multi-day out-of-office block, the 1:1 he organises, and copies of the standup, the design review and the retro prep.
- **Platform Team** (`c_st…01@group.calendar.google.com`, owned by Dana; Sam is `writer`) — the weekly standup
  (`RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR` with an `EXDATE`) and a past Q3 planning session.
- **Office Holidays** (`c_st…02@group.calendar.google.com`, owned by Sam; Dana is `reader`) — an all-day, transparent bank holiday.
- **Aurora (4) - 2nd floor** (`room-aurora@resource.calendar.google.com`, a resource; Dana `reader`, Sam `freeBusyReader`) —
  holds the room's copy of the design review.

All addresses use `example.test`, `example.com` or `example.org`; the content is invented. Replace it with your own scenarios —
nothing in the behavior depends on these rows. The starter rows are authored around 2026-09-14T09:00Z and `starter.json`
carries that instant as `virtualTimeUs`, so `tool add --install` creates the consumer world at it and quickAdd's "today",
the default search window, `created`/`updated` stamps and the app's current-time line all line up with the data. Set your
own `virtualTimeUs` in `world.json` or a scenario to move the world.

## Operations

Canonical MCP names are `google-calendar.<operation>`; the alias column lists the Google Calendar MCP tool name exposed in
addition. `calendarId` is optional everywhere and defaults to `primary`.

**Identifier validation.** Every caller-supplied calendar id (`calendarId`, `events.move` `destination`, `freeBusy`
`items[].id`), event id and page token is validated before it reaches state or a decoder. A calendar id that is empty,
whitespace-only, padded with whitespace (`" primary"` is not `primary`), contains whitespace, control characters or unpaired
surrogates, or is longer than 254 characters names no calendar and answers 404 `notFound` (canonical `NOT_FOUND`) on every
route and operation — for example `GET …/calendars/%20/events` or `GET …/users/me/calendarList/%09`; in `freeBusy` that
item reports `errors: [{ domain: "global", reason: "notFound" }]` under the id exactly as supplied. Ids are otherwise compared
case-insensitively. An event id that is not a base32hex id or a `<masterId>_<stamp>` instance id, or is longer than any
storable id (257 characters), is 404 `notFound`. A client-supplied `id` on insert must be 5–240 base32hex characters (400
`invalid`, "Invalid resource id value."). Page tokens must be unpadded base64url of the exact length and trailing bits the
encoder produces, decode to well-formed UTF-8 JSON of exactly `{ s, a }`, match the request's arguments (`s`), and carry a
position tuple `a` of exactly the endpoint's key shape — `[number, string, string]` for `calendarList` and `search_events`,
`[number, string]` for `events.list` and `instances`, numbers finite — before the position is compared with any row; anything
else (for example a forged `a` holding objects, arrays or `null`, or the wrong length) is 400 `invalid` on `pageToken`.

| operation | MCP alias | HTTP route | notes |
|---|---|---|---|
| `calendar-list.list` | `list_calendars` | `GET /calendar/v3/users/me/calendarList` | `maxResults` (≤250), `pageToken`, `minAccessRole`, `showHidden`; primary first, then by summary; the canonical/MCP result also carries `serverTime` (the world's virtual now, RFC 3339 UTC) — the REST resource omits it |
| `calendar-list.get` | — | `GET …/users/me/calendarList/{calendarId}` | |
| `calendar-list.patch` | — | `PATCH …/users/me/calendarList/{calendarId}` | own entry only: `colorId` (1–24), `backgroundColor`/`foregroundColor`, `selected`, `hidden`, `defaultReminders`; `If-Match` → 412 |
| `calendars.get` | — | `GET …/calendars/{calendarId}` | |
| `calendars.insert` | — | `POST …/calendars` | creates a secondary calendar owned by the actor plus an `owner` list entry (200, like Google) |
| `calendars.patch` | — | `PATCH …/calendars/{calendarId}` | owner only: `summary`, `description`, `location`, `timeZone` |
| `calendars.delete` | — | `DELETE …/calendars/{calendarId}` (204) | owner only, secondary calendars only; removes its events and every subscriber's entry, cancels mirrored copies |
| `events.list` | `list_events` | `GET …/calendars/{calendarId}/events` | `timeMin`/`timeMax` (half-open overlap), `q`, `singleEvents`, `orderBy=startTime\|updated` (other values → 400 `invalid`), `showDeleted`, `updatedMin`, `eventTypes` (repeatable), `iCalUID`, `timeZone`, `maxAttendees`, `maxResults`, `pageToken`; `syncToken` → 400 |
| `events.get` | `get_event` | `GET …/calendars/{calendarId}/events/{eventId}` | instance ids `<masterId>_<YYYYMMDDTHHMMSSZ>` resolve to expanded instances |
| `events.insert` | `create_event` | `POST …/calendars/{calendarId}/events` | attendees, rooms, recurrence, reminders, colour, visibility, transparency, guest permissions, client `id`; `conferenceData.createRequest` with `conferenceDataVersion=1` adds a synthetic Meet link; `sendUpdates` is recorded on the domain event only |
| `events.patch` | `update_event` | `PATCH` and `PUT …/calendars/{calendarId}/events/{eventId}` | PUT = replace (`start`/`end` required); changing only the start keeps the duration; patching an instance id creates an exception row; `If-Match` → 412 |
| `events.delete` | `delete_event` | `DELETE …/calendars/{calendarId}/events/{eventId}` (204) | sets `status: cancelled` (organizer: every copy; guest: own copy and `declined` on the organizer's event); again → 410 |
| `events.quick-add` | — | `POST …/calendars/{calendarId}/events/quickAdd?text=…` | documented English grammar (below) |
| `events.move` | — | `POST …/calendars/{calendarId}/events/{eventId}/move?destination=…` | organizer only, writer on both calendars, not for instances or mirrored copies |
| `events.instances` | — | `GET …/calendars/{calendarId}/events/{eventId}/instances` | expansion with exceptions merged; `timeMin`, `timeMax`, `originalStart`, `showDeleted`, paging |
| `events.respond` | `respond_to_event` | — (MCP/canonical only) | the actor's own `responseStatus`/`comment`, propagated to every copy |
| `events.search` | `search_events` | — (MCP/canonical only) | all readable calendars; default window now−30 days … now+365 days |
| `freebusy.query` | — | `POST …/freeBusy` | ≤50 calendars, ≤92 days; merged busy blocks; unreadable ids get `{ errors: [{ domain: "global", reason: "notFound" }] }` |
| `time.suggest` | `suggest_time` | — (MCP/canonical only) | 15-minute grid inside `startHour`–`endHour` (default 09:00–17:00), optional `excludeWeekends`; unknown attendees are free and listed in `unresolvedAttendees` |
| `time.now` | — | — (canonical only) | the world's virtual now rendered in the user's zone (`{ dateTime, date, timeZone, utc }`) for agents; Google's API has no equivalent. The app takes "today" from `serverTime` on `settings.list`/`calendar-list.list` instead |
| `colors.get` | — | `GET …/colors` | Google's fixed palette (24 calendar / 11 event colours) |
| `settings.list` | — | `GET …/users/me/settings` | `timezone`, `weekStart`, `format24HourTime`, `defaultEventLength`, `hideWeekends`, `locale`, `showDeclinedEvents`, `remindOnRespondedEventsOnly` (read-only); the canonical/MCP result also carries `serverTime` — the REST resource omits it |
| `settings.get` | — | `GET …/users/me/settings/{setting}` | |

Canonical inputs use the field names of Google's Calendar MCP tools (`startTime`/`endTime`, `pageSize`, `fullText`,
`eventType[]`, `attendees[].optionalAttendee`, `recurrenceData[]`, `overrideReminders[]`, `addGoogleMeetUrl`,
`notificationLevel`, `guestPermissions`, `availability`, `addedAttendees[]`, `removedAttendeeEmails[]`, `responseStatus`,
`responseComment`, `attendeeEmails[]`, `durationMinutes`, `preferences`, `query`); the REST codecs translate to and from the
Calendar API spelling. Every `Event` is returned as the REST resource plus the two MCP conveniences `conferenceUrl` and
`availability`, which the REST routes strip.

### Access model

Roles come from the actor's calendar-list entry (`freeBusyReader < reader < writer < owner`): a `freeBusyReader` may only use
`freebusy.query`/`time.suggest` (every `events.*` call answers 403 `requiredAccessLevel`), a `reader` may read, a `writer` may
also insert/patch/delete/move/quickAdd/respond, an `owner` may also patch and delete the calendar. Calendars the actor has no
entry for answer 404 (no probing). On an event the actor does not organise (and `guestsCanModify` is false) only the actor's own
response, reminders, colour and transparency may change; anything else answers 403 `forbiddenForNonOrganizer`. Framework grants
authorise calling an operation; an actor without a grant gets a Calendar-shaped 403 `forbidden` ("Insufficient Permission").

### Errors

Calendar's classic envelope `{ "error": { "errors": [{ "domain", "reason", "message", "locationType"?, "location"? }], "code",
"message" } }` with `invalid`/`required` (400), `timeRangeEmpty` (400), `failedPrecondition` (400), `forbidden`,
`requiredAccessLevel`, `forbiddenForNonOrganizer`, `rateLimitExceeded` (403, with `Retry-After: 30`), `notFound` (404),
`duplicate` (409), `deleted` (410), `conditionNotMet` (412) and `backendError` (500). Framework outcomes keep Firedrill's own
status codes: schema failures 400 `badRequest`, unknown routes 404, undeclared methods on a known path 405.

Caller mistakes in query parameters stay inside Calendar's envelope rather than the framework's. An empty `timeZone=`
(events get/list/instances, and an empty JSON `timeZone` on `freeBusy` or an event write) and `maxResults`/`maxAttendees`
values that are not positive integers (`0`, `abc`) answer 400 `invalid` with the offending value echoed back safely.
Every query parameter the routes read is singular, so one supplied more than once (`q=a&q=b`, `timeMin=…&timeMin=…`,
`orderBy`, `timeZone`, `maxResults`, `sendUpdates`, `destination`, `text`, …) answers 400 `invalid` "Invalid value for
parameter <name>: the parameter was supplied more than once" — the values are never joined or searched for, and the
request changes nothing. The route codec reports the repeated names in the operation argument `duplicateParameters`,
which the handler refuses before reading anything else (the same argument is refused the same way on the canonical and
MCP paths). Out-of-enum `orderBy` (events.list) and `minAccessRole` (calendarList.list) answer 400 `invalid` "Invalid
value for: <value> is not a valid value" instead of a schema failure; `minAccessRole` is not an events.list parameter
and is ignored there like any other unknown parameter (see Limitations). The real API's exact wording for repeated
parameters is undocumented and was not reproducible without OAuth credentials; this package refuses them uniformly.
Malformed percent-encoding is refused, not searched for: the framework decodes query strings leniently, so `q=%E0%A4%A` arrives as the replacement character U+FFFD, and
`q`, `iCalUID`, `originalStart`, `text` (quickAdd), `timeMin`/`timeMax` and `timeZone` answer 400 `invalid` ("contains
an invalid character (U+FFFD); check the percent-encoding") instead of silently running a corrupted search. A correctly
encoded U+FFFD (`%EF%BF%BD`) is refused the same way, because the two are indistinguishable after decoding; `%ZZ` is not
percent-encoding at all and is searched for literally, and legitimate non-ASCII search text (accented letters, CJK,
emoji) works normally. A blank or whitespace-only event id is a lookup that misses — 404 `notFound`, Calendar's answer —
not a schema refusal.

### Time zones, recurrence, quickAdd

Time zones are a fixed table with 2026 daylight-saving rules (no `Intl`): `UTC`, `Etc/UTC`, `Europe/London`, `Europe/Dublin`,
`Europe/Lisbon`, `Europe/Berlin`, `Europe/Paris`, `Europe/Madrid`, `Europe/Rome`, `Europe/Amsterdam`, `Europe/Zurich`,
`Europe/Stockholm`, `Europe/Warsaw`, `Europe/Athens`, `Europe/Helsinki`, `America/New_York`, `America/Toronto`,
`America/Chicago`, `America/Denver`, `America/Phoenix`, `America/Los_Angeles`, `America/Vancouver`, `America/Sao_Paulo`,
`America/Mexico_City`, `Asia/Kolkata`, `Asia/Dubai`, `Asia/Singapore`, `Asia/Tokyo`, `Asia/Shanghai`, `Asia/Hong_Kong`,
`Australia/Sydney`, `Australia/Melbourne`, `Pacific/Auckland`, `Africa/Johannesburg`, `Africa/Lagos`, `Africa/Nairobi`. Any
other name is a 400.

Years are literal: a date in years 0-99 (`0050-01-01`) means that year, never 1900-1999. All instants are computed
through a helper that corrects JavaScript's two-digit-year mapping, so recurrence expansion, `UNTIL` and instance ids of
such series stay in the year the caller wrote.

Recurrence: `RRULE:` with `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, `INTERVAL`, `COUNT` or `UNTIL`, `BYDAY` (weekly list; monthly
single ordinal such as `2TU`/`-1FR`), single `BYMONTHDAY`, single `BYMONTH`, `WKST`, plus `EXDATE:`/`RDATE:` (optional `TZID=`,
`VALUE=DATE`). Anything else is a 400 `Unsupported recurrence rule`. Expansion is capped at two years when no bounds are given
and at 2,000 instances per call (400 `failedPrecondition` beyond that). Expansion fast-forwards over whole recurrence periods
that end before `timeMin` (counting them analytically for `COUNT` rules), so the work depends on the requested window, not on
how far it lies from the series start: a year-9999 window or instance id answers as quickly as this week's. Duplicate `BYDAY`
entries (`MO,MO`) count once, as in RFC 5545. If expansion still exceeds its internal step budget, list, instances and
search answer 400 `failedPrecondition`, `freeBusy` and `suggest_time` answer 400 `invalid`, and an instance id that cannot be
derived is 404 `notFound`; none of them crash. Instance ids follow Google
(`<masterId>_<YYYYMMDDTHHMMSSZ>`, all-day `<masterId>_<YYYYMMDD>`).

quickAdd parses `<title> [<date>] [<time>[-<time>|for N min|hours]] [at|in <location>]` with `today`, `tomorrow`, `on <weekday>`,
`next <weekday>`, `<Month> <D>[, YYYY]`, `<D> <Month>`, `YYYY-MM-DD`, `H[:MM][am|pm]`, `noon`, `midnight`, `for 45 minutes`,
`for an hour` in the calendar's time zone; no date → today, no time → all-day, no end → the user's `defaultEventLength`.

## Browser app

`firedrill serve` also serves a Google Calendar-shaped web client (**Tools → Open app** in the inspector, or the app link printed
by `serve`). It is a client of the operations above — every button calls the same operation an agent calls, the world revision
is polled every two seconds so agent writes appear without a reload, and nothing is cached as authority. Screens:

- **Day / Week / Month / Year / Schedule / 4 days views** (`events.list` per selected calendar with `singleEvents`, the visible range as
  `timeMin`/`timeMax`, the user's zone as `timeZone`, 250-row pages; free/busy-only calendars are drawn as "Busy" blocks from
  `freebusy.query`): calendar-coloured chips, outlined chips for invitations you have not answered, striped for tentative,
  struck-through for declined, focus-time and out-of-office styling, the red current-time line at the world's virtual now
  (`serverTime` from `settings.list`, or from `calendar-list.list` when settings are denied — never the browser clock),
  all-day row, "N more" in month cells, press-and-drag on the hour grid to size a new event, keyboard shortcuts (`t`,
  `j`/`k`, `d`/`w`/`m`/`y`/`a`/`x`, `c`, `/`, `Esc`). Chips use the web client's named palette (Peacock, Basil, …) mapped
  from the API's legacy colour hexes; stored colours are unchanged. The year view shows the twelve months (dates only, as the
  web client does) and opens a day on click.
- **Header**: main menu, logo, Today, previous/next, the period title, search, support, settings, the view switcher, the
  Calendar/Tasks switch, Google apps and the account avatar. **Right side panel**: Keep, Tasks, Contacts, Maps, Get add-ons
  and hide/show.
- **Left panel**: Create (Event / Task / Appointment schedule), mini month, Search for people, Booking pages, *My calendars* / *Other calendars* with coloured
  checkboxes (`calendar-list.patch selected`), per-calendar menu (Display this only, Hide from list, Settings, the 24 calendar
  colours from `colors.get`), "+" → Create new calendar / browse hidden calendars.
- **Event popover** (`events.get`, plus the master for recurrence text): title, date and time in the user's zone, recurrence
  sentence, location, Join with Google Meet (synthetic link — nothing is dialled), guests with response badges and
  "2 yes, 2 awaiting", description, notifications, calendar; edit, delete (with "This event / All events" for series and a
  confirmation), more menu (Duplicate, Change colour via `events.patch`, Move to calendar via `events.move`, copy id), and
  **Going? Yes / No / Maybe** (`events.respond`).
- **Quick create** (click a slot or a mini-day, or press `c`) and the **full editor** ("More options"): title, dates, 15-minute
  time pickers, All day, time zone (the supported table), repeat presets or a raw RRULE, guests with optional/required and
  guest permissions, Google Meet, location, notification, calendar, colour, Busy/Free, visibility, description, and a **Find a
  time** tab (`freebusy.query` for everyone on the invitation, suggestions from `time.suggest`). Saving asks "Send invitation
  e-mails to guests?" and passes the answer as `notificationLevel`; every mutation carries an idempotency key that is reused
  only when the same save is retried after a rate-limit or backend fault; edits send the event's `etag` so a concurrent change
  is reported instead of overwritten.
- **Search** (`events.search`, 25-row pages, "More results"), **Settings** (read-only language/region/time format, Add calendar
  → `calendars.insert`, per-calendar name/description/zone via `calendars.patch`, colour, hide, owner-only delete via
  `calendars.delete` with confirmation, the access role in Google's wording).
- States: loading bar and skeletons, "Nothing planned" / "No results found", a banner with Retry when `events.list` fails
  (e.g. the `backend-error` fault), inline "Couldn't save" errors for the `write-rate-limited` fault without duplicating the
  write, and a "You don't have access" page for an actor without grants.

The served root is `firedrill/tools/google-calendar/app/site/` (plain HTML/CSS/ES modules, Roboto bundled, no CDN, no inline
scripts); attribution and licences are in `firedrill/tools/google-calendar/app/assets/`.

## Events and faults

| id | kind | payload / effect |
|---|---|---|
| `event.created` | event | `{ calendarId, eventId, iCalUID, organizer, attendees, start, end, notificationLevel, source: "insert"\|"quickAdd" }` |
| `event.updated` | event | `{ calendarId, eventId, sequence, changedFields, actor, notificationLevel }` from patch (only when something changed), move (`["calendarId"]`) and respond (`["attendees"]`) |
| `event.cancelled` | event | `{ calendarId, eventId, byOrganizer, affectedCalendars, notificationLevel }` from delete and from calendar deletion (per organised event that had in-world attendees) |
| `write-rate-limited` | fault | `events.insert`, `events.patch`, `events.delete`, `events.quick-add`, `events.move` → 403 `usageLimits/rateLimitExceeded` + `Retry-After: 30`; no state change |
| `backend-error` | fault | `events.list`, `events.search`, `freebusy.query`, `events.insert` → 500 `backendError` before any state change |

Activate a fault in a scenario with `"faults": [{ "packageId": "google-calendar", "faultId": "write-rate-limited" }]`.

## Connecting a client

`manifest.connections` describes two seams for test processes: `googleapis-http` (`GOOGLE_CALENDAR_API_BASE_URL` ←
`FIREDRILL_HTTP_URL`, `GOOGLE_CALENDAR_ACCESS_TOKEN` ← `FIREDRILL_HTTP_TOKEN`: point the client's root URL at the base so
requests hit `<base>/calendar/v3/…` and send the token as `Authorization: Bearer`) and `calendar-mcp` (`GOOGLE_CALENDAR_MCP_URL`
← `FIREDRILL_MCP_URL`, `GOOGLE_CALENDAR_MCP_TOKEN` ← `FIREDRILL_MCP_TOKEN`, Streamable HTTP). Protocol compatibility statement:
**not verified against a real client.** Neither Google's Calendar MCP server (`calendarmcp.googleapis.com`), the `googleapis`
Node client, `google-api-python-client` nor any other client library has been run against this package; the alias names and
input argument names follow Google's published tool documentation as read on 2026-09-14, and the alias outputs are documented
supersets whose exact field naming is unverified. `manifest.compatibility` is empty.

## Conformance

`firedrill tool test google-calendar` runs eight drills twice (REST flow as the owner, MCP aliases, sharing roles as the
colleague, a denied actor, both faults, a fresh-install actor without identity attributes, and size bounds: byte-bounded pages of
maximum-size events, an oversized free/busy request, and the 10,000-row scan-bound errors, which the `state-bound` scenario
produces with tool overrides because a world of that size is too large to ship in the package) from `firedrill/` with the
Node-only target `test/conformance.mjs`, checks that every
operation, every declared error of every operation, every event and both faults were observed, and compares the two passes.
The REST flow deliberately reaches the 50-subscriptions bound (45 scratch calendars) and the 2,000-instance expansion cap (an
unbounded daily series over seven years). Author-written checks are not certification of Google Calendar fidelity.

## Limitations

- A bounded subset: 23 operations / 20 REST routes. No `acl.*` (sharing is authored in starter/scenario data, not mutable
  through the API), `calendarList.insert/update/delete/watch`, `calendars.update/clear/transferOwnership`, `events.import`,
  `events.watch`/push channels, `syncToken` incremental sync (400), batch, attachments, `fields` masks, discovery document or
  OAuth flow. Undeclared paths return the framework 404; declared paths with an undeclared method return the framework 405.
- Authentication is the isolated world bearer token; OAuth scopes, consent, service accounts and domain-wide delegation are not
  emulated.
- Time zones are the 36-name table above with 2026 rules; `dateTime` values keep the caller's offset string; historical DST
  changes are not modelled.
- Recurrence supports the subset above; patching a series' time or rule discards its exception rows (Google keeps some);
  "this and following" splits are not supported.
- Invitations never leave the world: `sendUpdates`/`notificationLevel` is validated and recorded on the domain event only;
  copies exist only for attendee addresses that are primary or resource calendars in the same world; external guests get
  nothing; rooms always accept (no booking policies or conflicts).
- Meet links are synthetic `meet.google.com` strings that resolve to nothing; `htmlLink` values follow Google's `eid`
  construction but open nothing.
- `freebusy.query` treats every in-world primary calendar as free/busy-readable (Google's default), ignores `groupExpansionMax`
  and `calendarExpansionMax`, and limits the window to 92 days. All-day events with the default `opaque` transparency count as
  busy for the whole day. `time.suggest` uses a 15-minute grid and treats unknown attendees as free.
- Search is case-insensitive AND-substring matching over summary, description, location, organizer and attendees — no ranking,
  stemming or Google's tokenised matching. `events.search` is MCP/canonical only (Google's REST API has no cross-calendar search).
- Pagination is live (not a snapshot); tokens are bound to the exact arguments; `maxResults` above 250 is clamped (Google
  allows 2,500). A page also stops filling before its items reach about 900 KB of JSON (Firedrill refuses HTTP responses over
  1 MiB), so a page of large events can hold fewer than `maxResults` items while still returning a real `nextPageToken`.
  Bounds: 200 calendars per world, 50 subscriptions per user, 2,000 expanded instances per series and 20,000 assembled events
  per list, search or free/busy call. Reads scan at most 10,000 rows of one calendar or one user's list and never truncate:
  beyond that bound events list/instances/search, calendarList list, calendar delete and event patch/update/move answer 400
  `failedPrecondition`, while `freeBusy` and `suggest_time` answer 400 `invalid`. Reading or changing one event or instance
  by id does not scan. A `freeBusy` answer whose busy lists would pass the same ~900 KB budget answers 400 `invalid` ("narrow
  the time range or request fewer calendars").
- A JSON request body nested more than 512 levels deep is refused with a 400 by the route codec, before argument
  validation runs. Real Calendar requests never approach that depth. The canonical operation endpoint and MCP still
  parse arguments without a depth bound; that path belongs to the framework, not this package.
- Unknown query parameters are ignored rather than refused: for example `maxResults` on `events.get` or `minAccessRole`
  on `events.list`, which take no such parameter, are dropped by the route codec. Whether real Calendar ignores or
  refuses an unrecognised parameter was not reproducible here (its front end answers 401/403 before validating
  parameters without credentials), so this is documented as behaviour, not claimed as fidelity.
- `events.insert` accepts a missing `summary` (Google's REST does) although Google's MCP `create_event` documents it as required.
- Client-supplied event ids are limited to 240 characters (Google allows 1024): Firedrill state row ids are at most 512
  characters and an event row id is `<calendarId>:<eventId>`, exception rows `<calendarId>:<eventId>_<stamp>`. Longer ids
  answer 400 `invalid`. Calendar ids with surrounding whitespace are not trimmed; they are unknown calendars (404).
- Settings are read-only defaults per user; Google's remaining setting keys are absent. `eventType` values are stored and
  filterable but their typed sub-objects (`outOfOfficeProperties`, `focusTimeProperties`, …), `extendedProperties`, `source`,
  `gadget`, `attachments` and `eventLabel` are not.
- Virtual time only: `created`/`updated`, quickAdd's "today" and the default search window resolve against the world clock.
- The browser app is a client of the operations above, so it inherits every limit here. **Controls rendered but not
  simulated** (each opens a short "not simulated by this Tool" card or is visibly disabled): Create → Task and Appointment
  schedule; Search for people; Booking pages +; the Tasks side of the Calendar/Tasks switch; Google apps; the side panel's
  Keep, Tasks, Contacts, Maps and Get add-ons; the popover's Email event guests; the editor's More actions (Print, Publish
  event), Rooms tab and description formatting toolbar (disabled: descriptions are plain text). Also absent: moving or
  resizing existing events by dragging (drag on empty grid creates only), working hours, working
  location, birthdays, sharing/ACL pages, calendar subscriptions by URL, offline mode or
  notifications; settings pages are read-only except calendar name/description/zone/colour/visibility and calendar creation
  and deletion; recurrence editing offers presets plus a raw RRULE prompt; "this and following" is absent; search results
  omit calendars hidden from the list; the hour grid is fixed at 48 px per hour; date fields are the browser's native date inputs; the header
  logo is the official 2026 mark with its fixed "31" (the web client draws today's date into its logo, which would mean
  altering the trademark file). "Today", the red current-time line, the default slot of a new event and
  the year shown on dates all derive from the world's virtual time (`serverTime`), so replaying the same world on another
  day renders identically; if both `settings.list` and `calendar-list.list` are denied the app has no time source and
  shows its access page rather than the browser clock. The browser's IANA data still converts instants into the user's
  zone.
- All data is fictional. Never point this package at a production Google account; it cannot reach one.

## Trademarks

Google Calendar, Google Meet, Google Workspace and Google are trademarks of Google LLC. The names and the Google Calendar logo
are used here only to identify the service this package simulates inside a test environment; this package is an independent
Firedrill Tool and is not affiliated with, sponsored by or endorsed by Google. The logo file under
`firedrill/tools/google-calendar/app/` (`google-calendar-2026.svg`, the mark in use since 19 May 2026, downloaded unmodified
from the ln-dev7/logos-apps library and cross-checked against Wikimedia Commons `File:Google Calendar icon (2026).svg`) and the
bundled Roboto font (SIL OFL 1.1) are documented with their source URLs in
`firedrill/tools/google-calendar/app/assets/ATTRIBUTION.md`; the font licence is in `app/assets/fonts/OFL.txt`.

## Safety

Tool behavior and conformance targets are trusted local code, not a sandbox. Review before running. Keep generated worlds,
reports and serve links (they contain short-lived local credentials) out of the package and your repository.
