// Metric monitor query model for the editor: parse "avg(last_5m):avg:metric{scope} by {group} > 90" into form fields
// and build it back. Anything outside this shape is edited as a raw query.
export const WINDOWS = [["last_1m", "1 minute"], ["last_5m", "5 minutes"], ["last_10m", "10 minutes"], ["last_15m", "15 minutes"], ["last_30m", "30 minutes"], ["last_1h", "1 hour"], ["last_4h", "4 hours"], ["last_1d", "1 day"]];
export const TIME_AGGS = [["avg", "average"], ["max", "maximum"], ["min", "minimum"], ["sum", "sum"]];
export const SPACE_AGGS = ["avg", "max", "min", "sum"];
export const COMPARATORS = [[">", "above"], [">=", "above or equal to"], ["<", "below"], ["<=", "below or equal to"]];

const RE = /^\s*(avg|max|min|sum)\((last_\w+)\)\s*:\s*(avg|max|min|sum):([A-Za-z][\w.]*)\{([^}]*)\}(?:\s+by\s+\{([^}]*)\})?\s*(>=|<=|>|<)\s*(-?[\d.]+)\s*$/;

export function parseMetricQuery(query) {
  const m = RE.exec(String(query ?? ""));
  if (!m) return null;
  return { timeAgg: m[1], window: m[2], spaceAgg: m[3], metric: m[4], scope: m[5].trim() === "*" ? "" : m[5].trim(), groupBy: (m[6] ?? "").trim(), comparator: m[7], threshold: m[8] };
}

export function buildMetricQuery(f) {
  const scope = f.scope.trim() || "*";
  const by = f.groupBy.trim() ? ` by {${f.groupBy.trim()}}` : "";
  return `${f.timeAgg}(${f.window}):${f.spaceAgg}:${f.metric.trim()}{${scope}}${by} ${f.comparator} ${f.critical}`;
}

export const DEFAULT_FIELDS = { timeAgg: "avg", window: "last_5m", spaceAgg: "avg", metric: "", scope: "", groupBy: "", comparator: ">", critical: "", warning: "" };

export function numOrNull(value) {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : NaN;
}

/** Collect a monitor body from the editor state; returns { body, errors }. */
export function monitorBody(state) {
  const errors = [];
  const f = state.fields;
  let query = state.rawQuery;
  const critical = numOrNull(f.critical);
  const warning = numOrNull(f.warning);
  if (state.mode === "metric") {
    if (!f.metric.trim()) errors.push("Choose a metric.");
    if (critical === null || Number.isNaN(critical)) errors.push("Alert threshold must be a number.");
    if (Number.isNaN(warning)) errors.push("Warning threshold must be a number.");
    query = buildMetricQuery({ ...f, critical });
  } else if (!String(query ?? "").trim()) errors.push("Query is required.");
  if (!state.name.trim()) errors.push("Monitor name is required.");
  const tags = state.tags.split(",").map((t) => t.trim()).filter(Boolean);
  const thresholds = state.mode === "metric" ? { critical, ...(warning !== null && !Number.isNaN(warning) ? { warning } : {}) } : undefined;
  const body = {
    name: state.name.trim(), type: state.type, query, message: state.message, tags,
    priority: state.priority ? Number(state.priority) : null,
    options: { ...(thresholds ? { thresholds } : {}), notify_no_data: state.notifyNoData, ...(state.notifyNoData ? { no_data_timeframe: Number(state.noDataTimeframe) || 10 } : {}), renotify_interval: state.renotify ? Number(state.renotify) : null },
  };
  return { body, errors };
}
