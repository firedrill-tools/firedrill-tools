// Customer page: contact header, open/overdue totals, Transaction list and Customer details tabs.
import { app, go, isVoided, queryAll, register } from "../store.js";
import { call, describe, el, errorBanner, icon, isAccessDenied, loadingRows, mdY, money, newKey, notSimulated, openMenu, quote, toast, confirmDialog } from "../ui.js";
import { emptyRow, statusCell } from "./common.js";
import { openCustomerDrawer } from "./customer-drawer.js";
import { rowActions } from "./invoice-actions.js";
import { openInvoiceEditor } from "./invoice-editor.js";
import { openReceivePayment } from "./receive-payment.js";

register("customer", async (host, route) => {
  const refresh = () => { if (host.isConnected) app.pages.customer(host, route); };
  host.replaceChildren(el("div", { class: "loading" }, [el("span", { class: "spinner" }), el("span", { text: "Loading customer…" })]));
  let c;
  try {
    c = (await call("customers.get", { id: route.id ?? "" })).Customer;
  } catch (error) {
    host.replaceChildren(el("div", { class: "page-inner" }, [el("div", { class: "crumb" }, el("a", { href: "#/customers", text: "Customers" })), errorBanner(error, isAccessDenied(error) ? "You don't have access to this customer" : "We couldn't find this customer")]));
    return;
  }
  const tab = route.sub === "details" ? "details" : "transactions";
  const newTxn = el("button", { type: "button", class: "btn primary", "aria-haspopup": "menu" }, ["New transaction", icon("chevronDown")]);
  newTxn.addEventListener("click", () => openMenu(newTxn, [
    { label: "Invoice", disabled: !c.Active, run: () => openInvoiceEditor(null, refresh, { customerId: c.Id }) },
    { label: "Payment", run: () => openReceivePayment({ customerId: c.Id, onSaved: refresh }) },
    { label: "Estimate", run: () => notSimulated("Estimate") }, { label: "Sales receipt", run: () => notSimulated("Sales receipt") },
    { label: "Credit memo", run: () => notSimulated("Credit memo") }, { label: "Statement", run: () => notSimulated("Statement") },
  ]));
  const inactivate = async () => {
    if (!(await confirmDialog("Make inactive?", `Are you sure you want to make ${c.DisplayName} inactive?`, "Yes, make inactive"))) return;
    try { await call("customers.delete", { idOrEntity: { Id: c.Id, SyncToken: c.SyncToken } }, newKey()); toast(`${c.DisplayName} is now inactive`); refresh(); }
    catch (error) { toast(describe(error), { error: true }); }
  };
  const reactivate = async () => {
    try { await call("customers.post", { body: { Id: c.Id, SyncToken: c.SyncToken, sparse: true, Active: true } }, newKey()); toast(`${c.DisplayName} is active again`); refresh(); }
    catch (error) { toast(describe(error), { error: true }); }
  };
  const addr = c.BillAddr ? [c.BillAddr.Line1, c.BillAddr.City && `${c.BillAddr.City}, ${c.BillAddr.CountrySubDivisionCode ?? ""} ${c.BillAddr.PostalCode ?? ""}`.trim()].filter(Boolean).join(", ") : "";
  const overdueHost = el("div", { class: "l-amt", text: "…" });
  const header = el("div", { class: "card widget" }, [
    el("div", { class: "sheet-top" }, [
      el("div", {}, [
        el("h1", { class: "greeting", text: c.DisplayName }),
        c.Active ? null : el("span", { class: "pill inactive", text: "Inactive" }),
        el("div", { class: "muted", text: [c.CompanyName, c.PrimaryEmailAddr?.Address, c.PrimaryPhone?.FreeFormNumber].filter(Boolean).join(" · ") }),
        addr ? el("div", { class: "muted", text: addr }) : null,
        c.Notes ? el("div", { class: "muted", text: `Notes: ${c.Notes}` }) : null,
      ]),
      el("div", { class: "actions", style: undefined }, [
        el("div", { class: "page-head" }, el("div", { class: "actions" }, [el("button", { type: "button", class: "btn", text: "Edit", onclick: () => openCustomerDrawer(c, refresh) }),
          c.Active ? el("button", { type: "button", class: "btn", text: "Make inactive", onclick: inactivate }) : el("button", { type: "button", class: "btn", text: "Make active", onclick: reactivate }), newTxn])),
        el("div", { class: "legend" }, [el("div", {}, [el("div", { class: "l-amt", text: money(c.Balance) }), el("div", { class: "muted", text: "Open balance" })]), el("div", {}, [overdueHost, el("div", { class: "muted", text: "Overdue payment" })])]),
      ]),
    ]),
  ]);
  const tabs = el("nav", { class: "tabs", "aria-label": "Customer" }, [
    el("a", { class: `tab${tab === "transactions" ? " active" : ""}`, href: `#/customers/${encodeURIComponent(c.Id)}`, text: "Transaction list" }),
    el("a", { class: `tab${tab === "details" ? " active" : ""}`, href: `#/customers/${encodeURIComponent(c.Id)}/details`, text: "Customer details" }),
    el("button", { type: "button", class: "tab", text: "Statements", onclick: () => notSimulated("Statements") }),
  ]);
  const content = el("div", { class: "card" });
  host.replaceChildren(el("div", { class: "page-inner" }, [el("div", { class: "crumb" }, el("a", { href: "#/customers", text: "Customers" })), header, el("br"), tabs, content]));

  if (tab === "details") {
    const row = (k, v) => el("div", { class: "field" }, [el("span", { class: "muted", text: k }), el("div", { text: v || "—" })]);
    content.replaceChildren(el("div", { class: "widget row2" }, [row("Customer display name", c.DisplayName), row("Company", c.CompanyName), row("First name", c.GivenName), row("Last name", c.FamilyName),
      row("Email", c.PrimaryEmailAddr?.Address), row("Phone", c.PrimaryPhone?.FreeFormNumber), row("Billing address", addr), row("Terms", c.SalesTermRef?.name), row("Notes", c.Notes), row("Customer since", mdY(c.MetaData?.CreateTime))]));
    return;
  }
  const tbody = el("tbody", {}, loadingRows(8, 4));
  content.replaceChildren(el("div", { class: "table-wrap" }, el("table", { class: "grid" }, [el("thead", {}, el("tr", {}, ["Date", "Type", "No.", "Due date", "Balance", "Total", "Status", "Action"].map((h, i) => el("th", { class: i === 4 || i === 5 ? "num" : i === 7 ? "act" : "", text: h })))), tbody])));
  try {
    const ref = quote(c.Id);
    const [invoices, payments] = await Promise.all([queryAll(`select * from Invoice where CustomerRef = ${ref}`), queryAll(`select * from Payment where CustomerRef = ${ref}`)]);
    const overdue = invoices.filter((i) => Number(i.Balance) > 0 && i.DueDate < app.today).reduce((s, i) => s + Number(i.Balance), 0);
    overdueHost.textContent = money(overdue);
    const all = [...invoices.map((i) => ({ kind: "Invoice", date: i.TxnDate, row: i })), ...payments.map((p) => ({ kind: "Payment", date: p.TxnDate, row: p }))].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    tbody.replaceChildren(...(all.length ? all.map(({ kind, row }) => kind === "Invoice"
      ? el("tr", { class: "clickable", onclick: (e) => { if (!e.target.closest("button")) openInvoiceEditor(row.Id, refresh); } }, [el("td", { text: mdY(row.TxnDate) }), el("td", { text: "Invoice" }), el("td", { text: row.DocNumber ?? "" }), el("td", { text: mdY(row.DueDate) }), el("td", { class: "num", text: money(row.Balance) }), el("td", { class: "num", text: isVoided(row) ? "$0.00" : money(row.TotalAmt) }), el("td", {}, statusCell(row)), el("td", { class: "act" }, rowActions(row, refresh))])
      : el("tr", {}, [el("td", { text: mdY(row.TxnDate) }), el("td", { text: "Payment" }), el("td", { text: row.PaymentRefNum ?? "" }), el("td", { text: "" }), el("td", { class: "num", text: money(-(row.UnappliedAmt ?? 0)) }), el("td", { class: "num", text: money(-row.TotalAmt) }), el("td", { text: String(row.PrivateNote ?? "").startsWith("Voided") ? "Voided" : Number(row.UnappliedAmt ?? 0) > 0 ? "Unapplied" : "Closed" }), el("td", { class: "act" }, el("a", { href: `#/payments?customer=${encodeURIComponent(c.Id)}`, text: "View" }))]))
      : [emptyRow(8, "No transactions yet", "Invoices and payments for this customer appear here.")]));
  } catch (error) {
    content.replaceChildren(errorBanner(error, "We couldn't load transactions"));
  }
  void go;
});
