// Line icons for the Documenso Tool app: 24x24 grid, 2 px round strokes, drawn for this package in the thin
// outline style the web app uses. Built with createElementNS; no markup strings.
const P = {
  search: ["M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z", "M21 21l-4.3-4.3"],
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
  chevronDown: ["M6 9l6 6l6-6"],
  chevronUpDown: ["M7 15l5 5l5-5", "M7 9l5-5l5 5"],
  chevronLeft: ["M15 18l-6-6l6-6"],
  chevronRight: ["M9 18l6-6l-6-6"],
  chevronsLeft: ["M11 17l-5-5l5-5", "M18 17l-5-5l5-5"],
  chevronsRight: ["M13 17l5-5l-5-5", "M6 17l5-5l-5-5"],
  listFilter: ["M3 6h18", "M7 12h10", "M10 18h4"],
  user: ["M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", "M12 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8z"],
  users: ["M14 19a6 6 0 0 0-12 0", "M8 5a4 4 0 1 0 0 8a4 4 0 1 0 0-8z", "M22 19a6 6 0 0 0-6-6a4 4 0 1 0 0-8"],
  calendar: ["M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M16 2v4", "M8 2v4", "M3 10h18"],
  file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z", "M14 2v4a2 2 0 0 0 2 2h4"],
  fileText: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z", "M14 2v4a2 2 0 0 0 2 2h4", "M10 9H8", "M16 13H8", "M16 17H8"],
  clock: ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z", "M12 6v6l4 2"],
  checkCircle: ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z", "M9 12l2 2l4-4"],
  xCircle: ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z", "M15 9l-6 6", "M9 9l6 6"],
  timerOff: ["M10 2h4", "M4.6 11a8 8 0 0 0 1.7 8.7a8 8 0 0 0 8.7 1.7", "M7.4 7.4a8 8 0 0 1 10.3 1l.1.1a8 8 0 0 1 1 10.3", "M2 2l20 20", "M12 12v-2"],
  signature: ["M21 17c-2 0-3 1-4.5 1S14 16 12 16s-4 3-6 3s-3-1-3-2.5S5 13 7 11s4-6 2-7s-5 4-5 8", "M3 21h18"],
  edit: ["M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7", "M18.4 2.6a2.1 2.1 0 1 1 3 3L12 15l-4 1l1-4z"],
  pencil: ["M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5L2 22l1.5-5.5z", "M15 5l4 4"],
  eye: ["M2 12s3-7 10-7s10 7 10 7s-3 7-10 7s-10-7-10-7z", "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z"],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5l5-5", "M12 15V3"],
  upload: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M17 8l-5-5l-5 5", "M12 3v12"],
  more: ["M12 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2z", "M19 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2z", "M5 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2z"],
  copy: ["M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"],
  trash: ["M3 6h18", "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2", "M10 11v6", "M14 11v6"],
  mail: ["M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M22 7l-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"],
  send: ["M14.5 21.7a.5.5 0 0 0 .94-.03L21.96 2.64a.5.5 0 0 0-.6-.6L2.33 8.55a.5.5 0 0 0-.03.94l7.9 3.17a2 2 0 0 1 1.1 1.1z", "M21.85 2.15L10.9 13.1"],
  bird: ["M16 7h.01", "M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20", "M20 7l2 .5l-2 .5", "M10 18v3", "M14 17.75V21", "M7 18a6 6 0 0 0 3.84-10.61"],
  folderPlus: ["M12 10v6", "M9 13h6", "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"],
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"],
  plus: ["M5 12h14", "M12 5v14"],
  x: ["M18 6L6 18", "M6 6l12 12"],
  lock: ["M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z", "M7 11V7a5 5 0 0 1 10 0v4"],
  globe: ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z", "M12 2a14.5 14.5 0 0 0 0 20a14.5 14.5 0 0 0 0-20", "M2 12h20"],
  check: ["M20 6L9 17l-5-5"],
  loader: ["M21 12a9 9 0 1 1-6.22-8.56"],
  history: ["M3 12a9 9 0 1 0 9-9a9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M12 7v5l4 2"],
  link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
  alert: ["M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
  settings: ["M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z", "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z"],
  logOut: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5l-5-5", "M21 12H9"],
  building: ["M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18z", "M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2", "M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2", "M10 6h4", "M10 10h4", "M10 14h4", "M10 18h4"],
  type: ["M4 7V4h16v3", "M9 20h6", "M12 4v16"],
  hash: ["M4 9h16", "M4 15h16", "M10 3L8 21", "M16 3l-2 18"],
  checkSquare: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M9 12l2 2l4-4"],
  circleDot: ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z", "M12 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2z"],
  listDropdown: ["M3 5h18", "M3 12h18", "M3 19h18"],
  contact: ["M17 18a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2", "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M12 8a2 2 0 1 0 0 4a2 2 0 1 0 0-4z", "M8 2v2", "M16 2v2"],
  atSign: ["M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z", "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"],
  grip: ["M9 6h.01", "M9 12h.01", "M9 18h.01", "M15 6h.01", "M15 12h.01", "M15 18h.01"],
  bell: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
  shield: ["M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"],
};

const NS = "http://www.w3.org/2000/svg";

/** An inline SVG icon (decorative: aria-hidden). */
export function icon(name, className = "") {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `ic ${className}`.trim());
  for (const d of P[name] ?? P.file) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Replace every `<span data-icon="name">` placeholder in static markup with its SVG. */
export function hydrateIcons(root = document) {
  for (const holder of root.querySelectorAll("[data-icon]")) {
    holder.replaceWith(icon(holder.dataset.icon, holder.className));
  }
}
