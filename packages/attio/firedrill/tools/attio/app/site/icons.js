// 16 px line icons in the CRM's own visual language: 1.5 px rounded strokes on a 16-unit grid, monochrome,
// coloured by `currentColor`. Drawn as path data so the app ships no icon font and makes no remote requests.
const P = {
  search: "M7.25 12.5a5.25 5.25 0 1 0 0-10.5 5.25 5.25 0 0 0 0 10.5ZM14 14l-3-3",
  bell: "M4 6.5a4 4 0 0 1 8 0c0 2.6.7 4 1.5 4.75H2.5C3.3 10.5 4 9.1 4 6.5ZM6.5 13.5a1.6 1.6 0 0 0 3 0",
  tasks: "M3 2.75h10c.7 0 1.25.55 1.25 1.25v8c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25V4c0-.7.55-1.25 1.25-1.25ZM5.25 8l1.75 1.75L10.75 6",
  note: "M4 1.75h5.5L12.75 5v8.25c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1V2.75c0-.55.45-1 1-1ZM9.25 1.75V5.25h3.5M5.5 8.5h5M5.5 11h3.5",
  mail: "M2.5 3.25h11c.4 0 .75.35.75.75v8c0 .4-.35.75-.75.75h-11a.75.75 0 0 1-.75-.75V4c0-.4.35-.75.75-.75ZM2 4l6 4.5L14 4",
  phone: "M5.6 2.25 3.4 2.3c-.6 0-1.1.5-1.05 1.1.35 5.6 4.65 9.9 10.25 10.25.6.05 1.1-.45 1.1-1.05v-2.2l-2.75-1.1-1.3 1.3a7.2 7.2 0 0 1-3.25-3.25l1.3-1.3-1.1-2.8Z",
  reports: "M2.75 13.25V8.5M6.25 13.25V2.75M9.75 13.25V6M13.25 13.25V9.75",
  workflows: "M8.75 1.75 3.5 9h4l-.75 5.25L12.5 7h-4l.25-5.25Z",
  sequences: "M2 8h8.5M7.5 4.5 11 8l-3.5 3.5M13.75 3v10",
  chevronDown: "m4.5 6.25 3.5 3.5 3.5-3.5",
  chevronUp: "m4.5 9.75 3.5-3.5 3.5 3.5",
  chevronRight: "m6.25 4.5 3.5 3.5-3.5 3.5",
  chevronLeft: "m9.75 4.5-3.5 3.5 3.5 3.5",
  chevronsUpDown: "m5.25 6 2.75-2.75L10.75 6M5.25 10l2.75 2.75L10.75 10",
  sidebar: "M2.75 2.5h10.5c.4 0 .75.35.75.75v9.5c0 .4-.35.75-.75.75H2.75a.75.75 0 0 1-.75-.75v-9.5c0-.4.35-.75.75-.75ZM6.25 2.5v11",
  plus: "M8 3v10M3 8h10",
  filter: "M2.5 4h11M4.75 8h6.5M7 12h2",
  sort: "M5 2.75v10.5M2.5 10.75 5 13.25l2.5-2.5M11 13.25V2.75M8.5 5.25 11 2.75l2.5 2.5",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  star: "m8 2 1.8 3.7 4 .55-2.9 2.8.7 4L8 11.15 4.4 13.05l.7-4-2.9-2.8 4-.55L8 2Z",
  settings: "M8 10.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM6.9 1.75h2.2l.35 1.9 1.25.72 1.82-.65 1.1 1.9-1.47 1.26v1.44l1.47 1.26-1.1 1.9-1.82-.65-1.25.72-.35 1.9H6.9l-.35-1.9-1.25-.72-1.82.65-1.1-1.9 1.47-1.26V7.28L2.38 6.02l1.1-1.9 1.82.65 1.25-.72.35-1.9Z",
  help: "M8 14.25a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5ZM6.25 6.25a1.8 1.8 0 0 1 3.5.6c0 1.2-1.75 1.5-1.75 2.65M8 11.5h.01",
  user: "M8 7.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5ZM2.75 14c.4-2.6 2.6-4.25 5.25-4.25s4.85 1.65 5.25 4.25",
  users: "M6 7.25a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.5 13.5c.35-2.3 2.2-3.75 4.5-3.75s4.15 1.45 4.5 3.75M10.5 2.4a2.5 2.5 0 0 1 0 4.7M12.25 9.9c1.2.5 2 1.7 2.25 3.6",
  userPlus: "M6.5 7.25a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM2 13.5c.35-2.3 2.2-3.75 4.5-3.75 1 0 1.9.25 2.6.75M12.5 9v4.5M10.25 11.25h4.5",
  building: "M3 14V3c0-.55.45-1 1-1h5c.55 0 1 .45 1 1v11M10 6.5h2c.55 0 1 .45 1 1V14M1.75 14h12.5M5.25 4.75h2M5.25 7.25h2M5.25 9.75h2",
  deals: "M8 14.25a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5ZM8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 8h.01",
  list: "M5.75 4h7.5M5.75 8h7.5M5.75 12h7.5M2.75 4h.01M2.75 8h.01M2.75 12h.01",
  kanban: "M2.75 2.5h2.5v11h-2.5zM6.75 2.5h2.5v7h-2.5zM10.75 2.5h2.5v9h-2.5z",
  table: "M2.75 2.5h10.5c.4 0 .75.35.75.75v9.5c0 .4-.35.75-.75.75H2.75a.75.75 0 0 1-.75-.75v-9.5c0-.4.35-.75.75-.75ZM2 6h12M2 10h12M6 6v7.5",
  x: "m4 4 8 8M12 4l-8 8",
  check: "m3.25 8.5 3 3 6.5-7",
  calendar: "M3 3.25h10c.4 0 .75.35.75.75v8.75c0 .4-.35.75-.75.75H3a.75.75 0 0 1-.75-.75V4c0-.4.35-.75.75-.75ZM2.25 6.5h11.5M5.25 1.75v2.5M10.75 1.75v2.5",
  clock: "M8 14.25a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5ZM8 4.5V8l2.25 1.5",
  text: "M3 4.25V3h10v1.25M8 3v10M6.25 13h3.5",
  hash: "M3 6h10.5M2.5 10H13M6.5 2.5 5.5 13.5M10.5 2.5l-1 11",
  currency: "M8 1.75v12.5M11 4.5c-.5-.9-1.6-1.5-3-1.5-1.75 0-3 .9-3 2.25C5 8.5 11 7.25 11 10.5 11 11.9 9.75 13 8 13c-1.5 0-2.7-.7-3.1-1.75",
  at: "M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm0 0v1c0 1 .6 1.75 1.5 1.75S13.75 10 13.75 8A5.75 5.75 0 1 0 11 12.9",
  globe: "M8 14.25a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5ZM1.75 8h12.5M8 1.75c1.6 1.7 2.4 3.8 2.4 6.25S9.6 12.55 8 14.25C6.4 12.55 5.6 10.45 5.6 8S6.4 3.45 8 1.75Z",
  link: "M6.75 9.25a2.9 2.9 0 0 0 4.1 0l2-2a2.9 2.9 0 0 0-4.1-4.1l-.7.7M9.25 6.75a2.9 2.9 0 0 0-4.1 0l-2 2a2.9 2.9 0 0 0 4.1 4.1l.7-.7",
  tag: "M2 2.75v4.1c0 .3.1.55.3.75l6.1 6.1c.4.4 1 .4 1.4 0l4.1-4.1c.4-.4.4-1 0-1.4l-6.1-6.1a1.05 1.05 0 0 0-.75-.3H2.75A.75.75 0 0 0 2 2.75ZM5 5h.01",
  status: "M8 14.25a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5ZM8 10.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z",
  checkbox: "M3.25 2.25h9.5c.55 0 1 .45 1 1v9.5c0 .55-.45 1-1 1h-9.5c-.55 0-1-.45-1-1v-9.5c0-.55.45-1 1-1ZM5.25 8.25l1.9 1.9 3.6-4",
  lock: "M4 7.25h8c.4 0 .75.35.75.75v5.25c0 .4-.35.75-.75.75H4a.75.75 0 0 1-.75-.75V8c0-.4.35-.75.75-.75ZM5.25 7.25v-2a2.75 2.75 0 0 1 5.5 0v2",
  trash: "M2.5 4h11M6.25 4V2.75h3.5V4M4 4l.6 9.3c.05.55.5.95 1 .95h4.8c.5 0 .95-.4 1-.95L12 4",
  arrowUpRight: "M5 11 11 5M6 5h5v5",
  arrowRight: "M3 8h10M9 4l4 4-4 4",
  download: "M8 2.5v8M4.75 7.5 8 10.75l3.25-3.25M2.75 13.25h10.5",
  sparkle: "M8 1.75c.4 3.3 1.95 4.85 5.25 5.25-3.3.4-4.85 1.95-5.25 5.25-.4-3.3-1.95-4.85-5.25-5.25 3.3-.4 4.85-1.95 5.25-5.25Z",
  activity: "M1.75 8h2.5l1.75-4.5 3.5 9 1.75-4.5h3",
  file: "M4 1.75h5.5L12.75 5v8.25c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1V2.75c0-.55.45-1 1-1ZM9.25 1.75V5.25h3.5",
  overview: "M2.75 2.5h4v4.25h-4zM9.25 2.5h4v4.25h-4zM2.75 9.25h4v4.25h-4zM9.25 9.25h4v4.25h-4z",
  eye: "M1.5 8S3.75 3.5 8 3.5 14.5 8 14.5 8 12.25 12.5 8 12.5 1.5 8 1.5 8ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  circle: "M8 14.25a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5Z",
  circleCheck: "M8 14.25a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5ZM5.5 8.1l1.75 1.75L10.6 6.4",
  alert: "M8 14.25a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5ZM8 4.75V8.5M8 11.25h.01",
  grip: "M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01",
  columns: "M3 2.5h10c.55 0 1 .45 1 1v9c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1v-9c0-.55.45-1 1-1ZM8 2.5v11",
  home: "M2.5 7 8 2.5 13.5 7v6.25c0 .4-.35.75-.75.75H3.25a.75.75 0 0 1-.75-.75V7ZM6.25 14V10h3.5v4",
  inbox: "M1.75 8.5 3.6 3.1c.1-.35.45-.6.8-.6h7.2c.35 0 .7.25.8.6l1.85 5.4v4c0 .4-.35.75-.75.75h-11a.75.75 0 0 1-.75-.75v-4ZM1.75 8.5h3.5l.75 1.75h4l.75-1.75h3.5",
  edit: "M10.25 2.75 13.25 5.75 5.5 13.5H2.5v-3l7.75-7.75Z",
  keyboard: "M2.25 4h11.5c.3 0 .5.2.5.5v7c0 .3-.2.5-.5.5H2.25a.5.5 0 0 1-.5-.5v-7c0-.3.2-.5.5-.5ZM4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h.01M5 9.5h6",
};

// Glyphs that read better filled (dots).
const FILLED = new Set(["more"]);

/** `<svg>` element for icon `name` (16 px by default). Decorative: hidden from assistive technology. */
export function icon(name, className = "", size = 16) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `at-icon ${className}`.trim());
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", P[name] ?? P.circle);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", FILLED.has(name) ? "2.5" : "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

/** Replace every `<span data-icon="name">` placeholder in static markup with its SVG. */
export function hydrateIcons(root = document) {
  for (const holder of root.querySelectorAll("[data-icon]")) {
    const name = holder.getAttribute("data-icon");
    holder.removeAttribute("data-icon");
    holder.classList.add("at-icon-slot");
    holder.replaceChildren(icon(name));
  }
}

/** Column-header glyph for an attribute type. */
export function typeIcon(type) {
  switch (type) {
    case "text": return "text";
    case "number": return "hash";
    case "checkbox": return "checkbox";
    case "currency": return "currency";
    case "date": return "calendar";
    case "timestamp": return "clock";
    case "select": return "tag";
    case "status": return "status";
    case "record-reference": return "link";
    case "actor-reference": return "user";
    case "domain": return "globe";
    case "email-address": return "at";
    case "phone-number": return "phone";
    case "personal-name": return "user";
    default: return "text";
  }
}
