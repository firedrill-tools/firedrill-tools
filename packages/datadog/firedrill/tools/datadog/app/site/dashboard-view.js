// Dashboard view: title bar with Configure menu actions, template variable selectors, widget grid; edit mode adds
// note/timeseries widgets, removes widgets, renames, saves (full replace) and deletes with confirmation.
import { call, canWrite, el, fmtAgo, isoToSec, describeError } from "./ui.js";
import { icon } from "./icons.js";
import { banner, closeModal, confirmDialog, errorBlock, openModal, toast } from "./feedback.js";
import { currentRange, pageHeader, timePicker } from "./header.js";
import { app } from "./app.js";
import { fillWidget, stripNulls } from "./widgets.js";

const session = { id: null, draft: null, vars: new Map(), key: null };

export async function renderDashboard(main, rerender, { args }) {
  const id = args[0];
  let d;
  try { d = await call("dashboards.get", { dashboard_id: id }); }
  catch (error) { main.append(pageHeader({ crumbs: [["Dashboards", "#/dashboard/lists"]], title: "Dashboard" }), errorBlock(error, rerender)); return; }
  if (session.id !== id) { session.id = id; session.draft = null; session.vars = new Map(); }
  for (const tv of d.template_variables ?? []) if (!session.vars.has(tv.name)) session.vars.set(tv.name, { prefix: tv.prefix, value: tv.defaults?.[0] ?? "*" });
  const editing = session.draft !== null;
  const model = editing ? session.draft : d;
  const writable = canWrite("dashboards");
  const range = currentRange();

  const editBtn = el("button.dd-btn", { type: "button", disabled: !writable, title: writable ? "Edit widgets" : "Your role cannot edit dashboards", on: { click: () => { session.draft = structuredClone(d); session.key = crypto.randomUUID(); app.dirty = true; rerender(); } } }, icon("edit"), "Edit Widgets");
  const delBtn = el("button.dd-btn.dd-btn--icon", { type: "button", "aria-label": "Delete dashboard", title: "Delete dashboard", disabled: !writable }, icon("trash"));
  delBtn.addEventListener("click", async () => {
    if (!(await confirmDialog({ title: "Delete dashboard", message: `Delete "${d.title}"? It moves to Deleted Dashboards.`, confirmLabel: "Delete", danger: true }))) return;
    delBtn.disabled = true;
    try { await call("dashboards.delete", { dashboard_id: id }, { mutate: true }); toast("Dashboard deleted"); app.dirty = false; session.draft = null; location.hash = "#/dashboard/lists"; }
    catch (error) { delBtn.disabled = false; toast(describeError(error), "error"); }
  });
  const titleNode = editing ? el("input.dd-input", { id: "dash-title", "aria-label": "Dashboard title", value: model.title, style: "font-size:16px;height:32px;width:min(420px,50vw)", on: { input: (e) => { session.draft.title = e.target.value; } } }) : el("span.dd-truncate", { text: d.title });
  const actions = editing ? [
    el("button.dd-btn", { type: "button", on: { click: () => addWidget(rerender) } }, icon("plus"), "Add Widgets"),
    el("button.dd-btn", { type: "button", on: { click: () => { session.draft = null; app.dirty = false; rerender(); } } }, "Cancel"),
    saveButton(id, rerender),
  ] : [timePicker(rerender), el("button.dd-btn", { type: "button", dataset: { notsim: "Share dashboard" } }, icon("share"), "Share"), editBtn, delBtn];
  main.append(
    pageHeader({ crumbs: [["Dashboards", "#/dashboard/lists"]], title: el("span", { style: "display:flex;align-items:center;gap:8px;min-width:0" }, el("button.dd-btn.dd-btn--ghost.dd-btn--icon", { type: "button", "aria-label": "Favorite", title: "Favorite", dataset: { notsim: "Favorite dashboards" } }, icon("star")), titleNode, d.is_read_only ? icon("lock", { label: "Read only" }) : null), actions }),
    el("div.dd-meta-line", {}, el("span", { text: `Created by ${d.author_name ?? d.author_handle ?? "—"}` }), el("span", { text: `Modified ${fmtAgo(isoToSec(d.modified_at))}` }), d.description ? el("span", { text: d.description }) : null, (d.tags ?? []).map((t) => el("span.dd-tag", { text: t }))));
  if (!writable) main.append(banner("info", "You have the Datadog Read Only Role: this dashboard can be viewed but not edited."));
  if ((d.template_variables ?? []).length) {
    main.append(el("div.dd-tvars", {}, d.template_variables.map((tv) => {
      const idAttr = `tvar-${tv.name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      const current = session.vars.get(tv.name);
      const options = ["*", ...(tv.available_values?.length ? tv.available_values : tv.defaults ?? [])].filter((v, i, a) => a.indexOf(v) === i);
      const sel = el("select", { id: idAttr, "aria-label": `Template variable ${tv.name}` }, options.map((v) => el("option", { value: v, text: v })));
      sel.value = current.value;
      sel.addEventListener("change", () => { current.value = sel.value; rerender(); });
      return el("span.dd-tvar", {}, el("b", { text: `$${tv.name}` }), sel);
    })));
  }
  const grid = el("div.dd-dash-grid", {});
  main.append(grid);
  const widgets = model.widgets ?? [];
  if (widgets.length === 0) {
    grid.append(el("div.dd-card", { style: "grid-column:span 12" }, el("div.dd-state", {}, el("div.dd-state__art", { "aria-hidden": "true" }, icon("dashboards", { size: 28 })), el("h3", { text: "This dashboard is empty" }), el("p", { text: "Add widgets to graph your metrics." }),
      writable ? el("button.dd-btn.dd-btn--primary", { type: "button", on: { click: () => { if (!editing) { session.draft = structuredClone(d); session.key = crypto.randomUUID(); app.dirty = true; } addWidget(rerender); } } }, icon("plus"), "Add Widgets") : null)));
    return;
  }
  widgets.forEach((w, index) => {
    const def = w.definition;
    const body = el("div.dd-widget__body", {});
    const remove = editing ? el("button.dd-btn.dd-btn--ghost.dd-btn--icon.dd-btn--sm", { type: "button", "aria-label": `Remove widget ${def.title ?? def.type}`, on: { click: async () => { if (await confirmDialog({ title: "Remove widget", message: "Remove this widget from the dashboard? Changes apply when you save.", confirmLabel: "Remove", danger: true })) { session.draft.widgets.splice(index, 1); rerender(); } } } }, icon("close")) : null;
    grid.append(el(`section.dd-widget.dd-widget--${def.type}`, { "aria-label": def.title ?? def.type }, el("div.dd-widget__head", {}, el("span", { text: def.title ?? "" }), remove), body));
    void fillWidget(body, def, session.vars, range);
  });
}

function saveButton(id, rerender) {
  const btn = el("button.dd-btn.dd-btn--primary", { type: "button" }, "Save");
  btn.addEventListener("click", async () => {
    const d = session.draft;
    if (!String(d.title ?? "").trim()) { toast("Dashboard title is required", "error"); return; }
    btn.disabled = true;
    const body = stripNulls({ dashboard_id: id, title: d.title.trim(), description: d.description, layout_type: d.layout_type, reflow_type: d.reflow_type, is_read_only: d.is_read_only, widgets: d.widgets.map((w) => ({ definition: w.definition, ...(w.layout ? { layout: w.layout } : {}) })), template_variables: d.template_variables, tags: d.tags, notify_list: d.notify_list, restricted_roles: d.restricted_roles });
    try { await call("dashboards.update", body, { mutate: true, key: session.key }); session.draft = null; app.dirty = false; toast("Dashboard saved"); rerender(); }
    catch (error) { btn.disabled = false; toast(describeError(error), "error"); }
  });
  return btn;
}

function addWidget(rerender) {
  const type = el("select.dd-select", { id: "widget-type" }, [["timeseries", "Timeseries"], ["query_value", "Query Value"], ["toplist", "Top List"], ["note", "Notes & Links"]].map(([v, l]) => el("option", { value: v, text: l })));
  const title = el("input.dd-input", { id: "widget-title", placeholder: "Widget title" });
  const query = el("input.dd-input.dd-mono", { id: "widget-query", placeholder: "avg:system.cpu.user{*} by {host}" });
  const content = el("textarea.dd-textarea", { id: "widget-content", rows: 4, placeholder: "## Heading\nText with **bold**" });
  const queryField = el("div.dd-field", {}, el("label", { for: "widget-query", text: "Metric query" }), query);
  const contentField = el("div.dd-field", { hidden: true }, el("label", { for: "widget-content", text: "Content" }), content);
  type.addEventListener("change", () => { const note = type.value === "note"; queryField.hidden = note; contentField.hidden = !note; });
  const error = el("div", { role: "alert" });
  const add = el("button.dd-btn.dd-btn--primary", { type: "button", on: { click: () => {
    error.replaceChildren();
    const t = type.value;
    if (t === "note" ? !content.value.trim() : !query.value.trim()) { error.append(banner("error", t === "note" ? "Content is required." : "A metric query is required.")); return; }
    const def = t === "note" ? { type: "note", content: content.value } : { type: t, ...(title.value.trim() ? { title: title.value.trim() } : {}), requests: [{ q: query.value.trim(), ...(t === "timeseries" ? { display_type: "line" } : { aggregator: "avg" }) }] };
    if (t === "note" && title.value.trim()) content.value = content.value;
    const widget = { definition: def };
    if (session.draft.layout_type === "free") widget.layout = { x: 0, y: session.draft.widgets.reduce((y, w) => Math.max(y, (w.layout?.y ?? 0) + (w.layout?.height ?? 0)), 0), width: 4, height: 2 };
    session.draft.widgets.push(widget);
    closeModal();
    rerender();
  } } }, "Add");
  openModal({ title: "Add a widget", width: 520, body: el("div", {}, error, el("div.dd-field", {}, el("label", { for: "widget-type", text: "Widget type" }), type), el("div.dd-field", {}, el("label", { for: "widget-title", text: "Title" }), title), queryField, contentField), footer: [el("button.dd-btn", { type: "button", on: { click: closeModal } }, "Cancel"), add] });
}
