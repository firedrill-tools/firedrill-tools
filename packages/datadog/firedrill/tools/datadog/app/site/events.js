// Event Management › Explorer: time picker, search over tags, source and priority facets, event stream with the
// alert-type bar, and a side panel with the full event.
import { call, el, fmtAgo, fmtDate, describeError } from "./ui.js";
import { icon } from "./icons.js";
import { emptyBlock, errorBlock, openModal, closeModal } from "./feedback.js";
import { currentRange, pageHeader, timePicker } from "./header.js";

const view = { tags: "", priority: "", sources: new Set(), page: 0 };
const PRIORITIES = [["", "All"], ["normal", "Normal"], ["low", "Low"]];

let appliedTagsParam = null;

export async function renderEvents(main, rerender, { params } = {}) {
  const tagsParam = params?.get("tags") ?? null;
  if (tagsParam !== null && tagsParam !== appliedTagsParam) { view.tags = tagsParam.trim(); view.page = 0; view.priority = ""; view.sources.clear(); }
  appliedTagsParam = tagsParam;
  const range = currentRange();
  const input = el("input.dd-input", { type: "search", id: "event-search", "aria-label": "Filter events by tags", placeholder: "Filter by tags, e.g. service:checkout,env:prod", value: view.tags, autocomplete: "off" });
  const form = el("form.dd-search", { role: "search", on: { submit: (e) => { e.preventDefault(); view.tags = input.value.trim(); view.page = 0; rerender(); } } }, icon("search"), input);
  const facets = el("aside.dd-facets", { "aria-label": "Event facets" });
  const results = el("section.dd-results", { "aria-live": "polite" }, el("p.dd-muted", { text: "Loading events…" }));
  main.append(
    pageHeader({ crumbs: [["Service Mgmt", null], ["Event Management", null]], title: "Explorer", actions: [timePicker(rerender)] }),
    el("div.dd-toolbar", {}, form),
    el("div.dd-split", {}, facets, results));

  let value;
  try {
    value = await call("events.list", { start: range.from, end: range.to, tags: view.tags || undefined, priority: view.priority || undefined, sources: view.sources.size ? [...view.sources].join(",") : undefined, page: view.page });
  } catch (error) {
    results.replaceChildren(errorBlock(error, rerender));
    return;
  }
  const events = value.events ?? [];
  const sourceCounts = new Map();
  for (const e of events) { const s = (e.source_type_name ?? "user").toLowerCase(); sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + 1); }
  for (const s of view.sources) if (!sourceCounts.has(s)) sourceCounts.set(s, 0);
  const priorityGroup = el("div.dd-facet__list", { role: "radiogroup", "aria-label": "Priority" }, PRIORITIES.map(([v, label]) => el("label.dd-facet__opt", { for: `ev-pri-${v || "all"}` },
    el("input", { type: "radio", name: "ev-priority", id: `ev-pri-${v || "all"}`, checked: view.priority === v, on: { change: () => { view.priority = v; view.page = 0; rerender(); } } }), el("span.dd-facet__name", { text: label }))));
  facets.replaceChildren(
    el("details.dd-facet", { open: true }, el("summary", {}, icon("chevronDown", { size: 12 }), el("span", { text: "Source" })),
      sourceCounts.size ? el("ul.dd-facet__list", {}, [...sourceCounts].map(([name, count]) => {
        const id = `ev-src-${name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
        return el("li", {}, el("label.dd-facet__opt", { for: id }, el("input", { type: "checkbox", id, checked: view.sources.has(name), on: { change: (e) => { if (e.target.checked) view.sources.add(name); else view.sources.delete(name); view.page = 0; rerender(); } } }), el("span.dd-facet__name", { text: name }), el("span.dd-facet__count", { text: String(count) })));
      })) : el("p.dd-muted.dd-facet__none", { text: "No values" })),
    el("details.dd-facet", { open: true }, el("summary", {}, icon("chevronDown", { size: 12 }), el("span", { text: "Priority" })), priorityGroup));

  if (events.length === 0) {
    results.replaceChildren(emptyBlock("No events found", `No events match these filters in the ${range.label.toLowerCase()}. Try a wider time range.`));
    return;
  }
  const list = el("ul.dd-stream", { role: "listbox", "aria-label": "Events" }, events.map((e) => {
    const item = el("li.dd-event", { role: "option", tabindex: "0", "aria-selected": "false" },
      el("span", { class: `dd-timeline__bar dd-bar--${e.alert_type}` }),
      el("div.dd-event__time", {}, el("div", { text: fmtAgo(e.date_happened) }), el("div", { text: fmtDate(e.date_happened, { seconds: false }) })),
      el("div", { style: "min-width:0" }, el("div.dd-event__title", { text: e.title }), e.text ? el("div.dd-event__text", { text: e.text }) : null,
        el("div.dd-row__tags", {}, e.source_type_name ? el("span.dd-tag", { text: e.source_type_name }) : null, e.tags.slice(0, 6).map((t) => el("span.dd-tag", { text: t })), e.is_aggregate ? el("span.dd-tag", { text: `${e.children?.length ?? 0} aggregated` }) : null)));
    const open = () => { for (const n of list.children) n.setAttribute("aria-selected", "false"); item.setAttribute("aria-selected", "true"); void openEvent(e.id_str ?? String(e.id)); };
    item.addEventListener("click", open);
    item.addEventListener("keydown", (ev) => { if (ev.key === "Enter") open(); });
    return item;
  }));
  const full = events.length >= 1000;
  results.replaceChildren(
    el("div.dd-results__summary", {}, el("span", { text: `${events.length}${full ? "+" : ""} event${events.length === 1 ? "" : "s"}` }), el("span.dd-muted", { text: `${fmtDate(range.from, { seconds: false })} – ${fmtDate(range.to, { seconds: false })} UTC` })),
    el("div.dd-card", {}, list),
    el("div.dd-pager", {}, el("span.dd-muted", { text: `Page ${view.page + 1}` }),
      el("button.dd-btn.dd-btn--icon", { type: "button", "aria-label": "Previous page", disabled: view.page === 0, on: { click: () => { view.page -= 1; rerender(); } } }, icon("chevronLeft")),
      el("button.dd-btn.dd-btn--icon", { type: "button", "aria-label": "Next page", disabled: !full, on: { click: () => { view.page += 1; rerender(); } } }, icon("chevronRight"))));
}

async function openEvent(id) {
  const body = el("div", {}, el("p.dd-muted", { text: "Loading…" }));
  openModal({ title: "Event", body, side: true, footer: [el("button.dd-btn", { type: "button", on: { click: closeModal } }, "Close")] });
  try {
    const { event: e } = await call("events.get", { event_id: id });
    body.replaceChildren(
      el("h3", { style: "font-size:16px;margin-bottom:8px", text: e.title }),
      el("dl.dd-kv", {},
        el("dt", { text: "Date" }), el("dd", { text: `${fmtDate(e.date_happened, { year: true })} UTC` }),
        el("dt", { text: "Alert type" }), el("dd", { text: e.alert_type }),
        el("dt", { text: "Priority" }), el("dd", { text: e.priority }),
        el("dt", { text: "Source" }), el("dd", { text: e.source_type_name ?? "—" }),
        el("dt", { text: "Host" }), el("dd", { text: e.host ?? "—" }),
        el("dt", { text: "ID" }), el("dd.dd-mono", { text: e.id_str ?? String(e.id) })),
      el("div.dd-label", { style: "margin-top:14px", text: "Message" }), el("pre.dd-message", { text: e.text || "No message" }),
      el("div.dd-label", { style: "margin-top:14px", text: "Tags" }), el("div.dd-tags", {}, e.tags.map((t) => el("span.dd-tag", { text: t }))));
  } catch (error) {
    body.replaceChildren(el("p", { text: describeError(error) }));
  }
}
