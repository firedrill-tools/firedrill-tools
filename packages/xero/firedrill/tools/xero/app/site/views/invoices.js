// Sales → Invoices and Purchases → Bills to pay: status tabs with counts, search, sortable columns, real paging.
import { DOC, app, countOf, dateOnly, go, isOverdue, listPage, register } from "../store.js";
import { amount, dmy, el, errorBanner, icon, lit, skeletonRows } from "../ui.js";
import { notSimulated, openMenu } from "../overlay.js";
import { pageHead, pager, statusTag } from "./common.js";

const TABS = [["all", "All"], ["DRAFT", "Draft"], ["SUBMITTED", "Awaiting Approval"], ["AUTHORISED", "Awaiting Payment"], ["PAID", "Paid"]];
const COLS = [
  ["InvoiceNumber", "Number"], ["Reference", "Ref"], ["Contact.Name", null], ["Date", "Date"], ["DueDate", "Due Date"],
  ["AmountPaid", "Paid", "num"], ["AmountDue", "Due", "num"], ["Status", "Status"], [null, "Sent"],
];

function hrefFor(doc, params) { return `#/${doc.route}?${params.toString()}`; }

async function renderList(host, route, doc) {
  const p = route.params;
  const tab = TABS.some(([k]) => k === p.get("tab")) ? p.get("tab") : "all";
  const q = (p.get("q") ?? "").slice(0, 200);
  const sort = p.get("sort") ?? "Date";
  const dir = p.get("dir") === "ASC" ? "ASC" : "DESC";
  const page = Math.max(1, Number.parseInt(p.get("page") ?? "1", 10) || 1);
  const pageSize = [25, 50, 100, 200].includes(Number(p.get("size"))) ? Number(p.get("size")) : 25;
  const setParams = (changes) => { const next = new URLSearchParams(p); for (const [k, v] of Object.entries(changes)) { if (v === null || v === "") next.delete(k); else next.set(k, String(v)); } go(hrefFor(doc, next)); };

  let where = `Type==${lit(doc.type)}&&Status!="DELETED"`;
  if (q) where += `&&(InvoiceNumber.Contains(${lit(q)})||Reference.Contains(${lit(q)})||Contact.Name.Contains(${lit(q)}))`;
  const base = { where, ...(tab === "all" ? {} : { statuses: [tab] }) };

  const tabs = TABS.map(([key, label]) => ({ key, label, href: hrefFor(doc, new URLSearchParams({ tab: key })), selected: key === tab }));
  tabs.push({ label: "Repeating", disabled: true });
  const newBtn = el("div", { class: "btn-split" }, [
    el("a", { class: "btn main", href: `#/${doc.route}/new`, text: doc.newLabel }),
    el("button", { type: "button", class: "btn main", "aria-label": `More ${doc.noun.toLowerCase()} options`, "aria-haspopup": "menu", onclick: (e) => { e.stopPropagation(); openMenu(e.currentTarget, doc.type === "ACCREC" ? [{ label: "New invoice", run: () => go("#/invoices/new") }, { label: "New repeating invoice" }, { label: "New credit note" }, { label: "Upload invoices" }] : [{ label: "New bill", run: () => go("#/bills/new") }, { label: "New repeating bill" }, { label: "New credit note" }], { align: "right" }); } }, icon("chevron", 18)),
  ]);
  const actions = doc.type === "ACCREC"
    ? [el("button", { type: "button", class: "btn", text: "Send statements", onclick: () => notSimulated("Send statements") }), el("button", { type: "button", class: "btn", text: "Import", onclick: () => notSimulated("Import") }), newBtn]
    : [el("button", { type: "button", class: "btn", text: "Import", onclick: () => notSimulated("Import") }), newBtn];
  const head = pageHead({ crumbs: doc.type === "ACCREC" ? [["Sales overview"]] : [["Purchases overview"]], title: doc.plural, actions, tabs });

  const searchInput = el("input", { type: "search", id: "list-search", value: q, placeholder: "Enter a contact, number or reference", "aria-label": "Search" });
  const searchForm = el("form", { class: "searchfield", role: "search", onsubmit: (e) => { e.preventDefault(); setParams({ q: searchInput.value.trim(), page: 1 }); } }, [icon("search"), searchInput]);
  const selectionNote = el("span", { class: "selection-note" });
  const toolbar = el("div", { class: "toolbar" }, [searchForm, el("button", { type: "button", class: "btn", onclick: () => notSimulated("Date filters") }, [icon("filter", 18), "Filter"]), selectionNote]);

  const thead = el("tr", {}, [el("th", { class: "check" }, el("input", { type: "checkbox", "aria-label": "Select all on this page", id: "select-all" }))]);
  for (const [field, label, cls] of COLS) {
    const text = label ?? doc.party;
    if (!field) { thead.append(el("th", { text })); continue; }
    const on = sort === field;
    const th = el("th", { class: cls, "aria-sort": on ? (dir === "ASC" ? "ascending" : "descending") : "none" },
      el("button", { type: "button", class: "sorter", onclick: () => setParams({ sort: field, dir: on && dir === "DESC" ? "ASC" : "DESC", page: 1 }) }, [text, on ? icon(dir === "ASC" ? "arrowUp" : "arrowDown", 14) : null]));
    thead.append(th);
  }
  const tbody = el("tbody", {}, skeletonRows(COLS.length + 1, 8));
  const table = el("table", { class: "xt" }, [el("thead", {}, thead), tbody]);
  const footer = el("div");
  const panel = el("div", { class: "panel" }, [toolbar, el("div", { class: "table-scroll" }, table), footer]);
  host.replaceChildren(head, el("div", { class: "page-inner" }, panel));

  // counts on the tabs (Draft, Awaiting Approval, Awaiting Payment), loaded alongside the page
  Promise.all(["DRAFT", "SUBMITTED", "AUTHORISED"].map((s) => countOf("invoices.list", "Invoices", { where: `Type==${lit(doc.type)}`, statuses: [s] }).catch(() => undefined))).then((counts) => {
    const els = head.querySelectorAll(".tab");
    counts.forEach((c, i) => { if (c !== undefined && c > 0) els[i + 1].append(el("span", { class: "count", text: `(${c})` })); });
  });

  let result;
  try {
    result = await listPage("invoices.list", "Invoices", { ...base, order: `${sort} ${dir}`, page, pageSize, summaryOnly: true });
  } catch (error) {
    tbody.replaceChildren(el("tr", {}, el("td", { colspan: String(COLS.length + 1) }, errorBanner(error, `We couldn't load your ${doc.plural.toLowerCase()}`))));
    return;
  }
  if (result.rows.length === 0) {
    const text = q ? `No ${doc.noun.toLowerCase()}s match “${q}”` : "There are no items to display";
    tbody.replaceChildren(el("tr", {}, el("td", { colspan: String(COLS.length + 1) }, el("div", { class: "empty" }, [el("div", { class: "empty-title", text }), el("div", { text: q ? "Try a different contact, number or reference." : `${doc.plural} you create will appear here.` })]))));
  } else {
    const selected = new Set();
    const sync = () => { selectionNote.textContent = selected.size ? `${selected.size} item${selected.size === 1 ? "" : "s"} selected` : ""; };
    tbody.replaceChildren(...result.rows.map((inv) => {
      const box = el("input", { type: "checkbox", "aria-label": `Select ${doc.noun.toLowerCase()} ${inv.InvoiceNumber || inv.InvoiceID}` });
      const row = el("tr", { class: "clickable", onclick: (e) => { if (e.target !== box) go(`#/${doc.route}/${encodeURIComponent(inv.InvoiceID)}`); } }, [
        el("td", { class: "check" }, box),
        el("td", {}, el("a", { class: "primary-cell", href: `#/${doc.route}/${encodeURIComponent(inv.InvoiceID)}`, text: inv.InvoiceNumber || "—" })),
        el("td", { text: inv.Reference ?? "" }),
        el("td", { text: inv.Contact?.Name ?? "" }),
        el("td", { text: dmy(inv.DateString) }),
        el("td", { class: isOverdue(inv) ? "overdue" : "", text: dmy(inv.DueDateString) }),
        el("td", { class: "num", text: amount(inv.AmountPaid) }),
        el("td", { class: "num", text: amount(inv.AmountDue) }),
        el("td", {}, statusTag(inv)),
        el("td", {}, inv.SentToContact ? el("span", { class: "sent-mark", title: "Sent" }, [icon("check", 18), el("span", { class: "visually-hidden", text: "Sent" })]) : null),
      ]);
      box.addEventListener("change", () => { box.checked ? selected.add(inv.InvoiceID) : selected.delete(inv.InvoiceID); row.classList.toggle("selected", box.checked); sync(); });
      return row;
    }));
    table.querySelector("#select-all").addEventListener("change", (e) => { for (const b of tbody.querySelectorAll('input[type="checkbox"]')) { if (b.checked !== e.target.checked) { b.checked = e.target.checked; b.dispatchEvent(new Event("change")); } } });
  }
  footer.replaceChildren(pager(result.pagination, ({ page: pg, pageSize: size }) => setParams({ page: pg, size })));
  void app; void dateOnly;
}

register("invoices", (host, route) => renderList(host, route, DOC.ACCREC));
register("bills", (host, route) => renderList(host, route, DOC.ACCPAY));
