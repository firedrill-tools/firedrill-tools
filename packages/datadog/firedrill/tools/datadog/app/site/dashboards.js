// Dashboards › Dashboard List: search, All / Deleted tabs, paging, New Dashboard modal.
import { call, canWrite, el, fmtAgo, isoToSec, describeError } from "./ui.js";
import { icon } from "./icons.js";
import { banner, closeModal, emptyBlock, errorBlock, openModal, toast } from "./feedback.js";
import { pageHeader } from "./header.js";

const view = { query: "", deleted: false, start: 0 };
const COUNT = 25;

export async function renderDashboardList(main, rerender, { params }) {
  const input = el("input.dd-input", { type: "search", id: "dash-search", "aria-label": "Search dashboards", placeholder: "Search dashboards", value: view.query, autocomplete: "off" });
  const form = el("form.dd-search", { role: "search", on: { submit: (e) => { e.preventDefault(); view.query = input.value.trim(); view.start = 0; rerender(); } } }, icon("search"), input);
  const newBtn = el("button.dd-btn.dd-btn--primary", { type: "button", disabled: !canWrite("dashboards"), on: { click: () => newDashboard() } }, icon("plus"), "New Dashboard");
  const results = el("section.dd-results", { "aria-live": "polite" }, el("p.dd-muted", { text: "Loading dashboards…" }));
  const tab = (label, deleted) => el("button", { type: "button", "aria-selected": String(view.deleted === deleted), on: { click: () => { view.deleted = deleted; view.start = 0; rerender(); } } }, label);
  main.append(
    pageHeader({ crumbs: [["Dashboards", null]], title: "Dashboard List", actions: [newBtn] }),
    el("nav.dd-tabs", { role: "tablist", "aria-label": "Dashboard lists" }, tab("All Dashboards", false), el("button", { type: "button", dataset: { notsim: "Shared Dashboards" } }, "Shared"), tab("Deleted Dashboards", true)),
    el("div.dd-toolbar", {}, form),
    results);
  if (params.get("new") === "1" && canWrite("dashboards")) { history.replaceState(null, "", "#/dashboard/lists"); newDashboard(); }
  let value;
  try {
    value = await call("dashboards.list", { "filter[deleted]": view.deleted ? "true" : "false", count: COUNT, start: view.start, query: view.query || undefined });
  } catch (error) { results.replaceChildren(errorBlock(error, rerender)); return; }
  const rows = value.dashboards ?? [];
  if (rows.length === 0) {
    results.replaceChildren(emptyBlock(view.query ? "No dashboards match your search" : view.deleted ? "No deleted dashboards" : "No dashboards yet", view.deleted ? "Deleted dashboards can be restored for 30 days in Datadog; this Tool lists them read-only." : "Create a dashboard to graph your metrics."));
    return;
  }
  const total = value.total_rows ?? rows.length;
  results.replaceChildren(
    el("div.dd-results__summary", {}, el("span", { text: `${total} dashboard${total === 1 ? "" : "s"}` })),
    el("div.dd-table-wrap", {}, el("table.dd-table", {},
      el("thead", {}, el("tr", {}, ["", "Name", "Author", view.deleted ? "Deleted" : "Modified", "Created"].map((h) => el("th", { scope: "col", text: h })))),
      el("tbody", {}, rows.map((d) => {
        const href = `#/dashboard/${d.id}`;
        const go = () => { if (!view.deleted) location.hash = href; };
        return el("tr.dd-row", { tabindex: "0", on: { click: go, keydown: (e) => { if (e.key === "Enter") go(); } } },
          el("td", { style: "width:32px;color:var(--text-3)" }, icon(d.is_read_only ? "lock" : "dashboards")),
          el("td", {}, view.deleted ? el("span.dd-row__title", { text: d.title }) : el("a.dd-row__title", { href, text: d.title }), d.description ? el("div.dd-muted", { text: d.description }) : null),
          el("td.dd-muted", { text: d.author_handle ?? "—" }),
          el("td.dd-muted", { text: fmtAgo(isoToSec(view.deleted ? d.deleted_at : d.modified_at)) }),
          el("td.dd-muted", { text: fmtAgo(isoToSec(d.created_at)) }));
      })))),
    el("div.dd-pager", {}, el("span.dd-muted", { text: `${view.start + 1}–${view.start + rows.length} of ${total}` }),
      el("button.dd-btn.dd-btn--icon", { type: "button", "aria-label": "Previous page", disabled: view.start === 0, on: { click: () => { view.start = Math.max(0, view.start - COUNT); rerender(); } } }, icon("chevronLeft")),
      el("button.dd-btn.dd-btn--icon", { type: "button", "aria-label": "Next page", disabled: view.start + rows.length >= total, on: { click: () => { view.start += COUNT; rerender(); } } }, icon("chevronRight"))));
}

function newDashboard() {
  const key = crypto.randomUUID();
  const title = el("input.dd-input", { id: "new-dash-title", placeholder: "My Dashboard", autocomplete: "off" });
  const desc = el("textarea.dd-textarea", { id: "new-dash-desc", rows: 3 });
  const error = el("div", { role: "alert" });
  const create = el("button.dd-btn.dd-btn--primary", { type: "button" }, "New Dashboard");
  create.addEventListener("click", async () => {
    error.replaceChildren();
    if (!title.value.trim()) { error.append(banner("error", "Dashboard name is required.")); title.setAttribute("aria-invalid", "true"); return; }
    create.disabled = true;
    try {
      const d = await call("dashboards.create", { title: title.value.trim(), description: desc.value.trim() || null, layout_type: "ordered", widgets: [] }, { mutate: true, key });
      closeModal();
      toast("Dashboard created");
      location.hash = `#/dashboard/${d.id}`;
    } catch (e) { create.disabled = false; error.append(banner("error", describeError(e))); }
  });
  openModal({ title: "Create a Dashboard", width: 520, body: el("div", {}, error,
    el("div.dd-field", {}, el("label", { for: "new-dash-title", text: "Dashboard name" }), title),
    el("div.dd-field", {}, el("label", { for: "new-dash-desc", text: "Description" }), desc)),
    footer: [el("button.dd-btn", { type: "button", on: { click: closeModal } }, "Cancel"), create] });
}
