// Monochrome 24px interface glyphs (original paths) and the six coloured reaction badges.
const NS = "http://www.w3.org/2000/svg";

const PATHS = {
  "nav-home": "M23 9v2h-2v7a3 3 0 01-3 3h-4v-6h-4v6H6a3 3 0 01-3-3v-7H1V9l11-7 5 3.18V2h3v5.09z",
  "nav-network": "M12 16v6H3v-6a3 3 0 013-3h3a3 3 0 013 3zm5.5-3A3.5 3.5 0 1014 9.5a3.5 3.5 0 003.5 3.5zm1 2h-2a2.5 2.5 0 00-2.5 2.5V22h7v-4.5a2.5 2.5 0 00-2.5-2.5zM7.5 2A4.5 4.5 0 1012 6.5 4.49 4.49 0 007.5 2z",
  "nav-jobs": "M17 6V5a3 3 0 00-3-3h-4a3 3 0 00-3 3v1H2v4a3 3 0 003 3h14a3 3 0 003-3V6zM9 5a1 1 0 011-1h4a1 1 0 011 1v1H9zm10 9a4 4 0 003-1.38V17a3 3 0 01-3 3H5a3 3 0 01-3-3v-4.38A4 4 0 005 14z",
  "nav-messaging": "M16 4H8a7 7 0 000 14h4v4l8.16-5.39A6.78 6.78 0 0023 11a7 7 0 00-7-7zm-8 8.25A1.25 1.25 0 119.25 11 1.25 1.25 0 018 12.25zm4 0A1.25 1.25 0 1113.25 11 1.25 1.25 0 0112 12.25zm4 0A1.25 1.25 0 1117.25 11 1.25 1.25 0 0116 12.25z",
  "nav-bell": "M22 19h-8.28a2 2 0 11-3.44 0H2v-1a4.52 4.52 0 011.17-2.83l1-1.17h15.7l1 1.17A4.42 4.42 0 0122 18zM18.21 7.44A6.27 6.27 0 0012 2a6.27 6.27 0 00-6.21 5.44L5 13h14z",
  "nav-grid": "M3 3h4v4H3zm7 4h4V3h-4zm7-4v4h4V3zM3 14h4v-4H3zm7 0h4v-4h-4zm7 0h4v-4h-4zM3 21h4v-4H3zm7 0h4v-4h-4zm7 0h4v-4h-4z",
  search: "M14.56 12.44L11.3 9.18a5.51 5.51 0 10-2.12 2.12l3.26 3.26a1.5 1.5 0 102.12-2.12zM3 6.5A3.5 3.5 0 116.5 10 3.5 3.5 0 013 6.5z",
  "caret-down": "M8 11L3 6h10z",
  like: "M19.46 11l-3.91-3.91a7 7 0 01-1.69-2.74l-.49-1.47A2.76 2.76 0 0010.76 1 2.75 2.75 0 008 3.74v1.12a9.19 9.19 0 00.46 2.85L8.89 9H4.12A2.12 2.12 0 002 11.12a2.16 2.16 0 00.92 1.76A2.11 2.11 0 002 14.62a2.14 2.14 0 001.28 2 2 2 0 00-.28 1 2.12 2.12 0 002 2.12v.14A2.12 2.12 0 007.12 22h7.49a8.08 8.08 0 003.58-.84l.31-.16H21V11zM19 19h-1l-.73.37a6.14 6.14 0 01-2.69.63H7.72a1 1 0 01-1-.72l-.25-.87-.85-.41A1 1 0 015 17l.17-1-.76-.74A1 1 0 014.27 14l.66-1.09-.73-1.1a.49.49 0 01.08-.7.48.48 0 01.34-.11h7.05l-1.31-3.92A7 7 0 0110 4.86V3.75a.77.77 0 01.75-.75.75.75 0 01.71.51L12 5a9 9 0 002.13 3.5l4.5 4.5H19z",
  comment: "M7 9h10v1H7zm0 4h7v-1H7zm16-2a6.78 6.78 0 01-2.84 5.61L12 22v-4H8A7 7 0 018 4h8a7 7 0 017 7zm-2 0a5 5 0 00-5-5H8a5 5 0 000 10h6v2.28L19 15a4.79 4.79 0 002-4z",
  repost: "M13.96 5H6c-.55 0-1 .45-1 1v10H3V6c0-1.66 1.34-3 3-3h7.96L12 0h2.37L17 4l-2.63 4H12l1.96-3zm5.54 3H19v10c0 .55-.45 1-1 1h-7.96L12 16H9.63L7 20l2.63 4H12l-1.96-3H18c1.66 0 3-1.34 3-3V8h-1.5z",
  send: "M21 3L0 10l7.66 4.26L16 8l-6.26 8.34L14 24l7-21z",
  ellipsis: "M14 12a2 2 0 11-2-2 2 2 0 012 2zM4 10a2 2 0 102 2 2 2 0 00-2-2zm16 0a2 2 0 102 2 2 2 0 00-2-2z",
  close: "M13.42 12L20 18.58 18.58 20 12 13.42 5.42 20 4 18.58 10.58 12 4 5.42 5.42 4 12 10.58 18.58 4 20 5.42z",
  "close-sm": "M14 3.41L9.41 8 14 12.59 12.59 14 8 9.41 3.41 14 2 12.59 6.59 8 2 3.41 3.41 2 8 6.59 12.59 2z",
  globe: "M8 1a7 7 0 107 7 7 7 0 00-7-7zM3 8a5 5 0 011-3l.55.55A1.5 1.5 0 015 6.62v1.07a.75.75 0 00.22.53l.56.56a.75.75 0 00.53.22H7v.69a.75.75 0 00.22.53l.56.56a.75.75 0 01.22.53V13a5 5 0 01-5-5zm6.24 4.83l2-2.46a.75.75 0 00.09-.8l-.58-1.16A.76.76 0 0010 8H7v-.19a.51.51 0 01.28-.45l.38-.19a.74.74 0 01.68 0L9 7.5l.38-.7a1 1 0 00.12-.48v-.85a.78.78 0 01.21-.53l1.07-1.09a5 5 0 01-1.54 9z",
  people: "M9.5 8A2.5 2.5 0 107 5.5 2.5 2.5 0 009.5 8zm0 1C7.57 9 6 10.12 6 11.5V13h7v-1.5C13 10.12 11.43 9 9.5 9zM4.5 7A1.5 1.5 0 103 5.5 1.5 1.5 0 004.5 7zM5 11.5a3.16 3.16 0 01.52-1.72A2.47 2.47 0 004.5 9.5C3.12 9.5 2 10.29 2 11.25V13h3z",
  lock: "M12 7V6a4 4 0 00-8 0v1H3v8h10V7zM6 6a2 2 0 014 0v1H6z",
  pencil: "M21.13 2.86a3 3 0 00-4.17 0l-13 13L2 22l6.19-2L21.13 7a3 3 0 000-4.16zM6.77 18.57l-1.35-1.34L16.64 6 18 7.35z",
  trash: "M20 4v1H4V4a1 1 0 011-1h4a1 1 0 011-1h4a1 1 0 011 1h4a1 1 0 011 1zM5 6h14v13a3 3 0 01-3 3H8a3 3 0 01-3-3zm9 13h1V9h-1zm-5 0h1V9H9z",
  "comment-off": "M2.41 1L1 2.41l3.13 3.13A7 7 0 008 18h4v4l5.3-3.5 4.29 4.29L23 21.41zM8 16a5 5 0 01-2.44-9.36L14.92 16zm15-5a6.83 6.83 0 01-2.23 5.13l-1.42-1.42A4.87 4.87 0 0021 11a5 5 0 00-5-5H9.24l-2-2H16a7 7 0 017 7z",
  link: "M18 10.5a3.5 3.5 0 01-1 2.5l-3.5 3.5a3.5 3.5 0 01-5-5l.5-.5 1.4 1.4-.5.5a1.5 1.5 0 002.1 2.1l3.5-3.5a1.5 1.5 0 00-2.1-2.1l-.4.4L11.6 8l.4-.4a3.5 3.5 0 016 2.9zM12.4 16l-.4.4a1.5 1.5 0 01-2.1-2.1l3.5-3.5a1.5 1.5 0 012.1 0L17 9.4a3.5 3.5 0 00-5-.4L8.5 12.5a3.5 3.5 0 005 5l.4-.4z",
  photo: "M19 4H5a3 3 0 00-3 3v10a3 3 0 003 3h14a3 3 0 003-3V7a3 3 0 00-3-3zm1 13a1 1 0 01-.29.71L16 14l-2 2-6-6-4 4V7a1 1 0 011-1h14a1 1 0 011 1zm-2-7a2 2 0 11-2-2 2 2 0 012 2z",
  video: "M19 4H5a3 3 0 00-3 3v10a3 3 0 003 3h14a3 3 0 003-3V7a3 3 0 00-3-3zm-9 12V8l6 4z",
  article: "M21 3v2H3V3zm-6 6h6V7h-6zm0 4h6v-2h-6zm0 4h6v-2h-6zM3 21h18v-2H3zM13 7H3v10h10z",
  bookmark: "M13 4a3 3 0 00-3-3H3v14l5-4.5 5 4.5z",
  group: "M8.5 7h-1A1.5 1.5 0 006 8.5V14h4V8.5A1.5 1.5 0 008.5 7zM12.75 8h-.5A1.25 1.25 0 0011 9.25V14h3V9.25A1.25 1.25 0 0012.75 8zM3.75 8h-.5A1.25 1.25 0 002 9.25V14h3V9.25A1.25 1.25 0 003.75 8zM8 6a2 2 0 10-2-2 2 2 0 002 2zm4.5 1A1.5 1.5 0 1011 5.5 1.5 1.5 0 0012.5 7zm-9 0A1.5 1.5 0 102 5.5 1.5 1.5 0 003.5 7z",
  newsletter: "M13 13H3V3h10zM2 1a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1V2a1 1 0 00-1-1zm3 4h6v1H5zm0 2.5h6v1H5zM5 10h4v1H5z",
  calendar: "M2 2v9a3 3 0 003 3h6a3 3 0 003-3V2zm10 9a1 1 0 01-1 1H5a1 1 0 01-1-1V6h8zM7 8H5V7h2zm4 0H8V7h3zM7 11H5v-1h2zm4 0H8v-1h3z",
  info: "M12 2a10 10 0 1010 10A10 10 0 0012 2zm1 15h-2v-6h2zm0-8h-2V7h2z",
  "arrow-up": "M12 3l7 7-1.4 1.4-4.6-4.6V21h-2V6.8L6.4 11.4 5 10z",
  plus: "M21 13h-8v8h-2v-8H3v-2h8V3h2v8h8z",
  emoji: "M8 1a7 7 0 107 7 7 7 0 00-7-7zm3 3.5A1.5 1.5 0 119.5 6 1.5 1.5 0 0111 4.5zm-6 0A1.5 1.5 0 113.5 6 1.5 1.5 0 015 4.5zM8 13a4.5 4.5 0 01-4.24-3h8.48A4.5 4.5 0 018 13z",
  check: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  alert: "M12 2a10 10 0 1010 10A10 10 0 0012 2zm1 15h-2v-2h2zm0-4h-2V7h2z",
  "back": "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z",
};
const SMALL = new Set(["caret-down", "close-sm", "globe", "people", "lock", "bookmark", "group", "newsletter", "calendar", "emoji"]);

/** An `<svg>` glyph filled with currentColor. */
export function icon(name, className) {
  const svg = document.createElementNS(NS, "svg");
  const size = SMALL.has(name) ? 16 : 24;
  svg.setAttribute("viewBox", name === "search" ? "0 0 16 16" : `0 0 ${size} ${size}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `icon icon--${name}${className ? ` ${className}` : ""}`);
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", PATHS[name] ?? PATHS.info);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

/** Replace every `[data-icon]` placeholder under root with its glyph. */
export function hydrateIcons(root = document) {
  for (const holder of root.querySelectorAll("[data-icon]")) {
    const name = holder.getAttribute("data-icon");
    holder.removeAttribute("data-icon");
    holder.append(icon(name));
  }
}

export { reactionBadge, REACTIONS } from "./reactions.js";
