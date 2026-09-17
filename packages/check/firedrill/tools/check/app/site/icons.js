// Monochrome interface glyphs drawn for this package on a 24px grid, in the light stroke-weight
// style of the Console's navigation. No third-party icon font or brand asset is embedded here.
const NS = "http://www.w3.org/2000/svg";
const PATHS = {
  home: "M12 3 3 10.2V21h6.2v-5.8h5.6V21H21V10.2L12 3Zm0 2.6 7 5.6V19.2h-2.4v-5.8H7.4v5.8H5V11.2l7-5.6Z",
  building: "M4 3h10v6h6v12H4V3Zm1.8 1.8v14.4h6.4V4.8H5.8Zm8.2 6v8.4h4.2v-8.4H14ZM7.2 6.6h3v1.8h-3V6.6Zm0 3.6h3V12h-3v-1.8Zm0 3.6h3v1.8h-3v-1.8Zm8.4-1.2h1.8v1.8h-1.8v-1.8Zm0 3.6h1.8v1.8h-1.8V16.2Z",
  people: "M9 4a3.4 3.4 0 1 1 0 6.8A3.4 3.4 0 0 1 9 4Zm0 1.8a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2Zm7 .2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6Zm0 1.8a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM9 12.2c3 0 5.4 1.5 5.4 3.6V20H3.6v-4.2c0-2.1 2.4-3.6 5.4-3.6Zm0 1.8c-2.2 0-3.6.9-3.6 1.8v2.4h7.2v-2.4c0-.9-1.4-1.8-3.6-1.8Zm7-.6c2.5 0 4.4 1.2 4.4 2.9V20h-4.2v-4.2c0-.7-.3-1.4-.9-1.9l.7-.1Z",
  badge: "M9.4 2h5.2v2H19a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4.4V2Zm-3.6 3.8v13.4h12.4V5.8H14.6v1.6H9.4V5.8H5.8ZM12 9.2a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Zm0 5.2c2.3 0 4 1 4 2.3v.7H8v-.7c0-1.3 1.7-2.3 4-2.3Z",
  money: "M3 5.5h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Zm.8 1.8v9.4h16.4V7.3H3.8ZM12 9.1a2.9 2.9 0 1 1 0 5.8 2.9 2.9 0 0 1 0-5.8Zm0 1.8a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2ZM5.6 9.1h1.8v1.8H5.6V9.1Zm11 4.2h1.8v1.8h-1.8v-1.8Z",
  pin: "M12 2.4a6.6 6.6 0 0 1 6.6 6.6c0 4.5-5.4 11.1-6.1 11.9a.7.7 0 0 1-1 0C10.8 20.1 5.4 13.5 5.4 9A6.6 6.6 0 0 1 12 2.4Zm0 1.8A4.8 4.8 0 0 0 7.2 9c0 3 3.2 7.6 4.8 9.7 1.6-2.1 4.8-6.7 4.8-9.7A4.8 4.8 0 0 0 12 4.2Zm0 2.4a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z",
  calendar: "M8 2.4v1.8h8V2.4h1.8v1.8H20a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.2a1 1 0 0 1 1-1h2.2V2.4H8ZM4.8 9.2v10h14.4v-10H4.8Zm0-3.2v1.4h14.4V6H4.8Zm2 5h2.4v2.4H6.8V11Zm4.2 0h2.4v2.4H11V11Zm4.2 0h2.4v2.4h-2.4V11Zm-8.4 4.2h2.4v2.4H6.8v-2.4Zm4.2 0h2.4v2.4H11v-2.4Z",
  doc: "M6 2h8l4 4v16H6V2Zm1.8 1.8v16.4h8.4V7.6H13V3.8H7.8Zm1.8 6.4h4.8V12H9.6v-1.8Zm0 3.4h4.8v1.8H9.6v-1.8Z",
  bank: "M12 2.4 21.6 7.2v2H2.4v-2L12 2.4Zm0 2L6.7 7.4h10.6L12 4.4ZM5 11h2.4v6.2H5V11Zm5.8 0h2.4v6.2h-2.4V11Zm5.8 0H19v6.2h-2.4V11ZM2.4 19h19.2v2.2H2.4V19Z",
  code: "M9 6.4 10.3 7.7 6 12l4.3 4.3L9 17.6 3.4 12 9 6.4Zm6 0L20.6 12 15 17.6l-1.3-1.3L18 12l-4.3-4.3L15 6.4Z",
  gear: "M13.6 2.4l.4 2.3c.5.2 1 .4 1.5.8l2.2-.8 1.6 2.8-1.8 1.5a6 6 0 0 1 0 1.7l1.8 1.5-1.6 2.8-2.2-.8c-.5.3-1 .6-1.5.8l-.4 2.3h-3.2l-.4-2.3a5.7 5.7 0 0 1-1.5-.8l-2.2.8-1.6-2.8L6.1 11a6 6 0 0 1 0-1.7L4.3 7.8 5.9 5l2.2.8c.5-.4 1-.6 1.5-.8l.4-2.3h3.6ZM12 8.6a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Z",
  menu: "M3 5.4h18v2H3v-2Zm0 5.6h18v2H3v-2Zm0 5.6h18v2H3v-2Z",
  bell: "M12 2.2c.9 0 1.6.7 1.6 1.6v.5a5.8 5.8 0 0 1 4.2 5.5v3.9l1.8 2.3v1H4.4v-1l1.8-2.3V9.8a5.8 5.8 0 0 1 4.2-5.5v-.5c0-.9.7-1.6 1.6-1.6Zm-2.2 16.6h4.4a2.2 2.2 0 0 1-4.4 0Z",
  search: "M10.6 3.2a7.4 7.4 0 0 1 5.8 12l4.2 4.2-1.4 1.4-4.2-4.2a7.4 7.4 0 1 1-4.4-13.4Zm0 1.8a5.6 5.6 0 1 0 0 11.2 5.6 5.6 0 0 0 0-11.2Z",
  plus: "M11 4.4h2v6.6h6.6v2H13v6.6h-2V13H4.4v-2H11V4.4Z",
  close: "M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4 6.4 5Z",
  chevronLeft: "M15.2 5.4 13.8 4l-8 8 8 8 1.4-1.4L8.6 12l6.6-6.6Z",
  chevronRight: "M8.8 5.4 10.2 4l8 8-8 8-1.4-1.4L15.4 12 8.8 5.4Z",
  chevronDown: "M5.4 8.8 4 10.2l8 8 8-8-1.4-1.4L12 15.4 5.4 8.8Z",
  check: "M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7 9.5 16.2Z",
  info: "M12 2.2a9.8 9.8 0 1 1 0 19.6 9.8 9.8 0 0 1 0-19.6Zm-1 8.3V17h2v-6.5h-2ZM12 6.6a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z",
  warn: "M12 2.6 22.4 20.6H1.6L12 2.6Zm0 3.9L4.9 18.8h14.2L12 6.5Zm-1 3.7v4.4h2V10.1h-2Zm0 5.6v1.9h2v-1.9h-2Z",
  lock: "M12 2.2a4.8 4.8 0 0 1 4.8 4.8v2.8H18a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1.2V7A4.8 4.8 0 0 1 12 2.2Zm0 1.8A3 3 0 0 0 9 7v2.8h6V7a3 3 0 0 0-3-3Z",
  more: "M12 4.6a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6Zm0 5.6a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6Zm0 5.6a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6Z",
  refresh: "M12 4a8 8 0 0 1 7.4 5H22l-3.5 4.5L15 9h2.2A6 6 0 1 0 18 14h2.1A8 8 0 1 1 12 4Z",
  trash: "M9 2.6h6l.8 1.6H20V6H4V4.2h4.2L9 2.6ZM5.6 7.4h12.8V21a1 1 0 0 1-1 1H6.6a1 1 0 0 1-1-1V7.4Zm1.8 1.8v11h9.2v-11H7.4Zm2 1.8h1.8v7.4H9.2v-7.4Zm3.6 0h1.8v7.4h-1.8v-7.4Z",
  edit: "M16.8 2.6 21.4 7.2 8.6 20H4v-4.6L16.8 2.6Zm0 2.6L5.8 16.2v2h2L18.8 7.2l-2-2Z",
  clock: "M12 2.2a9.8 9.8 0 1 1 0 19.6 9.8 9.8 0 0 1 0-19.6Zm0 1.8a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm-.9 2.6h1.8v5.1l3.5 2-.9 1.6-4.4-2.6V6.6Z",
  play: "M7 4.2 19.4 12 7 19.8V4.2Zm1.8 3.3v9L16 12 8.8 7.5Z",
  arrowLeft: "M11.4 4 12.8 5.4 7.2 11H20v2H7.2l5.6 5.6L11.4 20 3.4 12l8-8Z",
  download: "M11 3h2v9.2l3.3-3.3 1.4 1.4-5.7 5.7-5.7-5.7 1.4-1.4L11 12.2V3ZM4 18h16v2H4v-2Z",
};
export function icon(name, cls = "") {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (cls) svg.setAttribute("class", cls);
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", Object.hasOwn(PATHS, name) ? PATHS[name] : PATHS.info);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}
export function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll("[data-icon]")) {
    node.replaceChildren(icon(node.dataset.icon));
    delete node.dataset.icon;
  }
}
