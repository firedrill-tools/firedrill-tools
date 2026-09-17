// Synthetic monitor evaluation: metric monitors against stored points at virtual now, composites over their children.
// Every group transition writes a Datadog event and emits `monitor.state_changed`. Bounded; fails instead of dropping groups.
import { isoMillis, limitExceeded, limits, nowSec, nowUs, pad, scanAll } from "./core.mjs";
import { renderTemplate, writeEvent } from "./events-store.mjs";
import { beyond, monitorRowId } from "./monitor-def.mjs";
import { evaluateComposite, parseComposite, parseMonitorQuery } from "./mquery.mjs";
import { windowValues } from "./series.mjs";

const SEVERITY = new Map([["Alert", 4], ["Warn", 3], ["No Data", 2], ["OK", 1]]);
export const MAX_MONITORS_PER_METRIC = 200;

function statusFor(parsed, thresholds, value, previous) {
  if (beyond(parsed.comparator, value, thresholds.critical)) return "Alert";
  if (previous === "Alert" && thresholds.criticalRecovery !== null && beyond(parsed.comparator, value, thresholds.criticalRecovery)) return "Alert";
  if (thresholds.warning !== null && beyond(parsed.comparator, value, thresholds.warning)) return "Warn";
  if (previous === "Warn" && thresholds.warningRecovery !== null && beyond(parsed.comparator, value, thresholds.warningRecovery)) return "Warn";
  return "OK";
}

function muted(row, groupName, now) {
  const tags = groupName === "*" ? [] : groupName.split(",");
  return row.options.silenced.some((entry) => (entry.untilSec === null || entry.untilSec > now) && (entry.scope === "*" || tags.includes(entry.scope)));
}

const TITLE = new Map([["Alert", "Triggered"], ["Warn", "Warn"], ["OK", "Recovered"], ["No Data", "No Data"]]);
const ALERT_TYPE = new Map([["Alert", "error"], ["Warn", "warning"], ["OK", "success"], ["No Data", "info"]]);

function transition(context, row, group, previous, status, value, tagSet) {
  const now = nowSec(context);
  const isMuted = muted(row, group.name, now);
  const vars = [["value", value === null ? "" : String(value)], ["threshold", String(row.options.thresholds.critical ?? "")],
    ["warn_threshold", String(row.options.thresholds.warning ?? "")]];
  for (const tag of tagSet) {
    const colon = tag.indexOf(":");
    if (colon > 0) vars.push([`${tag.slice(0, colon)}.name`, tag.slice(colon + 1)]);
  }
  const name = renderTemplate(row.name, status, vars);
  const label = TITLE.get(status);
  const title = `[${group.name === "*" ? label : `${label} on ${group.name}`}] ${name}`.slice(0, 100);
  const tags = [...row.tags, `monitor:${row.id}`, ...tagSet.filter((tag) => !tag.endsWith(":N/A"))];
  if (isMuted) tags.push("muted:true");
  const event = writeEvent(context, {
    title, text: renderTemplate(row.message, status, vars).slice(0, 4000), dateHappenedSec: now, alertType: ALERT_TYPE.get(status),
    aggregationKey: `monitor-${row.id}`, sourceTypeName: "Monitor Alert", tags: [...new Set(tags)].slice(0, 100), handle: row.creatorHandle, monitorId: row.id,
  });
  context.events.emit("monitor.state_changed", {
    monitor_id: row.id, monitor_name: row.name, group: group.name, previous_status: previous, status, value,
    threshold: row.options.thresholds.critical, event_id: event.id, muted: isMuted, evaluated_at: isoMillis(nowUs(context)),
  });
  if (status === "Alert" || status === "Warn") group.lastTriggeredSec = now;
  if (status === "No Data") group.lastNodataSec = now;
  if (status === "OK") group.lastResolvedSec = now;
}

/** Evaluate one monitor row; returns the updated row (not yet stored). Non-evaluated types are returned unchanged. */
export function evaluateMonitor(context, row, { pruneMissing = false } = {}) {
  const outcomes = new Map();
  if (row.type === "composite") {
    const parsed = parseComposite(row.query);
    if (!parsed.ok) return row;
    const states = new Map();
    for (const id of parsed.parsed.ids) states.set(id, context.state.get("monitors", monitorRowId(id))?.overallState);
    outcomes.set("*", { status: evaluateComposite(parsed.parsed.tree, states), value: null, tagSet: [] });
  } else if (row.type === "metric alert" || row.type === "query alert") {
    const result = parseMonitorQuery(row.query);
    if (!result.ok) return row;
    const parsed = result.parsed;
    const to = nowSec(context) - (row.options.evaluationDelay ?? 0);
    const from = to - parsed.windowSec;
    const values = windowValues(context, parsed, from, to, { points: 0 });
    const known = new Map(row.groups.map((group) => [group.name, group]));
    for (const [name, entry] of values) {
      const fullWindowMissing = row.options.requireFullWindow && entry.firstTs !== null && entry.firstTs >= from + 60;
      const previous = known.get(name)?.status ?? "OK";
      if (entry.value === null || fullWindowMissing) {
        outcomes.set(name, { status: row.options.notifyNoData ? "No Data" : previous, value: null, tagSet: entry.tagSet });
      } else {
        outcomes.set(name, { status: statusFor(parsed, row.options.thresholds, entry.value, previous), value: entry.value, tagSet: entry.tagSet });
      }
    }
    for (const group of row.groups) {
      if (!outcomes.has(group.name) && !pruneMissing) {
        outcomes.set(group.name, { status: row.options.notifyNoData ? "No Data" : group.status, value: null, tagSet: group.name === "*" ? [] : group.name.split(",") });
      }
    }
    for (const name of outcomes.keys()) {
      if (name.length > 512) limitExceeded(context, `monitor group names are limited to 512 characters`);
    }
    const bound = limits(context).maxGroupsPerMonitor;
    if (outcomes.size > bound) limitExceeded(context, `monitor ${row.id} would exceed the supported bound of ${bound} groups`);
  } else {
    return row;
  }
  const groups = [];
  for (const name of [...outcomes.keys()].sort()) {
    const outcome = outcomes.get(name);
    const existing = row.groups.find((group) => group.name === name);
    const group = existing === undefined
      ? { name, status: "OK", lastTriggeredSec: null, lastNodataSec: null, lastResolvedSec: null, lastValue: null }
      : { ...existing };
    const previous = existing === undefined ? (row.type === "composite" ? row.overallState : "OK") : existing.status;
    if (outcome.status !== previous && !(existing === undefined && outcome.status === "OK")) {
      transition(context, row, group, previous, outcome.status, outcome.value, outcome.tagSet);
    }
    group.status = outcome.status;
    if (outcome.value !== null) group.lastValue = outcome.value;
    groups.push(group);
  }
  let overall = "OK";
  for (const group of groups) if (SEVERITY.get(group.status) > SEVERITY.get(overall)) overall = group.status;
  if (groups.length === 0) overall = row.options.notifyNoData ? "No Data" : row.overallState;
  const changed = overall !== row.overallState;
  return { ...row, groups, overallState: overall, overallStateModifiedUs: changed ? nowUs(context) : row.overallStateModifiedUs };
}

/** Store the evaluated row and cascade to composites that reference it when its overall state changed. */
export function evaluateAndStore(context, row, seen = new Set(), options = {}) {
  const next = evaluateMonitor(context, row, options);
  context.state.put("monitors", monitorRowId(next.id), next);
  seen.add(next.id);
  if (next.overallState !== row.overallState && next.type !== "composite") {
    for (const record of scanAll(context, "composite-refs", { prefix: `${monitorRowId(next.id)}/` })) {
      if (seen.has(record.value.compositeId)) continue;
      const composite = context.state.get("monitors", monitorRowId(record.value.compositeId));
      if (composite !== null) evaluateAndStore(context, composite, seen);
    }
  }
  return next;
}

/** Re-evaluate every monitor indexed for the given metric names. */
export function evaluateForMetrics(context, metrics) {
  const seen = new Set();
  for (const metric of metrics) {
    const refs = scanAll(context, "monitor-metrics", { prefix: `${metric}/`, max: MAX_MONITORS_PER_METRIC });
    for (const record of refs) {
      if (seen.has(record.value.monitorId)) continue;
      const row = context.state.get("monitors", monitorRowId(record.value.monitorId));
      if (row !== null) evaluateAndStore(context, row, seen);
    }
  }
}

/** Keep `monitor-metrics` and `composite-refs` in step with a monitor's parsed definition. */
export function reindex(context, before, after) {
  const id12 = monitorRowId((after ?? before).id);
  if (before?.parsed?.metric) context.state.delete("monitor-metrics", `${before.parsed.metric}/${id12}`);
  for (const child of before?.parsed?.ids ?? []) context.state.delete("composite-refs", `${monitorRowId(child)}/${id12}`);
  if (after?.parsed?.metric) {
    const existing = scanAll(context, "monitor-metrics", { prefix: `${after.parsed.metric}/`, max: MAX_MONITORS_PER_METRIC });
    if (existing.length >= MAX_MONITORS_PER_METRIC) limitExceeded(context, `metric ${after.parsed.metric} already has the supported bound of ${MAX_MONITORS_PER_METRIC} monitors`);
    context.state.put("monitor-metrics", `${after.parsed.metric}/${id12}`, { metric: after.parsed.metric, monitorId: after.id });
  }
  for (const child of after?.parsed?.ids ?? []) {
    context.state.put("composite-refs", `${monitorRowId(child)}/${id12}`, { childId: child, compositeId: after.id });
  }
}

export const padId = (id) => pad(id, 12);
