// Monochrome SVG glyphs drawn in the product's icon language (20 px grid, 1.6 px strokes, round caps).
// Original paths for this package; rendered through the DOM API (never innerHTML with record data).
const SVG = "http://www.w3.org/2000/svg";

const STROKE = {
  search: ["M9 3.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z", "M13 13l3.5 3.5"],
  home: ["M3.5 9.5 10 4l6.5 5.5V16a1 1 0 0 1-1 1h-3.5v-4.5h-4V17H4.5a1 1 0 0 1-1-1V9.5Z"],
  inbox: ["M4 4.5h12l1.5 7v4a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-4l1.5-7Z", "M2.5 11.5H7l1 2h4l1-2h4.5"],
  settings: ["M10 7.25a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Z", "M8.6 3h2.8l.4 1.9 1.6.9 1.9-.6 1.4 2.4-1.5 1.3v1.8l1.5 1.3-1.4 2.4-1.9-.6-1.6.9-.4 1.9H8.6l-.4-1.9-1.6-.9-1.9.6-1.4-2.4 1.5-1.3v-1.8L3.3 7.6l1.4-2.4 1.9.6 1.6-.9L8.6 3Z"],
  templates: ["M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5v-9Z", "M4 8.5h12", "M8.5 8.5V16"],
  trash: ["M4 5.5h12", "M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5", "M5.5 5.5 6.2 16a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.7-10.5", "M8.5 8.5v5", "M11.5 8.5v5"],
  invite: ["M8 9.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z", "M3 16.5c.4-2.9 2.4-4.5 5-4.5s4.6 1.6 5 4.5", "M15 7v5", "M12.5 9.5h5"],
  compose: ["M11.5 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5V9", "M15.6 3.4a1.4 1.4 0 0 1 2 2L11 12l-2.8.8.8-2.8 6.6-6.6Z"],
  plus: ["M10 4.5v11", "M4.5 10h11"],
  close: ["M5.5 5.5l9 9", "M14.5 5.5l-9 9"],
  chevron_down: ["M6 8l4 4 4-4"],
  chevron_right: ["M8 6l4 4-4 4"],
  chevron_left: ["M12 6l-4 4 4 4"],
  double_chevron_left: ["M11 6l-4 4 4 4", "M16 6l-4 4 4 4"],
  arrow_left: ["M16 10H4", "M9 5l-5 5 5 5"],
  menu: ["M3.5 6h13", "M3.5 10h13", "M3.5 14h13"],
  more: ["M5 10h.01", "M10 10h.01", "M15 10h.01"],
  comment: ["M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H5.5A1.5 1.5 0 0 1 4 11.5v-6Z"],
  star: ["M10 3.5l2 4.2 4.5.6-3.3 3.2.8 4.5-4-2.2-4 2.2.8-4.5L3.5 8.3 8 7.7l2-4.2Z"],
  star_filled: ["M10 3.5l2 4.2 4.5.6-3.3 3.2.8 4.5-4-2.2-4 2.2.8-4.5L3.5 8.3 8 7.7l2-4.2Z"],
  share: ["M14 7.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z", "M6 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z", "M14 16.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z", "M7.8 9.1l4.4-2.6", "M7.8 10.9l4.4 2.6"],
  clock: ["M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Z", "M10 6.5V10l2.5 1.5"],
  help: ["M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Z", "M8 8a2 2 0 1 1 2.8 1.8c-.6.3-.8.6-.8 1.2v.5", "M10 14h.01"],
  page: ["M6 3h5.5L15 6.5V16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z", "M11 3v4h4", "M7.5 10h5", "M7.5 13h5"],
  database: ["M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5v-9Z", "M4 8h12", "M4 12h12", "M8 8v8"],
  table: ["M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5v-9Z", "M4 8h12", "M4 12h12", "M8 8v8"],
  board: ["M3.5 4.5h3.5v11H3.5z", "M8.25 4.5h3.5v8h-3.5z", "M13 4.5h3.5v6H13z"],
  filter: ["M3.5 5h13", "M6 10h8", "M8.5 15h3"],
  sort: ["M7 4v12", "M4 7l3-3 3 3", "M13 16V4", "M10 13l3 3 3-3"],
  expand: ["M11 4h5v5", "M9 9l7-7", "M9 16H4v-5", "M11 9l-7 7"],
  open: ["M11 4h5v5", "M16 4l-7 7", "M9 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5V11"],
  check: ["M4 10.5l4 4 8-9"],
  restore: ["M4.5 8.5A6 6 0 1 1 6 14", "M4 4.5v4h4"],
  drag: ["M7.5 5h.01", "M7.5 10h.01", "M7.5 15h.01", "M12.5 5h.01", "M12.5 10h.01", "M12.5 15h.01"],
  move: ["M4 5.5A1.5 1.5 0 0 1 5.5 4H9l1.5 2h4A1.5 1.5 0 0 1 16 7.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5v-9Z", "M10 9v5", "M7.5 11.5 10 14l2.5-2.5"],
  markdown: ["M3.5 5h13v10h-13z", "M6 12.5v-5l2 2.5 2-2.5v5", "M13 7.5v5", "M11.5 11l1.5 1.5 1.5-1.5"],
  link: ["M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2L9.6 6.2", "M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8a3 3 0 0 0 4.2 4.2l1.2-1.2"],
  lock: ["M5.5 9h9a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Z", "M7 9V6.5a3 3 0 0 1 6 0V9"],
  warning: ["M10 3.5 17 16H3l7-12.5Z", "M10 8v3.5", "M10 13.8h.01"],
  refresh: ["M15.5 8A6 6 0 0 0 4.7 6.4", "M4.5 3.5v3.5H8", "M4.5 12a6 6 0 0 0 10.8 1.6", "M15.5 16.5V13H12"],
  send: ["M3.5 10 16.5 4l-3 12.5-4-4.5-6-2Z", "M9.5 12l7-8"],
  ai: ["M10 3v3", "M10 14v3", "M3 10h3", "M14 10h3", "M5.2 5.2l2 2", "M12.8 12.8l2 2", "M14.8 5.2l-2 2", "M7.2 12.8l-2 2"],
  image: ["M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5v-9Z", "M4.5 14l3.5-4 3 3 2-2 2.5 3", "M12.5 8h.01"],
  learn: ["M3.5 6.5 10 3.5l6.5 3-6.5 3-6.5-3Z", "M6 8v4c0 1.2 1.8 2.5 4 2.5s4-1.3 4-2.5V8", "M16.5 6.5V11"],
  text_color: ["M6 13.5 9.5 4.5h1l3.5 9", "M7.2 10.5h5.6", "M4 16.5h12"],
  bolt: ["M11 2.5 4.5 11h5l-1 6.5L15.5 9h-5l.5-6.5Z"],
  calendar: ["M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5v-9Z", "M4 8.5h12", "M7.5 3v2.5", "M12.5 3v2.5"],
  list_view: ["M4 6h.01", "M4 10h.01", "M4 14h.01", "M7 6h9.5", "M7 10h9.5", "M7 14h9.5"],
  gallery: ["M3.5 4h5.5v5.5H3.5z", "M11 4h5.5v5.5H11z", "M3.5 11.5h5.5V17H3.5z", "M11 11.5h5.5V17H11z"],
  timeline: ["M3.5 5.5h7", "M6.5 10h8", "M9.5 14.5h7"],
  chart: ["M4 16.5h12.5", "M6 13.5V9", "M10 13.5V5", "M14 13.5V11"],
  feed: ["M4 4.5h12v4H4z", "M4 11.5h12v4H4z"],
  map: ["M3.5 5.5 7.5 4l5 2 4-1.5v10l-4 1.5-5-2-4 1.5v-10Z", "M7.5 4v10", "M12.5 6v10"],
  teamspace: ["M7 9a2.25 2.25 0 1 0 0-4.5A2.25 2.25 0 0 0 7 9Z", "M13.5 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z", "M2.5 15.5c.4-2.4 2-3.8 4.5-3.8s4.1 1.4 4.5 3.8", "M12 11.8c.5-.2 1-.3 1.5-.3 2.1 0 3.4 1.3 3.8 3.5"],
  // Property-type glyphs (the table header and property panel show one before each name).
  prop_title: ["M4 15l3.5-9h1L12 15", "M5.3 12h5.4", "M14 8.5v6.5", "M12.5 12.7a1.6 1.6 0 1 0 1.5 1.5"],
  prop_text: ["M3.5 6h13", "M3.5 10h13", "M3.5 14h8"],
  prop_number: ["M7.5 3.5 6 16.5", "M13.5 3.5 12 16.5", "M4 7.5h13", "M3 12.5h13"],
  prop_select: ["M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Z", "M7.5 10l1.8 1.8L13 8"],
  prop_multi_select: ["M4 6h1.5", "M4 10h1.5", "M4 14h1.5", "M8 6h8.5", "M8 10h8.5", "M8 14h8.5"],
  prop_status: ["M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Z", "M10 3.5a6.5 6.5 0 0 1 0 13Z"],
  prop_date: ["M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5v-9Z", "M4 8.5h12", "M7.5 3v2.5", "M12.5 3v2.5"],
  prop_people: ["M10 9.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z", "M4.5 16.5c.5-2.9 2.6-4.5 5.5-4.5s5 1.6 5.5 4.5"],
  prop_checkbox: ["M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5v-9Z", "M7 10.2l2 2 4-4.4"],
  prop_url: ["M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2L9.6 6.2", "M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8a3 3 0 0 0 4.2 4.2l1.2-1.2"],
  prop_email: ["M3.5 5.5h13v9h-13z", "M3.5 6l6.5 5 6.5-5"],
  prop_phone: ["M5 3.5h3l1.5 3.5-2 1.5a8 8 0 0 0 4 4l1.5-2 3.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5C8.6 16.5 3.5 11.4 3.5 5A1.5 1.5 0 0 1 5 3.5Z"],
  prop_relation: ["M4 6h6", "M4 10h4", "M4 14h6", "M12 4l4 6-4 6"],
  prop_created_time: ["M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Z", "M10 6.5V10l2.5 1.5"],
  prop_last_edited_time: ["M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Z", "M10 6.5V10l2.5 1.5"],
  prop_created_by: ["M10 9.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z", "M4.5 16.5c.5-2.9 2.6-4.5 5.5-4.5s5 1.6 5.5 4.5"],
  prop_last_edited_by: ["M10 9.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z", "M4.5 16.5c.5-2.9 2.6-4.5 5.5-4.5s5 1.6 5.5 4.5"],
  // Block-type glyphs for the slash menu.
  block_text: ["M3.5 6h13", "M3.5 10h13", "M3.5 14h8"],
  block_h1: ["M4 4.5v11", "M4 10h6", "M10 4.5v11", "M14.5 15.5v-7l-1.5 1"],
  block_h2: ["M4 4.5v11", "M4 10h6", "M10 4.5v11", "M13 9.5c.3-1 1.2-1.3 2-1 1.2.4 1 1.8.3 2.5L13 13.5h3.5"],
  block_h3: ["M4 4.5v11", "M4 10h6", "M10 4.5v11", "M13 8.5h3l-1.7 2.5c1.3 0 2 .7 2 1.6 0 1.3-1.5 2-3.3 1.3"],
  block_bullet: ["M6 6h.01", "M6 10h.01", "M6 14h.01", "M9 6h7.5", "M9 10h7.5", "M9 14h7.5"],
  block_numbered: ["M4 5.5h1.5v3", "M4 8.5h3", "M4 11.5c.4-.5 1.5-.7 2-.2.6.6-.2 1.3-2 3h2.5", "M9 6h7.5", "M9 10h7.5", "M9 14h7.5"],
  block_todo: ["M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5v-9Z", "M7 10.2l2 2 4-4.4"],
  block_toggle: ["M6 5l6 5-6 5"],
  block_quote: ["M5 5.5v9", "M8.5 7h8", "M8.5 10h8", "M8.5 13h5"],
  block_callout: ["M4 6.5A1.5 1.5 0 0 1 5.5 5h9A1.5 1.5 0 0 1 16 6.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 13.5v-7Z", "M7.5 8v.01", "M10 8h3.5", "M7.5 11.5h6"],
  block_code: ["M7 6.5 3.5 10 7 13.5", "M13 6.5l3.5 3.5-3.5 3.5", "M11.5 4.5l-3 11"],
  block_divider: ["M3.5 10h13"],
  block_page: ["M6 3h5.5L15 6.5V16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z", "M11 3v4h4"],
};

const FILLED = new Set(["star_filled"]);

/** Build one icon element; `name` unknown → an empty box (so a typo is visible, never a crash). */
export function icon(name, className = "") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `icon icon-${name} ${className}`.trim());
  const filled = FILLED.has(name);
  svg.setAttribute("fill", filled ? "currentColor" : "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of STROKE[name] ?? []) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Property-type glyph name for a data source property type. */
export function propertyIcon(type) {
  return STROKE[`prop_${type}`] ? `prop_${type}` : "prop_text";
}

/** Replace every `<span data-icon="…">` placeholder in `root` with its SVG (used for the static shell). */
export function hydrateIcons(root = document) {
  for (const placeholder of root.querySelectorAll("[data-icon]")) {
    const name = placeholder.getAttribute("data-icon");
    const svg = icon(name, placeholder.className);
    placeholder.replaceWith(svg);
  }
}
