// Monitors › Manage Monitors: query-syntax search, facet panel with counts, sortable table, paging.
import { call, el, fmtAgo, fmtDate, world, canWrite } from "./ui.js";
import { icon } from "./icons.js";
import { banner, emptyBlock, errorBlock, loadingBlock } from "./feedback.js";
import { pageHeader } from "./header.js";

const FACETS = [
  { key: "status", title: "Status", labels: { alert: "Alert", warn: "Warn", "no data": "No Data", ok: "OK", unknown: "Unknown" } },
  { key: "muted", title: "Muted", labels: { true: "Muted", false: "Not muted" } },
  { key: "type", title: "Monitor Type", labels: { metric: "Metric", composite: "Composite", custom: "Service Check", log: "Logs", event: "Event" } },
  { key: "tag", title: "Tags" },
];
const TYPE_QUERY = { metric: "metric", composite: "composite", custom: "service", log: "log", event: "event" };
export const monitorsView = { text: "", selected: { status: new Set(), muted: new Set(), type: new Set(), tag: new Set() }, sort: "status,asc", page: 0 };

export const statusClass = (s) => `dd-status dd-status--${String(s ?? "unknown").toLowerCase().replace(/\s+/g, "")}`;
export const statusPill = (s, lg = false) => el(`span.${statusClass(s).split(" ").join(".")}${lg ? ".dd-status--lg" : ""}`, { text: s ?? "Unknown" });
const quote = (v) => (/[\s()"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);

export function buildMonitorQuery(view = monitorsView) {
  const parts = [];
  if (view.text.trim()) parts.push(view.text.trim());
  for (const facet of FACETS) {
    const values = [...view.selected[facet.key]];
    if (values.length === 0) continue;
    const terms = values.map((v) => `${facet.key}:${quote(facet.key === "type" ? TYPE_QUERY[v] ?? v : v)}`);
    parts.push(terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`);
  }
  return parts.join(" ");
}

export async function renderMonitors(main, rerender) {
  const view = monitorsView;
  const input = el("input.dd-input", { type: "search", id: "monitor-search", "aria-label": "Search monitors", placeholder: "Search monitors by name, tag:, status:, type:, priority:, muted:", value: view.text, autocomplete: "off", spellcheck: "false" });
  const form = el("form.dd-search", { role: "search", on: { submit: (e) => { e.preventDefault(); view.text = input.value; view.page = 0; rerender(); } } }, icon("search"), input);
  const facetsPane = el("aside.dd-facets", { "aria-label": "Monitor facets" }, loadingBlock(""));
  const results = el("section.dd-results", { "aria-live": "polite" }, loadingBlock("Loading monitors…"));
  main.append(
    pageHeader({ title: "Monitors", actions: [
      el("button.dd-btn", { type: "button", "aria-label": "Monitor settings", title: "Monitor Settings", dataset: { notsim: "Monitor Settings" } }, icon("gear")),
      el("a.dd-btn.dd-btn--primary", { href: "#/monitors/create", "aria-disabled": String(!canWrite("monitors")), title: canWrite("monitors") ? "Create a monitor" : "Your role cannot create monitors" }, icon("plus"), "New Monitor"),
    ] }),
    el("nav.dd-tabs", { "aria-label": "Monitors" }, el("a", { href: "#/monitors/manage", "aria-current": "page" }, "Monitors List"),
      el("button", { type: "button", dataset: { notsim: "Downtimes" } }, "Downtimes"), el("button", { type: "button", dataset: { notsim: "Monitor Quality" } }, "Monitor Quality"), el("button", { type: "button", dataset: { notsim: "SLOs" } }, "SLOs")),
    el("div.dd-toolbar", {}, form),
    el("div.dd-split", {}, facetsPane, results),
  );
  if (!canWrite("monitors")) results.before(banner("info", "You have the Datadog Read Only Role: monitors can be viewed but not created, edited, muted or deleted."));

  let value;
  try {
    value = await call("monitors.search", { query: buildMonitorQuery(), page: view.page, per_page: 30, sort: view.sort });
  } catch (error) {
    facetsPane.replaceChildren();
    results.replaceChildren(errorBlock(error, rerender));
    return;
  }
  facetsPane.replaceChildren(...FACETS.map((facet) => facetGroup(facet, value.counts?.[facet.key] ?? [], rerender)));
  const meta = value.metadata ?? { total_count: 0, page: 0, page_count: 0, per_page: 30 };
  if (value.monitors.length === 0) {
    const filtered = buildMonitorQuery() !== "";
    results.replaceChildren(emptyBlock(filtered ? "No monitors match your search" : "No monitors yet", filtered ? "Try removing a facet or changing the search query." : "Create a monitor to be notified when a metric crosses a threshold.",
      filtered ? el("button.dd-btn", { type: "button", on: { click: () => { view.text = ""; for (const s of Object.values(view.selected)) s.clear(); view.page = 0; rerender(); } } }, "Clear search") : el("a.dd-btn.dd-btn--primary", { href: "#/monitors/create" }, icon("plus"), "New Monitor")));
    return;
  }
  const sortHeader = (label, field, cls = "") => {
    const [f, dir] = view.sort.split(",");
    const active = f === field;
    return el(`th${cls}`, { scope: "col", "aria-sort": active ? (dir === "asc" ? "ascending" : "descending") : "none" },
      el("button.dd-th-sort", { type: "button", on: { click: () => { view.sort = `${field},${active && dir === "asc" ? "desc" : "asc"}`; view.page = 0; rerender(); } } }, label, active ? icon(dir === "asc" ? "chevronDown" : "chevronRight", { size: 10 }) : null));
  };
  const table = el("table.dd-table.dd-table--monitors", {},
    el("thead", {}, el("tr", {}, sortHeader("Status", "status", ".dd-col-status"), sortHeader("Name", "name"), el("th", { scope: "col" }, "Type"), el("th", { scope: "col" }, "Last Triggered"), sortHeader("ID", "id", ".dd-col-id"), el("th", { scope: "col" }, "Creator"))),
    el("tbody", {}, value.monitors.map((m) => monitorRow(m, rerender))));
  const from = meta.page * meta.per_page + 1;
  const to = meta.page * meta.per_page + value.monitors.length;
  results.replaceChildren(
    el("div.dd-results__summary", {}, el("span", { text: `${meta.total_count} monitor${meta.total_count === 1 ? "" : "s"}` }), el("span.dd-muted", { text: `as of ${fmtDate(world.nowSec)} UTC` })),
    el("div.dd-table-wrap", {}, table),
    pager(`${from}–${to} of ${meta.total_count}`, meta.page > 0, meta.page + 1 < meta.page_count, (delta) => { view.page += delta; rerender(); }));
}

function monitorRow(m, rerender) {
  const href = `#/monitors/${m.id}`;
  return el("tr.dd-row", { tabindex: "0", on: { click: (e) => { if (!e.target.closest("button,a")) location.hash = href; }, keydown: (e) => { if (e.key === "Enter") location.hash = href; } } },
    el("td.dd-col-status", {}, statusPill(m.status)),
    el("td", {}, el("a.dd-row__title", { href, text: m.name }),
      el("div.dd-row__tags", {}, m.tags.slice(0, 6).map((t) => el("button.dd-tag", { type: "button", title: `Filter by ${t}`, on: { click: () => { monitorsView.selected.tag.add(t); monitorsView.page = 0; rerender(); } } }, t)), m.tags.length > 6 ? el("span.dd-muted", { text: `+${m.tags.length - 6}` }) : null)),
    el("td.dd-muted", { text: typeLabel(m.type) }),
    el("td", { title: m.last_triggered_ts ? `${fmtDate(m.last_triggered_ts)} UTC` : "" }, m.last_triggered_ts ? fmtAgo(m.last_triggered_ts) : el("span.dd-muted", { text: "—" })),
    el("td.dd-col-id.dd-mono.dd-muted", { text: String(m.id) }),
    el("td.dd-muted", { text: m.creator?.name ?? "" }));
}
export const typeLabel = (t) => ({ "metric alert": "Metric", "query alert": "Metric", composite: "Composite", "service check": "Service Check", "log alert": "Logs", "event-v2 alert": "Event" })[t] ?? t;

function facetGroup(facet, counts, rerender) {
  const selected = monitorsView.selected[facet.key];
  const names = new Map(counts.map((c) => [c.name, c.count]));
  for (const s of selected) if (!names.has(s)) names.set(s, 0);
  const list = el("ul.dd-facet__list", {});
  for (const [name, count] of names) {
    const id = `facet-${facet.key}-${name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    const label = facet.labels?.[name] ?? name;
    list.append(el("li", {}, el("label.dd-facet__opt", { for: id },
      el("input", { type: "checkbox", id, checked: selected.has(name), on: { change: (e) => { if (e.target.checked) selected.add(name); else selected.delete(name); monitorsView.page = 0; rerender(); } } }),
      facet.key === "status" ? el(`span.dd-dot.dd-dot--${name.replace(/\s+/g, "")}`, { "aria-hidden": "true" }) : null,
      el("span.dd-facet__name", { text: label }), el("span.dd-facet__count", { text: String(count) }))));
  }
  return el("details.dd-facet", { open: true }, el("summary", {}, icon("chevronDown", { size: 12 }), el("span", { text: facet.title })), counts.length || selected.size ? list : el("p.dd-muted.dd-facet__none", { text: "No values" }));
}

export function pager(label, canPrev, canNext, go) {
  return el("div.dd-pager", {}, el("span.dd-muted", { text: label }),
    el("button.dd-btn.dd-btn--icon", { type: "button", "aria-label": "Previous page", disabled: !canPrev, on: { click: () => go(-1) } }, icon("chevronLeft")),
    el("button.dd-btn.dd-btn--icon", { type: "button", "aria-label": "Next page", disabled: !canNext, on: { click: () => go(1) } }, icon("chevronRight")));
}
