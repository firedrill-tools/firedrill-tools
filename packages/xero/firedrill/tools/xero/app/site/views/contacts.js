// Contacts: All contacts · Customers · Suppliers · Archived, search, You owe / They owe from outstanding documents, paging.
import { go, listAll, listPage, register } from "../store.js";
import { amount, el, errorBanner, icon, skeletonRows } from "../ui.js";
import { notSimulated } from "../overlay.js";
import { pageHead, pager } from "./common.js";
import { openContactForm } from "./contact-form.js";

const GROUPS = [["all", "All contacts"], ["customers", "Customers"], ["suppliers", "Suppliers"], ["archived", "Archived"]];

register("contacts", async (host, route) => {
  const p = route.params;
  const group = GROUPS.some(([k]) => k === p.get("group")) ? p.get("group") : "all";
  const q = (p.get("q") ?? "").slice(0, 200);
  const page = Math.max(1, Number.parseInt(p.get("page") ?? "1", 10) || 1);
  const pageSize = [25, 50, 100, 200].includes(Number(p.get("size"))) ? Number(p.get("size")) : 25;
  const setParams = (changes) => { const next = new URLSearchParams(p); for (const [k, v] of Object.entries(changes)) { if (v === null || v === "") next.delete(k); else next.set(k, String(v)); } go(`#/contacts?${next}`); };

  const tabs = GROUPS.map(([key, label]) => ({ label, href: `#/contacts?group=${key}`, selected: key === group }));
  tabs.push({ label: "Groups", disabled: true }, { label: "Smart lists", disabled: true });
  const head = pageHead({ crumbs: [["Contacts"]], title: "Contacts", tabs, actions: [
    el("button", { type: "button", class: "btn", text: "Import", onclick: () => notSimulated("Import contacts") }),
    el("button", { type: "button", class: "btn", text: "Export", onclick: () => notSimulated("Export contacts") }),
    el("button", { type: "button", class: "btn main", text: "New contact", onclick: () => openContactForm() }),
  ] });
  const input = el("input", { type: "search", value: q, placeholder: "Search contacts", "aria-label": "Search contacts" });
  const toolbar = el("div", { class: "toolbar" }, [el("form", { class: "searchfield", role: "search", onsubmit: (e) => { e.preventDefault(); setParams({ q: input.value.trim(), page: 1 }); } }, [icon("search"), input])]);
  const tbody = el("tbody", {}, skeletonRows(5, 8));
  const table = el("table", { class: "xt" }, [el("thead", {}, el("tr", {}, [el("th", { class: "check" }, el("input", { type: "checkbox", "aria-label": "Select all contacts on this page" })), el("th", { text: "Contact" }), el("th", { text: "Phone" }), el("th", { class: "num", text: "You owe" }), el("th", { class: "num", text: "They owe" })])), tbody]);
  const footer = el("div");
  host.replaceChildren(head, el("div", { class: "page-inner" }, el("div", { class: "panel" }, [toolbar, el("div", { class: "table-scroll" }, table), footer])));

  const args = { page, pageSize, ...(q ? { searchTerm: q } : {}) };
  if (group === "customers") args.where = "IsCustomer==true";
  if (group === "suppliers") args.where = "IsSupplier==true";
  if (group === "archived") { args.where = `ContactStatus=="ARCHIVED"`; args.includeArchived = true; }
  let result, open;
  try {
    [result, open] = await Promise.all([
      listPage("contacts.list", "Contacts", args),
      listAll("invoices.list", "Invoices", { where: `Status=="AUTHORISED"&&AmountDue>0`, summaryOnly: true }).catch(() => null),
    ]);
  } catch (error) {
    tbody.replaceChildren(el("tr", {}, el("td", { colspan: "5" }, errorBanner(error, "We couldn't load your contacts"))));
    return;
  }
  const owe = new Map();
  for (const inv of open ?? []) {
    const id = inv.Contact?.ContactID;
    const cur = owe.get(id) ?? { ar: 0, ap: 0 };
    cur[inv.Type === "ACCPAY" ? "ap" : "ar"] += Number(inv.AmountDue) || 0;
    owe.set(id, cur);
  }
  if (!result.rows.length) {
    tbody.replaceChildren(el("tr", {}, el("td", { colspan: "5" }, el("div", { class: "empty" }, [el("div", { class: "empty-title", text: q ? `No contacts match “${q}”` : "There are no contacts to display" }), el("div", { text: q ? "Check the spelling or search for another name." : "Contacts you add will appear here." })]))));
  } else {
    tbody.replaceChildren(...result.rows.map((c) => {
      const href = `#/contacts/${encodeURIComponent(c.ContactID)}`;
      const phone = (c.Phones ?? []).find((ph) => ph.PhoneNumber);
      const o = owe.get(c.ContactID);
      const box = el("input", { type: "checkbox", "aria-label": `Select ${c.Name}` });
      return el("tr", { class: "clickable", onclick: (e) => { if (e.target !== box) go(href); } }, [
        el("td", { class: "check" }, box),
        el("td", {}, [el("a", { class: "primary-cell", href, text: c.Name }), c.EmailAddress ? el("div", { class: "muted", text: c.EmailAddress }) : null]),
        el("td", { text: phone ? [phone.PhoneAreaCode, phone.PhoneNumber].filter(Boolean).join(" ") : "" }),
        el("td", { class: "num", text: open === null ? "—" : amount(o?.ap ?? 0) }),
        el("td", { class: "num", text: open === null ? "—" : amount(o?.ar ?? 0) }),
      ]);
    }));
  }
  footer.replaceChildren(pager(result.pagination, ({ page: pg, pageSize: size }) => setParams({ page: pg, size })));
});
