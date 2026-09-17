// New / Edit metric monitor: numbered steps like Datadog's editor, live preview graph, validate before save.
import { call, canWrite, el, world, describeError } from "./ui.js";
import { icon } from "./icons.js";
import { banner, errorBlock, toast } from "./feedback.js";
import { currentRange, pageHeader } from "./header.js";
import { timeseriesChart } from "./chart.js";
import { app } from "./app.js";
import { COMPARATORS, DEFAULT_FIELDS, SPACE_AGGS, TIME_AGGS, WINDOWS, buildMetricQuery, monitorBody, numOrNull, parseMetricQuery } from "./monitor-form.js";

export const renderMonitorCreate = (main, rerender, ctx) => renderEditor(main, rerender, { ...ctx, id: null, cloneId: ctx.params.get("clone") });
export const renderMonitorEdit = (main, rerender, ctx) => renderEditor(main, rerender, { ...ctx, id: ctx.args[0] });
const drafts = new Map();

async function renderEditor(main, rerender, { id, cloneId }) {
  const draftKey = id ?? `new:${cloneId ?? ""}`;
  let state = app.dirty ? drafts.get(draftKey) : null;
  let metrics = [];
  try {
    const [source, active] = await Promise.all([id || cloneId ? call("monitors.get", { monitor_id: id ?? cloneId }) : null, call("metrics.list_active", { from: Math.max(0, world.nowSec - 86400 * 7) })]);
    metrics = active.metrics ?? [];
    if (!state) state = initialState(source, Boolean(cloneId));
  } catch (error) {
    main.append(pageHeader({ crumbs: [["Monitors", "#/monitors/manage"]], title: id ? "Edit Monitor" : "New Monitor" }), errorBlock(error, rerender));
    return;
  }
  drafts.set(draftKey, state);
  const f = state.fields;
  const markDirty = () => { app.dirty = true; };
  const errorsBox = el("div", { role: "alert" });
  const preview = el("div.dd-card__body", {});
  const bind = (node, get, set, after) => { node.addEventListener("input", () => { set(node.type === "checkbox" ? node.checked : node.value); markDirty(); after?.(); }); if (node.type === "checkbox") node.checked = get(); else node.value = get(); return node; };
  const field = (label, control, hint) => el("div.dd-field", {}, el("label", { for: control.id, text: label }), control, hint ? el("span.dd-field__hint", { text: hint }) : null);
  const select = (idAttr, options, get, set, after) => bind(el("select.dd-select", { id: idAttr }, options.map(([v, l]) => el("option", { value: v, text: l ?? v }))), get, set, after);
  const input = (idAttr, get, set, attrs = {}, after) => bind(el("input.dd-input", { id: idAttr, ...attrs }), get, set, after);
  let previewTimer = null;
  const schedulePreview = () => { clearTimeout(previewTimer); previewTimer = setTimeout(() => void drawPreview(state, preview), 400); };

  const metricList = el("datalist", { id: "metric-options" }, metrics.map((name) => el("option", { value: name })));
  const stepMetric = state.mode === "metric" ? [
    el("div.dd-row-fields", {},
      field("Metric", input("mon-metric", () => f.metric, (v) => { f.metric = v; }, { list: "metric-options", placeholder: "e.g. system.cpu.user", style: "width:260px;font-family:var(--mono)" }, schedulePreview)),
      field("from", input("mon-scope", () => f.scope, (v) => { f.scope = v; }, { placeholder: "(everywhere)", style: "width:200px" }, schedulePreview)),
      field("avg by", input("mon-groupby", () => f.groupBy, (v) => { f.groupBy = v; }, { placeholder: "e.g. host", style: "width:140px" }, schedulePreview)),
      field("as", select("mon-spaceagg", SPACE_AGGS.map((a) => [a, a]), () => f.spaceAgg, (v) => { f.spaceAgg = v; }, schedulePreview))),
    metricList,
  ] : [field("Query", bind(el("textarea.dd-textarea.dd-mono", { id: "mon-query", rows: 3 }), () => state.rawQuery, (v) => { state.rawQuery = v; }), "This monitor type is edited as a raw query.")];
  const stepConditions = state.mode === "metric" ? el("div", {},
    el("div.dd-row-fields", {},
      field("Trigger when the evaluated value is", select("mon-cmp", COMPARATORS, () => f.comparator, (v) => { f.comparator = v; }, schedulePreview)),
      field("the threshold on", select("mon-timeagg", TIME_AGGS, () => f.timeAgg, (v) => { f.timeAgg = v; })),
      field("during the last", select("mon-window", WINDOWS, () => f.window, (v) => { f.window = v; }))),
    el("div.dd-row-fields", { style: "margin-top:12px" },
      field("Alert threshold", input("mon-critical", () => f.critical, (v) => { f.critical = v; }, { inputmode: "decimal", style: "width:140px" }, schedulePreview)),
      field("Warning threshold", input("mon-warning", () => f.warning, (v) => { f.warning = v; }, { inputmode: "decimal", style: "width:140px" }, schedulePreview)))) : el("p.dd-muted", { text: "Thresholds are part of the raw query for this monitor type." });

  const noData = el("label.dd-check", { for: "mon-nodata" }, bind(el("input", { type: "checkbox", id: "mon-nodata" }), () => state.notifyNoData, (v) => { state.notifyNoData = v; }), "Notify if data is missing for more than");
  const steps = [
    ["Define the metric", stepMetric],
    ["Set alert conditions", [stepConditions, el("div.dd-row-fields", { style: "margin-top:12px;align-items:center" }, noData, input("mon-nodata-min", () => state.noDataTimeframe, (v) => { state.noDataTimeframe = v; }, { "aria-label": "No data timeframe in minutes", inputmode: "numeric", style: "width:70px" }), el("span", { text: "minutes" }))]],
    ["Configure notifications & automations", [
      field("Monitor name", input("mon-name", () => state.name, (v) => { state.name = v; }, { placeholder: "Example: CPU high on {{host.name}}" })),
      field("Message", bind(el("textarea.dd-textarea", { id: "mon-message", rows: 6, placeholder: "{{#is_alert}}Describe the problem{{/is_alert}} @team-handle" }), () => state.message, (v) => { state.message = v; }), "Notification handles are stored as text; nothing is delivered."),
      el("div.dd-row-fields", {},
        field("Tags", input("mon-tags", () => state.tags, (v) => { state.tags = v; }, { placeholder: "team:checkout, env:prod", style: "width:320px" })),
        field("Priority", select("mon-priority", [["", "Not defined"], ["1", "P1 (Critical)"], ["2", "P2 (High)"], ["3", "P3 (Medium)"], ["4", "P4 (Low)"], ["5", "P5 (Info)"]], () => state.priority, (v) => { state.priority = v; })),
        field("Renotify every (minutes)", input("mon-renotify", () => state.renotify, (v) => { state.renotify = v; }, { inputmode: "numeric", placeholder: "Never", style: "width:120px" }))),
    ]],
  ];
  const saveBtn = el("button.dd-btn.dd-btn--primary", { type: "button", disabled: !canWrite("monitors") }, id ? "Save" : "Create");
  const title = id ? `Edit ${state.name || "Monitor"}` : "New Monitor";
  main.append(
    pageHeader({ crumbs: [["Monitors", "#/monitors/manage"], [id ? "Edit" : "New Monitor", null]], title, actions: [el("span.dd-tag", { text: state.mode === "metric" ? "Metric Monitor" : state.type })] }),
    ...(canWrite("monitors") ? [] : [banner("info", "Your role cannot create or edit monitors.")]),
    el("div.dd-body.dd-editor", {},
      el("section.dd-card", { "aria-label": "Preview" }, el("div.dd-card__head", {}, "Preview", el("span.dd-muted", { text: currentRange().label })), preview),
      errorsBox,
      el("div.dd-card", {}, el("div.dd-card__body", {}, steps.map(([h, content], i) => el("section.dd-step", {}, el("span.dd-step__num", { text: String(i + 1) }), el("div", { style: "min-width:0" }, el("h2", { text: h }), content)))))),
    el("div.dd-editor__footer", {}, el("a.dd-btn", { href: id ? `#/monitors/${id}` : "#/monitors/manage", on: { click: () => { app.dirty = false; drafts.delete(draftKey); } } }, "Cancel"), saveBtn));
  saveBtn.addEventListener("click", () => void save(state, id, saveBtn, errorsBox, draftKey));
  void drawPreview(state, preview);
}

function initialState(source, clone) {
  const parsed = source ? parseMetricQuery(source.query) : null;
  const metricType = !source || ((source.type === "metric alert" || source.type === "query alert") && parsed);
  const t = source?.options?.thresholds ?? {};
  return {
    key: crypto.randomUUID(), mode: metricType ? "metric" : "raw", type: source?.type ?? "metric alert", rawQuery: source?.query ?? "",
    fields: parsed ? { ...DEFAULT_FIELDS, ...parsed, critical: t.critical ?? parsed.threshold, warning: t.warning ?? "" } : { ...DEFAULT_FIELDS },
    name: source ? `${source.name}${clone ? " (clone)" : ""}` : "", message: source?.message ?? "", tags: (source?.tags ?? []).join(", "),
    priority: source?.priority ? String(source.priority) : "", notifyNoData: Boolean(source?.options?.notify_no_data), noDataTimeframe: String(source?.options?.no_data_timeframe ?? 10),
    renotify: source?.options?.renotify_interval ? String(source.options.renotify_interval) : "",
  };
}

async function drawPreview(state, host) {
  const f = state.fields;
  if (state.mode !== "metric" || !f.metric.trim()) { host.replaceChildren(el("div.dd-nodata", { text: state.mode === "metric" ? "Choose a metric to preview it" : "No preview for this monitor type" })); return; }
  const range = currentRange();
  const query = buildMetricQuery({ ...f, critical: 0 }).replace(/^\w+\(\w+\):/, "").replace(/\s*[<>]=?\s*0$/, "");
  try {
    const q = await call("metrics.query", { from: range.from, to: range.to, query });
    const series = (q.series ?? []).map((s) => ({ name: s.scope, points: s.pointlist }));
    const above = !f.comparator.startsWith("<");
    const th = [[numOrNull(f.critical), "#d33d3d"], [numOrNull(f.warning), "#e5a21a"]].filter(([v]) => v !== null && !Number.isNaN(v)).map(([value, color]) => ({ value, color, above }));
    host.replaceChildren(series.length ? timeseriesChart(series, { from: range.from, to: range.to, thresholds: th, height: 160 }) : el("div.dd-nodata", { text: "No data for this time frame" }));
  } catch (error) {
    host.replaceChildren(banner("error", describeError(error)));
  }
}

async function save(state, id, btn, errorsBox, draftKey) {
  const { body, errors } = monitorBody(state);
  errorsBox.replaceChildren();
  if (errors.length) { errorsBox.append(el("ul.dd-errors", {}, errors.map((e) => el("li", { text: e })))); return; }
  btn.disabled = true;
  try {
    await call("monitors.validate", body);
    const saved = id ? await call("monitors.update", { monitor_id: id, ...body }, { mutate: true, key: state.key }) : await call("monitors.create", body, { mutate: true, key: state.key });
    app.dirty = false;
    drafts.delete(draftKey);
    toast(id ? "Monitor saved" : "Monitor created");
    location.hash = `#/monitors/${saved.id}`;
  } catch (error) {
    btn.disabled = false;
    errorsBox.append(el("ul.dd-errors", {}, el("li", { text: describeError(error) })));
  }
}
