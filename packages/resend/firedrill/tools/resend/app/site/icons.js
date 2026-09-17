// Monochrome 16px line icons in the dashboard's thin-stroke style (1.5px strokes, round joins). Built with DOM APIs only.
const NS = "http://www.w3.org/2000/svg";
const P = {
  mail: ["M3 5.5h18v13H3z", "m3.5 6 8.5 7 8.5-7"],
  broadcast: ["M4 10v4", "M7.5 8.5v7", "M11 6v12", "M14.5 8.5v7", "M18 10v4"],
  template: ["M4 4h16v16H4z", "M4 9h16", "M9 9v11"],
  audience: ["M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5", "M16 4.3a3.5 3.5 0 0 1 0 6.4", "M18 14.8c2 .7 3.2 2.5 3.5 5.2"],
  metrics: ["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"],
  globe: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M3 12h18", "M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z"],
  logs: ["M8 6h13", "M8 12h13", "M8 18h13", "M3.5 6h.01", "M3.5 12h.01", "M3.5 18h.01"],
  key: ["M14.5 9.5a2 2 0 1 0 0-.01", "M15 15a6 6 0 1 0-5.6-3.9L3 17.5V21h3.5v-2h2v-2h2l1.9-1.9A6 6 0 0 0 15 15Z"],
  webhook: ["M9 7.5a3.5 3.5 0 1 1 5.3 3L17 15", "M6.5 13a3.5 3.5 0 1 0 3.5 4h7", "M17.5 20.5a3.5 3.5 0 1 0-1.5-6.7L12 7"],
  settings: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z", "m20 20-3.5-3.5"],
  chevronDown: ["m6 9 6 6 6-6"],
  chevronRight: ["m9 6 6 6-6 6"],
  chevronLeft: ["m15 6-6 6 6 6"],
  chevronsUpDown: ["m7 15 5 5 5-5", "m7 9 5-5 5 5"],
  plus: ["M12 5v14", "M5 12h14"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  check: ["m5 12.5 4.5 4.5L19 7"],
  x: ["M6 6l12 12", "M18 6 6 18"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"],
  book: ["M4 19.5V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2Z", "M4 19.5A2 2 0 0 0 6 21h14"],
  help: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6", "M12 17h.01"],
  calendar: ["M4 5h16v16H4z", "M4 10h16", "M8 3v4", "M16 3v4"],
  download: ["M12 4v11", "m7 10 5 5 5-5", "M4 20h16"],
  refresh: ["M20 11a8 8 0 0 0-14.8-4L4 8.5", "M4 4v4.5h4.5", "M4 13a8 8 0 0 0 14.8 4l1.2-1.5", "M20 20v-4.5h-4.5"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7v5l3 2"],
  ban: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "m5.7 5.7 12.6 12.6"],
  alert: ["M12 3 2 20h20L12 3Z", "M12 10v4", "M12 17h.01"],
  lock: ["M5 11h14v10H5z", "M8 11V7a4 4 0 1 1 8 0v4"],
  users: ["M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5"],
  filter: ["M4 5h16", "M7 12h10", "M10 19h4"],
  send: ["m4 12 16-8-6 16-2.5-6.5L4 12Z"],
  logout: ["M15 4h4v16h-4", "M10 16l4-4-4-4", "M14 12H4"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  inbox: ["M3 13h5l1.5 3h5l1.5-3h5", "M5.5 5h13L21 13v6H3v-6l2.5-8Z"],
  tag: ["M3 12V4h8l10 10-8 8L3 12Z", "M7.5 8h.01"],
  topic: ["M4 6h16", "M4 12h10", "M4 18h6"],
  property: ["M5 4h14v16H5z", "M9 9h6", "M9 13h6", "M9 17h3"],
};

export function icon(name, size = 16) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("i");
  for (const d of P[name] ?? P.more) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll("[data-icon]")) {
    if (node.firstChild) continue;
    node.append(icon(node.dataset.icon, Number(node.dataset.size ?? 16)));
  }
}
