// Synthetic Datadog organization for Firedrill. Every operation computes from `context.state`: monitors are evaluated
// against submitted synthetic metric points at virtual time, ids come from counters or seeded randomness, and nothing
// here contacts a real Datadog service, host agent or notification channel.
import { decodeInput, encodeOutcome, header } from "./lib/wire.mjs";
import { dashboardsCreate, dashboardsDelete, dashboardsGet, dashboardsList, dashboardsUpdate } from "./ops/dashboards.mjs";
import { eventsCreate, eventsGet, eventsList } from "./ops/events.mjs";
import { incidentsCreate, incidentsGet, incidentsList, incidentsSearch, incidentsUpdate } from "./ops/incidents.mjs";
import { metricsGetMetadata, metricsListActive, metricsQuery, metricsSubmit } from "./ops/metrics.mjs";
import { monitorsSearch } from "./ops/monitor-search.mjs";
import { monitorsCreate, monitorsDelete, monitorsGet, monitorsList, monitorsUpdate, monitorsValidate } from "./ops/monitors.mjs";
import { orgContext } from "./ops/org.mjs";

const operations = {
  "monitors.list": monitorsList,
  "monitors.search": monitorsSearch,
  "monitors.get": monitorsGet,
  "monitors.create": monitorsCreate,
  "monitors.update": monitorsUpdate,
  "monitors.delete": monitorsDelete,
  "monitors.validate": monitorsValidate,
  "events.create": eventsCreate,
  "events.list": eventsList,
  "events.get": eventsGet,
  "metrics.submit": metricsSubmit,
  "metrics.query": metricsQuery,
  "metrics.list_active": metricsListActive,
  "metrics.get_metadata": metricsGetMetadata,
  "dashboards.list": dashboardsList,
  "dashboards.get": dashboardsGet,
  "dashboards.create": dashboardsCreate,
  "dashboards.update": dashboardsUpdate,
  "dashboards.delete": dashboardsDelete,
  "incidents.create": incidentsCreate,
  "incidents.list": incidentsList,
  "incidents.search": incidentsSearch,
  "incidents.get": incidentsGet,
  "incidents.update": incidentsUpdate,
  "org.context": orgContext,
};

const route = (options) => ({ decode: (request) => decodeInput(request, options), encode: encodeOutcome });

function seriesDecode(request) {
  const encoding = header(request, "content-encoding");
  if (typeof encoding === "string" && encoding.trim().length > 0 && encoding.trim().toLowerCase() !== "identity") {
    return { arguments: { refused_request: "Content-Encoding not supported by this Tool" } };
  }
  return decodeInput(request, { body: true });
}

const http = {
  "list-monitors": route({ queryNames: ["group_states", "name", "tags", "monitor_tags", "with_downtimes", "id_offset", "page", "page_size"] }),
  "create-monitor": route({ body: true }),
  "validate-monitor": route({ body: true }),
  "get-monitor": route({ path: ["monitor_id"], queryNames: ["group_states", "with_downtimes"] }),
  "update-monitor": route({ path: ["monitor_id"], body: true }),
  "delete-monitor": route({ path: ["monitor_id"], queryNames: ["force"] }),
  "create-event": route({ body: true }),
  "list-events": route({ queryNames: ["start", "end", "priority", "sources", "tags", "unaggregated", "exclude_aggregate", "page"] }),
  "get-event": route({ path: ["event_id"] }),
  "submit-series": { decode: seriesDecode, encode: encodeOutcome },
  "query-metrics": route({ queryNames: ["from", "to", "query"] }),
  "list-active-metrics": route({ queryNames: ["from", "host", "tag_filter"] }),
  "get-metric-metadata": route({ path: ["metric_name"] }),
  "list-dashboards": route({ queryNames: ["filter[shared]", "filter[deleted]", "count", "start"] }),
  "create-dashboard": route({ body: true }),
  "get-dashboard": route({ path: ["dashboard_id"] }),
  "update-dashboard": route({ path: ["dashboard_id"], body: true }),
  "delete-dashboard": route({ path: ["dashboard_id"] }),
  "create-incident": route({ body: true, queryNames: ["include"] }),
  "list-incidents": route({ queryNames: ["page[size]", "page[offset]", "include"] }),
  "get-incident": route({ path: ["incident_id"], queryNames: ["include"] }),
  "update-incident": route({ path: ["incident_id"], body: true, queryNames: ["include"] }),
};

export default { operations, http };
