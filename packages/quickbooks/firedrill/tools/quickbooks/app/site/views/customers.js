// Sales & Get paid > Customers: money bar, search, include-inactive, paging, row actions.
import { app, go, query, register } from "../store.js";
import { call, el, errorBanner, icon, isAccessDenied, loadingRows, money, notSimulated, openMenu, quote } from "../ui.js";
import { emptyRow, pageShell, pager, salesTabs, select } from "./common.js";
import { openCustomerDrawer } from "./customer-drawer.js";
import { openInvoiceEditor } from "./invoice-editor.js";
import { moneyBarData } from "./invoices.js";
import { openReceivePayment } from "./receive-payment.js";
import { createSelection } from "./batch.js";
import { customerBatchActions } from "./batch-actions.js";

const SIZE = 25;

register("customers", async (host, route) => {
  const p = route.params;
  const q = p.get("q") ?? "";
  const inactive = p.get("inactive") === "1";
  const balance = p.get("balance") ?? "";
  const start = Math.max(1, Number(p.get("start")) || 1);
  const nav = (patch) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k); go(`#/customers?${n}`); };
  const refresh = () => { if (host.isConnected) app.pages.customers(host, route); };
  const { root, body } = pageShell("Customers", {
    crumb: "Sales & Get paid",
    actions: [el("button", { type: "button", class: "btn", text: "Customer types", onclick: () => notSimulated("Customer types") }),
      el("div", { class: "split" }, [el("button", { type: "button", class: "btn primary", text: "New customer", onclick: () => openCustomerDrawer() }),
        el("button", { type: "button", class: "btn primary", "aria-label": "More new customer options", onclick: () => notSimulated("Import customers") }, icon("chevronDown"))])],
    tabs: salesTabs("customers"),
  });
  const bar = el("div", { class: "moneybar" }, [el("div", { class: "skeleton" }), el("div", { class: "skeleton" })]);
  const search = el("input", { type: "search", placeholder: "Search", "aria-label": "Search customers", value: q });
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") nav({ q: search.value.trim(), start: "" }); });
  const bal = select([["", "All customers"], ["open", "With open balance"]], balance);
  bal.setAttribute("aria-label", "Balance filter");
  bal.addEventListener("change", () => nav({ balance: bal.value, start: "" }));
  const inc = el("input", { type: "checkbox", id: "cust-inactive", checked: inactive, onchange: () => nav({ inactive: inc.checked ? "1" : "", start: "" }) });
  const sel = createSelection({ noun: "customers", labelFor: (c) => c.DisplayName, actionsFor: (rows) => customerBatchActions(rows, refresh) });
  const tbody = el("tbody", {}, loadingRows(5));
  const foot = el("div");
  const card = el("div", { class: "card" }, [
    el("div", { class: "toolbar" }, [el("div", { class: "tsearch" }, [icon("search"), search]), bal, el("label", { class: "checkline", for: "cust-inactive" }, [inc, "Include inactive"]), el("div", { class: "grow" }),
      el("button", { type: "button", class: "icon-btn", "aria-label": "Print list", title: "Print", onclick: () => notSimulated("Print list") }, icon("print")),
      el("button", { type: "button", class: "icon-btn", "aria-label": "Export to Excel", title: "Export", onclick: () => notSimulated("Export to Excel") }, icon("export"))]),
    sel.bar,
    el("div", { class: "table-wrap" }, el("table", { class: "grid" }, [el("thead", {}, el("tr", {}, [el("th", { class: "check" }, sel.head), ...["Name", "Company name", "Phone", "Open balance", "Action"].map((h, i) => el("th", { class: i === 3 ? "num" : i === 4 ? "act" : "", text: h }))])), tbody])),
    foot,
  ]);
  body.append(bar, card);
  host.replaceChildren(root);
  moneyBarData().then((d) => bar.replaceChildren(
    el("div", {}, [el("div", { class: "mb-group-head" }, [el("strong", { text: "Unpaid" }), el("span", { text: "Last 365 days" })]), el("div", { class: "mb-segs" }, [
      el("a", { class: "mb-seg", href: "#/invoices?status=overdue" }, [el("div", { class: "mb-amt", text: money(d.overdue) }), el("div", { class: "mb-lbl", text: `${d.overdueN} Overdue invoices` }), el("div", { class: "mb-bar tone-orange" })]),
      el("a", { class: "mb-seg", href: "#/invoices?status=unpaid" }, [el("div", { class: "mb-amt", text: money(d.overdue + d.notDue) }), el("div", { class: "mb-lbl", text: `${d.overdueN + d.notDueN} Open invoices` }), el("div", { class: "mb-bar tone-grey" })])])]),
    el("div", {}, [el("div", { class: "mb-group-head" }, [el("strong", { text: "Paid" }), el("span", { text: "Last 30 days" })]), el("div", { class: "mb-segs" }, [
      el("a", { class: "mb-seg", href: "#/payments" }, [el("div", { class: "mb-amt", text: money(d.deposited + d.notDeposited) }), el("div", { class: "mb-lbl", text: `${d.depositedN + d.notDepositedN} Paid last 30 days` }), el("div", { class: "mb-bar tone-green" })])])]),
  )).catch((error) => (isAccessDenied(error) ? bar.remove() : bar.replaceChildren(errorBanner(error, "We couldn't load the summary"))));
  try {
    const where = [inactive ? "Active IN (true, false)" : "Active = true"];
    if (q) where.push(`DisplayName LIKE ${quote(`%${q}%`)}`);
    if (balance === "open") where.push("Balance > '0'");
    const clause = ` where ${where.join(" AND ")}`;
    const total = (await call("query.run", { query: `select count(*) from Customer${clause}` })).QueryResponse.totalCount ?? 0;
    const rows = await query(`select * from Customer${clause} orderby DisplayName STARTPOSITION ${start} MAXRESULTS ${SIZE}`);
    sel.reset();
    tbody.replaceChildren(...(rows.length ? rows.map((c) => {
      const open = Number(c.Balance) > 0;
      const primary = open
        ? el("button", { type: "button", class: "link-btn", text: "Receive payment", onclick: () => openReceivePayment({ customerId: c.Id, onSaved: refresh }) })
        : el("button", { type: "button", class: "link-btn", text: "Create invoice", disabled: !c.Active, onclick: () => openInvoiceEditor(null, refresh, { customerId: c.Id }) });
      const caret = el("button", { type: "button", class: "caret", "aria-label": `More actions for ${c.DisplayName}`, "aria-haspopup": "menu" }, icon("chevronDown"));
      caret.addEventListener("click", () => openMenu(caret, [
        { label: "Create invoice", disabled: !c.Active, run: () => openInvoiceEditor(null, refresh, { customerId: c.Id }) },
        { label: "Receive payment", run: () => openReceivePayment({ customerId: c.Id, onSaved: refresh }) },
        { label: "Create sales receipt", run: () => notSimulated("Sales receipt") },
        { label: "Create estimate", run: () => notSimulated("Estimate") },
        { label: "Edit", run: () => openCustomerDrawer(c, refresh) },
      ]));
      const nameLink = el("a", { href: `#/customers/${encodeURIComponent(c.Id)}`, text: c.DisplayName });
      return el("tr", {}, [sel.cell(c),
        el("td", {}, [nameLink, c.Active ? null : el("span", { class: "pill inactive", text: " Inactive" }), c.PrimaryEmailAddr ? el("div", { class: "s-sub muted", text: c.PrimaryEmailAddr.Address }) : null]),
        el("td", { text: c.CompanyName ?? "" }), el("td", { text: c.PrimaryPhone?.FreeFormNumber ?? "" }), el("td", { class: "num", text: money(c.Balance) }),
        el("td", { class: "act" }, el("div", { class: "row-actions" }, [primary, caret]))]);
    }) : [emptyRow(6, q ? "No customers match your search" : "No customers yet", q ? "Try another name." : "Add your first customer to start invoicing.")]));
    foot.replaceChildren(pager({ start, size: SIZE, total, onChange: (s) => nav({ start: String(s) }) }));
  } catch (error) {
    card.replaceWith(errorBanner(error, isAccessDenied(error) ? "You don't have access to Sales data" : "We couldn't load your customers"));
  }
});
