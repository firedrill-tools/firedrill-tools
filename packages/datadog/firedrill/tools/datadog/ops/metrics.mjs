// Metrics: v2 series intake, v1 timeseries query (grammar subset), active metrics and metric metadata.
import { bad, caller, checkBudget, fail, intArg, limitExceeded, notFound, nowSec, present, requireInt, scanAll } from "../lib/core.mjs";
import { evaluateForMetrics } from "../lib/evaluate.mjs";
import { nextId } from "../lib/events-store.mjs";
import { parseMetricQuery, scopeMatches } from "../lib/mquery.mjs";
import { bucketRowId, evaluateExpression, MAX_SERIES_PER_METRIC, seriesOfMetric, seriesTags } from "../lib/series.mjs";
import { tagList, text } from "../lib/text.mjs";

const METRIC = /^[A-Za-z][A-Za-z0-9_.]{0,199}$/;
const INTAKE_TYPES = ["gauge", "count", "rate", "gauge"];
const UNITS = new Map([
  ["millisecond", ["time", "milliseconds", 0.001, "ms"]], ["second", ["time", "seconds", 1, "s"]], ["percent", ["percentage", "percent", 1, "%"]],
  ["byte", ["bytes", "bytes", 1, "B"]], ["request", ["network", "requests", 1, "req"]], ["error", ["general", "errors", 1, "err"]],
  ["item", ["general", "items", 1, "item"]], ["event", ["general", "events", 1, "event"]],
]);

const renderUnit = (name) => {
  const unit = name === null ? undefined : UNITS.get(name);
  return unit === undefined ? null : { family: unit[0], name, plural: unit[1], scale_factor: unit[2], short_name: unit[3] };
};

const tooLarge = (context) => fail(context, "PAYLOAD_TOO_LARGE", "Payload too large");

function validateSeries(context, raw) {
  if (!Array.isArray(raw) || raw.length === 0) bad(context, "Invalid parameter: series must be a non-empty array");
  if (raw.length > 1000) tooLarge(context);
  let total = 0;
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) bad(context, `Invalid parameter: series[${index}] must be an object`);
    for (const key of Object.keys(entry)) {
      if (!["metric", "type", "points", "tags", "resources", "unit", "interval", "source_type_name"].includes(key)) bad(context, `Invalid parameter: series[${index}].${key} is not supported`);
    }
    if (typeof entry.metric !== "string" || !METRIC.test(entry.metric)) bad(context, "Invalid metric name");
    const type = intArg(entry.type, 0, 3);
    if (type === undefined) bad(context, `Invalid parameter: series[${index}].type must be 0, 1, 2 or 3`);
    if (!Array.isArray(entry.points) || entry.points.length === 0 || entry.points.length > 1000) {
      bad(context, `Invalid parameter: series[${index}].points must contain 1 to 1000 points`);
    }
    total += entry.points.length;
    if (total > 50_000) tooLarge(context);
    const points = entry.points.map((point) => {
      const timestamp = typeof point === "object" && point !== null ? intArg(point.timestamp, 0, 99_999_999_999) : undefined;
      if (timestamp === undefined || timestamp === null || typeof point.value !== "number" || !Number.isFinite(point.value)) {
        bad(context, `Invalid parameter: series[${index}].points entries need an integer timestamp and a finite value`);
      }
      return [timestamp, point.value];
    });
    const tags = [...new Set(tagList(context, entry.tags, `series[${index}].tags`))].sort();
    if (present(entry.resources) && (!Array.isArray(entry.resources) || entry.resources.length > 10)) bad(context, `Invalid parameter: series[${index}].resources must be an array of at most 10`);
    let host = null;
    const resources = (entry.resources ?? []).map((resource) => {
      const name = typeof resource === "object" && resource !== null ? text(context, resource.name, "resources.name", { min: 1, max: 255, noFffd: true, required: true }) : bad(context, "Invalid parameter: resources entries must be objects");
      const kind = text(context, resource.type, "resources.type", { min: 1, max: 100, required: true });
      if (kind === "host") host = name;
      return { name, type: kind };
    });
    const unit = text(context, entry.unit, `series[${index}].unit`, { max: 50 });
    const interval = intArg(entry.interval, 1, 86400);
    if (interval === undefined) bad(context, `Invalid parameter: series[${index}].interval must be a positive integer`);
    text(context, entry.source_type_name, "source_type_name", { max: 100 });
    return { metric: entry.metric, type: type ?? 0, points, tags, host, resources, unit, interval };
  });
}

export function metricsSubmit(input, context) {
  caller(context, { write: true });
  const series = validateSeries(context, input.series);
  const now = nowSec(context);
  const known = new Map();
  const buckets = new Map();
  const touched = new Set();
  for (const entry of series) {
    const points = entry.points.filter(([ts]) => ts >= now - 3600 && ts <= now + 600);
    if (points.length === 0) continue;
    if (!known.has(entry.metric)) known.set(entry.metric, seriesOfMetric(context, entry.metric));
    const list = known.get(entry.metric);
    let row = list.find((candidate) => candidate.host === entry.host && candidate.tags.length === entry.tags.length && candidate.tags.every((tag, i) => tag === entry.tags[i]));
    if (row === undefined) {
      if (list.length >= MAX_SERIES_PER_METRIC) limitExceeded(context, `metric ${entry.metric} exceeds the supported bound of ${MAX_SERIES_PER_METRIC} series`);
      row = { seq: nextId(context, "series"), metric: entry.metric, tags: entry.tags, host: entry.host, resources: entry.resources, intakeType: entry.type, interval: entry.interval, firstSeenSec: points[0][0], lastSeenSec: points[0][0], pointCount: 0 };
      list.push(row);
    }
    for (const [ts, value] of points) {
      const id = bucketRowId(row.seq, Math.floor(ts / 3600) * 3600);
      if (!buckets.has(id)) {
        const stored = context.state.get("metric-points", id);
        buckets.set(id, { row, value: stored ?? { seq: row.seq, hourStartSec: Math.floor(ts / 3600) * 3600, points: [] }, map: new Map(stored?.points ?? []) });
      }
      const bucket = buckets.get(id);
      if (!bucket.map.has(ts)) row.pointCount += 1;
      bucket.map.set(ts, value);
      row.firstSeenSec = Math.min(row.firstSeenSec, ts);
      row.lastSeenSec = Math.max(row.lastSeenSec, ts);
    }
    if (context.state.get("metrics-meta", entry.metric) === null) {
      context.state.put("metrics-meta", entry.metric, { metric: entry.metric, type: INTAKE_TYPES[entry.type], description: null, shortName: null, unit: entry.unit, perUnit: null, statsdInterval: entry.interval, integration: null });
    }
    touched.add(row);
  }
  for (const [id, bucket] of buckets) {
    const points = [...bucket.map].sort((a, b) => a[0] - b[0]);
    context.state.put("metric-points", id, { seq: bucket.value.seq, hourStartSec: bucket.value.hourStartSec, points });
  }
  for (const row of touched) context.state.put("metric-series", `${row.metric}/${String(row.seq).padStart(8, "0")}`, row);
  evaluateForMetrics(context, [...new Set([...touched].map((row) => row.metric))]);
  return { errors: [] };
}

export function metricsQuery(input, context) {
  caller(context);
  const from = requireInt(context, input.from, "from", 0, 99_999_999_999);
  const to = requireInt(context, input.to, "to", 0, 99_999_999_999);
  if (from >= to) bad(context, "Invalid parameter: from must be earlier than to");
  if (to - from > 15 * 86400) bad(context, "Invalid parameter: the query time range cannot exceed 15 days");
  const query = text(context, input.query, "query", { required: true, min: 1, max: 4000 });
  const parsed = parseMetricQuery(query);
  if (!parsed.ok) bad(context, parsed.message);
  const budget = { points: 0 };
  const series = [];
  const groupBy = [];
  parsed.exprs.forEach((expr, index) => {
    const meta = context.state.get("metrics-meta", expr.metric);
    for (const key of expr.by) if (!groupBy.includes(key)) groupBy.push(key);
    for (const result of evaluateExpression(context, expr, from, to, meta?.type ?? "gauge", budget)) {
      const scopeParts = [...(expr.scopeText === "*" ? [] : expr.scopeText.split(",").map((part) => part.trim())), ...result.tagSet];
      const scope = scopeParts.length === 0 ? "*" : scopeParts.join(",");
      const points = result.pointlist;
      series.push({
        metric: expr.metric, display_name: expr.metric, expression: `${expr.aggr}:${expr.metric}{${scope}}`, scope, tag_set: result.tagSet,
        pointlist: points, start: points.length > 0 ? points[0][0] : from * 1000, end: points.length > 0 ? points[points.length - 1][0] : to * 1000,
        interval: result.interval, length: points.length, aggr: expr.aggr, unit: [renderUnit(meta?.unit ?? null), renderUnit(meta?.perUnit ?? null)], query_index: index,
      });
    }
  });
  return checkBudget(context, { status: "ok", res_type: "time_series", resp_version: 1, query, from_date: from * 1000, to_date: to * 1000, group_by: groupBy, series, message: "" });
}

export function metricsListActive(input, context) {
  caller(context);
  const from = requireInt(context, input.from, "from", 0, 99_999_999_999);
  const host = text(context, input.host, "host", { max: 255, noFffd: true });
  const filter = text(context, input.tag_filter, "tag_filter", { max: 1000, noFffd: true });
  let scope = [];
  if (filter !== null && filter.trim().length > 0) {
    const parsed = /[{}]/.test(filter) ? { ok: false } : parseMetricQuery(`avg:m{${filter}}`);
    if (!parsed.ok) bad(context, "Invalid parameter: tag_filter is not a valid tag filter");
    scope = parsed.exprs[0].scope;
  }
  const names = new Set();
  for (const { value: row } of scanAll(context, "metric-series")) {
    if (row.lastSeenSec >= from && (host === null || row.host === host) && scopeMatches(seriesTags(row), scope)) names.add(row.metric);
  }
  return checkBudget(context, { metrics: [...names].sort(), from: String(from) });
}

export function metricsGetMetadata(input, context) {
  caller(context);
  const name = input.metric_name;
  if (typeof name !== "string" || !METRIC.test(name)) bad(context, "Invalid metric name");
  const meta = context.state.get("metrics-meta", name);
  if (meta === null) notFound(context, "Metric not found");
  return { type: meta.type, description: meta.description, short_name: meta.shortName, unit: meta.unit, per_unit: meta.perUnit, statsd_interval: meta.statsdInterval, integration: meta.integration };
}
