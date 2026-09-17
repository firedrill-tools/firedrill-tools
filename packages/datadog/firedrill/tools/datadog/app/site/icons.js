// Monochrome 16px stroke-style glyphs in the style of Datadog's navigation and toolbar icons (drawn for this app).
const NS = "http://www.w3.org/2000/svg";
const P = {
  search: "M7 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11zM11 11l3.5 3.5",
  recent: "M8 14.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM8 4.5V8l2.5 1.5",
  bits: "M3 5.5l5-3 5 3v5l-5 3-5-3zM6.5 7.5h.01M9.5 7.5h.01M6.5 10h3",
  watchdog: "M2.5 8.5c1.5-3 3.5-4.5 5.5-4.5s4 1.5 5.5 4.5c-1.5 2.5-3.5 3.5-5.5 3.5s-4-1-5.5-3.5zM8 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  service: "M2.5 3.5h11v3h-11zM2.5 9.5h11v3h-11zM4.5 5h.01M4.5 11h.01",
  infra: "M2 13.5h12M3.5 13.5V6l4.5-3 4.5 3v7.5M6.5 13.5v-4h3v4",
  apm: "M1.5 8h3l1.5-4 3 8 1.5-4h4",
  dx: "M2 3h12v8.5H2zM5.5 14h5M8 11.5V14",
  delivery: "M2.5 13.5l3-3M6 5l5-3.5 1.5 1.5L9 8M6 5l-3 .5L2 7l3 1M9 8l-.5 3-1.5 1-1-3M5 8l3 3",
  security: "M8 1.5l5.5 2v4c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7v-4z",
  metrics: "M2 13.5h12M3.5 11l3-4 2.5 2 4-5.5",
  logs: "M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h8",
  dashboards: "M2 2.5h5v6H2zM9 2.5h5v3H9zM9 7.5h5v6H9zM2 10.5h5v3H2z",
  monitors: "M8 1.5c-2.5 0-4.5 2-4.5 4.5v3L2 11.5h12L12.5 9V6c0-2.5-2-4.5-4.5-4.5zM6.5 13.5a1.5 1.5 0 0 0 3 0",
  integrations: "M6 2v3M10 2v3M4 5h8v2.5a4 4 0 0 1-8 0zM8 11.5V14",
  help: "M8 14.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM6.2 6a1.9 1.9 0 0 1 3.6.8c0 1.3-1.8 1.6-1.8 2.7M8 11.5h.01",
  settings: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  incidents: "M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5h.01",
  events: "M2.5 4h11M2.5 8h11M2.5 12h11M5 2.5v3M9.5 6.5v3M7 10.5v3",
  notebooks: "M3.5 1.5h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-8zM6 1.5v13M8 5h3",
  chevronDown: "M4 6l4 4 4-4",
  chevronRight: "M6 4l4 4-4 4",
  chevronLeft: "M10 4L6 8l4 4",
  close: "M4 4l8 8M12 4l-8 8",
  plus: "M8 3v10M3 8h10",
  clock: "M8 14.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM8 4.5V8h3",
  pause: "M5.5 3.5v9M10.5 3.5v9",
  share: "M10 2.5h3.5V6M13.5 2.5L8 8M12 9.5v4H2.5V4h4",
  edit: "M10.5 2.5l3 3-8 8h-3v-3z",
  trash: "M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  mute: "M2 6h3l4-3v10l-4-3H2zM11 6l3 4M14 6l-3 4",
  unmute: "M2 6h3l4-3v10l-4-3H2zM11.5 5.5a3.5 3.5 0 0 1 0 5",
  star: "M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6z",
  gear: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2",
  filter: "M2 3h12L9.5 8.5V13l-3 1.5v-6z",
  refresh: "M13 3v3.5H9.5M3 13V9.5h3.5M12.6 6.5A5 5 0 0 0 3.5 5M3.4 9.5a5 5 0 0 0 9.1 1.5",
  lock: "M4 7h8v7H4zM5.5 7V5a2.5 2.5 0 0 1 5 0v2",
  info: "M8 14.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM8 7.5v4M8 5h.01",
  external: "M9.5 2.5h4v4M13.5 2.5L7 9M11.5 9.5v4h-9v-9h4",
  bell: "M8 1.5c-2.5 0-4.5 2-4.5 4.5v3L2 11.5h12L12.5 9V6c0-2.5-2-4.5-4.5-4.5z",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  kebab: "M8 3.5h.01M8 8h.01M8 12.5h.01",
  check: "M3 8.5l3 3 7-7",
  collapse: "M9.5 3.5L5 8l4.5 4.5M13 3v10",
  user: "M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 14.5c.5-3 2.8-4.5 5.5-4.5s5 1.5 5.5 4.5",
};

export function icon(name, { size = 16, cls = "", label } = {}) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.3");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", `dd-icon ${cls}`.trim());
  if (label) { svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label); } else svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", P[name] ?? P.info);
  svg.append(path);
  return svg;
}

/** Replace <span data-icon="name"> placeholders in static HTML. */
export function hydrateIcons(root = document) {
  for (const span of root.querySelectorAll("[data-icon]")) {
    if (span.firstChild) continue;
    span.append(icon(span.dataset.icon, { size: Number(span.dataset.size ?? 16) }));
  }
}
