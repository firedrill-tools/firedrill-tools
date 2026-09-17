// Sales & Get paid > Invoices: money bar, filters, server-side paging through query.run, row actions.
import { app, go, isVoided, query, queryAll, register } from "../store.js";
import { addDays, amount, call, describe, el, errorBanner, icon, isAccessDenied, loadingRows, mdY, money, notSimulated, quote, toast } from "../ui.js";
import { emptyRow, pageShell, pager, salesTabs, select, statusCell } from "./common.js";
import { openInvoiceEditor } from "./invoice-editor.js";
import { rowActions } from "./invoice-actions.js";
import { createSelection } from "./batch.js";
import { invoiceBatchActions } from "./batch-actions.js";

const SIZE = 25;

/** Money bar data: unpaid (overdue / not due) over 365 days and paid (not deposited / deposited) over 30 days. */
export async function moneyBarData() {
  const today = app.today;
  const [open, payments, undeposited] = await Promise.all([
    queryAll(`select * from Invoice where Balance > '0' AND TxnDate >= ${quote(addDays(today, -365))}`),
    queryAll(`select * from Payment where TxnDate >= ${quote(addDays(today, -30))}`),
    queryAll("select * from Account where Active IN (true, false)").then((a) => new Set(a.filter((x) => x.AccountSubType === "UndepositedFunds").map((x) => x.Id))).catch(() => new Set()),
  ]);
  const d = { overdue: 0, overdueN: 0, notDue: 0, notDueN: 0, notDeposited: 0, notDepositedN: 0, deposited: 0, depositedN: 0 };
  for (const inv of open) {
    if (inv.DueDate < today) { d.overdue += Number(inv.Balance); d.overdueN += 1; } else { d.notDue += Number(inv.Balance); d.notDueN += 1; }
  }
  for (const p of payments) {
    if (typeof p.PrivateNote === "string" && p.PrivateNote.startsWith("Voided")) continue;
    if (undeposited.has(p.DepositToAccountRef?.value)) { d.notDeposited += Number(p.TotalAmt); d.notDepositedN += 1; } else { d.deposited += Number(p.TotalAmt); d.depositedN += 1; }
  }
  return d;
}

function moneyBar(d, selected, onPick) {
  const seg = (key, amt, n, label, tone) => el("button", { type: "button", class: `mb-seg${selected === key ? " selected" : ""}`, "aria-pressed": selected === key ? "true" : "false", onclick: () => onPick(selected === key ? "" : key), style: undefined }, [
    el("div", { class: "mb-amt", text: money(amt) }), el("div", { class: "mb-lbl", text: `${n} ${label}` }), el("div", { class: `mb-bar ${tone}` }),
  ]);
  return el("div", { class: "moneybar", role: "group", "aria-label": "Invoice summary" }, [
    el("div", {}, [el("div", { class: "mb-group-head" }, [el("span", {}, [el("strong", { text: `${money(d.overdue + d.notDue)} Unpaid` })]), el("span", { text: "Last 365 days" })]),
      el("div", { class: "mb-segs" }, [seg("overdue", d.overdue, d.overdueN, "Overdue", "tone-orange"), seg("open", d.notDue, d.notDueN, "Not due yet", "tone-grey")])]),
    el("div", {}, [el("div", { class: "mb-group-head" }, [el("span", {}, [el("strong", { text: `${money(d.notDeposited + d.deposited)} Paid` })]), el("span", { text: "Last 30 days" })]),
      el("div", { class: "mb-segs" }, [seg("notdeposited", d.notDeposited, d.notDepositedN, "Not deposited", "tone-lgreen"), seg("paid", d.deposited, d.depositedN, "Deposited", "tone-green")])]),
  ]);
}

register("invoices", async (host, route) => {
  const p = route.params;
  const status = p.get("status") ?? "";
  const customer = p.get("customer") ?? "";
  const dates = p.get("dates") ?? "365";
  const q = p.get("q") ?? "";
  const start = Math.max(1, Number(p.get("start")) || 1);
  const nav = (patch) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k); go(`#/invoices?${n}`); };
  const refresh = () => { if (host.isConnected) app.pages.invoices(host, route); };
  const { root, body } = pageShell("Invoices", {
    crumb: "Sales & Get paid",
    actions: [
      el("button", { type: "button", class: "btn", text: "Manage templates", onclick: () => notSimulated("Custom form styles") }),
      el("div", { class: "split" }, [el("button", { type: "button", class: "btn primary", text: "Create invoice", onclick: () => openInvoiceEditor(null, refresh) }),
        el("button", { type: "button", class: "btn primary", "aria-label": "More create options", onclick: () => notSimulated("Import invoices") }, icon("chevronDown"))]),
    ],
    tabs: salesTabs("invoices"),
  });
  const barHost = el("div", {}, el("div", { class: "moneybar" }, [el("div", { class: "skeleton" }), el("div", { class: "skeleton" })]));
  const search = el("input", { type: "search", placeholder: "Search by invoice no.", "aria-label": "Search by invoice number", value: q });
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") nav({ q: search.value.trim(), start: "" }); });
  const statusSel = select([["", "All"], ["unpaid", "Unpaid"], ["overdue", "Overdue"], ["open", "Not due yet"], ["paidall", "Paid"]], ["notdeposited", "paid"].includes(status) ? "paidall" : status);
  statusSel.setAttribute("aria-label", "Status");
  statusSel.addEventListener("change", () => nav({ status: statusSel.value, start: "" }));
  const dateSel = select([["365", "Last 365 days"], ["90", "Last 90 days"], ["30", "Last 30 days"], ["all", "All dates"]], dates);
  dateSel.setAttribute("aria-label", "Date");
  dateSel.addEventListener("change", () => nav({ dates: dateSel.value, start: "" }));
  const custSel = select([["", "All customers"]], "");
  custSel.setAttribute("aria-label", "Customer");
  custSel.addEventListener("change", () => nav({ customer: custSel.value, start: "" }));
  const sel = createSelection({ noun: "invoices", labelFor: (inv) => `invoice ${inv.DocNumber ?? inv.Id}`, actionsFor: (rows) => invoiceBatchActions(rows, refresh) });
  const tbody = el("tbody", {}, loadingRows(7));
  const foot = el("div");
  const card = el("div", { class: "card" }, [
    el("div", { class: "toolbar" }, [el("div", { class: "tsearch" }, [icon("search"), search]), el("label", { class: "filter-label" }, ["Status", statusSel]), el("label", { class: "filter-label" }, ["Date", dateSel]), el("label", { class: "filter-label" }, ["Customer", custSel]), el("div", { class: "grow" }),
      el("button", { type: "button", class: "icon-btn", "aria-label": "Print list", title: "Print list", onclick: () => notSimulated("Print list") }, icon("print")),
      el("button", { type: "button", class: "icon-btn", "aria-label": "Export to Excel", title: "Export to Excel", onclick: () => notSimulated("Export to Excel") }, icon("export")),
      el("button", { type: "button", class: "icon-btn", "aria-label": "Table settings", title: "Settings", onclick: () => notSimulated("Table settings") }, icon("gear"))]),
    sel.bar,
    el("div", { class: "table-wrap" }, el("table", { class: "grid" }, [el("thead", {}, el("tr", {}, [el("th", { class: "check" }, sel.head), ...["Date", "No.", "Customer", "Amount", "Status", "Action"].map((h, i) => el("th", { class: i === 3 ? "num" : i === 5 ? "act" : "", text: h }))])), tbody])),
    foot,
  ]);
  body.append(barHost, card);
  host.replaceChildren(root);
  moneyBarData().then((d) => barHost.replaceChildren(moneyBar(d, status, (key) => nav({ status: key, start: "" })))).catch((error) => (isAccessDenied(error) ? barHost.remove() : barHost.replaceChildren(errorBanner(error, "We couldn't load the invoice summary"))));
  queryAll("select * from Customer where Active IN (true, false) orderby DisplayName").then((cs) => { for (const c of cs) custSel.append(el("option", { value: c.Id, text: c.DisplayName })); custSel.value = customer; }).catch((error) => { if (!isAccessDenied(error)) toast(`Customer filter: ${describe(error)}`, { error: true }); });
  try {
    const where = [];
    if (dates !== "all") where.push(`TxnDate >= ${quote(addDays(app.today, -Number(dates)))}`);
    if (status === "unpaid") where.push("Balance > '0'");
    if (status === "overdue") where.push("Balance > '0'", `DueDate < ${quote(app.today)}`);
    if (status === "open") where.push("Balance > '0'", `DueDate >= ${quote(app.today)}`);
    if (status === "paidall" || status === "paid" || status === "notdeposited") where.push("Balance = '0'");
    if (customer) where.push(`CustomerRef = ${quote(customer)}`);
    if (q) where.push(`DocNumber LIKE ${quote(`%${q}%`)}`);
    const clause = where.length ? ` where ${where.join(" AND ")}` : "";
    const total = (await call("query.run", { query: `select count(*) from Invoice${clause}` })).QueryResponse.totalCount ?? 0;
    const rows = await query(`select * from Invoice${clause} orderby TxnDate desc STARTPOSITION ${start} MAXRESULTS ${SIZE}`);
    sel.reset();
    tbody.replaceChildren(...(rows.length ? rows.map((inv) => {
      const tr = el("tr", { class: "clickable", tabindex: "0", "aria-label": `Invoice ${inv.DocNumber ?? inv.Id}` }, [
        sel.cell(inv),
        el("td", { text: mdY(inv.TxnDate) }), el("td", { text: inv.DocNumber ?? "" }), el("td", { text: inv.CustomerRef?.name ?? "" }),
        el("td", { class: "num", text: isVoided(inv) ? "$0.00" : money(inv.TotalAmt) }), el("td", {}, statusCell(inv)), el("td", { class: "act" }, rowActions(inv, refresh)),
      ]);
      const open = () => openInvoiceEditor(inv.Id, refresh);
      tr.addEventListener("click", (e) => { if (!e.target.closest("button, input, a")) open(); });
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === tr) open(); });
      return tr;
    }) : [emptyRow(7, q || status || customer ? "No invoices match these filters" : "No invoices yet", q || status || customer ? "Try changing the filters." : "Create an invoice to get paid faster.")]));
    foot.replaceChildren(pager({ start, size: SIZE, total, onChange: (s) => nav({ start: String(s) }) }));
  } catch (error) {
    card.replaceWith(errorBanner(error, isAccessDenied(error) ? "You don't have access to Sales data" : "We couldn't load your invoices"));
  }
  void amount;
});
