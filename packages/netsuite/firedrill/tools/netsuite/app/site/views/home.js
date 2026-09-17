// Home dashboard: the NetSuite portlet grid (Reminders, Recent Records, Navigation, Tasks | Key Performance
// Indicators, Trend Graphs, Report Snapshots, Settings | Shortcuts, Custom Search, Calendar, Phone Calls, Tips).
// Every number is computed from this Tool's own record collections; portlets whose feature is outside the
// Tool's scope say so instead of showing invented rows.
import { app, can, listIds, expand, register } from "../store.js";
import { el, icon, money, addDays, errorBanner, emptyState, describe, isDenied } from "../ui.js";
import { notSimulated } from "../overlay.js";
import { setPageTitle, nsButton } from "./common.js";
import { MAX_KPI_ROWS, trendBody, snapshotBody, searchBody } from "./home-data.js";
import { navigationBody, calendarBody, activityBody } from "./home-chrome.js";

function portlet(title, body, { menu = true } = {}) {
  return el("section", { class: "portlet" }, [
    el("header", {}, [
      el("h2", { text: title }),
      el("span", { class: "phead-actions" }, menu
        ? [el("button", { type: "button", class: "icon-btn", "aria-label": `${title} portlet menu`, onclick: () => notSimulated(`${title} portlet setup`) }, icon("chevron", 14))]
        : []),
    ]),
    el("div", { class: "pbody" }, body),
  ]);
}

function loading() { return el("div", { class: "muted", text: "Loading…" }); }

async function countOf(operationId, q) {
  const page = await listIds(operationId, { q, limit: 10, offset: 0 });
  return page.totalResults;
}
/** Sum a field over a filtered collection, paging instead of truncating; reports when the cap is reached. */
async function sumOf(listOperation, getOperation, q, field) {
  let total = 0;
  let counted = 0;
  let capped = false;
  for (let offset = 0; ; offset += 50) {
    const page = await listIds(listOperation, { q, limit: 50, offset });
    const rows = await expand(getOperation, page.ids);
    for (const row of rows) total += Number(row[field]) || 0;
    counted += rows.length;
    if (!page.hasMore) break;
    if (counted >= MAX_KPI_ROWS) { capped = true; break; }
  }
  return { total: Math.round(total * 100) / 100, counted, capped };
}

function reminder(label, count, href, { alert = false } = {}) {
  return el("div", { class: "reminder" }, [
    el("span", { class: `rcount${count === 0 ? " zero" : alert && count > 0 ? " alert" : ""}`, text: String(count) }),
    href && count > 0 ? el("a", { href, text: label }) : el("span", { class: count === 0 ? "muted" : "", text: label }),
  ]);
}

async function remindersBody(node) {
  try {
    const soon = addDays(app.today, 7);
    const [toApprove, toFulfill, toBill, overdue, dueSoon, invToApprove, toDeposit] = await Promise.all([
      can("TRAN_SALESORD") ? countOf("sales-order.list", 'status IS "pendingApproval"') : null,
      can("TRAN_SALESORD") ? countOf("sales-order.list", 'status IS "pendingFulfillment"') : null,
      can("TRAN_SALESORD") ? countOf("sales-order.list", '(status IS "pendingBilling" OR status IS "pendingBillingPartFulfilled")') : null,
      can("TRAN_CUSTINVC") ? countOf("invoice.list", `status IS "open" AND dueDate BEFORE "${app.today}"`) : null,
      can("TRAN_CUSTINVC") ? countOf("invoice.list", `status IS "open" AND dueDate ON_OR_AFTER "${app.today}" AND dueDate ON_OR_BEFORE "${soon}"`) : null,
      can("TRAN_CUSTINVC") ? countOf("invoice.list", 'status IS "pendingApproval"') : null,
      can("TRAN_CUSTPYMT") ? countOf("customer-payment.list", 'status IS "notDeposited"') : null,
    ]);
    const rows = [];
    if (toApprove !== null) rows.push(reminder("Sales Orders to Approve", toApprove, "#/orders?status=pendingApproval"));
    if (toFulfill !== null) rows.push(reminder("Sales Orders to Fulfill", toFulfill, "#/orders?status=pendingFulfillment"));
    if (toBill !== null) rows.push(reminder("Sales Orders to Bill", toBill, "#/orders?status=pendingBilling"));
    if (invToApprove !== null) rows.push(reminder("Invoices to Approve", invToApprove, "#/invoices?tab=All"));
    if (overdue !== null) rows.push(reminder("Overdue Invoices", overdue, "#/invoices?tab=Overdue", { alert: true }));
    if (dueSoon !== null) rows.push(reminder("Invoices Due Within 7 Days", dueSoon, "#/invoices?tab=Open"));
    if (toDeposit !== null) rows.push(reminder("Payments to Deposit", toDeposit, "#/payments"));
    node.replaceChildren(...(rows.length ? rows : [emptyState("No reminders", "This role cannot view transactions.")]));
  } catch (error) {
    node.replaceChildren(errorBanner(error, "Reminders could not be loaded"));
  }
}

async function kpiBody(node) {
  if (!can("TRAN_CUSTINVC")) {
    node.replaceChildren(el("div", { class: "muted", text: describe(new Error("The Invoice permission is required for these indicators.")) }));
    return;
  }
  try {
    const currency = app.session?.account?.baseCurrency ?? "";
    const open = await sumOf("invoice.list", "invoice.get", 'status IS "open"', "amountRemaining");
    const overdue = await sumOf("invoice.list", "invoice.get", `status IS "open" AND dueDate BEFORE "${app.today}"`, "amountRemaining");
    const unbilled = can("TRAN_SALESORD")
      ? await sumOf("sales-order.list", "sales-order.get", '(status IS "pendingBilling" OR status IS "pendingBillingPartFulfilled" OR status IS "pendingFulfillment")', "total")
      : null;
    const table = el("table", { class: "kv" }, [
      el("tr", {}, [el("td", { text: "Open Invoice Total" }), el("td", { class: "num", text: money(open.total, currency) })]),
      el("tr", {}, [el("td", { text: "Overdue Receivables" }), el("td", { class: "num", text: money(overdue.total, currency) })]),
      unbilled ? el("tr", {}, [el("td", { text: "Unbilled Orders" }), el("td", { class: "num", text: money(unbilled.total, currency) })]) : null,
    ]);
    const capped = [open, overdue, unbilled].some((result) => result?.capped === true);
    node.replaceChildren(table, capped
      ? el("p", { class: "muted", text: `Computed over the first ${MAX_KPI_ROWS} matching transactions.` })
      : el("p", { class: "muted", text: `As of ${app.today}, the account date of this world.` }));
  } catch (error) {
    node.replaceChildren(isDenied(error) ? errorBanner(error) : errorBanner(error, "Indicators could not be computed"));
  }
}

function recentBody() {
  if (app.recent.length === 0) {
    return el("p", { class: "muted", text: "Records you open appear here." });
  }
  return el("ul", { class: "shortcut-list" }, app.recent.map((entry) =>
    el("li", {}, el("a", { href: entry.href, text: entry.label }))));
}

function shortcutsBody() {
  const entries = [
    ["Customers", "#/customers", can("LIST_CUSTJOB")],
    ["Sales Orders", "#/orders", can("TRAN_SALESORD")],
    ["Invoices", "#/invoices", can("TRAN_CUSTINVC")],
    ["Customer Payments", "#/payments", can("TRAN_CUSTPYMT")],
    ["Items", "#/items", can("LIST_ITEM")],
    ["SuiteQL Query Tool", "#/suiteql", can("REPO_ANALYTICS")],
  ].filter(([, , allowed]) => allowed);
  return el("ul", { class: "shortcut-list" }, entries.map(([label, href]) => el("li", {}, el("a", { href, text: label }))));
}

register("home", async (main) => {
  setPageTitle("Home");
  const session = app.session;
  const reminders = el("div", {}, loading());
  const kpis = el("div", {}, loading());
  const trend = el("div", {}, loading());
  const snapshot = el("div", {}, loading());
  const search = el("div", {}, loading());
  main.replaceChildren(el("div", { class: "dash" }, [
    el("div", { class: "dash-title" }, [
      el("h1", { text: session ? `${session.account.companyName} — Home` : "Home" }),
      el("span", { class: "muted", text: session ? `${session.user.name} · ${session.role.name} · account date ${app.today}` : "" }),
    ]),
    el("div", { class: "col" }, [
      portlet("Reminders", reminders),
      portlet("Recent Records", recentBody()),
      portlet("Navigation", navigationBody()),
      portlet("Tasks", activityBody("Tasks")),
    ]),
    el("div", { class: "col" }, [
      portlet("Key Performance Indicators", kpis),
      portlet("Trend Graphs", trend),
      portlet("Report Snapshots", snapshot),
      portlet("Settings", [
        el("p", { class: "muted", text: "Personalization of the dashboard is not simulated by this Tool." }),
        el("div", { class: "btn-row" }, [nsButton("Personalize Dashboard"), nsButton("Layout")]),
      ], { menu: false }),
    ]),
    el("div", { class: "col" }, [
      portlet("Shortcuts", shortcutsBody()),
      portlet("Custom Search", search),
      portlet("Calendar", calendarBody()),
      portlet("Phone Calls", activityBody("Phone Calls")),
      portlet("Tips", el("p", { class: "muted", text: "This is a synthetic NetSuite account served by a Firedrill Tool. Records written here are the same records your agent reads over SuiteTalk REST." }), { menu: false }),
    ]),
  ]));
  await Promise.all([remindersBody(reminders), kpiBody(kpis), trendBody(trend), snapshotBody(snapshot), searchBody(search)]);
});
