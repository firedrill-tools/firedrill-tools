// Incidents v2 (minimal): create, list (offset paging), search (query subset with facets), get, update.
import { bad, caller, checkBudget, nowUs, present, requireInt, scanAll } from "../lib/core.mjs";
import { nextId } from "../lib/events-store.mjs";
import {
  includedUsers, loadIncident, newUuid, parseCommander, parseFields, parseHandles, parseImpacted, parseIso, publicRowId, renderIncident, STATES,
} from "../lib/incident-model.mjs";
import { oneOf, text } from "../lib/text.mjs";

const CREATE_ATTRIBUTES = ["title", "customer_impacted", "customer_impact_scope", "fields", "is_test", "notification_handles"];
const UPDATE_ATTRIBUTES = ["title", "customer_impacted", "customer_impact_scope", "customer_impact_start", "customer_impact_end", "fields"];

function document(context, input) {
  const data = input.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) bad(context, "Missing required parameter: data");
  if (data.type !== "incidents") bad(context, "Invalid parameter: data.type must be incidents");
  const attributes = data.attributes ?? {};
  if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) bad(context, "Invalid parameter: data.attributes must be an object");
  return { data, attributes };
}

function include(context, raw) {
  return oneOf(context, raw, "include", ["users"], null);
}

export function incidentsCreate(input, context) {
  const user = caller(context, { write: true });
  include(context, input.include);
  const { data, attributes } = document(context, input);
  for (const key of Object.keys(attributes)) if (!CREATE_ATTRIBUTES.includes(key)) bad(context, `Invalid parameter: attributes.${key} is not supported`);
  const title = text(context, attributes.title, "title", { required: true, min: 1, max: 500, trim: true });
  if (title.length === 0) bad(context, "Invalid parameter: title must not be empty");
  if (!present(attributes.customer_impacted)) bad(context, "Missing required parameter: customer_impacted");
  const impacted = parseImpacted(context, attributes.customer_impacted, false);
  const scope = text(context, attributes.customer_impact_scope, "customer_impact_scope", { max: 1000, trim: true });
  if (impacted && (scope === null || scope.length === 0)) bad(context, "Invalid parameter: customer_impact_scope is required when customer_impacted is true");
  const fields = parseFields(context, attributes.fields);
  if (present(attributes.is_test) && typeof attributes.is_test !== "boolean") bad(context, "Invalid parameter: is_test must be a boolean");
  const handles = parseHandles(context, attributes.notification_handles);
  for (const key of Object.keys(data)) if (!["type", "attributes", "relationships"].includes(key)) bad(context, `Invalid parameter: data.${key} is not supported`);
  const commander = parseCommander(context, data.relationships);
  let id = newUuid(context);
  for (let attempt = 0; context.state.get("incidents", id) !== null; attempt += 1) {
    if (attempt >= 5) bad(context, "could not allocate an incident id");
    id = newUuid(context);
  }
  const now = nowUs(context);
  const state = fields.state ?? "active";
  const row = {
    id, publicId: nextId(context, "incident"), title, customerImpacted: impacted, customerImpactScope: impacted ? scope : null,
    customerImpactStartUs: impacted ? now : null, customerImpactEndUs: impacted && state === "resolved" ? now : null, state,
    severity: fields.severity ?? "UNKNOWN", commanderHandle: commander?.handle ?? null, createdByHandle: user.handle, lastModifiedByHandle: user.handle,
    createdUs: now, modifiedUs: now, detectedUs: now, resolvedUs: state === "resolved" ? now : null, isTest: attributes.is_test === true, notificationHandles: handles,
  };
  context.state.put("incidents", id, row);
  context.state.put("incident-public-ids", publicRowId(row.publicId), { incidentId: id });
  context.events.emit("incident.declared", {
    incident_id: id, public_id: row.publicId, title, severity: row.severity, state, customer_impacted: impacted, commander_handle: row.commanderHandle,
    created: renderIncident(context, row).attributes.created,
  });
  return { data: renderIncident(context, row), included: includedUsers(context, [row]) };
}

function sortedIncidents(context, descending = true) {
  const rows = scanAll(context, "incidents").map((record) => record.value);
  rows.sort((a, b) => (descending ? b.createdUs - a.createdUs || b.publicId - a.publicId : a.createdUs - b.createdUs || a.publicId - b.publicId));
  return rows;
}

function pageArgs(context, input) {
  return { size: requireInt(context, input["page[size]"], "page[size]", 1, 100, 10), offset: requireInt(context, input["page[offset]"], "page[offset]", 0, 1_000_000, 0) };
}

export function incidentsList(input, context) {
  caller(context);
  const withUsers = include(context, input.include) === "users";
  const { size, offset } = pageArgs(context, input);
  const rows = sortedIncidents(context).slice(offset, offset + size);
  return checkBudget(context, {
    data: rows.map((row) => renderIncident(context, row)), included: withUsers ? includedUsers(context, rows) : [],
    meta: { pagination: { offset, next_offset: offset + rows.length, size } },
  });
}

export function incidentsGet(input, context) {
  caller(context);
  const withUsers = include(context, input.include) === "users";
  const row = loadIncident(context, input.incident_id);
  return { data: renderIncident(context, row), included: withUsers ? includedUsers(context, [row]) : [] };
}

function termMatcher(context, term) {
  const colon = term.indexOf(":");
  if (colon < 0) return (row) => row.title.toLowerCase().includes(term.toLowerCase());
  const key = term.slice(0, colon);
  const value = term.slice(colon + 1);
  if (key === "state") {
    if (!STATES.includes(value)) bad(context, `Invalid query: unsupported state ${value}`);
    return (row) => row.state === value;
  }
  if (key === "severity") return (row) => row.severity === value;
  if (key === "customer_impacted") {
    if (value !== "true" && value !== "false") bad(context, "Invalid query: customer_impacted must be true or false");
    return (row) => row.customerImpacted === (value === "true");
  }
  if (key === "commander.handle") return (row) => row.commanderHandle === value.toLowerCase();
  return bad(context, `Invalid query: unsupported search attribute ${key}`);
}

function groups(context, query) {
  const out = [];
  let i = 0;
  const word = () => { let w = ""; while (i < query.length && !" ()".includes(query[i])) { w += query[i]; i += 1; } return w; };
  while (i < query.length) {
    if (query[i] === " ") { i += 1; continue; }
    if (query[i] === ")") bad(context, `Invalid query: unexpected ) at position ${i}`);
    const any = [];
    if (query[i] === "(") {
      i += 1;
      for (;;) {
        while (query[i] === " ") i += 1;
        if (i >= query.length || query[i] === "(") bad(context, "Invalid query: unbalanced parentheses");
        if (query[i] === ")") { i += 1; break; }
        const w = word();
        if (w !== "OR") any.push(termMatcher(context, w));
      }
    } else any.push(termMatcher(context, word()));
    if (any.length === 0) bad(context, "Invalid query: empty group");
    out.push(any);
    if (out.length > 50) bad(context, "Invalid query: at most 50 terms are supported");
  }
  return out;
}

const facet = (rows, pick) => {
  const counts = new Map();
  for (const row of rows) { const name = pick(row); if (name !== null) counts.set(name, (counts.get(name) ?? 0) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name, count]) => ({ name, count }));
};

export function incidentsSearch(input, context) {
  caller(context);
  const query = text(context, input.query, "query", { required: true, min: 1, max: 1000, noFffd: true });
  const sort = oneOf(context, input.sort, "sort", ["created", "-created"], "-created");
  const { size, offset } = pageArgs(context, input);
  const matchers = groups(context, query);
  const rows = sortedIncidents(context, sort === "-created").filter((row) => matchers.every((any) => any.some((match) => match(row))));
  return checkBudget(context, {
    data: {
      type: "incidents_search_results",
      attributes: {
        facets: { state: facet(rows, (row) => row.state), severity: facet(rows, (row) => row.severity), commander: facet(rows, (row) => row.commanderHandle), customer_impacted: facet(rows, (row) => String(row.customerImpacted)) },
        incidents: rows.slice(offset, offset + size).map((row) => ({ data: renderIncident(context, row) })), total: rows.length,
      },
    },
    meta: { pagination: { offset, next_offset: offset + Math.max(0, Math.min(size, rows.length - offset)), size } },
  });
}

export function incidentsUpdate(input, context) {
  const user = caller(context, { write: true });
  const row = loadIncident(context, input.incident_id);
  include(context, input.include);
  const { data, attributes } = document(context, input);
  if (data.id !== row.id) bad(context, "Invalid parameter: data.id does not match the incident in the path");
  for (const key of Object.keys(attributes)) if (!UPDATE_ATTRIBUTES.includes(key)) bad(context, `Invalid parameter: attributes.${key} is not supported`);
  for (const key of Object.keys(data)) if (!["type", "id", "attributes", "relationships"].includes(key)) bad(context, `Invalid parameter: data.${key} is not supported`);
  const next = { ...row, lastModifiedByHandle: user.handle, modifiedUs: nowUs(context) };
  if (Object.hasOwn(attributes, "title")) {
    next.title = text(context, attributes.title, "title", { required: true, min: 1, max: 500, trim: true });
    if (next.title.length === 0) bad(context, "Invalid parameter: title must not be empty");
  }
  if (Object.hasOwn(attributes, "customer_impacted")) next.customerImpacted = parseImpacted(context, attributes.customer_impacted, row.customerImpacted);
  if (Object.hasOwn(attributes, "customer_impact_scope")) next.customerImpactScope = text(context, attributes.customer_impact_scope, "customer_impact_scope", { max: 1000, trim: true });
  if (Object.hasOwn(attributes, "customer_impact_start")) next.customerImpactStartUs = parseIso(context, attributes.customer_impact_start, "customer_impact_start");
  if (Object.hasOwn(attributes, "customer_impact_end")) next.customerImpactEndUs = parseIso(context, attributes.customer_impact_end, "customer_impact_end");
  const fields = parseFields(context, attributes.fields);
  if (fields.severity !== undefined) next.severity = fields.severity;
  if (fields.state !== undefined) next.state = fields.state;
  const commander = parseCommander(context, data.relationships);
  if (commander !== undefined) next.commanderHandle = commander?.handle ?? null;
  if (next.customerImpacted && (next.customerImpactScope === null || next.customerImpactScope.length === 0)) bad(context, "Invalid parameter: customer_impact_scope is required when customer_impacted is true");
  if (!next.customerImpacted) Object.assign(next, { customerImpactScope: null, customerImpactStartUs: null, customerImpactEndUs: null });
  else if (next.customerImpactStartUs === null) next.customerImpactStartUs = next.modifiedUs;
  if (next.state === "resolved" && row.state !== "resolved") {
    next.resolvedUs = next.modifiedUs;
    if (next.customerImpacted && next.customerImpactEndUs === null) next.customerImpactEndUs = next.modifiedUs;
  } else if (next.state !== "resolved") next.resolvedUs = null;
  if (next.customerImpactEndUs !== null && next.customerImpactStartUs !== null && next.customerImpactEndUs < next.customerImpactStartUs) {
    bad(context, "Invalid parameter: customer_impact_end must not be earlier than customer_impact_start");
  }
  context.state.put("incidents", row.id, next);
  if (next.state !== row.state) {
    context.events.emit("incident.state_changed", { incident_id: row.id, public_id: row.publicId, previous_state: row.state, state: next.state, severity: next.severity, modified: renderIncident(context, next).attributes.modified });
  }
  return { data: renderIncident(context, next), included: includedUsers(context, [next]) };
}
