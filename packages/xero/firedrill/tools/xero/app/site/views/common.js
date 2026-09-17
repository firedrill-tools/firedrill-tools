// Page scaffolding shared by the views: page header with breadcrumbs and tabs, status tags, pager.
import { el, icon } from "../ui.js";
import { isOverdue, statusLabel } from "../store.js";

/** crumbs: [[label, href]]; actions: Node[]; tabs: [{ label, count?, href?, selected?, disabled?, onclick? }] */
export function pageHead({ crumbs = [], title, titleExtra, actions = [], tabs }) {
  const crumbRow = el("div", { class: "crumbs" });
  crumbs.forEach(([label, href], i) => {
    crumbRow.append(href ? el("a", { href, text: label }) : el("span", { text: label }));
    if (i < crumbs.length - 1 || crumbs.length === 1) crumbRow.append(icon("chevronRight", 14));
  });
  const inner = el("div", { class: "pagehead-inner" }, [
    crumbRow,
    el("div", { class: "titlerow" }, [el("div", { class: "sub" }, [el("h1", { text: title }), titleExtra ?? null]), el("div", { class: "actions" }, actions)]),
  ]);
  if (tabs) {
    const bar = el("div", { class: "tabs", role: "tablist" });
    for (const t of tabs) {
      const attrs = { class: "tab", role: "tab", "aria-selected": t.selected ? "true" : "false", disabled: t.disabled, title: t.disabled ? "Not simulated by this Tool" : undefined };
      const kids = [el("span", { text: t.label }), t.count === undefined ? null : el("span", { class: "count", text: `(${t.count})` })];
      bar.append(t.href && !t.disabled ? el("a", { ...attrs, href: t.href }, kids) : el("button", { ...attrs, type: "button", onclick: t.onclick }, kids));
    }
    inner.append(bar);
  }
  return el("div", { class: "pagehead" }, inner);
}

export function statusTag(inv) {
  if (isOverdue(inv)) return el("span", { class: "tag OVERDUE", text: "Overdue" });
  return el("span", { class: `tag ${inv.Status}`, text: statusLabel(inv) });
}

/** Xero-style pager footer. onChange({ page, pageSize }) */
export function pager({ page, pageSize, itemCount, pageCount }, onChange, sizes = [25, 50, 100, 200]) {
  const first = itemCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(itemCount, page * pageSize);
  const sizeId = `pagesize-${Math.floor(performance.now())}`;
  const size = el("select", { id: sizeId, onchange: (e) => onChange({ page: 1, pageSize: Number(e.target.value) }) },
    sizes.map((s) => el("option", { value: String(s), text: String(s), selected: s === pageSize })));
  const nav = el("div", { class: "pager-controls" }, [
    el("label", { for: sizeId, text: "Items per page" }), size,
    el("button", { type: "button", class: "pg", "aria-label": "Previous page", disabled: page <= 1, onclick: () => onChange({ page: page - 1, pageSize }) }, icon("chevronLeft", 18)),
  ]);
  const total = Math.max(1, pageCount);
  const shown = new Set([1, total, page - 1, page, page + 1].filter((p) => p >= 1 && p <= total));
  let prev = 0;
  for (const p of [...shown].sort((a, b) => a - b)) {
    if (p - prev > 1) nav.append(el("span", { text: "…" }));
    nav.append(el("button", { type: "button", class: "pg", "aria-label": `Page ${p}`, "aria-current": p === page ? "page" : undefined, text: String(p), onclick: () => onChange({ page: p, pageSize }) }));
    prev = p;
  }
  nav.append(el("button", { type: "button", class: "pg", "aria-label": "Next page", disabled: page >= total, onclick: () => onChange({ page: page + 1, pageSize }) }, icon("chevronRight", 18)));
  return el("div", { class: "pager" }, [el("span", { text: itemCount === 0 ? "No items" : `Showing items ${first}-${last} of ${itemCount}` }), nav]);
}

export function initials(name) {
  return String(name ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}
