// Datadog v1 event rows (caller events and monitor transition events), id counters and the Event JSON rendering.
import { pad } from "./core.mjs";

export const ALERT_TYPES = ["error", "warning", "info", "success", "user_update", "recommendation", "snapshot"];

const COUNTER_DEFAULTS = { monitor: 148500001, event: 7412300000000001, incident: 1, series: 1, widget: 1 };

/** Next id from `meta/counters` (rolled back with the operation when it fails). */
export function nextId(context, name) {
  const counters = { ...COUNTER_DEFAULTS, ...(context.state.get("meta", "counters") ?? {}) };
  const id = counters[name];
  counters[name] = id + 1;
  context.state.put("meta", "counters", counters);
  return id;
}

export const eventRowId = (id) => pad(id, 19);

export function writeEvent(context, fields) {
  const id = nextId(context, "event");
  const row = {
    id,
    title: fields.title,
    text: fields.text,
    dateHappenedSec: fields.dateHappenedSec,
    priority: fields.priority ?? "normal",
    alertType: fields.alertType ?? "info",
    host: fields.host ?? null,
    aggregationKey: fields.aggregationKey ?? null,
    sourceTypeName: fields.sourceTypeName ?? null,
    tags: fields.tags ?? [],
    relatedEventId: fields.relatedEventId ?? null,
    handle: fields.handle,
    monitorId: fields.monitorId ?? null,
  };
  context.state.put("events", eventRowId(id), row);
  return row;
}

export function renderEvent(row, children) {
  const event = {
    id: row.id,
    id_str: String(row.id),
    title: row.title,
    text: row.text,
    date_happened: row.dateHappenedSec,
    handle: row.handle,
    priority: row.priority,
    related_event_id: row.relatedEventId,
    tags: row.tags,
    url: `/event/event?id=${row.id}`,
    alert_type: row.alertType,
    host: row.host,
    device_name: null,
    source_type_name: row.sourceTypeName,
    is_aggregate: children !== undefined && children.length > 0,
  };
  if (children !== undefined) {
    event.children = children.map((child) => ({ id: child.id, date_happened: child.dateHappenedSec, alert_type: child.alertType }));
  }
  return event;
}

/** Monitor message template: `{{#is_alert}}…{{/is_alert}}` style sections and `{{value}}`-style variables. */
export function renderTemplate(message, status, vars) {
  const sections = [["is_alert", status === "Alert"], ["is_warning", status === "Warn"], ["is_recovery", status === "OK"],
    ["is_no_data", status === "No Data"], ["is_alert_or_warning", status === "Alert" || status === "Warn"]];
  let out = message;
  for (const [name, keep] of sections) {
    const open = `{{#${name}}}`;
    const close = `{{/${name}}}`;
    let result = "";
    let cursor = 0;
    for (;;) {
      const start = out.indexOf(open, cursor);
      const end = start < 0 ? -1 : out.indexOf(close, start + open.length);
      if (start < 0 || end < 0) break;
      result += out.slice(cursor, start) + (keep ? out.slice(start + open.length, end) : "");
      cursor = end + close.length;
    }
    out = result + out.slice(cursor);
  }
  for (const [name, value] of vars) out = out.split(`{{${name}}}`).join(value);
  return out;
}
