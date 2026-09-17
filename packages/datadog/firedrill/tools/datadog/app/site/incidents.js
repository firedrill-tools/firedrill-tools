// Incidents list: Active / Stable / Resolved tabs with counts, search, sort, offset paging, Declare Incident modal.
import { call, canWrite, el, fmtAgo, isoToSec, world, describeError } from "./ui.js";
import { icon } from "./icons.js";
import { banner, closeModal, emptyBlock, errorBlock, openModal, toast } from "./feedback.js";
import { pageHeader } from "./header.js";

const view = { state: "active", text: "", sort: "-created", offset: 0 };
const SIZE = 25;
export const SEVERITIES = ["SEV-1", "SEV-2", "SEV-3", "SEV-4", "SEV-5", "UNKNOWN"];
export const stateChip = (s) => el(`span.dd-state-chip.dd-state-chip--${s}`, { text: s });
export const sevLabel = (s) => el(`span.dd-sev.dd-sev--${s}`, { text: s === "UNKNOWN" ? "Unknown" : s });

const buildQuery = (state) => [`state:${state}`, ...view.text.trim().split(/\s+/).filter(Boolean)].join(" ");

export async function renderIncidents(main, rerender) {
  const input = el("input.dd-input", { type: "search", id: "incident-search", "aria-label": "Search incidents", placeholder: "Search incidents by title, severity:SEV-2, customer_impacted:true", value: view.text, autocomplete: "off" });
  const form = el("form.dd-search", { role: "search", on: { submit: (e) => { e.preventDefault(); view.text = input.value; view.offset = 0; rerender(); } } }, icon("search"), input);
  const declare = el("button.dd-btn.dd-btn--primary", { type: "button", disabled: !canWrite("incidents"), on: { click: () => declareIncident() } }, icon("plus"), "Declare Incident");
  const tabsNav = el("nav.dd-tabs", { role: "tablist", "aria-label": "Incident state" });
  const results = el("section.dd-results", { "aria-live": "polite" }, el("p.dd-muted", { text: "Loading incidents…" }));
  const sort = el("select.dd-select", { id: "incident-sort", "aria-label": "Sort incidents" }, [["-created", "Newest first"], ["created", "Oldest first"]].map(([v, l]) => el("option", { value: v, text: l })));
  sort.value = view.sort;
  sort.addEventListener("change", () => { view.sort = sort.value; view.offset = 0; rerender(); });
  main.append(
    pageHeader({ crumbs: [["Service Mgmt", null]], title: "Incidents", actions: [el("button.dd-btn", { type: "button", dataset: { notsim: "Incident Settings" } }, icon("gear"), "Settings"), declare] }),
    tabsNav, el("div.dd-toolbar", {}, form, sort), results);
  if (!canWrite("incidents")) results.before(banner("info", "You have the Datadog Read Only Role: incidents can be viewed but not declared or updated."));

  let page;
  let counts;
  try {
    [page, ...counts] = await Promise.all([
      call("incidents.search", { query: buildQuery(view.state), sort: view.sort, "page[size]": SIZE, "page[offset]": view.offset }),
      ...["active", "stable", "resolved"].map((s) => call("incidents.search", { query: buildQuery(s), "page[size]": 1 })),
    ]);
  } catch (error) { results.replaceChildren(errorBlock(error, rerender)); return; }
  ["active", "stable", "resolved"].forEach((s, i) => tabsNav.append(el("button", { type: "button", role: "tab", "aria-selected": String(view.state === s), on: { click: () => { view.state = s; view.offset = 0; rerender(); } } }, s[0].toUpperCase() + s.slice(1), el("span.dd-count", { text: String(counts[i].data.attributes.total) }))));
  const attrs = page.data.attributes;
  const rows = attrs.incidents.map((x) => x.data);
  if (rows.length === 0) {
    results.replaceChildren(emptyBlock(view.text.trim() ? "No incidents match your search" : `No ${view.state} incidents`, view.state === "active" ? "When something breaks, declare an incident to coordinate the response." : null));
    return;
  }
  results.replaceChildren(
    el("div.dd-results__summary", {}, el("span", { text: `${attrs.total} ${view.state} incident${attrs.total === 1 ? "" : "s"}` })),
    el("div.dd-table-wrap", {}, el("table.dd-table", {},
      el("thead", {}, el("tr", {}, ["ID", "Title", "Severity", "State", "Customer Impact", "Declared", "Duration"].map((h) => el("th", { scope: "col", text: h })))),
      el("tbody", {}, rows.map((inc) => {
        const a = inc.attributes;
        const href = `#/incidents/${inc.id}`;
        const created = isoToSec(a.created);
        const end = isoToSec(a.resolved) ?? world.nowSec;
        return el("tr.dd-row.dd-inc-row", { tabindex: "0", on: { click: (e) => { if (!e.target.closest("a")) location.hash = href; }, keydown: (e) => { if (e.key === "Enter") location.hash = href; } } },
          el("td.dd-mono.dd-muted", { text: `IR-${a.public_id}` }),
          el("td", {}, el("a.dd-row__title", { href, text: a.title }), a.is_test ? el("span.dd-tag", { style: "margin-left:6px", text: "Test" }) : null),
          el("td", {}, sevLabel(a.severity)), el("td", {}, stateChip(a.state)),
          el("td", { text: a.customer_impacted ? (a.customer_impact_scope ?? "Yes") : "No impact" }),
          el("td.dd-muted", { text: fmtAgo(created) }),
          el("td.dd-muted", { text: created ? humanDuration(end - created) : "—" }));
      })))),
    el("div.dd-pager", {}, el("span.dd-muted", { text: `${view.offset + 1}–${view.offset + rows.length} of ${attrs.total}` }),
      el("button.dd-btn.dd-btn--icon", { type: "button", "aria-label": "Previous page", disabled: view.offset === 0, on: { click: () => { view.offset = Math.max(0, view.offset - SIZE); rerender(); } } }, icon("chevronLeft")),
      el("button.dd-btn.dd-btn--icon", { type: "button", "aria-label": "Next page", disabled: view.offset + rows.length >= attrs.total, on: { click: () => { view.offset += SIZE; rerender(); } } }, icon("chevronRight"))));
}

export function humanDuration(sec) {
  const s = Math.max(0, sec);
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function declareIncident() {
  const key = crypto.randomUUID();
  const title = el("input.dd-input", { id: "inc-title", placeholder: "What's happening?", autocomplete: "off" });
  const sev = el("select.dd-select", { id: "inc-sev" }, SEVERITIES.map((s) => el("option", { value: s, text: s === "UNKNOWN" ? "Unknown" : s })));
  sev.value = "UNKNOWN";
  const impacted = el("input", { type: "checkbox", id: "inc-impacted" });
  const scope = el("textarea.dd-textarea", { id: "inc-scope", rows: 2, placeholder: "Describe how customers are impacted" });
  const scopeField = el("div.dd-field", { hidden: true }, el("label", { for: "inc-scope", text: "Customer impact scope" }), scope);
  impacted.addEventListener("change", () => { scopeField.hidden = !impacted.checked; });
  const commander = el("input", { type: "checkbox", id: "inc-commander", checked: true });
  const error = el("div", { role: "alert" });
  const submit = el("button.dd-btn.dd-btn--primary", { type: "button" }, "Declare Incident");
  submit.addEventListener("click", async () => {
    error.replaceChildren();
    if (!title.value.trim()) { title.setAttribute("aria-invalid", "true"); error.append(banner("error", "Title is required.")); return; }
    if (impacted.checked && !scope.value.trim()) { error.append(banner("error", "Describe the customer impact scope.")); return; }
    submit.disabled = true;
    const data = { type: "incidents", attributes: { title: title.value.trim(), customer_impacted: impacted.checked, ...(impacted.checked ? { customer_impact_scope: scope.value.trim() } : {}), fields: { severity: { type: "dropdown", value: sev.value } } } };
    if (commander.checked && world.org?.user?.uuid) data.relationships = { commander_user: { data: { type: "users", id: world.org.user.uuid } } };
    try {
      const created = await call("incidents.create", { data }, { mutate: true, key });
      closeModal();
      toast(`Incident IR-${created.data.attributes.public_id} declared`);
      location.hash = `#/incidents/${created.data.id}`;
    } catch (e) { submit.disabled = false; error.append(banner("error", describeError(e))); }
  });
  openModal({ title: "Declare Incident", width: 560, body: el("div", {}, error,
    el("div.dd-field", {}, el("label", { for: "inc-title", text: "Title" }), title),
    el("div.dd-field", {}, el("label", { for: "inc-sev", text: "Severity" }), sev),
    el("label.dd-check", { for: "inc-impacted", style: "margin-bottom:10px" }, impacted, "Customers are impacted"), scopeField,
    el("label.dd-check", { for: "inc-commander" }, commander, `Assign me (${world.org?.user?.name ?? "current user"}) as Incident Commander`)),
    footer: [el("button.dd-btn", { type: "button", on: { click: closeModal } }, "Cancel"), submit] });
}
