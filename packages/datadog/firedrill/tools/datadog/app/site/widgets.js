// Dashboard widget renderers: note (safe Markdown subset built with DOM nodes), query value, timeseries, toplist.
import { call, el, fmtNumber, describeError } from "./ui.js";
import { timeseriesChart } from "./chart.js";

/** Replace $var template variables inside metric scopes: "$env" → "env:prod", or drop it when set to "*". */
export function applyTemplate(query, vars) {
  return String(query ?? "").replace(/\{([^}]*)\}/g, (whole, scope) => {
    if (!scope.includes("$")) return whole;
    const parts = scope.split(",").map((p) => p.trim()).map((p) => {
      if (!p.startsWith("$")) return p;
      const v = vars.get(p.slice(1));
      if (!v || v.value === "*") return null;
      return v.prefix ? `${v.prefix}:${v.value}` : v.value;
    }).filter(Boolean);
    return `{${parts.length ? parts.join(",") : "*"}}`;
  });
}

export function widgetQuery(def) {
  const r = def.requests?.[0];
  if (!r) return null;
  return r.q ?? r.queries?.[0]?.query ?? null;
}

function inline(text) {
  const nodes = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m; (m = re.exec(text)); last = re.lastIndex) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(m[1] !== undefined ? el("strong", { text: m[1] }) : el("code", { text: m[2] }));
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function noteBody(content) {
  const box = el("div.dd-note", {});
  for (const line of String(content ?? "").split("\n")) {
    if (!line.trim()) continue;
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) box.append(el(h[1].length <= 2 ? "h3" : "h4", {}, inline(h[2])));
    else if (/^[-*]\s+/.test(line)) box.append(el("p", {}, "• ", inline(line.replace(/^[-*]\s+/, ""))));
    else box.append(el("p", {}, inline(line)));
  }
  return box;
}

const lastValue = (points) => { for (let i = points.length - 1; i >= 0; i -= 1) if (points[i][1] !== null) return points[i][1]; return null; };
const aggregate = (points, how) => {
  const v = points.map((p) => p[1]).filter((x) => x !== null);
  if (!v.length) return null;
  if (how === "max") return Math.max(...v);
  if (how === "min") return Math.min(...v);
  if (how === "sum") return v.reduce((a, b) => a + b, 0);
  if (how === "last") return lastValue(points);
  return v.reduce((a, b) => a + b, 0) / v.length;
};

export async function fillWidget(body, def, vars, range) {
  if (def.type === "note") { body.replaceChildren(noteBody(def.content)); return; }
  const raw = widgetQuery(def);
  if (!raw) { body.replaceChildren(el("div.dd-nodata", { text: "No query" })); return; }
  body.replaceChildren(el("div.dd-nodata", { text: "Loading…" }));
  let q;
  try { q = await call("metrics.query", { from: range.from, to: range.to, query: applyTemplate(raw, vars) }); }
  catch (error) { body.replaceChildren(el("div.dd-nodata", { text: describeError(error) })); return; }
  const series = q.series ?? [];
  if (series.length === 0) { body.replaceChildren(el("div.dd-nodata", { text: "No data" })); return; }
  if (def.type === "query_value") {
    const value = aggregate(series[0].pointlist, def.requests[0].aggregator ?? "avg");
    body.replaceChildren(el("div.dd-qv", {}, fmtNumber(value, def.precision ?? 2), def.custom_unit ? el("small", { text: def.custom_unit }) : null));
    return;
  }
  if (def.type === "toplist") {
    const rows = series.map((s) => ({ name: s.scope, value: lastValue(s.pointlist) })).filter((r) => r.value !== null).sort((a, b) => b.value - a.value).slice(0, 10);
    const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
    body.replaceChildren(el("ol.dd-toplist", {}, rows.map((r) => el("li", {}, el("span.dd-truncate", { text: r.name, title: r.name }), el("span.dd-toplist__bar", { style: `width:${Math.max(2, (Math.abs(r.value) / max) * 100)}%` }), el("b", { text: fmtNumber(r.value) })))));
    return;
  }
  const lines = series.map((s) => ({ name: s.scope, points: s.pointlist }));
  body.replaceChildren(timeseriesChart(lines, { from: range.from, to: range.to, height: 170, kind: def.requests[0].display_type === "bars" ? "bars" : "line" }),
    def.show_legend ? el("div.dd-legend", {}, lines.slice(0, 8).map((s, i) => el("span", {}, el("span.dd-swatch", { dataset: { c: String(i % 8) } }), s.name))) : null);
}

/** Drop null fields recursively so a fetched definition can be sent back through dashboards.update. */
export function stripNulls(value) {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== null && v !== undefined) out[k] = stripNulls(v);
    return out;
  }
  return value;
}
