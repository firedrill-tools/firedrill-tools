// Incident page: IR number and title, state and severity dropdowns, commander, customer impact, timing, Resolve.
import { call, canWrite, el, fmtDate, isoToSec, world, describeError } from "./ui.js";
import { icon } from "./icons.js";
import { banner, confirmDialog, errorBlock, toast } from "./feedback.js";
import { pageHeader } from "./header.js";
import { SEVERITIES, humanDuration, sevLabel, stateChip } from "./incidents.js";
import { initials } from "./nav.js";

export async function renderIncident(main, rerender, { args }) {
  let res;
  try { res = await call("incidents.get", { incident_id: args[0], include: "users" }); }
  catch (error) { main.append(pageHeader({ crumbs: [["Incidents", "#/incidents"]], title: "Incident" }), errorBlock(error, rerender)); return; }
  const inc = res.data;
  const a = inc.attributes;
  const users = new Map((res.included ?? []).filter((u) => u.type === "users").map((u) => [u.id, u.attributes]));
  const commanderId = inc.relationships?.commander_user?.data?.id ?? null;
  const commander = commanderId ? users.get(commanderId) : null;
  const creator = users.get(inc.relationships?.created_by_user?.data?.id);
  const writable = canWrite("incidents");
  const key = crypto.randomUUID();

  const update = async (data, message, control) => {
    if (control) control.disabled = true;
    try {
      await call("incidents.update", { incident_id: inc.id, data: { type: "incidents", ...data } }, { mutate: true, key: crypto.randomUUID() });
      toast(message);
      rerender();
    } catch (error) { if (control) control.disabled = false; toast(describeError(error), "error"); rerender(); }
  };

  const stateSel = el("select.dd-select", { id: "inc-state", disabled: !writable }, ["active", "stable", "resolved"].map((s) => el("option", { value: s, text: s[0].toUpperCase() + s.slice(1) })));
  stateSel.value = a.state;
  stateSel.addEventListener("change", async () => {
    const next = stateSel.value;
    if (next === "resolved" && !(await confirmDialog({ title: "Resolve incident", message: `Mark IR-${a.public_id} as resolved?`, confirmLabel: "Resolve" }))) { stateSel.value = a.state; return; }
    void update({ attributes: { fields: { state: { type: "dropdown", value: next } } } }, `State changed to ${next}`, stateSel);
  });
  const sevSel = el("select.dd-select", { id: "inc-severity", disabled: !writable }, SEVERITIES.map((s) => el("option", { value: s, text: s === "UNKNOWN" ? "Unknown" : s })));
  sevSel.value = a.severity;
  sevSel.addEventListener("change", () => void update({ attributes: { fields: { severity: { type: "dropdown", value: sevSel.value } } } }, `Severity changed to ${sevSel.value}`, sevSel));
  const me = world.org?.user;
  const cmdBtn = commanderId && commanderId === me?.uuid
    ? el("button.dd-btn.dd-btn--sm", { type: "button", disabled: !writable, on: { click: (e) => void update({ relationships: { commander_user: { data: null } } }, "Commander removed", e.currentTarget) } }, "Unassign")
    : el("button.dd-btn.dd-btn--sm", { type: "button", disabled: !writable || !me?.uuid, on: { click: (e) => void update({ relationships: { commander_user: { data: { type: "users", id: me.uuid } } } }, "You are now the Incident Commander", e.currentTarget) } }, "Assign to me");
  const resolveBtn = a.state === "resolved" ? null : el("button.dd-btn.dd-btn--primary", { type: "button", disabled: !writable, on: { click: async (e) => {
    const btn = e.currentTarget;
    if (await confirmDialog({ title: "Resolve incident", message: `Mark IR-${a.public_id} as resolved?`, confirmLabel: "Resolve" })) void update({ attributes: { fields: { state: { type: "dropdown", value: "resolved" } } } }, "Incident resolved", btn);
  } } }, icon("check"), "Resolve");

  main.append(
    pageHeader({ crumbs: [["Incidents", "#/incidents"], [`IR-${a.public_id}`, null]], title: el("span", { style: "display:flex;align-items:center;gap:10px;min-width:0" }, el("span.dd-mono.dd-muted", { text: `IR-${a.public_id}` }), el("span.dd-truncate", { text: a.title }), stateChip(a.state), a.is_test ? el("span.dd-tag", { text: "Test" }) : null), actions: [
      el("button.dd-btn", { type: "button", dataset: { notsim: "Incident notifications" } }, icon("bell"), "Notify"),
      el("button.dd-btn", { type: "button", dataset: { notsim: "Incident Slack channel" } }, icon("external"), "Open Slack Channel"),
      resolveBtn,
    ] }),
    el("nav.dd-tabs", { "aria-label": "Incident sections" }, el("a", { href: `#/incidents/${inc.id}`, "aria-current": "page" }, "Overview"),
      ["Timeline", "Remediation", "Notifications", "Postmortem"].map((t) => el("button", { type: "button", dataset: { notsim: `Incident ${t}` } }, t))));
  if (!writable) main.append(banner("info", "You have the Datadog Read Only Role: this incident can be viewed but not updated."));
  main.append(el("div.dd-inc-hero", {}, el("div.dd-inc-hero__meta", {},
    el("label", { for: "inc-state" }, "State", stateSel),
    el("label", { for: "inc-severity" }, "Severity", sevSel),
    el("div", { style: "display:flex;flex-direction:column;gap:3px" }, el("span.dd-label", { style: "font-size:11px;text-transform:uppercase;color:var(--text-3)", text: "Incident Commander" }),
      el("span", { style: "display:flex;align-items:center;gap:8px" }, commander ? [el("span.dd-avatar", { "aria-hidden": "true", text: initials(commander.name) }), el("span", { text: commander.name })] : el("span.dd-muted", { text: "Unassigned" }), cmdBtn)))));

  const created = isoToSec(a.created);
  const resolved = isoToSec(a.resolved);
  const impactStart = isoToSec(a.customer_impact_start);
  const impactEnd = isoToSec(a.customer_impact_end);
  main.append(el("div.dd-body", {}, el("div.dd-grid2", {},
    el("section.dd-card", { "aria-label": "Customer impact" }, el("div.dd-card__head", {}, "Customer Impact", el("span.dd-card__head-spacer"), a.customer_impacted ? el("span.dd-state-chip.dd-state-chip--active", { text: "Customers impacted" }) : el("span.dd-muted", { text: "No customer impact" })),
      el("div.dd-card__body", {}, a.customer_impacted ? el("dl.dd-kv", {},
        el("dt", { text: "Scope" }), el("dd", { text: a.customer_impact_scope ?? "—" }),
        el("dt", { text: "Impact start" }), el("dd", { text: impactStart ? `${fmtDate(impactStart, { year: true })} UTC` : "—" }),
        el("dt", { text: "Impact end" }), el("dd", { text: impactEnd ? `${fmtDate(impactEnd, { year: true })} UTC` : "Ongoing" }),
        el("dt", { text: "Duration" }), el("dd", { text: impactStart ? humanDuration((impactEnd ?? world.nowSec) - impactStart) : "—" })) : el("p.dd-muted", { style: "margin:0", text: "This incident has not been marked as impacting customers." }))),
    el("aside.dd-card", { "aria-label": "Incident properties" }, el("div.dd-card__head", {}, "Properties"), el("div.dd-card__body", {}, el("dl.dd-kv", {},
      el("dt", { text: "Declared" }), el("dd", { text: created ? `${fmtDate(created, { year: true })} UTC` : "—" }),
      el("dt", { text: "Declared by" }), el("dd", { text: creator?.name ?? "—" }),
      el("dt", { text: "Detected" }), el("dd", { text: isoToSec(a.detected) ? `${fmtDate(isoToSec(a.detected), { year: true })} UTC` : "—" }),
      el("dt", { text: "Resolved" }), el("dd", { text: resolved ? `${fmtDate(resolved, { year: true })} UTC` : "—" }),
      el("dt", { text: "Time to resolve" }), el("dd", { text: a.time_to_resolve ? humanDuration(a.time_to_resolve) : created ? `${humanDuration(world.nowSec - created)} (open)` : "—" }),
      el("dt", { text: "Visibility" }), el("dd", { text: a.visibility ?? "organization" }),
      el("dt", { text: "Notified" }), el("dd", {}, (a.notification_handles ?? []).length ? a.notification_handles.map((h) => el("span.dd-tag", { style: "margin:0 4px 4px 0", text: h.display_name ?? h.handle })) : el("span.dd-muted", { text: "No one" }))))))));
  void key;
}
