// Page header (breadcrumbs, title, actions) and the Datadog time picker bound to world virtual time.
import { el, world } from "./ui.js";
import { icon } from "./icons.js";

export const RANGES = [
  { key: "15m", abbr: "15m", label: "Past 15 Minutes", seconds: 900 },
  { key: "1h", abbr: "1h", label: "Past 1 Hour", seconds: 3600 },
  { key: "4h", abbr: "4h", label: "Past 4 Hours", seconds: 14400 },
  { key: "1d", abbr: "1d", label: "Past 1 Day", seconds: 86400 },
  { key: "2d", abbr: "2d", label: "Past 2 Days", seconds: 172800 },
  { key: "1w", abbr: "1w", label: "Past 1 Week", seconds: 604800 },
  { key: "1mo", abbr: "1mo", label: "Past 1 Month", seconds: 2592000 },
];
export const timeState = { key: "1h" };
export function currentRange() {
  const r = RANGES.find((x) => x.key === timeState.key) ?? RANGES[1];
  return { ...r, from: world.nowSec - r.seconds, to: world.nowSec };
}

export function timePicker(onChange, { allowed } = {}) {
  const options = allowed ? RANGES.filter((r) => allowed.includes(r.key)) : RANGES;
  if (!options.some((r) => r.key === timeState.key)) timeState.key = options[Math.min(1, options.length - 1)].key;
  const range = currentRange();
  const menu = el("div.dd-menu", { role: "menu", hidden: true });
  const btn = el("button.dd-timepicker__btn", { type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": `Time range: ${range.label}` },
    el("span.dd-timepicker__abbr", { text: range.abbr }), el("span", { text: range.label }), icon("chevronDown", { size: 12 }));
  for (const r of options) {
    menu.append(el("button", { type: "button", role: "menuitemradio", "aria-checked": String(r.key === range.key), on: { click: () => { timeState.key = r.key; close(); onChange(); } } },
      el("span.dd-timepicker__abbr", { text: r.abbr }), el("span", { text: r.label })));
  }
  const wrap = el("div.dd-timepicker", {}, btn, menu);
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); document.removeEventListener("mousedown", outside); };
  const outside = (e) => { if (!wrap.contains(e.target)) close(); };
  btn.addEventListener("click", () => {
    if (!menu.hidden) return close();
    menu.hidden = false; btn.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", outside);
  });
  menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { close(); btn.focus(); } });
  const live = el("button.dd-btn.dd-btn--icon", { type: "button", "aria-label": "Paused at world time", title: "Time is the world's virtual clock" }, icon("pause"));
  return el("div.dd-timectl", {}, wrap, live);
}

/** header({ crumbs: [[label, href]], title: string|node, badge, actions: [nodes] }) */
export function pageHeader({ crumbs = [], title, before, actions = [] }) {
  const crumbNodes = [];
  crumbs.forEach(([label, href], i) => {
    if (i > 0) crumbNodes.push(icon("chevronRight", { size: 10 }));
    crumbNodes.push(href ? el("a", { href, text: label }) : el("span", { text: label }));
  });
  return el("header.dd-page-header", {},
    el("div.dd-page-header__main", {},
      crumbNodes.length ? el("nav.dd-page-header__crumbs", { "aria-label": "Breadcrumb" }, crumbNodes) : null,
      el("h1.dd-page-header__title", {}, before ?? null, typeof title === "string" ? el("span.dd-truncate", { text: title }) : title)),
    el("div.dd-page-header__spacer"),
    el("div.dd-page-header__actions", {}, actions));
}
