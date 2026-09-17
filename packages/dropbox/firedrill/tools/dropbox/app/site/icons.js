// Dropbox-style line icons (24 px grid, 1.5 px strokes, rounded caps), drawn as SVG elements, no innerHTML.
const NS = "http://www.w3.org/2000/svg";

const P = {
  home: ["M4 10.5 12 4l8 6.5V20h-5.5v-5.5h-5V20H4z"],
  folder: ["M3.5 6.5h6l2 2h9v10.5h-17z"],
  photos: ["M4 5h16v14H4z", "M4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 17", "M15.5 9.5a1.2 1.2 0 1 0 0 .1"],
  shared: ["M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M3.5 19c.5-3.2 2.7-5 5.5-5s5 1.8 5.5 5", "M15.5 5.3a3 3 0 0 1 0 5.4", "M17 14.3c2 .6 3.2 2.3 3.5 4.7"],
  signature: ["M4 19h16", "M5.5 15.5c2-3.5 3-7.5 1.8-8.2-1.5-.9-3 4.3-.8 6.7 2.1 2.4 4.4-1.4 5-3 .3 1.6.7 3.2 2.3 3.2 1.4 0 2.2-1.3 2.9-2.3"],
  send: ["M4 12 20 4l-4 16-4.5-6.5z", "M11.5 13.5 20 4"],
  trash: ["M5 7h14", "M9.5 7V4.5h5V7", "M6.5 7l1 13h9l1-13", "M10.5 10.5v6", "M13.5 10.5v6"],
  more: ["M6 12h.01", "M12 12h.01", "M18 12h.01"],
  moreV: ["M12 6h.01", "M12 12h.01", "M12 18h.01"],
  search: ["M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "M15.5 15.5 20 20"],
  help: ["M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z", "M9.8 9.6a2.3 2.3 0 1 1 3.2 2.1c-.7.3-1 .8-1 1.5v.4", "M12 16.6h.01"],
  bell: ["M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z", "M10 20h4"],
  apps: ["M5 5h4v4H5z", "M15 5h4v4h-4z", "M5 15h4v4H5z", "M15 15h4v4h-4z"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  plus: ["M12 5v14", "M5 12h14"],
  upload: ["M12 16V5", "M7.5 9.5 12 5l4.5 4.5", "M5 15v4h14v-4"],
  download: ["M12 5v11", "M7.5 11.5 12 16l4.5-4.5", "M5 19h14"],
  caretDown: ["M8 10l4 4 4-4"],
  caretRight: ["M10 8l4 4-4 4"],
  chevronLeft: ["M14 6l-6 6 6 6"],
  link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
  copy: ["M9 9h10v10H9z", "M5 15V5h10"],
  move: ["M3.5 6.5h6l2 2h9v10.5h-17z", "M10 13.5h6", "M13.5 11l2.5 2.5-2.5 2.5"],
  rename: ["M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16z", "M13.5 6.5l4 4"],
  history: ["M4.5 12a7.5 7.5 0 1 0 2.2-5.3", "M4.5 4.5v3.5H8", "M12 8v4.5l3 1.5"],
  star: ["M12 4.5l2.3 4.7 5.2.8-3.8 3.6.9 5.2-4.6-2.4-4.6 2.4.9-5.2-3.8-3.6 5.2-.8z"],
  clock: ["M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M12 8v4.5l3 2"],
  list: ["M9 7h11", "M9 12h11", "M9 17h11", "M4.5 7h.01", "M4.5 12h.01", "M4.5 17h.01"],
  grid: ["M4.5 4.5h6v6h-6z", "M13.5 4.5h6v6h-6z", "M4.5 13.5h6v6h-6z", "M13.5 13.5h6v6h-6z"],
  info: ["M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z", "M12 11v5.5", "M12 7.8h.01"],
  lock: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
  globe: ["M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z", "M3.5 12h17", "M12 3.5c2.4 2.4 3.4 5.2 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.2-3.4-8.5s1-6.1 3.4-8.5z"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  alert: ["M12 4 21 19.5H3z", "M12 10v4.5", "M12 17.2h.01"],
  settings: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2L10 21h4l.6-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"],
  admin: ["M12 3.5 19 6v5.5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6z"],
  signout: ["M14 5h5v14h-5", "M10 16l-4-4 4-4", "M6 12h9.5"],
  restore: ["M4.5 12a7.5 7.5 0 1 0 2.2-5.3", "M4.5 4.5v3.5H8"],
  newFolder: ["M3.5 6.5h6l2 2h9v10.5h-17z", "M12 11v5", "M9.5 13.5h5"],
  file: ["M6 3.5h8l4.5 4.5v12.5H6z", "M14 3.5V8h4.5"],
};

const FILLED = new Set(["more", "moreV"]);

/** A decorative icon element (aria-hidden). */
export function icon(name, className = "") {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `db-ico ${className}`.trim());
  for (const d of P[name] ?? P.file) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", FILLED.has(name) ? "2.6" : "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg;
}

/** Replace every [data-icon] placeholder under root. */
export function hydrateIcons(root = document) {
  for (const holder of root.querySelectorAll("[data-icon]")) {
    if (holder.firstChild) continue;
    holder.append(icon(holder.dataset.icon));
  }
}

// File-type thumbnails in Dropbox's style: a pale-blue folder and a white page with a coloured type band.
const KIND = {
  folder: { fill: "#A1C3FF", back: "#6B9BF5" },
  image: { color: "#0061FE", label: "IMG" },
  pdf: { color: "#E0402E", label: "PDF" },
  spreadsheet: { color: "#1F8B4C", label: "CSV" },
  document: { color: "#0061FE", label: "TXT" },
  presentation: { color: "#E57C1F", label: "PPT" },
  audio: { color: "#7A3FE4", label: "MP3" },
  video: { color: "#7A3FE4", label: "MOV" },
  others: { color: "#736C64", label: "" },
};

function shape(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Thumbnail glyph for a Dropbox entry kind (folder, image, pdf, spreadsheet, document, ...). */
export function fileGlyph(kind, extension = "", size = 32) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 40 40");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "db-glyph");
  if (kind === "folder") {
    svg.append(shape("path", { d: "M4 9.5a2 2 0 0 1 2-2h9l3 3h16a2 2 0 0 1 2 2v1H4z", fill: KIND.folder.back }));
    svg.append(shape("path", { d: "M4 13h32v17.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", fill: KIND.folder.fill }));
    return svg;
  }
  const spec = KIND[kind] ?? KIND.others;
  svg.append(shape("path", { d: "M9 4h15l8 8v23a1.5 1.5 0 0 1-1.5 1.5h-21A1.5 1.5 0 0 1 8 35V5.5A1.5 1.5 0 0 1 9.5 4z", fill: "#FFFFFF", stroke: "#D6D1CB", "stroke-width": "1" }));
  svg.append(shape("path", { d: "M24 4v6.5a1.5 1.5 0 0 0 1.5 1.5H32", fill: "#EEEAE5", stroke: "#D6D1CB", "stroke-width": "1" }));
  const label = (extension || spec.label).slice(0, 4).toUpperCase();
  if (label) {
    svg.append(shape("rect", { x: "5", y: "20", width: String(Math.max(16, label.length * 6 + 6)), height: "10", rx: "2", fill: spec.color }));
    const text = shape("text", { x: String(5 + Math.max(16, label.length * 6 + 6) / 2), y: "27.6", "text-anchor": "middle", "font-size": "7", "font-weight": "700", fill: "#FFFFFF", "font-family": "Inter, Arial, sans-serif" });
    text.textContent = label;
    svg.append(text);
  }
  return svg;
}
