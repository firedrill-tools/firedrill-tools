// Monochrome interface glyphs drawn for this package (24px grid, solid/rounded like the dashboard's rail icons).
const NS = "http://www.w3.org/2000/svg";
const PATHS = {
  gauge: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm3.9 5.2-2.6 5.9a1.6 1.6 0 1 1-2.2-1.4l4.8-4.5Z",
  user: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4a3.4 3.4 0 1 1 0 6.8A3.4 3.4 0 0 1 12 6Zm0 14a8 8 0 0 1-6-2.7c.9-2 3.2-3.1 6-3.1s5.1 1.1 6 3.1A8 8 0 0 1 12 20Z",
  money: "M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm1.5 2v8h15V8h-15ZM12 9.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6Z",
  receipt: "M5 2h14v20l-2.3-1.5L14.3 22 12 20.5 9.7 22l-2.4-1.5L5 22V2Zm3 5v1.6h8V7H8Zm0 4v1.6h8V11H8Zm0 4v1.6h5V15H8Z",
  coins: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3Zm-8 5.4C5.6 9.6 8.6 10.4 12 10.4s6.4-.8 8-2V11c0 1.7-3.6 3-8 3s-8-1.3-8-3V8.4Zm0 5C5.6 14.6 8.6 15.4 12 15.4s6.4-.8 8-2V16c0 1.7-3.6 3-8 3s-8-1.3-8-3v-2.6Zm0 5c1.6 1.2 4.6 2 8 2s6.4-.8 8-2V19c0 1.7-3.6 3-8 3s-8-1.3-8-3v-.6Z",
  calculator: "M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm1 2.5V8h10V4.5H7ZM7 10v2h2v-2H7Zm4 0v2h2v-2h-2Zm4 0v2h2v-2h-2ZM7 14v2h2v-2H7Zm4 0v2h2v-2h-2Zm4 0v5h2v-5h-2ZM7 18v2h2v-2H7Zm4 0v2h2v-2h-2Z",
  chart: "M3 3h2v16h16v2H3V3Zm15.3 3.3 1.4 1.4-5.2 5.2-3-3-3.8 3.8-1.4-1.4 5.2-5.2 3 3 3.8-3.8Z",
  checkbox: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 2v14h14V5H5Zm11.3 3.3 1.4 1.4-7.2 7.2-4.2-4.2 1.4-1.4 2.8 2.8 5.8-5.8Z",
  code: "M8.7 6.3 10.1 7.7 5.8 12l4.3 4.3-1.4 1.4L3 12l5.7-5.7Zm6.6 0L21 12l-5.7 5.7-1.4-1.4 4.3-4.3-4.3-4.3 1.4-1.4Z",
  gear: "M13.8 2l.5 2.6c.6.2 1.2.5 1.7.9l2.5-.9 1.8 3.1-2 1.7a7 7 0 0 1 0 1.9l2 1.7-1.8 3.1-2.5-.9c-.5.4-1.1.7-1.7.9l-.5 2.6h-3.6l-.5-2.6a6.5 6.5 0 0 1-1.7-.9l-2.5.9-1.8-3.1 2-1.7a7 7 0 0 1 0-1.9l-2-1.7 1.8-3.1 2.5.9c.5-.4 1.1-.7 1.7-.9l.5-2.6h3.6ZM12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z",
  menu: "M3 5h18v2.2H3V5Zm0 5.9h18v2.2H3v-2.2Zm0 5.9h18V19H3v-2.2Z",
  bell: "M12 2a1.5 1.5 0 0 1 1.5 1.5v.7A6 6 0 0 1 18 10v4.6l2 2.4v1H4v-1l2-2.4V10a6 6 0 0 1 4.5-5.8v-.7A1.5 1.5 0 0 1 12 2Zm-2.3 17h4.6a2.3 2.3 0 0 1-4.6 0Z",
  search: "M10.5 3a7.5 7.5 0 0 1 6 12l4.3 4.3-1.5 1.5-4.3-4.3A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z",
  plus: "M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4Z",
  close: "M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4 6.4 5Z",
  chevronLeft: "M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12l6.6-6.6Z",
  chevronRight: "M8.6 5.4 10 4l8 8-8 8-1.4-1.4 6.6-6.6-6.6-6.6Z",
  chevronDown: "M5.4 8.6 4 10l8 8 8-8-1.4-1.4L12 15.2 5.4 8.6Z",
  bank: "M12 2 22 7v2H2V7l10-5Zm-7 9h2.5v7H5v-7Zm5.7 0h2.6v7h-2.6v-7Zm5.8 0H19v7h-2.5v-7ZM2 20h20v2H2v-2Z",
  paypal: "M7 3h6.5c3.2 0 5 1.6 4.6 4.4-.5 3.4-2.8 5-6 5H9.8L8.9 18H5.2L7 3Zm2.9 3-.6 3.8h1.6c1.4 0 2.3-.7 2.5-2 .2-1.2-.4-1.8-1.7-1.8H9.9ZM18.9 8.6c.9.8 1.2 2 1 3.4-.5 3.3-2.8 4.9-6 4.9h-1.2l-.8 5.1H8.3l.3-2h2l.8-5.1H13c2.9 0 5.3-1.9 5.9-6.3Z",
  check: "M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7 9.5 16.2Z",
  mail: "M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm1 2.3V17h16V7.3l-8 5.3-8-5.3ZM5.8 7 12 11.1 18.2 7H5.8Z",
  phone: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm0 3v13h8V5H8Zm3 14.2v1.3h2v-1.3h-2Z",
  info: "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm-1 8.5V17h2v-6.5h-2ZM12 6.6a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z",
  lock: "M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5Zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3Z",
  more: "M12 4.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6Zm0 5.7a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6Zm0 5.7a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6Z",
  refresh: "M12 4a8 8 0 0 1 7.4 5H22l-3.5 4.5L15 9h2.2A6 6 0 1 0 18 14h2.1A8 8 0 1 1 12 4Z",
};
export function icon(name, cls = "") {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (cls) svg.setAttribute("class", cls);
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", PATHS[name] ?? PATHS.info);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}
export function hydrateIcons(root = document) {
  for (const slot of root.querySelectorAll("[data-icon]")) {
    if (slot.firstChild) continue;
    slot.append(icon(slot.getAttribute("data-icon")));
    slot.classList.add("icon-slot");
  }
}
