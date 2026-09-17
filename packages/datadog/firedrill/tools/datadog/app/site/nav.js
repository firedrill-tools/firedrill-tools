// Persistent Datadog chrome: left navigation with hover flyouts, the "not simulated" panel for products outside
// this Tool, the page header helper and the time picker (relative to world virtual time).
import { $, clear, el, world } from "./ui.js";
import { icon } from "./icons.js";
import { closeModal, openModal } from "./feedback.js";

const NS = null; // marks an entry as not simulated
const NAV = {
  "nav-top": [
    { id: "recent", label: "Recent", icon: "recent", items: [["Monitors", "#/monitors/manage"], ["Dashboards", "#/dashboard/lists"], ["Incidents", "#/incidents"]] },
    { id: "bits", label: "Bits AI", icon: "bits", items: [["Bits AI Chat", NS], ["Bits AI SRE", NS]] },
    { id: "watchdog", label: "Watchdog", icon: "watchdog", items: [["Alerts", NS], ["Impact Analysis", NS]] },
  ],
  "nav-products": [
    { id: "service", label: "Service Mgmt", icon: "service", items: [["Incidents", "#/incidents"], ["Event Management", "#/event/explorer"], ["On-Call", NS], ["Case Management", NS], ["Status Pages", NS], ["Workflow Automation", NS]] },
    { id: "infra", label: "Infrastructure", icon: "infra", items: [["Infrastructure List", NS], ["Host Map", NS], ["Containers", NS], ["Kubernetes", NS], ["Serverless", NS], ["Network", NS]] },
    { id: "apm", label: "APM", icon: "apm", items: [["Software Catalog", NS], ["Traces", NS], ["Service Map", NS], ["Profiles", NS], ["Database Monitoring", NS]] },
    { id: "dx", label: "Digital Experience", icon: "dx", items: [["Real User Monitoring", NS], ["Session Replay", NS], ["Synthetic Tests", NS], ["Product Analytics", NS]] },
    { id: "delivery", label: "Software Delivery", icon: "delivery", items: [["CI Visibility", NS], ["Test Optimization", NS], ["Code Security", NS]] },
    { id: "security", label: "Security", icon: "security", items: [["Cloud SIEM", NS], ["Cloud Security", NS], ["App and API Protection", NS]] },
  ],
  "nav-data": [
    { id: "metrics", label: "Metrics", icon: "metrics", href: "#/metric/explorer", items: [["Explorer", "#/metric/explorer"], ["Summary", "#/metric/summary"], ["Volume", NS], ["Distribution Metrics", NS]] },
    { id: "logs", label: "Logs", icon: "logs", items: [["Explorer", NS], ["Patterns", NS], ["Pipelines", NS], ["Live Tail", NS]] },
  ],
  "nav-tools": [
    { id: "dashboards", label: "Dashboards", icon: "dashboards", href: "#/dashboard/lists", items: [["Dashboard List", "#/dashboard/lists"], ["New Dashboard", "#/dashboard/lists?new=1"], ["Notebooks", NS], ["Sheets", NS], ["Shared Dashboards", NS]] },
    { id: "monitors", label: "Monitors", icon: "monitors", href: "#/monitors/manage", items: [["Monitors List", "#/monitors/manage"], ["New Monitor", "#/monitors/create"], ["Downtimes", NS], ["SLOs", NS], ["Monitor Settings", NS]] },
    { id: "integrations", label: "Integrations", icon: "integrations", items: [["Integrations", NS], ["Agent", NS], ["APIs", NS], ["Marketplace", NS]] },
  ],
  "nav-bottom": [
    { id: "help", label: "Help", icon: "help", items: [["Documentation", NS], ["Support", NS], ["What's New", NS]] },
    { id: "settings", label: "Organization Settings", icon: "settings", items: [["Users", NS], ["Roles", NS], ["API Keys", NS], ["Application Keys", NS]] },
    { id: "user", label: "", icon: "user", items: [] },
  ],
};

export function notSimulated(feature) {
  openModal({
    title: feature,
    width: 460,
    body: el("div.dd-notsim", {},
      el("div.dd-state__art", { "aria-hidden": "true" }, icon("info", { size: 28 })),
      el("p", { text: `${feature} is not simulated by this Tool.` }),
      el("p.dd-muted", { text: "This synthetic Datadog organization covers Monitors, Events, Metrics (Explorer and Summary), Dashboards and Incidents. Nothing here reaches a real Datadog account." })),
    footer: [el("button.dd-btn.dd-btn--primary", { type: "button", on: { click: closeModal } }, "Got it")],
  });
}

let flyoutTimer = null;
function showFlyout(entry, button) {
  const fly = $("#nav-flyout");
  clearTimeout(flyoutTimer);
  clear(fly);
  for (const b of document.querySelectorAll(".dd-nav__item[aria-expanded]")) b.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-expanded", "true");
  const title = entry.id === "user" ? (world.org?.user?.name ?? "User") : entry.label;
  fly.append(el("h4", { text: title }));
  if (entry.id === "user") {
    const u = world.org?.user;
    fly.append(el("div.dd-flyout__user", {}, el("div", { text: u?.handle ?? "" }), el("div.dd-muted", { text: `${u?.role ?? ""} · ${world.org?.org?.name ?? ""}` })));
  }
  for (const [label, href] of entry.items) {
    if (href) fly.append(el("a", { href, on: { click: hideFlyout } }, label));
    else fly.append(el("button", { type: "button", on: { click: () => { hideFlyout(); notSimulated(label); } } }, el("span", { text: label }), el("span.dd-flyout__ns", { text: "Not simulated" })));
  }
  const rect = button.getBoundingClientRect();
  fly.hidden = false;
  fly.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - fly.offsetHeight - 8))}px`;
}
function hideFlyout() {
  $("#nav-flyout").hidden = true;
  for (const b of document.querySelectorAll(".dd-nav__item[aria-expanded]")) b.setAttribute("aria-expanded", "false");
}
const scheduleHide = () => { flyoutTimer = setTimeout(hideFlyout, 180); };

export function renderNav() {
  const top = $("#nav-top");
  const search = el("button.dd-nav__search", { type: "button", "aria-label": "Search Datadog", on: { click: () => notSimulated("Global search") } }, icon("search"), el("span", { text: "Go to…" }), el("kbd", { text: "⌘K" }));
  top.before(search);
  for (const [groupId, entries] of Object.entries(NAV)) {
    const list = $(`#${groupId}`);
    for (const entry of entries) {
      const label = entry.id === "user" ? (world.org?.user?.name ?? "User") : entry.label;
      const inner = [entry.id === "user" ? el("span.dd-avatar", { "aria-hidden": "true", text: initials(label) }) : icon(entry.icon), el("span", { text: label })];
      const attrs = { "aria-haspopup": "true", "aria-expanded": "false", dataset: { nav: entry.id }, title: label };
      const node = entry.href ? el("a.dd-nav__item", { href: entry.href, ...attrs }, inner) : el(`button.dd-nav__item${entry.id === "user" ? ".dd-nav__user" : ""}`, { type: "button", ...attrs }, inner);
      node.addEventListener("mouseenter", () => showFlyout(entry, node));
      node.addEventListener("mouseleave", scheduleHide);
      node.addEventListener("focus", () => showFlyout(entry, node));
      if (!entry.href) node.addEventListener("click", () => showFlyout(entry, node));
      list.append(el("li", {}, node));
    }
  }
  const fly = $("#nav-flyout");
  fly.addEventListener("mouseenter", () => clearTimeout(flyoutTimer));
  fly.addEventListener("mouseleave", scheduleHide);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideFlyout(); });
}
export function setActiveNav(id) {
  for (const node of document.querySelectorAll(".dd-nav__item")) {
    if (node.dataset.nav === id) node.setAttribute("aria-current", "page"); else node.removeAttribute("aria-current");
  }
}
export const initials = (name) => String(name ?? "?").split(/[\s.@]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";
