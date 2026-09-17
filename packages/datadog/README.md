# @firedrill-tools/tool-datadog

A synthetic **Datadog organization** for [Firedrill](https://firedrill.run): monitors that are evaluated deterministically
against synthetic metric points, the event stream, v2 metric intake and v1 timeseries queries, minimal dashboards and
minimal v2 incidents. It exposes Datadog-shaped REST routes (`DD-API-KEY` header, snake_case JSON, `{"errors":[...]}`
envelope, JSON:API incidents) plus canonical Firedrill operations and MCP aliases.

Everything is computed from Firedrill-owned state at world virtual time. Nothing is ingested from real hosts, no
agent, integration, log pipeline or notification channel exists, and no request ever reaches a real Datadog service.
Notification handles in monitor messages (`@slack-…`, `@pagerduty-…`, e-mail handles) are stored as text only.

The package also ships a **browser app** that recreates the Datadog web application over the same state (see *App*).

## App

`firedrill serve --root <project> --scenario baseline` lists the app link. The app is static HTML/CSS/JS under
`firedrill/tools/datadog/app/site/` and calls only this Tool's operations through `/_firedrill/client.js`, so every
change made in the app is visible over HTTP/MCP and the other way round; world reset restores both. "Now", relative
times and time ranges come from world virtual time (`org.context`), never the browser clock.

| screen | route | operations |
|---|---|---|
| Monitors › Monitors List: query search, Status / Muted / Type / Tag facets with counts, sortable table, paging | `#/monitors/manage` | `monitors.search` |
| Monitor status page: status, evaluation graph with thresholds, groups, event history, Mute/Unmute, Clone, Delete (force when referenced by a composite) | `#/monitors/<id>` | `monitors.get`, `metrics.query`, `events.list`, `monitors.update`, `monitors.delete` |
| New / Edit metric monitor: metric, scope, grouping, conditions, notification message, tags, priority, live preview; validate then save | `#/monitors/create`, `#/monitors/<id>/edit` | `metrics.list_active`, `metrics.query`, `monitors.validate`, `monitors.create`, `monitors.update` |
| Metrics Explorer and Metrics Summary (metadata panel) | `#/metric/explorer`, `#/metric/summary` | `metrics.list_active`, `metrics.query`, `metrics.get_metadata` |
| Event Management Explorer: time range, tag filter, source and priority facets, event side panel | `#/event/explorer` | `events.list`, `events.get` |
| Dashboard List (search, deleted tab, New Dashboard) and dashboard view (template variables, note / query value / timeseries / top list widgets, edit widgets, save, delete) | `#/dashboard/lists`, `#/dashboard/<id>` | `dashboards.list`, `dashboards.get`, `dashboards.create`, `dashboards.update`, `dashboards.delete`, `metrics.query` |
| Incidents list (Active / Stable / Resolved with counts, search, sort, Declare Incident) and incident page (state, severity, commander, customer impact, Resolve) | `#/incidents`, `#/incidents/<id>` | `incidents.search`, `incidents.create`, `incidents.get`, `incidents.update` |

Mutations carry idempotency keys, destructive actions ask for confirmation, and loading, empty, error and denied
(Read Only role) states are rendered. The left navigation keeps the rest of Datadog's chrome visible: Go to… search,
Recent, Bits AI, Watchdog, Service Mgmt (On-Call, Case Management, Status Pages, Workflow Automation),
Infrastructure, APM, Digital Experience, Software Delivery, Security, Logs, Metrics Volume and Distribution Metrics,
Notebooks, Sheets, Shared Dashboards, Downtimes, SLOs, Monitor Quality and Settings, Integrations, Help,
Organization Settings, Share, Favorite, incident Timeline / Remediation / Notifications / Postmortem, Notify and
Slack channel buttons. These are **not simulated**: they open a short "not simulated by this Tool" panel and never
show invented data. Typeface: Noto Sans (SIL OFL 1.1, bundled). Logo and font sources are recorded in
`firedrill/tools/datadog/app/assets/ATTRIBUTION.md`.

## Install

```sh
firedrill tool add /absolute/path/to/firedrill-tools-tool-datadog-0.1.0.tgz --install
firedrill serve
```

A new world receives the starter data below and grants for every operation. An existing world gets no silent data or
permission changes: add the grants that `firedrill tool add` prints (package `datadog`, operations listed under
[Operations](#operations)) and the starter rows you need.

Run the packaged conformance suite in the consuming project:

```sh
firedrill tool test datadog
```

### Connecting a client

Point the Datadog client or your HTTP code at `FIREDRILL_HTTP_URL` and send `FIREDRILL_HTTP_TOKEN` as the
`DD-API-KEY` header. `DD-APPLICATION-KEY` is accepted and not checked. The connection recipe `datadog-api-client`
maps `DATADOG_FIREDRILL_URL`, `DD_API_KEY` and `DD_APPLICATION_KEY` to those values. Canonical operations are
reachable at `POST {FIREDRILL_HTTP_URL}/v1/operations/datadog/<operation>` with `Authorization: Bearer <token>` and
`{"arguments": {...}}`, and through Firedrill's MCP endpoint.

## Identities and permissions

Datadog authorizes by API key (organization) and application key (user). This Tool models the calling **user** with
one actor attribute:

| actor attribute | behaviour |
|---|---|
| `datadogUserHandle` (optional) | Handle of a seeded user. **Absent** (for example an actor created by `firedrill tool add`): the organization's default user `priya.raman@example.com` (Datadog Admin Role). **Present but unknown or disabled**: every operation fails `FORBIDDEN` (403 `{"errors":["Forbidden"]}`). |

Rules applied by every operation, in order:

1. Identity resolution as above.
2. Role: the `Datadog Read Only Role` may call only reads (`*.list`, `*.get`, `*.search`, `metrics.query`,
   `metrics.list_active`, `metrics.get_metadata`, `monitors.validate`, `org.context`). Writes fail `FORBIDDEN`
   ("Forbidden: user does not have the required permission").
3. Resource restriction: a monitor or dashboard with non-empty `restricted_roles` can be updated or deleted only by an
   Admin or a user whose role is listed. A dashboard with `is_read_only: true` can be changed only by its author or an
   Admin. Setting `restricted_roles` that exclude your own role fails `BAD_REQUEST` (Admins excepted).
4. Validation and business rules.

Reads are not restricted: every user sees every monitor, event, metric, dashboard and incident. Framework grants still
decide whether an actor may call an operation at all; a framework denial answers 403 with this Tool's error envelope.

## Starting data

`starter.json` (and `firedrill/baseline.scenario.json`) holds 89 rows for the fictional organization **Northwind
Commerce** at virtual time `2026-09-15T14:00:00Z` (`virtualTimeUs 1789480800000000`). The data was produced by running
this package's own operations over two simulated hours, so stored states, events and points agree with each other.

- **Users (4):** `priya.raman@example.com` (Admin, default), `marco.silva@example.com` (Standard),
  `lin.okafor@example.com` (Read Only), `former.sre@example.com` (Standard, disabled).
- **Metrics (9 series, 26 hourly point buckets, 5 metadata rows), one point per minute 12:00–14:00:**
  `checkout.request.latency` (ms) on `web-01`/`web-02`/`web-03` (web-02 climbs above 800 ms after 13:40; web-03 carries
  the Unicode tag `region:são-paulo`), `system.cpu.user` (two prod hosts, one staging host), `system.disk.in_use`
  (`db-01`), `payments.errors` (count, burst 13:52–13:58), `queue.depth` (stops reporting at 13:05).
- **Monitors (9):** 148500001 latency by host (web-02 `Alert`), 148500002 CPU on prod (`Warn`), 148500003 DB disk
  (`OK`, restricted to Admin), 148500004 payment errors (`Alert`, muted with `silenced {"*": null}`), 148500005
  composite `148500001 && 148500004` (`Alert`), 148500006 queue `notify_no_data` (`No Data`), 148500007 service check
  (`OK`, stored only), 148500008 log alert (`Unknown`, stored only), 148500009 staging CPU (`OK`, created by Marco).
- **Events (13):** six monitor transition events, deploy events sharing `aggregation_key deploy-checkout`, a
  low-priority flag change, a `success` event with `related_event_id`, a 4,000-character capacity report and one event
  from 2026-08-10 (outside a 32-day window).
- **Dashboards (4):** `nwc-chk-001` Checkout Service Overview (ordered: note, query value, timeseries by host,
  toplist; template variable `env`), `nwc-inf-002` Infrastructure (free layout), `nwc-pay-003` Payments (Admin-only,
  read-only), `nwc-old-004` soft-deleted on 2026-09-10.
- **Incidents (4):** #41 active SEV-2 customer-impacted (commander Marco), #40 stable SEV-3, #39 resolved SEV-1
  (`time_to_resolve` 5,400 s), #38 resolved SEV-5 test incident.

## Operations

25 operations; 22 have a Datadog-shaped HTTP route. Writes accept an optional idempotency key (`Idempotency-Key` header
on routes); Datadog itself has no idempotency, so a repeated POST without a key creates a second object.

| operation | MCP alias | HTTP route | notes |
|---|---|---|---|
| `monitors.list` | — | `GET /api/v1/monitor` | `group_states`, `name`, `tags` (query scope tags), `monitor_tags`, `with_downtimes`, `id_offset`, `page`, `page_size`; bare JSON array |
| `monitors.search` | `search_datadog_monitors` | canonical only | query subset: free text, `status:`, `type:`, `tag:"k:v"`, `id:`, `creator:`, `muted:`, `priority:`, `( … OR … )`; facets, `sort`, `page`, `per_page` |
| `monitors.get` | — | `GET /api/v1/monitor/{monitor_id}` | `state.groups` with `group_states` |
| `monitors.create` | — | `POST /api/v1/monitor` (200) | evaluated immediately; read-only fields answer 400 |
| `monitors.update` | — | `PUT /api/v1/monitor/{monitor_id}` | partial; `type` cannot change; re-evaluated |
| `monitors.delete` | — | `DELETE /api/v1/monitor/{monitor_id}` | 400 while a composite references it, unless `force=true` |
| `monitors.validate` | `validate_datadog_monitor` | `POST /api/v1/monitor/validate` | `{}` when valid |
| `events.create` | — | `POST /api/v1/events` (202) | `date_happened` within the last 18 h and at most 10 min ahead |
| `events.list` | `search_datadog_events` | `GET /api/v1/events` | `start`/`end` required (≤ 32 days), `priority`, `sources`, `tags`, aggregation by `aggregation_key`, `unaggregated`, `exclude_aggregate`, `page` (1,000 per page) |
| `events.get` | — | `GET /api/v1/events/{event_id}` | |
| `metrics.submit` | — | `POST /api/v2/series` (202) | ≤ 1,000 series and 50,000 points (413 beyond); points outside [now − 1 h, now + 10 min] dropped |
| `metrics.query` | `get_datadog_metric` | `GET /api/v1/query` | grammar subset below; `from < to`, span ≤ 15 days |
| `metrics.list_active` | `search_datadog_metrics` | `GET /api/v1/metrics` | `from` required, `host`, `tag_filter` |
| `metrics.get_metadata` | `get_datadog_metric_context` | `GET /api/v1/metrics/{metric_name}` | |
| `dashboards.list` | `search_datadog_dashboards` | `GET /api/v1/dashboard` | `count`, `start`, `filter[deleted]`, `filter[shared]` (no shared dashboards exist); `query` title filter canonical only |
| `dashboards.get` | `get_datadog_dashboard` | `GET /api/v1/dashboard/{dashboard_id}` | deleted dashboards answer 404 |
| `dashboards.create` | — | `POST /api/v1/dashboard` | widgets `note`, `timeseries`, `query_value`, `toplist` |
| `dashboards.update` | — | `PUT /api/v1/dashboard/{dashboard_id}` | full replace |
| `dashboards.delete` | — | `DELETE /api/v1/dashboard/{dashboard_id}` | soft delete |
| `incidents.create` | — | `POST /api/v2/incidents` (201) | JSON:API; `customer_impacted` required; `fields.state`/`fields.severity`; commander by user UUID |
| `incidents.list` | — | `GET /api/v2/incidents` | `page[size]` (≤ 100), `page[offset]`, `include=users` |
| `incidents.search` | `search_datadog_incidents` | canonical only | `state:`, `severity:`, `customer_impacted:`, `commander.handle:`, free text, `( … OR … )`; facets |
| `incidents.get` | `get_datadog_incident` | `GET /api/v2/incidents/{incident_id}` | UUID or public id |
| `incidents.update` | — | `PATCH /api/v2/incidents/{incident_id}` | `data.id` must match; resolving sets `resolved` and a missing `customer_impact_end` |
| `org.context` | — | canonical only | virtual clock, organization, calling user and write permissions |

Errors use `{"errors": ["<message>"]}` with these statuses: `BAD_REQUEST` 400, `FORBIDDEN` 403, `NOT_FOUND` 404,
`LIMIT_EXCEEDED` 400, `PAYLOAD_TOO_LARGE` 413, `RATE_LIMITED` 429 (fault only, with `x-ratelimit-*` headers),
`SERVICE_UNAVAILABLE` 503 (fault only).

### Metric query grammar (subset)

`query := expr ("," expr){0,3}`, `expr := avg|sum|min|max ":" metric "{" scope "}" [" by {" key,… "}"] ("." fn)*`.
Scope is `*` or comma-separated `key:value`, `key`, `!key:value`, with an optional trailing `*` wildcard in a value.
Functions: `rollup(avg|sum|min|max|count[, seconds])`, `as_count()`, `as_rate()`, `fill(null|zero|last)`.
Monitor queries: `avg|sum|min|max(last_N{m,h,d,w}):expr <comparator> <number>` with `> >= < <= == !=`; composites
combine monitor ids with `&&`, `||`, `!` and parentheses (at most 10 monitors). Anything else (arithmetic, formulas,
`anomalies()`, `top()`, template variables outside dashboards) answers 400 "Error parsing query".

### Monitor evaluation

Metric and query alerts are evaluated at virtual now minus `evaluation_delay` over their window: per group the points
are space-aggregated per timestamp and then time-aggregated; `critical` gives `Alert`, `warning` gives `Warn`
(recovery thresholds hold the state until crossed), otherwise `OK`; a group without points becomes `No Data` when
`notify_no_data` is true. Composites map children to true (`Alert`/`Warn`), false (`OK`) or `No Data`. Evaluation
runs on `monitors.create`, `monitors.update`, and `metrics.submit` for monitors on the submitted metrics, then
cascades to composites. Each group transition writes a Datadog event (`[Triggered on host:web-02] …`,
`[Warn …]`, `[Recovered …]`, `[No Data …]`, template sections `{{#is_alert}}` etc. resolved) and emits
`monitor.state_changed`; monitors muted with `options.silenced` still transition, and their events carry `muted:true`.

### Malformed query encoding

Serve decodes query strings leniently, so a broken escape such as `%E0%A4%A` reaches the Tool as U+FFFD. It fails with
Datadog's 400 `{"errors":[…]}` envelope instead of returning an empty or corrupted result. This covers the metric `query`
("Error parsing query"), the `monitors.search`, `incidents.search` and `dashboards.list` `query`, and the monitor
`name`, `tags`, `monitor_tags` and `group_states` filters. It also covers the event `tags` and `sources` and the active
metrics `host` and `tag_filter` ("Invalid parameter: … contains malformed encoding"). A correctly encoded U+FFFD
(`%EF%BF%BD`) is rejected the same way. `%ZZ` stays literal, and non-ASCII values such as `café` work normally.

## Events and faults

| id | kind | payload / effect |
|---|---|---|
| `monitor.state_changed` | event | `monitor_id`, `monitor_name`, `group` (`*` or `host:web-02`), `previous_status`, `status`, `value`, `threshold`, `event_id`, `muted`, `evaluated_at` |
| `incident.declared` | event | `incident_id`, `public_id`, `title`, `severity`, `state`, `customer_impacted`, `commander_handle`, `created` |
| `incident.state_changed` | event | `incident_id`, `public_id`, `previous_state`, `state`, `severity`, `modified` |
| `metrics-intake-rate-limited` | fault (before) | `metrics.submit` answers 429 "Rate limit of 1000 requests per 60 seconds reached. Please try again later." with `x-ratelimit-limit: 1000`, `x-ratelimit-period: 60`, `x-ratelimit-remaining: 0`, `x-ratelimit-reset: 60`, `x-ratelimit-name: metrics_submit`; nothing is written |
| `incidents-create-unavailable` | fault (after commit) | `incidents.create` commits the incident and emits `incident.declared`, then answers 503 "Service Unavailable". A blind retry declares a duplicate, so an agent should search before retrying |

The conformance project ships the scenarios `intake-rate-limited`, `incidents-outage` and `tight-limits`
(lowered `meta/limits`) next to `baseline`.

## Bounds

`meta/limits` holds `maxScanRows` (5,000), `maxGroupsPerMonitor` (100), `maxSeriesPerQuery` (100) and
`maxDashboardBytes` (800,000). Anything that would exceed a bound fails `LIMIT_EXCEEDED` (400) instead of returning
partial results: scans of a namespace, groups of one monitor or query, 1,000 series per metric, 200 monitors per
metric, 500,000 scanned points per request, dashboards over the byte bound and list or query responses over 900 KB
of UTF-8 (narrow the time range or page size). Row ids built from caller input are validated first, so oversized
or malformed ids answer 404.

## Compatibility

Paths, methods, field names, status codes and the error envelope follow the public Datadog API reference and OpenAPI
documents for the implemented subset. **Not verified against a real client:** no official Datadog client or the
hosted Datadog MCP server has been run against this Tool, and the manifest's `compatibility` list is empty. MCP
aliases reuse public Datadog MCP tool names, but their arguments are this Tool's Datadog-API-shaped inputs and
results are JSON. Error message wording for validation, restriction and parse failures approximates Datadog's. An
idempotent replay (same `Idempotency-Key`) returns the stored result with equivalent data, but the framework re-serializes
it, so JSON key order can differ from the original response.

## Limitations

- Synthetic observability only: metrics exist only when submitted; there are no hosts, agents, integrations, logs,
  traces, RUM, synthetics, SLOs, downtimes, notebooks, users/roles API, key management or webhooks (those routes do
  not exist and answer the framework's 404).
- Monitors are evaluated only on monitor create/update and when a dependent metric receives points. Virtual time
  passing alone changes nothing (no scheduled re-evaluation, renotification or no-data timeout). Only metric/query
  alerts in the grammar subset and composites are evaluated; service check, log and event monitors keep their stored
  state. No anomaly, forecast, outlier, `change`/`pct_change`, formulas or arithmetic. Deleted monitors are removed
  immediately. Muting only through `options.silenced`.
- `GET /api/v1/monitor/search` and `GET /api/v2/incidents/search` have no HTTP route: Firedrill rejects routes whose
  templates overlap `GET /api/v1/monitor/{monitor_id}` and `GET /api/v2/incidents/{incident_id}`, so those paths reach
  the get routes and answer 404. Use the canonical operations or MCP aliases.
- Metric intake is v2 JSON only (no gzip/deflate, v1 series, distributions or sketches). Rollups are simplified and may
  differ from Datadog's interpolation, especially for counts and rates.
- Oversized pages or query results fail with `LIMIT_EXCEEDED` instead of returning a shorter page, because Datadog's
  page numbers cannot express a byte-shortened page.
- Dashboards: four widget types, no shared dashboards, restore, dashboard lists or notebooks; `is_read_only` is honoured
  as a legacy author lock. Incidents: only `state` and `severity` fields; no todos, timeline, attachments, impacts,
  integrations, notifications or delete.
- `DD-API-KEY` must carry the Firedrill world token; application keys are not validated. Framework denials, unknown
  routes and bodies the Tool refuses to map (JSON nested deeper than 512 levels, bodies Firedrill cannot parse) use
  Firedrill's own envelope or a generic 400 `Invalid request` message.
- Rate limits are not counted: 429 appears only under the `metrics-intake-rate-limited` fault, 503 only under the
  incidents outage fault.

## Trademarks

Datadog, the Datadog logo and related product names are trademarks of Datadog, Inc. The logo files bundled with the
app and the product names are used only to identify the simulated service in a test environment. This package is not
affiliated with, sponsored by or endorsed by Datadog, Inc.

## License

Apache-2.0. See `LICENSE`.
