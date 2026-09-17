// Home portlets that are part of the real NetSuite frame but carry no simulated records: the Navigation portlet
// (the menu tree, live for the pages this Tool serves), the Calendar (a month grid on the account date, with no
// events because activities are not simulated) and the Tasks / Phone Calls activity lists. Nothing here invents
// data: every list says plainly that the feature is outside this Tool's scope.
import { app } from "../store.js";
import { el, icon, dayNum } from "../ui.js";
import { notSimulated } from "../overlay.js";
import { MENUS } from "../menus.js";
import { nsButton } from "./common.js";

const NAV_MENUS = ["Transactions", "Lists", "Reports", "Analytics", "Setup"];

function navEntry(menu, entry) {
  if (entry.run) return el("li", {}, el("button", { type: "button", class: "nav-link", text: entry.label, onclick: entry.run }));
  return el("li", {}, el("button", { type: "button", class: "nav-link off", text: entry.label, onclick: () => notSimulated(`${menu} › ${entry.label}`) }));
}

/** Navigation portlet: one collapsible branch per menu, the first branch open, each leaf routed or "not simulated". */
export function navigationBody() {
  const branches = NAV_MENUS.filter((name) => MENUS[name]).map((name, index) => {
    const leaves = MENUS[name].filter((entry) => entry.label);
    const list = el("ul", { class: "nav-tree", hidden: index !== 0 }, leaves.map((entry) => navEntry(name, entry)));
    const toggle = el("button", {
      type: "button", class: "nav-branch", "aria-expanded": index === 0 ? "true" : "false",
      onclick: () => { const open = list.hidden; list.hidden = !open; toggle.setAttribute("aria-expanded", String(open)); },
    }, [icon("chevron", 12), el("span", { text: name }), el("span", { class: "muted", text: `(${leaves.length})` })]);
    return el("li", {}, [toggle, list]);
  });
  return el("ul", { class: "nav-root" }, branches);
}

const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Calendar portlet: the month that contains the account date, today highlighted; events are not simulated. */
export function calendarBody() {
  const today = dayNum(app.today);
  if (Number.isNaN(today)) return el("p", { class: "muted", text: "The account date is unavailable, so the calendar cannot be drawn." });
  const [y, m] = app.today.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < first.getUTCDay(); i += 1) cells.push(el("td", { class: "pad" }));
  for (let day = 1; day <= daysInMonth; day += 1) {
    const isToday = dayNum(`${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`) === today;
    cells.push(el("td", { class: isToday ? "today" : "", text: String(day), "aria-current": isToday ? "date" : undefined }));
  }
  while (cells.length % 7 !== 0) cells.push(el("td", { class: "pad" }));
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(el("tr", {}, cells.slice(i, i + 7)));
  return [
    el("div", { class: "cal-head" }, [
      el("strong", { text: `${MONTHS[m - 1]} ${y}` }),
      el("span", { class: "muted", text: "Account date" }),
    ]),
    el("table", { class: "cal" }, [
      el("thead", {}, el("tr", {}, DOW.map((d, i) => el("th", { text: d, "aria-label": ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][i] })))),
      el("tbody", {}, rows),
    ]),
    el("p", { class: "muted", text: "Events, tasks and phone calls are not simulated by this Tool, so the calendar shows no entries." }),
    el("div", { class: "btn-row" }, [nsButton("New Event"), nsButton("View Calendar")]),
  ];
}

/** Tasks and Phone Calls: the activity portlets a daily user sees, rendered as documented not-simulated lists. */
export function activityBody(kind) {
  const singular = kind === "Tasks" ? "Task" : "Phone Call";
  return [
    el("table", { class: "search-results" }, [
      el("thead", {}, el("tr", {}, ["Date", "Title", "Status", "Priority"].map((h) => el("th", { text: h })))),
      el("tbody", {}, el("tr", {}, el("td", { colspan: "4", class: "muted", text: `${kind} are not simulated by this Tool; this list is intentionally empty.` }))),
    ]),
    el("div", { class: "btn-row" }, [nsButton(`New ${singular}`), nsButton(`View All ${kind}`)]),
  ];
}
