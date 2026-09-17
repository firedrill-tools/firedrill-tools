// Monitor status page: header with status, Mute / Edit / Clone / Delete, properties, evaluation graph with thresholds,
// group status table and the monitor's event history.
import { call, canWrite, el, fmtAgo, fmtDate, isoToSec, world, describeError } from "./ui.js";
import { icon } from "./icons.js";
import { banner, confirmDialog, emptyBlock, errorBlock, toast } from "./feedback.js";
import { currentRange, pageHeader, timePicker } from "./header.js";
import { pager, statusPill, typeLabel } from "./monitors.js";
import { timeseriesChart } from "./chart.js";

export async function renderMonitorDetail(main, rerender, { args }) {
  const id = args[0];
  let m;
  try {
    m = await call("monitors.get", { monitor_id: id, group_states: "all" });
  } catch (error) {
    main.append(pageHeader({ crumbs: [["Monitors", "#/monitors/manage"]], title: `Monitor ${id}` }), errorBlock(error, rerender));
    return;
  }
  const writable = canWrite("monitors");
  const silenced = m.options?.silenced ?? {};
  const muted = Object.keys(silenced).length > 0;
  const busy = (btn, on) => { btn.disabled = on; };

  const muteBtn = el("button.dd-btn", { type: "button", disabled: !writable, title: writable ? "" : "Your role cannot mute monitors" }, icon(muted ? "unmute" : "mute"), muted ? "Unmute" : "Mute");
  muteBtn.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: muted ? "Unmute monitor" : "Mute monitor", message: muted ? `Notifications for "${m.name}" will resume.` : `"${m.name}" will stop notifying for all groups until you unmute it.`, confirmLabel: muted ? "Unmute" : "Mute" });
    if (!ok) return;
    busy(muteBtn, true);
    try {
      await call("monitors.update", { monitor_id: id, options: { silenced: muted ? {} : { "*": null } } }, { mutate: true });
      toast(muted ? "Monitor unmuted" : "Monitor muted");
      rerender();
    } catch (error) { toast(describeError(error), "error"); busy(muteBtn, false); }
  });
  const deleteBtn = el("button.dd-btn", { type: "button", disabled: !writable, "aria-label": "Delete monitor", title: "Delete" }, icon("trash"));
  deleteBtn.addEventListener("click", () => deleteMonitor(m, deleteBtn));

  main.append(
    pageHeader({ crumbs: [["Monitors", "#/monitors/manage"], [typeLabel(m.type), null]], title: el("span.dd-mon-title", {}, statusPill(m.overall_state, true), el("span.dd-truncate", { text: m.name })), actions: [
      muteBtn,
      el("a.dd-btn", { href: `#/monitors/${id}/edit`, "aria-disabled": String(!writable) }, icon("edit"), "Edit"),
      el("a.dd-btn", { href: `#/monitors/create?clone=${id}`, "aria-disabled": String(!writable) }, icon("copy"), "Clone"),
      deleteBtn,
      el("button.dd-btn.dd-btn--icon", { type: "button", "aria-label": "Share", title: "Share", dataset: { notsim: "Share monitor" } }, icon("share")),
    ] }),
    el("div.dd-meta-line", {},
      el("span", {}, "ID ", el("span.dd-mono", { text: String(m.id) })),
      el("span", { text: `Created by ${m.creator?.name ?? "—"} ${fmtAgo(isoToSec(m.created))}` }),
      el("span", { text: `Modified ${fmtAgo(isoToSec(m.modified))}` }),
      m.priority ? el("span", { text: `P${m.priority}` }) : null,
      muted ? el("span.dd-tag", {}, icon("mute", { size: 12 }), " Muted") : null,
      m.restricted_roles?.length ? el("span", {}, icon("lock", { size: 12 }), ` Restricted to ${m.restricted_roles.length} role(s)`) : null),
  );
  if (!writable) main.append(banner("info", "You have the Datadog Read Only Role: this monitor can be viewed but not changed."));

  const body = el("div.dd-body", {});
  main.append(body);
  const graphCard = el("section.dd-card", { "aria-label": "Status and history" });
  const groupsCard = el("section.dd-card", { "aria-label": "Group status" });
  const eventsCard = el("section.dd-card", { "aria-label": "Events" });
  body.append(el("div.dd-grid2", {},
    el("div", { style: "display:flex;flex-direction:column;gap:16px;min-width:0" }, graphCard, groupsCard, eventsCard),
    properties(m)));

  const range = currentRange();
  graphCard.append(el("div.dd-card__head", {}, el("span", { text: "Status & History" }), el("span.dd-card__head-spacer"), timePicker(rerender)));
  const graphBody = el("div.dd-card__body", {}, el("div.dd-nodata", { text: "Loading…" }));
  graphCard.append(graphBody);
  const metricQuery = m.type === "metric alert" || m.type === "query alert" ? extractMetricQuery(m.query) : null;
  if (metricQuery) {
    call("metrics.query", { from: range.from, to: range.to, query: metricQuery }).then((q) => {
      const t = m.options?.thresholds ?? {};
      const above = !/</.test(m.query);
      const thresholds = [t.critical !== null && t.critical !== undefined ? { value: t.critical, color: "#d33d3d", above } : null, t.warning !== null && t.warning !== undefined ? { value: t.warning, color: "#e5a21a", above } : null].filter(Boolean);
      const series = (q.series ?? []).map((s) => ({ name: s.scope || s.display_name, points: s.pointlist }));
      graphBody.replaceChildren(series.length ? timeseriesChart(series, { from: range.from, to: range.to, thresholds }) : el("div.dd-nodata", { text: "No data for this time frame" }), el("div.dd-legend", {}, series.slice(0, 8).map((s, i) => el("span", {}, el("span.dd-swatch", { dataset: { c: String(i % 8) } }), s.name))));
    }).catch((error) => graphBody.replaceChildren(banner("error", describeError(error))));
  } else {
    graphBody.replaceChildren(el("div.dd-nodata", { text: m.type === "composite" ? "Composite monitors are evaluated from their component monitors" : "This monitor type is not graphed by this Tool" }));
  }

  const groups = m.state?.groups ?? {};
  const names = Object.keys(groups);
  groupsCard.append(el("div.dd-card__head", {}, el("span", { text: "Groups" }), el("span.dd-count", { text: String(names.length) })));
  groupsCard.append(names.length === 0 ? el("p.dd-card__body.dd-muted", { text: "No groups have been evaluated yet." }) :
    el("div.dd-table-wrap", { style: "border:0" }, el("table.dd-table", {},
      el("thead", {}, el("tr", {}, ["Status", "Group", "Last Triggered", "Last Resolved"].map((h) => el("th", { scope: "col", text: h })))),
      el("tbody", {}, names.map((g) => {
        const s = groups[g];
        return el("tr", {}, el("td", {}, statusPill(s.status)), el("td.dd-mono", { text: g }),
          el("td", { text: s.last_triggered_ts ? fmtAgo(s.last_triggered_ts) : "—" }), el("td", { text: s.last_resolved_ts ? fmtAgo(s.last_resolved_ts) : "—" }));
      })))));

  eventsCard.append(el("div.dd-card__head", {}, el("span", { text: "Events" }), el("span.dd-muted", { text: "Past 30 Days" })));
  const evBody = el("div", {}, el("p.dd-card__body.dd-muted", { text: "Loading events…" }));
  eventsCard.append(evBody);
  const EV_SERVER_PAGE = 1000, EV_SCREEN = 50;
  const evQuery = { start: Math.max(0, world.nowSec - 2592000), end: world.nowSec, tags: `monitor:${m.id}` };
  const evPages = new Map();
  let evMore = true;
  const loadEvents = async (index) => {
    const serverPage = Math.floor(index / EV_SERVER_PAGE);
    if (!evPages.has(serverPage)) {
      const v = await call("events.list", { ...evQuery, page: serverPage });
      evPages.set(serverPage, v.events ?? []);
    }
    const rows = evPages.get(serverPage);
    const last = evPages.get(Math.max(...evPages.keys()));
    evMore = last.length === EV_SERVER_PAGE;
    return rows;
  };
  const showEvents = (start) => loadEvents(start).then(async (rows) => {
    const local = start % EV_SERVER_PAGE;
    const slice = rows.slice(local, local + EV_SCREEN);
    const known = [...evPages.values()].reduce((sum, page) => sum + page.length, 0);
    const lastPage = Math.max(...evPages.keys());
    const hasNext = local + EV_SCREEN < rows.length || (rows.length === EV_SERVER_PAGE && evMore);
    if (start === 0 && slice.length === 0) {
      evBody.replaceChildren(emptyBlock("No events", "This monitor has not changed state in the past 30 days."));
      return;
    }
    const total = evMore ? `${known}+` : String((lastPage * EV_SERVER_PAGE) + evPages.get(lastPage).length);
    evBody.replaceChildren(
      el("ul.dd-timeline", {}, slice.map((e) => el("li", {}, el("span.dd-timeline__bar", { class: `dd-timeline__bar dd-bar--${e.alert_type}` }), el("span.dd-muted", { text: `${fmtDate(e.date_happened)} UTC` }), el("span", { text: e.title })))),
      pager(`${start + 1}–${start + slice.length} of ${total}`, start > 0, hasNext, (delta) => {
        evBody.setAttribute("aria-busy", "true");
        showEvents(Math.max(0, start + delta * EV_SCREEN)).finally(() => evBody.removeAttribute("aria-busy"));
      }),
      el("p.dd-card__body", {}, el("a", { href: `#/event/explorer?tags=${encodeURIComponent(`monitor:${m.id}`)}`, text: "View all in Event Explorer" })));
  }).catch((error) => evBody.replaceChildren(banner("error", describeError(error))));
  showEvents(0);
}

function properties(m) {
  const t = m.options?.thresholds ?? {};
  return el("aside.dd-card", { "aria-label": "Monitor properties" },
    el("div.dd-card__head", {}, "Properties"),
    el("div.dd-card__body", { style: "display:flex;flex-direction:column;gap:12px" },
      el("div", {}, el("div.dd-label", { text: "Query" }), el("div.dd-query", { text: m.query })),
      el("dl.dd-kv", {},
        el("dt", { text: "Type" }), el("dd", { text: typeLabel(m.type) }),
        el("dt", { text: "Critical" }), el("dd", { text: t.critical ?? "—" }),
        el("dt", { text: "Warning" }), el("dd", { text: t.warning ?? "—" }),
        el("dt", { text: "Notify no data" }), el("dd", { text: m.options?.notify_no_data ? `Yes, after ${m.options.no_data_timeframe ?? "—"}m` : "No" }),
        el("dt", { text: "Renotify" }), el("dd", { text: m.options?.renotify_interval ? `Every ${m.options.renotify_interval}m` : "Never" })),
      el("div", {}, el("div.dd-label", { text: "Message" }), el("pre.dd-message", { text: m.message || "No message" })),
      el("div", {}, el("div.dd-label", { text: "Tags" }), m.tags.length ? el("div.dd-tags", {}, m.tags.map((tag) => el("a.dd-tag", { href: "#/monitors/manage", text: tag }))) : el("span.dd-muted", { text: "No tags" }))));
}

export function extractMetricQuery(query) {
  const match = /^\s*[a-z_]+\(last_\w+\)\s*:\s*(.+?)\s*(?:[<>]=?|==)\s*-?[\d.]+\s*$/i.exec(String(query ?? ""));
  return match ? match[1] : null;
}

async function deleteMonitor(m, btn) {
  const ok = await confirmDialog({ title: "Delete monitor", message: `Delete "${m.name}"? This cannot be undone.`, confirmLabel: "Delete", danger: true });
  if (!ok) return;
  btn.disabled = true;
  try {
    await call("monitors.delete", { monitor_id: String(m.id) }, { mutate: true });
    toast("Monitor deleted");
    location.hash = "#/monitors/manage";
  } catch (error) {
    btn.disabled = false;
    if (/referenced|composite/i.test(error.message) && error.code.includes("BAD_REQUEST")) {
      const force = await confirmDialog({ title: "Monitor is used by a composite", message: `${error.message} Delete it anyway?`, confirmLabel: "Force delete", danger: true });
      if (!force) return;
      try { await call("monitors.delete", { monitor_id: String(m.id), force: "true" }, { mutate: true }); toast("Monitor deleted"); location.hash = "#/monitors/manage"; }
      catch (e2) { toast(describeError(e2), "error"); }
      return;
    }
    toast(describeError(error), "error");
  }
}
