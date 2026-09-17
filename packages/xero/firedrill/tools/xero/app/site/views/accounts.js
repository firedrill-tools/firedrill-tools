// Accounting → Chart of accounts (read-only, tabs by class) and Accounting → Bank accounts (payments per bank account).
import { go, listAll, listPage, register } from "../store.js";
import { amount, dmy, el, errorBanner, skeletonRows } from "../ui.js";
import { notSimulated } from "../overlay.js";
import { pageHead, pager } from "./common.js";

const CLASSES = [["all", "All accounts"], ["ASSET", "Assets"], ["LIABILITY", "Liabilities"], ["EQUITY", "Equity"], ["EXPENSE", "Expenses"], ["REVENUE", "Revenue"], ["archived", "Archive"]];
const TYPE_LABEL = { BANK: "Bank", CURRENT: "Current Asset", CURRLIAB: "Current Liability", EQUITY: "Equity", EXPENSE: "Expense", DIRECTCOSTS: "Direct Costs", REVENUE: "Revenue", OTHERINCOME: "Other Income", SALES: "Sales", FIXED: "Fixed Asset", LIABILITY: "Liability", TERMLIAB: "Non-current Liability", OVERHEADS: "Overhead", DEPRECIATN: "Depreciation", NONCURRENT: "Non-current Asset", PREPAYMENT: "Prepayment", INVENTORY: "Inventory" };

register("accounts", async (host, route) => {
  const cls = CLASSES.some(([k]) => k === route.params.get("tab")) ? route.params.get("tab") : "all";
  const ns = (label) => el("button", { type: "button", class: "btn", text: label, onclick: () => notSimulated(label) });
  const head = pageHead({ crumbs: [["Accounting"]], title: "Chart of accounts", tabs: CLASSES.map(([k, l]) => ({ label: l, href: `#/accounts?tab=${k}`, selected: k === cls })),
    actions: [ns("Add Account"), ns("Add Bank Account"), ns("Print PDF"), ns("Import"), ns("Export")] });
  const tbody = el("tbody", {}, skeletonRows(4, 8));
  host.replaceChildren(head, el("div", { class: "page-inner" }, el("div", { class: "panel" }, el("div", { class: "table-scroll" }, el("table", { class: "xt" }, [
    el("thead", {}, el("tr", {}, ["Code", "Name", "Type", "Tax Rate"].map((h) => el("th", { text: h })))), tbody])))));
  const where = cls === "all" ? `Status=="ACTIVE"` : cls === "archived" ? `Status=="ARCHIVED"` : `Status=="ACTIVE"&&Class==${JSON.stringify(cls)}`;
  let rows, rates;
  try {
    [rows, rates] = await Promise.all([listAll("accounts.list", "Accounts", { where }), listAll("tax-rates.list", "TaxRates").catch(() => [])]);
  } catch (error) {
    tbody.replaceChildren(el("tr", {}, el("td", { colspan: "4" }, errorBanner(error, "We couldn't load the chart of accounts"))));
    return;
  }
  const rateName = new Map(rates.map((t) => [t.TaxType, t.Name]));
  if (!rows.length) { tbody.replaceChildren(el("tr", {}, el("td", { colspan: "4" }, el("div", { class: "empty", text: "There are no accounts to display" })))); return; }
  tbody.replaceChildren(...rows.map((a) => el("tr", {}, [el("td", { text: a.Code ?? "" }), el("td", {}, [el("div", { class: "primary-cell", text: a.Name }), a.Description ? el("div", { class: "muted", text: a.Description }) : null]),
    el("td", { text: TYPE_LABEL[a.Type] ?? a.Type }), el("td", { text: rateName.get(a.TaxType) ?? a.TaxType ?? "" })])));
});

register("bank", async (host, route) => {
  const p = route.params;
  const page = Math.max(1, Number.parseInt(p.get("page") ?? "1", 10) || 1);
  const pageSize = [25, 50, 100].includes(Number(p.get("size"))) ? Number(p.get("size")) : 25;
  const head = pageHead({ crumbs: [["Accounting"]], title: "Bank accounts", actions: [el("button", { type: "button", class: "btn main", text: "Add Bank Account", onclick: () => notSimulated("Add Bank Account") })] });
  const inner = el("div", { class: "page-inner" }, el("div", { class: "loading" }, [el("span", { class: "spinner", "aria-hidden": "true" }), el("span", { text: "Loading…" })]));
  host.replaceChildren(head, inner);
  let banks, result;
  try {
    [banks, result] = await Promise.all([
      listAll("accounts.list", "Accounts", { where: `Type=="BANK"` }),
      listPage("payments.list", "Payments", { page, pageSize, order: "Date DESC" }),
    ]);
  } catch (error) {
    inner.replaceChildren(errorBanner(error, "We couldn't load your bank accounts"));
    return;
  }
  const tiles = el("div", { class: "money-tiles" }, banks.map((a) => el("div", { class: "money-tile" }, [el("div", { class: "k", text: `${a.Code} · ${a.Name}` }), el("div", { class: "muted", text: a.BankAccountNumber ?? "" }), el("div", { class: "muted", text: a.Status === "ARCHIVED" ? "Archived" : "No bank feed connected" })])));
  const tbody = el("tbody", {}, result.rows.length ? result.rows.map((pm) => {
    const bill = pm.PaymentType === "ACCPAYPAYMENT";
    const inv = pm.Invoice ?? {};
    const href = `#/${bill ? "bills" : "invoices"}/${encodeURIComponent(inv.InvoiceID ?? "")}`;
    return el("tr", { class: "clickable", onclick: () => go(href) }, [
      el("td", { text: dmy(pm.DateString) }), el("td", {}, el("a", { href, class: "primary-cell", text: inv.Contact?.Name ?? "" })),
      el("td", { text: `${bill ? "Bill" : "Invoice"} ${inv.InvoiceNumber ?? ""}` }), el("td", { text: pm.Reference ?? "" }),
      el("td", { text: pm.Account ? `${pm.Account.Code} ${pm.Account.Name}` : "" }),
      el("td", { class: "num", text: bill ? "" : amount(pm.Amount) }), el("td", { class: "num", text: bill ? amount(pm.Amount) : "" }),
      el("td", {}, el("span", { class: `tag ${pm.Status === "DELETED" ? "DELETED" : pm.IsReconciled ? "PAID" : "AUTHORISED"}`, text: pm.Status === "DELETED" ? "Deleted" : pm.IsReconciled ? "Reconciled" : "Unreconciled" })),
    ]);
  }) : el("tr", {}, el("td", { colspan: "8" }, el("div", { class: "empty", text: "There are no transactions to display" }))));
  const table = el("table", { class: "xt" }, [el("thead", {}, el("tr", {}, ["Date", "Contact", "Description", "Reference", "Account", "Received", "Spent", "Status"].map((h, i) => el("th", { class: i === 5 || i === 6 ? "num" : "", text: h })))), tbody]);
  const panel = el("div", { class: "panel" }, [el("div", { class: "toolbar" }, el("strong", { text: "Payments recorded in Xero" })), el("div", { class: "table-scroll" }, table),
    pager(result.pagination, ({ page: pg, pageSize: size }) => go(`#/bank?page=${pg}&size=${size}`), [25, 50, 100])]);
  inner.replaceChildren(tiles, panel);
});
