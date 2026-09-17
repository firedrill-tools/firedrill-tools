// Shared list rendering: data table, loading/empty/error/denied states and Trolley's page/pageSize pager.
import { icon } from "./icons.js";
import { ToolError, btn, describe, el } from "./ui.js";

export function loadingRows(columns, rows = 5) {
  return el("tbody", {}, Array.from({ length: rows }, () => el("tr", {}, columns.map(() => el("td", {}, el("div", { class: "skeleton" }))))));
}

export function stateBlock(glyph, title, message, action) {
  return el("div", { class: "state" }, [icon(glyph), el("h3", { text: title }), message ? el("div", { text: message }) : null, action ? el("div", { class: "state-action" }, action) : null]);
}

export function errorBlock(error, retry) {
  if (error instanceof ToolError && (error.denied || error.is("INVALID_API_KEY"))) {
    return stateBlock("lock", error.is("INVALID_API_KEY") ? "API key is invalid" : "Access denied", describe(error));
  }
  return stateBlock("info", "We couldn't load this", describe(error), retry ? btn("Try again", "secondary", { icon: "refresh", onClick: retry }) : null);
}

/**
 * columns: [{ label, key?, sortable?, num?, cell(row) }]
 * Returns { node, setLoading, setRows, setError }.
 */
export function dataTable(columns, { onRowClick, sort, onSort, caption } = {}) {
  const head = el("thead", {}, el("tr", {}, columns.map((column) => {
    if (!column.key || !onSort) return el("th", { class: column.num ? "num" : "", text: column.label, attrs: { scope: "col" } });
    const active = sort?.orderBy === column.key;
    const arrow = active ? (sort.sortBy === "asc" ? " ↑" : " ↓") : "";
    return el("th", { class: column.num ? "num" : "", attrs: { scope: "col", "aria-sort": active ? (sort.sortBy === "asc" ? "ascending" : "descending") : undefined } },
      el("button", { text: `${column.label}${arrow}`, attrs: { type: "button" }, on: { click: () => onSort(column.key) } }));
  })));
  const table = el("table", { class: "table" }, [caption ? el("caption", { class: "skip-link", text: caption }) : null, head, loadingRows(columns)]);
  const wrap = el("div", { class: "table-wrap" }, table);
  const extra = el("div");
  const node = el("div", {}, [wrap, extra]);
  const replaceBody = (body) => { table.tBodies[0]?.remove(); table.append(body); };
  return {
    node,
    setLoading() { extra.replaceChildren(); replaceBody(loadingRows(columns)); },
    setRows(rows, empty) {
      extra.replaceChildren();
      replaceBody(el("tbody", {}, rows.map((row) => {
        const tr = el("tr", { class: onRowClick ? "clickable" : "" }, columns.map((column) => {
          const content = column.cell(row);
          return el("td", { class: column.num ? "num" : "" }, content);
        }));
        if (onRowClick) {
          tr.tabIndex = 0;
          tr.addEventListener("click", (event) => { if (!event.target.closest("button, a")) onRowClick(row); });
          tr.addEventListener("keydown", (event) => { if (event.key === "Enter") onRowClick(row); });
        }
        return tr;
      })));
      if (rows.length === 0 && empty) extra.append(empty);
    },
    setError(error, retry) { replaceBody(el("tbody")); extra.replaceChildren(errorBlock(error, retry)); },
  };
}

/** Trolley meta: { page, pages, records }. */
export function pager(meta, pageSize, onChange) {
  const { page = 1, pages = 0, records = 0 } = meta ?? {};
  const first = records === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(records, page * pageSize);
  const sizeSelect = el("select", { class: "input", attrs: { "aria-label": "Rows per page" }, on: { change: (event) => onChange({ page: 1, pageSize: Number(event.target.value) }) } },
    [10, 25, 50, 100].map((size) => el("option", { text: `${size} per page`, attrs: { value: size, selected: size === pageSize } })));
  return el("div", { class: "pager" }, [
    el("span", { text: records === 0 ? "No results" : `Showing ${first}–${last} of ${records}` }),
    el("span", { class: "spacer" }),
    sizeSelect,
    el("span", { text: `Page ${pages === 0 ? 0 : page} of ${pages}` }),
    el("button", { class: "icon-btn", attrs: { type: "button", "aria-label": "Previous page", disabled: page <= 1 }, on: { click: () => onChange({ page: page - 1, pageSize }) } }, icon("chevronLeft")),
    el("button", { class: "icon-btn", attrs: { type: "button", "aria-label": "Next page", disabled: page >= pages }, on: { click: () => onChange({ page: page + 1, pageSize }) } }, icon("chevronRight")),
  ]);
}

export function searchBox(placeholder, value, onInput) {
  let timer;
  const inputNode = el("input", { class: "input", attrs: { type: "search", placeholder, value: value ?? "", "aria-label": placeholder } });
  inputNode.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => onInput(inputNode.value.trim()), 300); });
  return el("div", { class: "search" }, [icon("search"), inputNode]);
}

export function tabs(items, active, onSelect) {
  return el("div", { class: "tabs", attrs: { role: "tablist" } }, items.map(([value, label]) =>
    el("button", { class: "tab", text: label, attrs: { type: "button", role: "tab", "aria-selected": value === active ? "true" : "false" }, on: { click: () => onSelect(value) } })));
}
