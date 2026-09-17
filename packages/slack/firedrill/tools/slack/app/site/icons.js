// Monochrome 20 px glyphs in the outlined style of the Slack client, drawn as path/stroke data so the app ships no
// icon font and makes no remote requests. Everything is `currentColor`.
const STROKE = { fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" };

// Each entry: [viewBox, elements]. Elements are [tag, attributes]; `s: true` applies the stroke preset.
const GLYPHS = {
  hash: ["0 0 20 20", [["path", { s: true, d: "M7.5 3.5 5.5 16.5M14.5 3.5l-2 13M3.5 7.5h13M3 12.5h13" }]]],
  lock: ["0 0 20 20", [["rect", { s: true, x: "4", y: "8.5", width: "12", height: "8.5", rx: "1.5" }], ["path", { s: true, d: "M6.5 8.5V6a3.5 3.5 0 0 1 7 0v2.5" }]]],
  chevron_down: ["0 0 20 20", [["path", { s: true, d: "m6 8 4 4 4-4" }]]],
  chevron_right: ["0 0 20 20", [["path", { s: true, d: "m8 6 4 4-4 4" }]]],
  chevron_left: ["0 0 20 20", [["path", { s: true, d: "m12 6-4 4 4 4" }]]],
  arrow_left: ["0 0 20 20", [["path", { s: true, d: "M16 10H4M9 5l-5 5 5 5" }]]],
  arrow_right: ["0 0 20 20", [["path", { s: true, d: "M4 10h12M11 5l5 5-5 5" }]]],
  clock: ["0 0 20 20", [["circle", { s: true, cx: "10", cy: "10", r: "7" }], ["path", { s: true, d: "M10 6v4l2.5 2" }]]],
  search: ["0 0 20 20", [["circle", { s: true, cx: "8.5", cy: "8.5", r: "5.5" }], ["path", { s: true, d: "m12.5 12.5 4.5 4.5" }]]],
  help: ["0 0 20 20", [["circle", { s: true, cx: "10", cy: "10", r: "7.5" }], ["path", { s: true, d: "M7.75 7.75a2.25 2.25 0 1 1 3.5 1.9c-.8.5-1.25 1-1.25 1.85" }], ["circle", { fill: "currentColor", cx: "10", cy: "14.25", r: ".9" }]]],
  home: ["0 0 20 20", [["path", { s: true, d: "M3.5 9.5 10 3.5l6.5 6v7a1 1 0 0 1-1 1h-3.5v-5h-4v5H4.5a1 1 0 0 1-1-1z" }]]],
  dm: ["0 0 20 20", [["path", { s: true, d: "M10 3.5c-3.9 0-7 2.6-7 5.8 0 1.6.8 3.1 2.1 4.1L4.5 17l3.6-1.6c.6.1 1.2.2 1.9.2 3.9 0 7-2.6 7-5.8s-3.1-6.3-7-6.3z" }]]],
  bell: ["0 0 20 20", [["path", { s: true, d: "M5.5 8.5a4.5 4.5 0 0 1 9 0v3l1.5 2.5h-12L5.5 11.5z" }], ["path", { s: true, d: "M8.5 16.5a1.5 1.5 0 0 0 3 0" }]]],
  bookmark: ["0 0 20 20", [["path", { s: true, d: "M5.5 3.5h9v13l-4.5-3-4.5 3z" }]]],
  more_h: ["0 0 20 20", [["circle", { fill: "currentColor", cx: "5", cy: "10", r: "1.5" }], ["circle", { fill: "currentColor", cx: "10", cy: "10", r: "1.5" }], ["circle", { fill: "currentColor", cx: "15", cy: "10", r: "1.5" }]]],
  more_v: ["0 0 20 20", [["circle", { fill: "currentColor", cx: "10", cy: "5", r: "1.5" }], ["circle", { fill: "currentColor", cx: "10", cy: "10", r: "1.5" }], ["circle", { fill: "currentColor", cx: "10", cy: "15", r: "1.5" }]]],
  compose: ["0 0 20 20", [["path", { s: true, d: "M11 4H5a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 5 16h9a1.5 1.5 0 0 0 1.5-1.5V9" }], ["path", { s: true, d: "m14.6 3.4 2 2-6.6 6.6H8v-2z" }]]],
  plus: ["0 0 20 20", [["path", { s: true, d: "M10 4.5v11M4.5 10h11" }]]],
  close: ["0 0 20 20", [["path", { s: true, d: "m5 5 10 10M15 5 5 15" }]]],
  check: ["0 0 20 20", [["path", { s: true, d: "m4 10.5 4 4 8-9" }]]],
  emoji: ["0 0 20 20", [["circle", { s: true, cx: "10", cy: "10", r: "7.5" }], ["path", { s: true, d: "M6.5 11.5c.7 1.5 2 2.3 3.5 2.3s2.8-.8 3.5-2.3" }], ["circle", { fill: "currentColor", cx: "7.5", cy: "8", r: "1" }], ["circle", { fill: "currentColor", cx: "12.5", cy: "8", r: "1" }]]],
  emoji_add: ["0 0 20 20", [["path", { s: true, d: "M17.4 11a7.5 7.5 0 1 1-8.4-8.4" }], ["path", { s: true, d: "M6.5 11.5c.7 1.5 2 2.3 3.5 2.3s2.8-.8 3.5-2.3" }], ["circle", { fill: "currentColor", cx: "7.5", cy: "8", r: "1" }], ["circle", { fill: "currentColor", cx: "12.5", cy: "8", r: "1" }], ["path", { s: true, d: "M15.5 2.5v5M13 5h5" }]]],
  thread: ["0 0 20 20", [["path", { s: true, d: "M4 4.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" }]]],
  reply: ["0 0 20 20", [["path", { s: true, d: "M8 5 3.5 9.5 8 14" }], ["path", { s: true, d: "M3.5 9.5H12a4.5 4.5 0 0 1 4.5 4.5v1.5" }]]],
  pin: ["0 0 20 20", [["path", { s: true, d: "M12.5 3.5l4 4-1.5 1.5-.5-.5-3 3 .5 3-1.5 1.5-3-3-4 4-1-1 4-4-3-3L5 8l3 .5 3-3-.5-.5z" }]]],
  pencil: ["0 0 20 20", [["path", { s: true, d: "m13.5 3.5 3 3L7 16H4v-3z" }], ["path", { s: true, d: "m11.5 5.5 3 3" }]]],
  trash: ["0 0 20 20", [["path", { s: true, d: "M4 5.5h12M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.5 5.5l.8 10a1 1 0 0 0 1 .9h5.4a1 1 0 0 0 1-.9l.8-10M8.5 8.5v5M11.5 8.5v5" }]]],
  link: ["0 0 20 20", [["path", { s: true, d: "M8.5 11.5a3 3 0 0 1 0-4.2l2-2a3 3 0 0 1 4.2 4.2l-1 1" }], ["path", { s: true, d: "M11.5 8.5a3 3 0 0 1 0 4.2l-2 2a3 3 0 0 1-4.2-4.2l1-1" }]]],
  at: ["0 0 20 20", [["circle", { s: true, cx: "10", cy: "10", r: "3" }], ["path", { s: true, d: "M13 10v1.5a1.5 1.5 0 0 0 3 0V10a6 6 0 1 0-2.4 4.8" }]]],
  bold: ["0 0 20 20", [["path", { s: true, "stroke-width": "1.8", d: "M6 4h4.5a2.75 2.75 0 0 1 0 5.5H6zM6 9.5h5.25a3 3 0 0 1 0 6H6z" }]]],
  italic: ["0 0 20 20", [["path", { s: true, d: "M8.5 4h6M5.5 16h6M11.5 4l-3 12" }]]],
  strike: ["0 0 20 20", [["path", { s: true, d: "M4 10h12M13.5 6.2C13 4.9 11.7 4 10 4 7.8 4 6.5 5.2 6.5 6.6c0 .6.2 1 .5 1.4M6.5 13.8c.5 1.3 1.8 2.2 3.5 2.2 2.2 0 3.5-1.2 3.5-2.6 0-.6-.2-1-.5-1.4" }]]],
  code: ["0 0 20 20", [["path", { s: true, d: "m7 6-4 4 4 4M13 6l4 4-4 4" }]]],
  code_block: ["0 0 20 20", [["rect", { s: true, x: "3", y: "4", width: "14", height: "12", rx: "1.5" }], ["path", { s: true, d: "m8.5 8-2 2 2 2M11.5 8l2 2-2 2" }]]],
  list_ol: ["0 0 20 20", [["path", { s: true, d: "M8 5.5h9M8 10h9M8 14.5h9M3.5 4.5 4.5 4v3M3.5 12.5h1.8c.5 0 .7.5.4.9L3.5 15.5h2.3" }]]],
  list_ul: ["0 0 20 20", [["path", { s: true, d: "M8 5.5h9M8 10h9M8 14.5h9" }], ["circle", { fill: "currentColor", cx: "4.5", cy: "5.5", r: "1" }], ["circle", { fill: "currentColor", cx: "4.5", cy: "10", r: "1" }], ["circle", { fill: "currentColor", cx: "4.5", cy: "14.5", r: "1" }]]],
  quote: ["0 0 20 20", [["path", { s: true, d: "M4 4v12M8 6h8M8 10h8M8 14h5" }]]],
  format: ["0 0 20 20", [["path", { s: true, d: "M4 5h12M4 10h12M4 15h7" }], ["path", { s: true, d: "M14 13v4" }]]],
  send: ["0 0 20 20", [["path", { fill: "currentColor", d: "M2.5 3.5 17.5 10 2.5 16.5l2-6.5zM5.5 10.5 4.2 14.8 14.3 10 4.2 5.2l1.3 4.3H10v1z" }]]],
  users: ["0 0 20 20", [["circle", { s: true, cx: "7.5", cy: "7", r: "2.75" }], ["path", { s: true, d: "M2.5 16a5 5 0 0 1 10 0" }], ["path", { s: true, d: "M12.5 4.6a2.75 2.75 0 0 1 0 4.8M14 11.3a5 5 0 0 1 3.5 4.7" }]]],
  user_add: ["0 0 20 20", [["circle", { s: true, cx: "8", cy: "7", r: "3" }], ["path", { s: true, d: "M2.5 16.5a5.5 5.5 0 0 1 11 0M15.5 6.5v5M13 9h5" }]]],
  info: ["0 0 20 20", [["circle", { s: true, cx: "10", cy: "10", r: "7.5" }], ["path", { s: true, d: "M10 9v5" }], ["circle", { fill: "currentColor", cx: "10", cy: "6.5", r: ".9" }]]],
  star: ["0 0 20 20", [["path", { s: true, d: "m10 3 2.1 4.4 4.9.6-3.6 3.3.9 4.8L10 13.8l-4.3 2.3.9-4.8L3 8l4.9-.6z" }]]],
  archive: ["0 0 20 20", [["path", { s: true, d: "M3 4.5h14v3H3zM4 7.5v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8M8 11h4" }]]],
  filter: ["0 0 20 20", [["path", { s: true, d: "M3 5h14M5.5 10h9M8 15h4" }]]],
  channel_browse: ["0 0 20 20", [["path", { s: true, d: "M7 3.5 5.5 12.5M12 3.5l-1.5 9M3.5 6.5h10M3 10.5h10" }], ["circle", { s: true, cx: "14.5", cy: "14", r: "2.5" }], ["path", { s: true, d: "m16.3 15.8 1.5 1.5" }]]],
  headphones: ["0 0 20 20", [["path", { s: true, d: "M4 12V10a6 6 0 0 1 12 0v2" }], ["rect", { s: true, x: "3", y: "11.5", width: "3.5", height: "5", rx: "1" }], ["rect", { s: true, x: "13.5", y: "11.5", width: "3.5", height: "5", rx: "1" }]]],
  refresh: ["0 0 20 20", [["path", { s: true, d: "M16 9.5A6 6 0 0 0 5.2 6.5M4 10.5a6 6 0 0 0 10.8 3" }], ["path", { s: true, d: "M4.5 3.5v3.5H8M15.5 16.5V13H12" }]]],
  spinner: ["0 0 20 20", [["path", { s: true, d: "M10 3a7 7 0 1 1-6.1 3.6" }]]],
  menu: ["0 0 20 20", [["path", { s: true, d: "M3 5.5h14M3 10h14M3 14.5h14" }]]],
  sort: ["0 0 20 20", [["path", { s: true, d: "M6 4v12M6 16l-2.5-2.5M6 16l2.5-2.5M14 16V4M14 4l-2.5 2.5M14 4l2.5 2.5" }]]],
  canvas: ["0 0 20 20", [["rect", { s: true, x: "3.5", y: "3.5", width: "13", height: "13", rx: "1.5" }], ["path", { s: true, d: "M6.5 7.5h7M6.5 10.5h7M6.5 13.5h4" }]]],
  hash_circle: ["0 0 20 20", [["circle", { s: true, cx: "10", cy: "10", r: "7.5" }], ["path", { s: true, d: "M8.5 6.5 7.5 13.5M12.5 6.5l-1 7M6.5 8.5h7M6 11.5h7" }]]],
  forward: ["0 0 20 20", [["path", { s: true, d: "M11.5 4.5 16.5 9l-5 4.5" }], ["path", { s: true, d: "M16.5 9H9a5 5 0 0 0-5 5v1.5" }]]],
  video: ["0 0 20 20", [["rect", { s: true, x: "2.5", y: "5.5", width: "10.5", height: "9", rx: "1.5" }], ["path", { s: true, d: "m13 9 4.5-2.5v7L13 11" }]]],
  mic: ["0 0 20 20", [["rect", { s: true, x: "7.5", y: "3", width: "5", height: "9", rx: "2.5" }], ["path", { s: true, d: "M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" }]]],
  slash: ["0 0 20 20", [["rect", { s: true, x: "3", y: "3", width: "14", height: "14", rx: "3" }], ["path", { s: true, d: "m11.5 6.5-3 7" }]]],
  drafts: ["0 0 20 20", [["path", { s: true, d: "M3 9.5 16.5 3.5 13 16.5l-3.5-4.5z" }], ["path", { s: true, d: "m9.5 12 7-8.5" }]]],
  directory: ["0 0 20 20", [["rect", { s: true, x: "4", y: "3", width: "12", height: "14", rx: "1.5" }], ["circle", { s: true, cx: "10", cy: "8.5", r: "2" }], ["path", { s: true, d: "M7 14a3 3 0 0 1 6 0" }]]],
  apps: ["0 0 20 20", [["rect", { s: true, x: "3.5", y: "3.5", width: "5", height: "5", rx: "1" }], ["rect", { s: true, x: "11.5", y: "3.5", width: "5", height: "5", rx: "1" }], ["rect", { s: true, x: "3.5", y: "11.5", width: "5", height: "5", rx: "1" }], ["rect", { s: true, x: "11.5", y: "11.5", width: "5", height: "5", rx: "1" }]]],
  files: ["0 0 20 20", [["path", { s: true, d: "M5.5 3h6l3.5 3.5V16a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" }], ["path", { s: true, d: "M11.5 3v3.5H15" }]]],
};

const NS = "http://www.w3.org/2000/svg";

/** Create one icon as an inline `<svg>` element (decorative; callers give labels to the surrounding control). */
export function icon(name, className = "") {
  const entry = Object.hasOwn(GLYPHS, name) ? GLYPHS[name] : GLYPHS.help;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", entry[0]);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `icon ${className}`.trim());
  svg.dataset.icon = name;
  for (const [tag, attributes] of entry[1]) {
    const element = document.createElementNS(NS, tag);
    if (attributes.s) for (const [key, value] of Object.entries(STROKE)) element.setAttribute(key, value);
    for (const [key, value] of Object.entries(attributes)) if (key !== "s") element.setAttribute(key, value);
    svg.append(element);
  }
  return svg;
}

/** Replace every `<span data-icon="…">` placeholder in `root` with its glyph. */
export function hydrateIcons(root = document) {
  for (const placeholder of root.querySelectorAll("span[data-icon]")) {
    const glyph = icon(placeholder.dataset.icon, placeholder.className);
    placeholder.replaceWith(glyph);
  }
}
