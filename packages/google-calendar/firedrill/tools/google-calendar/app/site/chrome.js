// Persistent Google Calendar chrome that sits around the Tool's own screens: the Calendar/Tasks switch, Google apps,
// the side panel, people search, booking pages, and the display palette. Controls outside the Tool's scope render in
// place and open a short "not simulated" card; nothing here writes world state.
import { icon } from "./icons.js";
import { $, el, openMenu, closeMenus } from "./ui.js";

// The Calendar API still reports the legacy calendar/event colour hexes; the web client paints the matching named
// colour of its current palette. This is a display mapping only; stored colours are never changed.
const WEB_PALETTE = {
  "#ac725e": "#795548", "#d06b64": "#e67c73", "#f83a22": "#d50000", "#fa573c": "#f4511e", "#ff7537": "#ef6c00",
  "#ffad46": "#f09300", "#42d692": "#009688", "#16a765": "#0b8043", "#7bd148": "#7cb342", "#b3dc6c": "#c0ca33",
  "#fbe983": "#e4c441", "#fad165": "#f6bf26", "#92e1c0": "#33b679", "#9fe1e7": "#039be5", "#9fc6e7": "#4285f4",
  "#4986e7": "#3f51b5", "#9a9cff": "#7986cb", "#b99aff": "#b39ddb", "#c2c2c2": "#616161", "#cabdbf": "#a79b8e",
  "#cca6ac": "#ad1457", "#f691b2": "#d81b60", "#cd74e6": "#8e24aa", "#a47ae2": "#9e69af",
  // event colours 1-11
  "#a4bdfc": "#7986cb", "#7ae7bf": "#33b679", "#dbadff": "#8e24aa", "#ff887c": "#e67c73", "#fbd75b": "#f6bf26",
  "#ffb878": "#f4511e", "#46d6db": "#039be5", "#e1e1e1": "#616161", "#5484ed": "#3f51b5", "#51b749": "#0b8043",
  "#dc2127": "#d50000",
};
const PALETTE_NAME = {
  "#795548": "Cocoa", "#e67c73": "Flamingo", "#d50000": "Tomato", "#f4511e": "Tangerine", "#ef6c00": "Pumpkin",
  "#f09300": "Mango", "#009688": "Eucalyptus", "#0b8043": "Basil", "#7cb342": "Pistachio", "#c0ca33": "Avocado",
  "#e4c441": "Citron", "#f6bf26": "Banana", "#33b679": "Sage", "#039be5": "Peacock", "#4285f4": "Cobalt",
  "#3f51b5": "Blueberry", "#7986cb": "Lavender", "#b39ddb": "Wisteria", "#616161": "Graphite", "#a79b8e": "Birch",
  "#ad1457": "Radicchio", "#d81b60": "Cherry blossom", "#8e24aa": "Grape", "#9e69af": "Amethyst",
};

export function displayColor(hex) {
  const value = String(hex ?? "").toLowerCase();
  return WEB_PALETTE[value] ?? (value || "#039be5");
}
export const colorName = (hex) => PALETTE_NAME[displayColor(hex)] ?? displayColor(hex);

/** A small card anchored to a control that the Tool does not simulate. */
export function notSimulated(anchor, title, detail) {
  const card = el("div", { class: "gc-ns-card", attrs: { role: "dialog", "aria-label": title } });
  card.append(el("div", { class: "gc-ns-head" }, [icon("info"), el("strong", { text: title })]));
  card.append(el("p", { text: detail ?? "Not simulated by this Tool. The synthetic Google Calendar models calendars, events, sharing and free/busy only." }));
  const ok = el("button", { class: "gc-text-btn gc-text-btn-primary", text: "OK", attrs: { type: "button" } });
  ok.addEventListener("click", () => closeMenus());
  card.append(el("div", { class: "gc-ns-actions" }, [ok]));
  openMenu(anchor, card, { align: "end", className: "gc-menu-wide gc-ns-menu" });
}

const SIDE_APPS = [
  ["lightbulb", "Keep", "Google Keep notes are not simulated by this Tool."],
  ["task_alt", "Tasks", "Google Tasks are not simulated by this Tool; the Calendar API has no task resource."],
  ["contacts", "Contacts", "Google Contacts are not simulated by this Tool."],
  ["map", "Maps", "Google Maps is not simulated by this Tool; event locations stay plain text."],
];

function sideButton(glyph, label, detail) {
  const button = el("button", { class: "gc-side-app", title: label, attrs: { type: "button", "aria-label": label } });
  button.append(icon(glyph));
  button.addEventListener("click", () => notSimulated(button, label, detail));
  return button;
}

/** Build the right side panel and wire the header and sidebar controls that are outside the Tool's scope. */
export function mountChrome() {
  const panel = $("#side-panel");
  if (panel) {
    const apps = el("div", { class: "gc-side-apps" });
    for (const [glyph, label, detail] of SIDE_APPS) apps.append(sideButton(glyph, label, detail));
    apps.append(el("div", { class: "gc-side-divider", attrs: { role: "separator" } }));
    apps.append(sideButton("add", "Get add-ons", "Google Workspace Marketplace add-ons are not simulated by this Tool."));
    const hide = el("button", { class: "gc-side-app gc-side-hide", title: "Hide side panel", attrs: { type: "button", "aria-label": "Hide side panel", "aria-expanded": "true" } });
    hide.append(icon("expand_panel"));
    hide.addEventListener("click", () => {
      const closed = document.getElementById("app").classList.toggle("side-panel-closed");
      hide.setAttribute("aria-expanded", String(!closed));
      hide.title = closed ? "Show side panel" : "Hide side panel";
      hide.setAttribute("aria-label", hide.title);
    });
    panel.replaceChildren(apps, hide);
  }
  $("#tasks-switch")?.addEventListener("click", (event) => notSimulated(event.currentTarget, "Tasks", "Google Tasks are not simulated by this Tool; only the Calendar side of this switch works."));
  $("#calendar-switch")?.addEventListener("click", () => {});
  $("#apps-btn")?.addEventListener("click", (event) => notSimulated(event.currentTarget, "Google apps", "Other Google apps are not part of this synthetic world."));
  $("#people-search")?.addEventListener("click", (event) => {
    notSimulated(event.currentTarget, "Search for people", "Looking up other people's calendars from the directory is not simulated. Use Other calendars + to open a calendar shared with you, or Find a time in the event editor.");
  });
  $("#booking-add")?.addEventListener("click", (event) => notSimulated(event.currentTarget, "Booking pages", "Appointment schedules and booking pages are not simulated by this Tool."));
}
