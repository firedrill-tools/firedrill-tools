// Monochrome 24px line glyphs drawn for this package in the rounded, 1.75px-stroke style of the QuickBooks icon set.
const NS = "http://www.w3.org/2000/svg";
const P = {
  plus: ["M12 5v14", "M5 12h14"],
  bookmark: ["M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z"],
  home: ["M4 11l8-7 8 7", "M6 9.5V20h4v-6h4v6h4V9.5"],
  feed: ["M5 5h14v14H5z", "M8 9h8", "M8 12h8", "M8 15h5"],
  reports: ["M5 20V10", "M10 20V4", "M15 20v-7", "M20 20v-11"],
  apps: ["M5 5h5v5H5z", "M14 5h5v5h-5z", "M5 14h5v5H5z", "M14 14h5v5h-5z"],
  accounting: ["M4 7h16", "M4 12h16", "M4 17h16", "M9 4v16"],
  expenses: ["M6 3h12v18l-3-2-3 2-3-2-3 2z", "M9 8h6", "M9 12h6"],
  sales: ["M4 17l5-5 4 4 7-8", "M15 8h5v5"],
  customers: ["M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M3 20c.5-3.5 3-5.5 6-5.5s5.5 2 6 5.5", "M16 11a3 3 0 1 0 0-6", "M18 14.5c1.7.6 2.8 2.4 3 5.5"],
  bank: ["M3 9l9-5 9 5", "M5 10v8", "M9.5 10v8", "M14.5 10v8", "M19 10v8", "M3 20h18"],
  payroll: ["M3 7h18v10H3z", "M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z", "M6 10v4", "M18 10v4"],
  taxes: ["M6 3h9l4 4v14H6z", "M9 16l6-6", "M9.5 10.5h.01", "M14.5 15.5h.01"],
  team: ["M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M5 20c.6-3.8 3.4-6 7-6s6.4 2.2 7 6"],
  customize: ["M4 7h10", "M18 7h2", "M16 5v4", "M4 17h2", "M10 17h10", "M8 15v4"],
  mileage: ["M4 16a8 8 0 1 1 16 0", "M4 16h16", "M12 16l4-5", "M7.5 12.5h.01", "M12 10h.01", "M16.5 12.5h.01"],
  accountant: ["M12 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M5.5 20c.6-3.2 3.2-5 6.5-5s5.9 1.8 6.5 5", "M16.5 4.5l2.5 1.2-2.5 1.2"],
  collapse: ["M13 7l-5 5 5 5", "M19 5v14"],
  expand: ["M11 7l5 5-5 5", "M5 5v14"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  search: ["M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "M15.5 15.5L20 20"],
  experts: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 20c1-4 4-6 8-6s7 2 8 6"],
  help: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6", "M12 17h.01"],
  bell: ["M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z", "M10 20.5a2 2 0 0 0 4 0"],
  gear: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.5 7.5 0 0 1-1.7 1l-.3 2h-4l-.3-2a7.5 7.5 0 0 1-1.7-1l-1.9.7-2-3.4 1.6-1.2a7.4 7.4 0 0 1 0-3L3 9.3l2-3.4 1.9.7a7.5 7.5 0 0 1 1.7-1l.3-2h4l.3 2a7.5 7.5 0 0 1 1.7 1l1.9-.7 2 3.4-1.6 1.2a7.4 7.4 0 0 1 0 3z"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  chevronDown: ["M6 9l6 6 6-6"],
  chevronLeft: ["M15 6l-6 6 6 6"],
  chevronRight: ["M9 6l6 6-6 6"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  trash: ["M5 7h14", "M10 7V4h4v3", "M7 7l1 13h8l1-13"],
  alert: ["M12 3l10 18H2z", "M12 10v5", "M12 18h.01"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v6", "M12 7.5h.01"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  print: ["M7 9V3h10v6", "M6 18H4v-8h16v8h-2", "M7 14h10v7H7z"],
  history: ["M4 12a8 8 0 1 0 2.3-5.6", "M4 4v4h4", "M12 8v4l3 2"],
  filter: ["M4 5h16l-6 8v5l-4 2v-7z"],
  settingsSm: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  lock: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
  mail: ["M3 6h18v12H3z", "M3 7l9 6 9-6"],
  edit: ["M4 20h4L19 9l-4-4L4 16z", "M13.5 6.5l4 4"],
  export: ["M12 4v11", "M7.5 8.5L12 4l4.5 4.5", "M5 15v5h14v-5"],
  invoice: ["M6 3h12v18H6z", "M9 8h6", "M9 12h6", "M9 16h3"],
  payment: ["M3 6h18v12H3z", "M3 10h18", "M7 15h3"],
  drag: ["M9 6h.01", "M15 6h.01", "M9 12h.01", "M15 12h.01", "M9 18h.01", "M15 18h.01"],
};
export function icon(name, cls = "") {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `i ${cls}`.trim());
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
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
