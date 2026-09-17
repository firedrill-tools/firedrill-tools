// Home dashboard: bank account card (payments recorded in this Tool), Invoices owed to you, Bills to pay, and the
// unmodelled cards Xero also shows (rendered, marked not simulated).
import { app, dateOnly, go, isOverdue, listAll, register } from "../store.js";
import { addDays, amount, dayNum, dmy, el, errorBanner, isAccessDenied } from "../ui.js";
import { notSimulated } from "../overlay.js";

function card(title, sub, body, foot = []) {
  return el("section", { class: "card", "aria-label": title }, [
    el("div", { class: "card-head" }, el("div", {}, [el("h2", { text: title }), sub ? el("div", { class: "card-sub", text: sub }) : null])),
    el("div", { class: "card-body" }, body), foot.length ? el("div", { class: "card-foot" }, foot) : null,
  ]);
}
const loadingCard = (title) => card(title, "", el("div", { class: "form-stack" }, [el("div", { class: "skeleton" }), el("div", { class: "skeleton" }), el("div", { class: "skeleton" })]));

/** Bars: Older (overdue), this week, next week, later — relative to the organisation's today. */
function dueBars(open) {
  const today = dayNum(app.today);
  const buckets = [["Older", 0, true], ["This week", 0], ["Next week", 0], ["Future", 0]];
  for (const inv of open) {
    const d = dayNum(dateOnly(inv.DueDateString)) - today;
    const i = Number.isNaN(d) ? 3 : d < 0 ? 0 : d < 7 ? 1 : d < 14 ? 2 : 3;
    buckets[i][1] += Number(inv.AmountDue) || 0;
  }
  const max = Math.max(1, ...buckets.map((b) => b[1]));
  return el("div", {}, [
    el("div", { class: "bars", role: "img", "aria-label": buckets.map((b) => `${b[0]} ${amount(b[1])}`).join(", ") },
      buckets.map((b) => el("div", { class: "bar" }, el("span", { class: `b${b[2] ? " over" : ""}`, style: undefined, "data-h": String(Math.round((b[1] / max) * 100)) })))),
    el("div", { class: "bar-labels" }, buckets.map((b) => el("span", { text: b[0] }))),
  ]);
}
function sizeBars(root) { for (const b of root.querySelectorAll(".bar .b")) b.style.height = `${b.getAttribute("data-h")}%`; }

function docsCard(type, rows) {
  const bill = type === "ACCPAY";
  const route = bill ? "bills" : "invoices";
  const mine = rows.filter((r) => r.Type === type);
  const sum = (list) => list.reduce((t, r) => t + (Number(r.AmountDue) || 0), 0);
  const drafts = mine.filter((r) => r.Status === "DRAFT");
  const waiting = mine.filter((r) => r.Status === "SUBMITTED");
  const open = mine.filter((r) => r.Status === "AUTHORISED" && Number(r.AmountDue) > 0);
  const overdue = open.filter((r) => isOverdue(r));
  const line = (label, list, href, over = false) => el("div", { class: "statline" }, [el("a", { href, text: `${list.length} ${label}` }), el("span", { class: `amt${over && list.length ? " overdue" : ""}`, text: amount(sum(list)) })]);
  const body = el("div", {}, [
    dueBars(open),
    line(bill ? "draft bills" : "draft invoices", drafts, `#/${route}?tab=DRAFT`),
    line("awaiting approval", waiting, `#/${route}?tab=SUBMITTED`),
    line("awaiting payment", open, `#/${route}?tab=AUTHORISED`),
    line("overdue", overdue, `#/${route}?tab=AUTHORISED&sort=DueDate&dir=ASC`, true),
  ]);
  return card(bill ? "Bills to pay" : "Invoices owed to you", "NZD", body, [el("a", { class: "btn small", href: `#/${route}/new`, text: bill ? "New bill" : "New invoice" })]);
}

register("home", async (host) => {
  const name = app.org?.Name ?? "Xero";
  const head = el("div", { class: "home-head" }, [el("div", {}, [el("h1", { text: name }), el("div", { class: "date", text: app.today ? `Today is ${dmy(app.today)}` : "" })]),
    el("div", { class: "actions" }, [el("button", { type: "button", class: "btn", text: "Edit homepage", onclick: () => notSimulated("Edit homepage") })])]);
  const grid = el("div", { class: "cards" }, [loadingCard("Business Bank Account"), loadingCard("Invoices owed to you"), loadingCard("Bills to pay")]);
  const inner = el("div", { class: "page-inner" }, [app.orgError ? errorBanner(app.orgError, "We couldn't load your organisation") : null, grid]);
  host.replaceChildren(head, inner);

  const [docs, accounts, payments] = await Promise.all([
    listAll("invoices.list", "Invoices", { where: `Status=="DRAFT"||Status=="SUBMITTED"||Status=="AUTHORISED"`, summaryOnly: true }).catch((e) => e),
    listAll("accounts.list", "Accounts", { where: `Type=="BANK"&&Status=="ACTIVE"` }).catch((e) => e),
    listAll("payments.list", "Payments", { where: `Status=="AUTHORISED"` }).catch((e) => e),
  ].map((p) => p));
  const cards = [];
  const failed = (title, error) => card(title, "", isAccessDenied(error) ? errorBanner(error) : errorBanner(error, "This card couldn't load"));
  if (accounts instanceof Error) cards.push(failed("Bank accounts", accounts));
  else for (const acc of accounts.slice(0, 2)) {
    let body;
    if (payments instanceof Error) body = errorBanner(payments, "Payments couldn't load");
    else {
      const mine = payments.filter((pm) => pm.Account?.AccountID === acc.AccountID);
      const balance = mine.reduce((t, pm) => t + (pm.PaymentType === "ACCPAYPAYMENT" ? -1 : 1) * (Number(pm.Amount) || 0), 0);
      const recent = mine.filter((pm) => dayNum(dateOnly(pm.DateString)) >= dayNum(addDays(app.today, -30))).length;
      body = el("div", {}, [el("div", { class: "muted", text: "Balance in Xero" }), el("div", { class: "bigfig", text: amount(balance) }),
        el("div", { class: "statline" }, [el("span", { text: "Payments in the last 30 days" }), el("span", { class: "amt", text: String(recent) })]),
        el("div", { class: "statline" }, [el("span", { class: "muted", text: "Statement balance" }), el("span", { class: "muted", text: "No bank feed" })])]);
    }
    cards.push(card(acc.Name, acc.BankAccountNumber || acc.Code, body, [el("button", { type: "button", class: "btn small", text: "Reconcile items", onclick: () => notSimulated("Bank reconciliation") }), el("button", { type: "button", class: "btn small borderless", text: "Account transactions", onclick: () => go(`#/bank`) })]));
  }
  if (docs instanceof Error) { cards.push(failed("Invoices owed to you", docs), failed("Bills to pay", docs)); }
  else cards.push(docsCard("ACCREC", docs), docsCard("ACCPAY", docs));
  for (const t of ["Net profit or loss", "Cash in and out", "Tasks"]) {
    cards.push(el("section", { class: "card ns", "aria-label": t }, [el("div", { class: "card-head" }, el("h2", { text: t })), el("div", { class: "card-body" }, el("div", {}, [el("p", { text: "Not simulated by this Tool" }), el("button", { type: "button", class: "btn small", text: "Learn more", onclick: () => notSimulated(t) })]))]));
  }
  grid.replaceChildren(...cards);
  sizeBars(grid);
});
