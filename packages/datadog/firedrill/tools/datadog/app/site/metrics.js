// Metrics › Explorer (query rows, graph, legend) and Metrics › Summary (searchable metric list with metadata panel).
import { call, el, fmtNumber, describeError, world } from "./ui.js";
import { icon } from "./icons.js";
import { banner, closeModal, emptyBlock, errorBlock, openModal } from "./feedback.js";
import { currentRange, pageHeader, timePicker } from "./header.js";
import { timeseriesChart } from "./chart.js";

const explorer = { query: "", display: "line" };
const summary = { filter: "", page: 0 };
const PAGE = 50;

const tabs = (active) => el("nav.dd-tabs", { "aria-label": "Metrics" },
  el("a", { href: "#/metric/explorer", "aria-current": active === "explorer" ? "page" : null }, "Explorer"),
  el("a", { href: "#/metric/summary", "aria-current": active === "summary" ? "page" : null }, "Summary"),
  el("button", { type: "button", dataset: { notsim: "Metrics Volume" } }, "Volume"),
  el("button", { type: "button", dataset: { notsim: "Distribution Metrics" } }, "Distribution Metrics"));

export async function renderMetricExplorer(main, rerender) {
  const range = currentRange();
  const graph = el("div.dd-card__body", {});
  let metrics = [];
  try { metrics = (await call("metrics.list_active", { from: Math.max(0, world.nowSec - 86400 * 7) })).metrics ?? []; }
  catch (error) { main.append(pageHeader({ title: "Metrics Explorer" }), tabs("explorer"), errorBlock(error, rerender)); return; }
  if (!explorer.query && metrics.length) explorer.query = `avg:${metrics[0]}{*}`;
  const input = el("input.dd-input", { id: "metric-query", "aria-label": "Metric query", value: explorer.query, list: "metric-names", placeholder: "avg:system.cpu.user{env:prod} by {host}", spellcheck: "false" });
  const display = el("div.dd-btn-group", { role: "group", "aria-label": "Display" }, [["line", "Lines"], ["bars", "Bars"]].map(([k, label]) =>
    el("button.dd-btn.dd-btn--sm", { type: "button", "aria-pressed": String(explorer.display === k), on: { click: () => { explorer.display = k; rerender(); } } }, label)));
  const form = el("form.dd-qrow", { on: { submit: (e) => { e.preventDefault(); explorer.query = input.value.trim(); rerender(); } } },
    el("span.dd-qrow__letter", { text: "a", "aria-hidden": "true" }), input, el("button.dd-btn.dd-btn--primary", { type: "submit" }, "Graph"));
  main.append(
    pageHeader({ crumbs: [["Metrics", null]], title: "Metrics Explorer", actions: [timePicker(rerender)] }),
    tabs("explorer"),
    el("div.dd-body", {},
      el("section.dd-card", { "aria-label": "Query" }, el("div.dd-card__head", {}, "Graph", el("span.dd-card__head-spacer"), display), el("div.dd-card__body", {}, form,
        el("datalist", { id: "metric-names" }, metrics.map((m) => el("option", { value: `avg:${m}{*}` }))),
        el("p.dd-field__hint", { text: "Supported: aggregator:metric{scope} by {tag}, with avg, max, min or sum." }))),
      el("section.dd-card", { "aria-label": "Graph" }, graph)));
  if (!explorer.query) { graph.append(emptyBlock("No metrics yet", "Submit points with the series intake to see them here.")); return; }
  graph.append(el("div.dd-nodata", { text: "Loading…" }));
  try {
    const q = await call("metrics.query", { from: range.from, to: range.to, query: explorer.query });
    const series = (q.series ?? []).map((s) => ({ name: s.scope === "*" ? s.metric : `${s.metric} ${s.scope}`, points: s.pointlist }));
    if (series.length === 0) { graph.replaceChildren(el("div.dd-nodata", { text: "No data for this time frame" })); return; }
    const stat = (s) => { const v = s.points.map((p) => p[1]).filter((x) => x !== null); return v.length ? { avg: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v), min: Math.min(...v) } : null; };
    graph.replaceChildren(timeseriesChart(series, { from: range.from, to: range.to, kind: explorer.display, height: 260 }),
      el("div.dd-table-wrap", { style: "margin-top:10px" }, el("table.dd-table", {},
        el("thead", {}, el("tr", {}, ["Series", "Avg", "Min", "Max"].map((h) => el("th", { scope: "col", text: h })))),
        el("tbody", {}, series.map((s, i) => { const st = stat(s); return el("tr", {}, el("td", {}, el("span", { style: "display:inline-flex;gap:6px;align-items:center" }, el("span.dd-swatch", { dataset: { c: String(i % 8) } }), s.name)), el("td", { text: fmtNumber(st?.avg) }), el("td", { text: fmtNumber(st?.min) }), el("td", { text: fmtNumber(st?.max) })); })))));
  } catch (error) {
    graph.replaceChildren(banner("error", describeError(error)));
  }
}

export async function renderMetricSummary(main, rerender) {
  const input = el("input.dd-input", { type: "search", id: "metric-filter", "aria-label": "Search metric names", placeholder: "Search metric names", value: summary.filter });
  input.addEventListener("input", () => { summary.filter = input.value; summary.page = 0; draw(); });
  const results = el("section.dd-results", { "aria-live": "polite" }, el("p.dd-muted", { text: "Loading metrics…" }));
  main.append(pageHeader({ crumbs: [["Metrics", null]], title: "Metrics Summary" }), tabs("summary"), el("div.dd-toolbar", {}, el("div.dd-search", {}, icon("search"), input)), results);
  let names;
  try { names = (await call("metrics.list_active", { from: Math.max(0, world.nowSec - 86400 * 30) })).metrics ?? []; }
  catch (error) { results.replaceChildren(errorBlock(error, rerender)); return; }
  function draw() {
    const needle = summary.filter.trim().toLowerCase();
    const rows = names.filter((n) => n.toLowerCase().includes(needle));
    if (rows.length === 0) { results.replaceChildren(emptyBlock(needle ? "No metrics match your search" : "No active metrics", "Metrics appear after points are submitted in the past 30 days.")); return; }
    const pages = Math.ceil(rows.length / PAGE);
    summary.page = Math.min(summary.page, pages - 1);
    const slice = rows.slice(summary.page * PAGE, (summary.page + 1) * PAGE);
    results.replaceChildren(
      el("div.dd-results__summary", {}, el("span", { text: `${rows.length} metric${rows.length === 1 ? "" : "s"}` }), el("span.dd-muted", { text: "active in the past 30 days" })),
      el("div.dd-table-wrap", {}, el("table.dd-table", {}, el("thead", {}, el("tr", {}, el("th", { scope: "col", text: "Metric Name" }), el("th", { scope: "col", text: "" }))),
        el("tbody", {}, slice.map((n) => el("tr.dd-row", { tabindex: "0", on: { click: () => void showMeta(n), keydown: (e) => { if (e.key === "Enter") void showMeta(n); } } }, el("td.dd-mono", { text: n }), el("td", { style: "text-align:right" }, el("a", { href: "#/metric/explorer", on: { click: () => { explorer.query = `avg:${n}{*}`; } } }, "Open in Explorer"))))))),
      el("div.dd-pager", {}, el("span.dd-muted", { text: `Page ${summary.page + 1} of ${pages}` }),
        el("button.dd-btn.dd-btn--icon", { type: "button", "aria-label": "Previous page", disabled: summary.page === 0, on: { click: () => { summary.page -= 1; draw(); } } }, icon("chevronLeft")),
        el("button.dd-btn.dd-btn--icon", { type: "button", "aria-label": "Next page", disabled: summary.page + 1 >= pages, on: { click: () => { summary.page += 1; draw(); } } }, icon("chevronRight"))));
  }
  draw();
}

async function showMeta(name) {
  const body = el("div", {}, el("p.dd-muted", { text: "Loading…" }));
  openModal({ title: name, body, side: true, footer: [el("button.dd-btn", { type: "button", on: { click: closeModal } }, "Close")] });
  try {
    const m = await call("metrics.get_metadata", { metric_name: name });
    body.replaceChildren(el("dl.dd-kv", {}, [["Metric type", m.type], ["Unit", m.unit ? `${m.unit}${m.per_unit ? ` per ${m.per_unit}` : ""}` : null], ["Short name", m.short_name], ["Description", m.description], ["Interval", m.statsd_interval ? `${m.statsd_interval}s` : null], ["Integration", m.integration]].flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v ?? "—" })])));
  } catch (error) { body.replaceChildren(el("p", { text: describeError(error) })); }
}
