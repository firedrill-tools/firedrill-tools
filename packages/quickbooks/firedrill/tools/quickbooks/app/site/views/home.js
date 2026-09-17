// Home: business at a glance (shortcuts, Invoices, Bank accounts, Sales, Customers owing money).
import { app, go, queryAll, register } from "../store.js";
import { addDays, el, errorBanner, icon, isAccessDenied, money, notSimulated, quote } from "../ui.js";
import { openCustomerDrawer } from "./customer-drawer.js";
import { openInvoiceEditor } from "./invoice-editor.js";
import { moneyBarData } from "./invoices.js";
import { openReceivePayment } from "./receive-payment.js";

function widget(title, sub) {
  const content = el("div", {}, [el("div", { class: "skeleton" }), el("br"), el("div", { class: "skeleton" })]);
  const card = el("section", { class: "card widget", "aria-label": title }, [el("h2", {}, [el("span", { text: title }), sub ? el("span", { class: "muted", text: sub }) : null]), content]);
  return { card, content };
}
const failed = (content, error) => content.replaceChildren(isAccessDenied(error)
  ? el("div", { class: "muted" }, [el("div", { class: "empty-title", text: "You don't have access" }), el("div", { text: "Your user role can't see this data. Ask your company admin for access." })])
  : errorBanner(error, "We couldn't load this"));

function hbar(parts) {
  const total = parts.reduce((s, p) => s + p.amt, 0) || 1;
  return el("div", { class: "hbar", "aria-hidden": "true" }, parts.map((p) => { const d = el("div", { class: p.tone }); d.style.flex = String(Math.max(p.amt / total, p.amt > 0 ? 0.02 : 0)); return d; }));
}

register("home", async (host) => {
  const hour = Number((app.time || "T09").split("T")[1]?.slice(0, 2) ?? 9);
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const sc = (label, name, run) => el("button", { type: "button", class: "shortcut", onclick: run }, [el("span", { class: "sc-ico" }, icon(name)), el("span", { text: label })]);
  const inv = widget("Invoices");
  const bank = widget("Bank accounts", "As of today");
  const sales = widget("Sales", "Last 30 days");
  const owing = widget("Customers owing money");
  const pl = widget("Profit & loss", "Last month");
  pl.content.replaceChildren(el("p", { class: "muted", text: "Profit and loss reports are not simulated by this Tool." }), el("button", { type: "button", class: "link-btn", text: "Learn more", onclick: () => notSimulated("Profit & loss") }));
  const expenses = widget("Expenses", "Last month");
  expenses.content.replaceChildren(el("p", { class: "muted", text: "Expenses, bills and bank feeds are not simulated by this Tool." }), el("button", { type: "button", class: "link-btn", text: "Learn more", onclick: () => notSimulated("Expenses") }));
  const root = el("div", { class: "page-inner" }, [
    el("div", { class: "greeting", text: `${greet}, ${app.company?.CompanyName ?? ""}` }),
    app.companyError ? errorBanner(app.companyError, "We couldn't load your company") : null,
    el("div", { class: "shortcuts", role: "group", "aria-label": "Shortcuts" }, [
      sc("Create invoice", "invoice", () => openInvoiceEditor()), sc("Receive payment", "payment", () => openReceivePayment()),
      sc("Add customer", "customers", () => openCustomerDrawer()), sc("Record expense", "expenses", () => notSimulated("Expense")),
      sc("Add bank deposit", "bank", () => notSimulated("Bank deposit")), sc("Create check", "edit", () => notSimulated("Check")),
    ]),
    el("div", { class: "home-grid" }, [inv.card, bank.card, sales.card, owing.card, pl.card, expenses.card]),
  ]);
  host.replaceChildren(root);

  moneyBarData().then((d) => inv.content.replaceChildren(
    el("div", { class: "legend" }, [el("span", {}, [el("strong", { text: `${money(d.overdue + d.notDue)} Unpaid` })]), el("span", { class: "muted", text: "Last 365 days" })]),
    hbar([{ amt: d.overdue, tone: "tone-orange" }, { amt: d.notDue, tone: "tone-grey" }]),
    el("div", { class: "legend" }, [
      el("a", { href: "#/invoices?status=overdue" }, [el("div", { class: "l-amt", text: money(d.overdue) }), el("div", { class: "muted", text: "Overdue" })]),
      el("a", { href: "#/invoices?status=open" }, [el("div", { class: "l-amt", text: money(d.notDue) }), el("div", { class: "muted", text: "Not due yet" })])]),
    el("div", { class: "hr" }),
    el("div", { class: "legend" }, [el("span", {}, [el("strong", { text: `${money(d.notDeposited + d.deposited)} Paid` })]), el("span", { class: "muted", text: "Last 30 days" })]),
    hbar([{ amt: d.notDeposited, tone: "tone-lgreen" }, { amt: d.deposited, tone: "tone-green" }]),
    el("div", { class: "legend" }, [
      el("a", { href: "#/payments" }, [el("div", { class: "l-amt", text: money(d.notDeposited) }), el("div", { class: "muted", text: "Not deposited" })]),
      el("a", { href: "#/payments" }, [el("div", { class: "l-amt", text: money(d.deposited) }), el("div", { class: "muted", text: "Deposited" })])]),
  )).catch((e) => failed(inv.content, e));

  queryAll("select * from Account where AccountType = 'Bank'").then((accts) => bank.content.replaceChildren(
    accts.length ? el("ul", { class: "alist" }, accts.map((a) => el("li", {}, [el("span", { text: a.Name }), el("strong", { text: money(a.CurrentBalance) })])))
      : el("p", { class: "muted", text: "No bank accounts." }),
    el("button", { type: "button", class: "link-btn", text: "Go to registers", onclick: () => go("#/accounts") }),
  )).catch((e) => failed(bank.content, e));

  queryAll(`select * from Invoice where TxnDate >= ${quote(addDays(app.today, -30))}`).then((rows) => {
    const total = rows.reduce((s, r) => s + Number(r.TotalAmt || 0), 0);
    sales.content.replaceChildren(el("div", { class: "big", text: money(total) }), el("div", { class: "muted", text: `${rows.length} invoice${rows.length === 1 ? "" : "s"} created in the last 30 days` }),
      el("a", { href: "#/invoices?dates=30", text: "View invoices" }));
  }).catch((e) => failed(sales.content, e));

  queryAll("select * from Customer where Balance > '0' orderby DisplayName").then((rows) => {
    rows.sort((a, b) => Number(b.Balance) - Number(a.Balance));
    owing.content.replaceChildren(rows.length
      ? el("ul", { class: "alist" }, rows.slice(0, 6).map((c) => el("li", {}, [el("a", { href: `#/customers/${encodeURIComponent(c.Id)}`, text: c.DisplayName }), el("strong", { text: money(c.Balance) })])))
      : el("p", { class: "muted", text: "No customers owe you money right now." }));
  }).catch((e) => failed(owing.content, e));
});
