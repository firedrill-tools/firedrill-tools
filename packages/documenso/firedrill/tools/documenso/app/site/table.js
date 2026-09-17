// Shared data-table pieces: pagination footer and loading skeleton.
import { icon } from "./icons.js";
import { el } from "./ui.js";

/** DataTablePagination: "Showing N results." · Rows per page · Page x of y · first/prev/next/last. */
export function pagination(result, onChange, sizes = [10, 20, 30, 40, 50]) {
  const totalPages = Math.max(1, result.totalPages);
  const current = Math.min(result.currentPage, totalPages);
  const visible = result.data.length;
  const select = el("select", { attrs: { "aria-label": "Rows per page" } }, sizes.map((n) => el("option", { text: String(n), attrs: { value: n, selected: n === result.perPage } })));
  select.addEventListener("change", () => onChange({ perPage: select.value, page: null }));
  const nav = (label, name, page, disabled) => {
    const b = el("button", { class: "btn btn-outline", attrs: { type: "button", "aria-label": label, title: label, disabled } }, icon(name));
    b.addEventListener("click", () => onChange({ page }));
    return b;
  };
  return el("div", { class: "pagination" }, [
    el("div", { text: `Showing ${visible} result${visible === 1 ? "" : "s"} of ${result.count}.` }),
    el("div", { class: "pagination-right" }, [
      el("label", { class: "per-page" }, [el("span", { text: "Rows per page" }), select]),
      el("div", { class: "page-of", text: `Page ${current} of ${totalPages}` }),
      el("div", { class: "page-btns" }, [
        nav("Go to first page", "chevronsLeft", 1, current <= 1),
        nav("Go to previous page", "chevronLeft", current - 1, current <= 1),
        nav("Go to next page", "chevronRight", current + 1, current >= totalPages),
        nav("Go to last page", "chevronsRight", totalPages, current >= totalPages),
      ]),
    ]),
  ]);
}

export function skeletonRows(headers, rows = 5) {
  const body = el("tbody");
  for (let i = 0; i < rows; i += 1) {
    body.append(el("tr", {}, headers.map((h, index) => el("td", {}, el("span", { class: `skeleton ${h === "Recipient" ? "round" : ""}`, attrs: { "aria-hidden": "true" } }))).map((td, index) => {
      td.firstChild.classList.add(index === 1 ? "w-40" : "w-20");
      return td;
    })));
  }
  return el("div", { class: "table-wrap", attrs: { "aria-busy": "true" } }, el("table", { class: "data" }, [el("thead", {}, el("tr", {}, headers.map((h) => el("th", { text: h })))), body]));
}
