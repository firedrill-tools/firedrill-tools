// Monochrome 24px glyphs drawn for this package in the simple rounded line style of the Xero web app icon set.
const NS = "http://www.w3.org/2000/svg";
const P = {
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  chevron: ["M7 10l5 5 5-5"],
  chevronRight: ["M10 7l5 5-5 5"],
  chevronLeft: ["M14 7l-5 5 5 5"],
  plus: ["M12 5v14", "M5 12h14"],
  search: ["M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "M15.5 15.5L20 20"],
  bell: ["M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z", "M10 20.5a2 2 0 0 0 4 0"],
  help: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7", "M12 17h.01"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v5", "M12 8h.01"],
  alert: ["M12 3l9.5 17h-19z", "M12 10v4", "M12 17h.01"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  filter: ["M4 6h16", "M7 12h10", "M10 18h4"],
  more: ["M6 12h.01", "M12 12h.01", "M18 12h.01"],
  trash: ["M5 7h14", "M10 7V5h4v2", "M7 7l1 13h8l1-13"],
  mail: ["M4 6h16v12H4z", "M4 7l8 6 8-6"],
  print: ["M7 9V4h10v5", "M6 18H4v-8h16v8h-2", "M7 14h10v6H7z"],
  edit: ["M4 20h4L19 9l-4-4L4 16z", "M13.5 6.5l4 4"],
  bank: ["M3 9l9-5 9 5", "M5 10v8", "M9.5 10v8", "M14.5 10v8", "M19 10v8", "M3 20h18"],
  sort: ["M8 10l4-4 4 4", "M8 14l4 4 4-4"],
  arrowUp: ["M12 18V6", "M7 11l5-5 5 5"],
  arrowDown: ["M12 6v12", "M7 13l5 5 5-5"],
  person: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4.5 20c.8-3.6 3.8-6 7.5-6s6.7 2.4 7.5 6"],
  lock: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
  drag: ["M9 6h.01", "M15 6h.01", "M9 12h.01", "M15 12h.01", "M9 18h.01", "M15 18h.01"],
};
export function icon(name, size = 20) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.classList.add("ic");
  for (const d of P[name] ?? P.info) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
export function hydrateIcons(root = document) {
  for (const host of root.querySelectorAll("[data-icon]")) {
    if (host.firstElementChild) continue;
    host.append(icon(host.getAttribute("data-icon")));
  }
}
