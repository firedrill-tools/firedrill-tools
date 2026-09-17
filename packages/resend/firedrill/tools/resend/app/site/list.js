// Cursor paging shared by every list screen: forward with `after` = last id, back through a stack of earlier cursors.
import { button, el } from "./ui.js";

export class Cursor {
  constructor() { this.reset(); }
  reset() { this.stack = []; this.after = undefined; }
  get page() { return this.stack.length + 1; }
  args() { return this.after === undefined ? {} : { after: this.after }; }
  next(lastId) { this.stack.push(this.after); this.after = lastId; }
  prev() { this.after = this.stack.pop(); }
}

/** Renders "Page N" with Previous / Next controls; `onChange` re-reads the list. */
export function pagerBar(cursor, list, onChange, noun = "items") {
  const prev = button("Previous", { size: "sm", iconName: "chevronLeft", attrs: { disabled: cursor.page === 1, "aria-label": `Previous page of ${noun}` }, onClick: () => { cursor.prev(); onChange(); } });
  const next = button("Next", { size: "sm", attrs: { disabled: !list.has_more, "aria-label": `Next page of ${noun}` }, onClick: () => { cursor.next(list.data[list.data.length - 1].id); onChange(); } });
  const count = list.data.length;
  return el("div", { class: "pager" }, [
    el("span", { text: count === 0 ? `Page ${cursor.page}` : `Page ${cursor.page} · ${count} ${noun}` }),
    el("div", { class: "btns" }, [prev, next]),
  ]);
}

/** A table with a header row; `body` is a tbody. */
export function table(headers, body, label) {
  const head = el("thead", {}, [el("tr", {}, headers.map((h) => el("th", { text: h, attrs: { scope: "col" } })))]);
  return el("div", { class: "table-wrap" }, [el("table", { class: "table", attrs: { "aria-label": label } }, [head, body])]);
}

/** Makes a clickable row keyboard accessible. */
export function linkRow(cells, href, label) {
  const row = el("tr", { class: "row", attrs: { tabindex: "0", "aria-label": label } }, cells);
  row.addEventListener("click", (event) => { if (!event.target.closest("button, a, input")) location.hash = href; });
  row.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target === row) location.hash = href; });
  return row;
}

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}
