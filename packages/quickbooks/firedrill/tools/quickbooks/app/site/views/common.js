// Shared view pieces: page header, Sales tabs, invoice status cell, pager, field helpers.
import { invoiceStatus } from "../store.js";
import { el, icon, notSimulated } from "../ui.js";

export function pageShell(title, { actions = [], tabs = null, crumb = null } = {}) {
  const body = el("div", { class: "page-body" });
  const root = el("div", { class: "page-inner" }, [
    crumb ? el("div", { class: "crumb" }, crumb) : null,
    el("div", { class: "page-head" }, [el("h1", { text: title }), el("div", { class: "actions" }, actions)]),
    tabs,
    body,
  ]);
  return { root, body };
}

const SALES_TABS = [["Overview"], ["All sales"], ["Invoices", "#/invoices", "invoices"], ["Payments", "#/payments", "payments"], ["Customers", "#/customers", "customers"], ["Products & services", "#/items", "items"]];
export function salesTabs(active) {
  return el("nav", { class: "tabs", "aria-label": "Sales & Get paid" }, SALES_TABS.map(([label, href, key]) =>
    href
      ? el("a", { class: `tab${key === active ? " active" : ""}`, href, "aria-current": key === active ? "page" : undefined, text: label })
      : el("button", { type: "button", class: "tab", text: label, title: "Not simulated by this Tool", onclick: () => notSimulated(label) })));
}

export function statusCell(inv, today) {
  const st = invoiceStatus(inv, today);
  const dot = st.key === "overdue" || st.key === "due" ? "orange" : st.key === "voided" ? "grey" : st.key === "paid" || st.key === "deposited" ? "green" : "hollow";
  return el("div", { class: "status" }, [
    el("span", { class: `dot ${dot}`, "aria-hidden": "true" }),
    el("div", {}, [
      el("div", { class: `s-main${dot === "orange" ? " orange" : ""}`, text: st.label }),
      st.sub ? el("div", { class: "s-sub", text: st.sub }) : null,
      st.key === "open" || st.key === "overdue" || st.key === "due" ? el("div", { class: "s-sub", text: inv.EmailStatus === "EmailSent" ? "Sent" : "Not sent" }) : null,
    ]),
  ]);
}

/** Pager with first/prev/next and "1-25 of 60" text. */
export function pager({ start, size, total, onChange }) {
  const end = Math.min(start + size - 1, total);
  const btn = (name, label, target, disabled) => el("button", { type: "button", class: "icon-btn", "aria-label": label, title: label, disabled, onclick: () => onChange(target) }, icon(name));
  return el("div", { class: "pager" }, [
    el("span", { text: total === 0 ? "0 items" : `${start}-${end} of ${total}` }),
    btn("chevronLeft", "Previous page", Math.max(1, start - size), start <= 1),
    btn("chevronRight", "Next page", start + size, end >= total),
  ]);
}

let fieldSeq = 0;
/** Labelled input/select/textarea; returns { wrap, input, setError }. */
export function field(label, control, { hint } = {}) {
  const id = `f${(fieldSeq += 1)}`;
  control.id = id;
  const err = el("div", { class: "err", role: "alert" });
  const wrap = el("div", { class: "field" }, [el("label", { for: id, text: label }), control, hint ? el("div", { class: "muted", text: hint }) : null, err]);
  const setError = (msg) => { wrap.classList.toggle("invalid", Boolean(msg)); err.textContent = msg ?? ""; };
  return { wrap, input: control, setError };
}
export const input = (attrs = {}) => el("input", { type: "text", ...attrs });
export function select(options, value) {
  const s = el("select");
  for (const [v, label, disabled] of options) s.append(el("option", { value: v, text: label, disabled }));
  if (value !== undefined) s.value = value;
  return s;
}
export function emptyRow(cols, title, text) {
  return el("tr", {}, el("td", { class: "empty", colspan: cols }, [el("div", { class: "empty-title", text: title }), text ? el("div", { text }) : null]));
}
/** Drawer with header, scrolling body and footer actions. */
export function drawer(title, body, actions) {
  const root = document.getElementById("overlay-root");
  const previous = document.activeElement;
  const scrim = el("div", { class: "drawer-scrim" });
  const close = () => { scrim.remove(); panel.remove(); document.removeEventListener("keydown", onKey); previous?.focus?.(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const foot = el("div", { class: "drawer-foot" });
  const panel = el("aside", { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": title }, [
    el("div", { class: "drawer-head" }, [el("h2", { text: title }), el("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close"))]),
    el("div", { class: "drawer-body" }, body),
    foot,
  ]);
  for (const a of actions(close)) foot.append(a);
  scrim.addEventListener("click", close);
  root.append(scrim, panel);
  document.addEventListener("keydown", onKey);
  panel.querySelector("input, select, textarea")?.focus();
  return { close, panel };
}
