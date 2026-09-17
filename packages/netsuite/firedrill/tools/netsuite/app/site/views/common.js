// Page scaffolding shared by every screen: list views, the NetSuite paging strip, record headers,
// field groups and the standard record button row.
import { $, el, icon, money } from "../ui.js";
import { notSimulated } from "../overlay.js";
import { app, statusClass } from "../store.js";

export function pill(status) {
  const name = status?.refName ?? status ?? "";
  return el("span", { class: `pill ${statusClass(name)}`, text: name });
}

export function link(text, href, extra = {}) {
  return el("a", { href, text, ...extra });
}

export function toolbarButton(label, run, { kind = "", disabled = false, title } = {}) {
  return el("button", { type: "button", class: `btn ${kind}`, text: label, disabled, title, onclick: run });
}
/** A control the real product shows here but this Tool does not implement. */
export function nsButton(label, { kind = "" } = {}) {
  return el("button", { type: "button", class: `btn ${kind}`, text: label, title: "Not simulated by this Tool", onclick: () => notSimulated(label) });
}

/** The NetSuite list-view frame: title row, optional filter bar, a grid body and the paging strip. */
export function listShell({ title, subtitle, actions = [], filter, tabs, columns, body, pager }) {
  const head = el("header", { class: "listhead" }, [
    el("h1", { text: title }),
    subtitle ? el("span", { class: "count", text: subtitle }) : null,
    el("span", { class: "grow" }),
    ...actions,
  ]);
  const table = el("table", { class: "grid" }, [
    el("thead", {}, el("tr", {}, columns.map((column) =>
      el("th", { class: column.numeric ? "num" : "", scope: "col", text: column.label })))),
    body,
  ]);
  return el("section", { class: "listview" }, [
    head,
    tabs ?? null,
    filter ?? null,
    el("div", { class: "tablewrap" }, table),
    pager ?? null,
  ]);
}

/** NetSuite's "1 to 25 of 137" strip with page size, previous and next. */
export function pagerStrip({ offset, shown, total, hasMore, pageSize, onOffset, onPageSize }) {
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + shown;
  const sizeId = "page-size";
  return el("div", { class: "pager" }, [
    el("label", { class: "fl", for: sizeId, text: "Rows per page" }),
    el("select", {
      id: sizeId,
      onchange: (event) => onPageSize(Number(event.currentTarget.value)),
    }, [10, 25, 50].map((size) => el("option", { value: String(size), text: String(size), selected: size === pageSize }))),
    el("span", { class: "grow" }),
    el("span", { text: `${from} to ${to} of ${total}` }),
    el("button", {
      type: "button", class: "btn", disabled: offset === 0, "aria-label": "Previous page",
      onclick: () => onOffset(Math.max(0, offset - pageSize)),
    }, [icon("chevronLeft", 14)]),
    el("button", {
      type: "button", class: "btn", disabled: !hasMore, "aria-label": "Next page",
      onclick: () => onOffset(offset + pageSize),
    }, [icon("chevronRight", 14)]),
  ]);
}

/** Record page frame: the pale header band, the standard button row and a subtab strip. */
export function recordShell({ title, subtitle, actions = [], subtabs, body }) {
  return el("section", { class: "record" }, [
    el("header", { class: "record-head" }, [
      el("div", { class: "rh-title" }, [
        el("h1", { text: title }),
        subtitle ? el("span", { class: "rh-sub", text: subtitle }) : null,
      ]),
      el("div", { class: "rh-actions" }, actions),
    ]),
    subtabs ?? null,
    el("div", { class: "record-body" }, body),
  ]);
}

/** The Edit / Back / Actions / Print / Email / More row every NetSuite record page carries. */
export function recordButtons({ onEdit, onBack, actions = [], editLabel = "Edit", editDisabled = false } = {}) {
  const row = [];
  if (onEdit) row.push(toolbarButton(editLabel, onEdit, { kind: "primary", disabled: editDisabled }));
  if (onBack) row.push(toolbarButton("Back", onBack));
  row.push(...actions, nsButton("Print"), nsButton("Email"), nsButton("More"));
  return row;
}

export function subtabStrip(names, current, onSelect) {
  return el("div", { class: "subtabs", role: "tablist" }, names.map((name) =>
    el("button", {
      type: "button", role: "tab", "aria-selected": String(name === current), text: name,
      onclick: () => onSelect(name),
    })));
}

export function fieldGroup(title, children) {
  return el("section", { class: "fieldgroup" }, [
    el("h3", { text: title }),
    el("div", { class: "fg-body" }, children),
  ]);
}

export function kv(label, value) {
  return el("div", { class: "kvrow" }, [
    el("dt", { text: label }),
    el("dd", {}, value instanceof Node ? value : el("span", { text: value === undefined || value === null || value === "" ? "" : String(value) })),
  ]);
}

export function kvColumns(...groups) {
  return el("div", { class: "fieldcols" }, groups.map((rows) => el("dl", { class: "kvcol" }, rows)));
}

export function totalsBlock(rows) {
  return el("dl", { class: "totals" }, rows.map(([label, value, grand]) =>
    el("div", { class: `kvrow${grand ? " grand" : ""}` }, [el("dt", { text: label }), el("dd", { text: value })])));
}

export const amountCell = (value, currency) => el("td", { class: "num", text: money(value, currency) });

/** Currency code of a record, falling back to the account's base currency. */
export const currencyOf = (record) => record?.currency?.refName ?? app.session?.account?.baseCurrency ?? "";

export function setPageTitle(text) {
  document.title = `${text} · NetSuite (synthetic)`;
}

export const host = () => $("#main");
