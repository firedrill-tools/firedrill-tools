// Monochrome 16-20px line glyphs drawn for this package in the plain, square-ended style of the NetSuite
// application bar and list toolbars. No third-party icon font is embedded.
const NS = "http://www.w3.org/2000/svg";
const P = {
  menu: ["M3 6h18", "M3 12h18", "M3 18h18"],
  search: ["M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "M15.4 15.4 20 20"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5.2l3.4 2"],
  plus: ["M12 5v14", "M5 12h14"],
  star: ["M12 4l2.4 5 5.6.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.6-.8z"],
  help: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.7", "M12 17h.01"],
  chevron: ["M6 9.5l6 6 6-6"],
  chevronRight: ["M9.5 6l6 6-6 6"],
  chevronLeft: ["M14.5 6l-6 6 6 6"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  check: ["M5 12.5l4.5 4.5L19 7"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v5.5", "M12 8h.01"],
  alert: ["M12 3.5 21.5 20h-19z", "M12 10v4.2", "M12 17.3h.01"],
  lock: ["M5.5 11h13v9h-13z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
  edit: ["M4 20h4L19 9l-4-4L4 16z", "M13.5 6.5l4 4"],
  trash: ["M5 7h14", "M10 7V4.5h4V7", "M7 7l1 13h8l1-13"],
  print: ["M7 9V4h10v5", "M6 18H4v-8h16v8h-2", "M7 14h10v6H7z"],
  mail: ["M4 6h16v12H4z", "M4 7l8 6 8-6"],
  refresh: ["M20 12a8 8 0 1 1-2.6-5.9", "M20 4v5h-5"],
  back: ["M20 12H5", "M11 6l-6 6 6 6"],
  money: ["M3 6.5h18v11H3z", "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M6.5 10v4", "M17.5 10v4"],
  doc: ["M6 3h8l4 4v14H6z", "M14 3v5h4", "M9 13h6", "M9 17h6"],
  cart: ["M3 5h2.2l2.3 10.5h9.6L19 8H6", "M9.5 20h.01", "M16.5 20h.01"],
  box: ["M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z", "M3.5 7.5 12 12l8.5-4.5", "M12 12v9"],
  people: ["M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M2 20c.8-3.6 3.5-6 7-6s6.2 2.4 7 6", "M16 5.2a3.6 3.6 0 0 1 0 6.9", "M17.5 14.4c2.3.7 3.9 2.7 4.5 5.6"],
  building: ["M5 21V4h9v17", "M14 10h5v11", "M8 8h3", "M8 12h3", "M8 16h3", "M17 14h.01", "M17 18h.01"],
  table: ["M3.5 5h17v14h-17z", "M3.5 9.5h17", "M9 9.5V19", "M14.5 9.5V19"],
};
export function icon(name, size = 18) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "square");
  svg.setAttribute("stroke-linejoin", "miter");
  svg.classList.add("ic");
  for (const d of P[name] ?? P.info) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
/** Fill every [data-icon] placeholder in the static shell markup. */
export function hydrateIcons(root = document) {
  for (const host of root.querySelectorAll("[data-icon]")) {
    host.prepend(icon(host.getAttribute("data-icon"), Number(host.getAttribute("data-icon-size") ?? 18)));
    host.removeAttribute("data-icon");
  }
}
