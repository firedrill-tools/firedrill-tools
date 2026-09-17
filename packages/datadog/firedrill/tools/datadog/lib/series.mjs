// Metric series storage (one row per metric + tag set + host, one bucket row per series per UTC hour) and the
// deterministic evaluation of parsed query expressions over those points.
import { limitExceeded, limits, pad, scanAll } from "./core.mjs";
import { scopeMatches } from "./mquery.mjs";

export const POINT_BUDGET = 500_000;
export const MAX_SERIES_PER_METRIC = 1000;

export const bucketRowId = (seq, hourStartSec) => `${pad(seq, 8)}/${pad(hourStartSec, 10)}`;

export function seriesTags(row) {
  return row.host === null ? row.tags : [...row.tags, `host:${row.host}`];
}

export function seriesOfMetric(context, metric) {
  return scanAll(context, "metric-series", { prefix: `${metric}/`, max: MAX_SERIES_PER_METRIC }).map((record) => ({ ...record.value }));
}

export function aggregate(values, method) {
  const result = aggregateRaw(values, method);
  return result === null || Number.isFinite(result) ? result : null;
}

function aggregateRaw(values, method) {
  if (values.length === 0) return null;
  if (method === "count") return values.length;
  if (method === "sum") return values.reduce((sum, value) => sum + value, 0);
  if (method === "min") return values.reduce((low, value) => (value < low ? value : low), values[0]);
  if (method === "max") return values.reduce((high, value) => (value > high ? value : high), values[0]);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Raw `[tsSec, value]` points of one series within [fromSec, toSec]; `budget.points` counts every point read. */
export function loadPoints(context, seq, fromSec, toSec, budget) {
  const out = [];
  for (let hour = Math.floor(fromSec / 3600) * 3600; hour <= toSec; hour += 3600) {
    const bucket = context.state.get("metric-points", bucketRowId(seq, hour));
    if (bucket === null) continue;
    budget.points += bucket.points.length;
    if (budget.points > POINT_BUDGET) limitExceeded(context, `query exceeds the supported budget of ${POINT_BUDGET} scanned points`);
    for (const point of bucket.points) if (point[0] >= fromSec && point[0] <= toSec) out.push(point);
  }
  return out;
}

function groupOf(tags, by) {
  const tagSet = by.map((key) => {
    const found = tags.find((tag) => tag.startsWith(`${key}:`));
    return found === undefined ? `${key}:N/A` : found;
  });
  return { name: by.length === 0 ? "*" : tagSet.join(","), tagSet };
}

/** Matching series grouped by the `by` keys: `Map<groupName, { tagSet, series[] }>`, bounded by maxSeriesPerQuery. */
export function selectGroups(context, expr) {
  const bound = limits(context).maxSeriesPerQuery;
  const groups = new Map();
  for (const row of seriesOfMetric(context, expr.metric)) {
    const tags = seriesTags(row);
    if (!scopeMatches(tags, expr.scope)) continue;
    const { name, tagSet } = groupOf(tags, expr.by);
    if (!groups.has(name)) {
      if (groups.size >= bound) limitExceeded(context, `query matches more than the supported bound of ${bound} groups`);
      groups.set(name, { tagSet, series: [] });
    }
    groups.get(name).series.push(row);
  }
  return groups;
}

export function defaultInterval(spanSec) {
  const base = spanSec <= 3600 ? 20 : spanSec <= 14400 ? 60 : spanSec <= 86400 ? 300 : spanSec <= 172800 ? 600 : spanSec <= 604800 ? 3600 : 14400;
  let interval = base;
  while (spanSec / interval > 1500) interval *= 2;
  return interval;
}

/** Evaluate one expression for `metrics.query`: per group, rolled-up and space-aggregated points. */
export function evaluateExpression(context, expr, fromSec, toSec, metaType, budget) {
  const span = toSec - fromSec;
  let interval = expr.fns.rollup?.seconds ?? defaultInterval(span);
  while (span / interval > 1500) interval *= 2;
  const counting = expr.fns.asCount || metaType === "count";
  const timeMethod = expr.fns.rollup?.method ?? (counting ? "sum" : "avg");
  const results = [];
  for (const [name, group] of selectGroups(context, expr)) {
    const perBucket = new Map();
    for (const row of group.series) {
      const buckets = new Map();
      for (const [ts, value] of loadPoints(context, row.seq, fromSec, toSec, budget)) {
        const start = Math.floor(ts / interval) * interval;
        if (!buckets.has(start)) buckets.set(start, []);
        buckets.get(start).push(value);
      }
      for (const [start, values] of buckets) {
        let rolled = aggregate(values, timeMethod);
        if (expr.fns.asRate && rolled !== null) rolled /= interval;
        if (!perBucket.has(start)) perBucket.set(start, []);
        perBucket.get(start).push(rolled);
      }
    }
    const starts = [...perBucket.keys()].sort((a, b) => a - b);
    let pointlist = starts.map((start) => [start * 1000, aggregate(perBucket.get(start), expr.aggr)]);
    if (expr.fns.fill === "zero" || expr.fns.fill === "last") pointlist = fillPoints(pointlist, fromSec, toSec, interval, expr.fns.fill);
    results.push({ name, tagSet: group.tagSet, pointlist, interval, series: group.series.length });
  }
  results.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return results;
}

function fillPoints(pointlist, fromSec, toSec, interval, mode) {
  if (pointlist.length === 0) return pointlist;
  const byTs = new Map(pointlist);
  const out = [];
  let last = null;
  for (let start = Math.ceil(fromSec / interval) * interval; start <= toSec; start += interval) {
    const ms = start * 1000;
    if (byTs.has(ms)) { last = byTs.get(ms); out.push([ms, last]); } else if (mode === "zero") out.push([ms, 0]);
    else if (last !== null) out.push([ms, last]);
  }
  return out;
}

/** Monitor window value per group: space-aggregate per timestamp, then `timeAggr` over the window. */
export function windowValues(context, parsed, fromSec, toSec, budget) {
  const values = new Map();
  for (const [name, group] of selectGroups(context, parsed.expr)) {
    const perTs = new Map();
    let firstTs = null;
    for (const row of group.series) {
      for (const [ts, value] of loadPoints(context, row.seq, fromSec, toSec, budget)) {
        if (!perTs.has(ts)) perTs.set(ts, []);
        perTs.get(ts).push(value);
        if (firstTs === null || ts < firstTs) firstTs = ts;
      }
    }
    const combined = [...perTs.values()].map((list) => aggregate(list, parsed.expr.aggr));
    values.set(name, { tagSet: group.tagSet, value: aggregate(combined, parsed.timeAggr), firstTs });
  }
  return values;
}
