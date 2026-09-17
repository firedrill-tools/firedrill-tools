// Sales & Get paid > Payments: received payments with paging, customer filter, void and delete.
import { app, go, query, queryAll, register } from "../store.js";
import { call, confirmDialog, describe, el, errorBanner, icon, isAccessDenied, loadingRows, mdY, money, newKey, openMenu, quote, toast } from "../ui.js";
import { emptyRow, pageShell, pager, salesTabs, select } from "./common.js";
import { openReceivePayment } from "./receive-payment.js";

const SIZE = 25;
const isVoidedPayment = (p) => typeof p.PrivateNote === "string" && p.PrivateNote.startsWith("Voided");

register("payments", async (host, route) => {
  const p = route.params;
  const customer = p.get("customer") ?? "";
  const start = Math.max(1, Number(p.get("start")) || 1);
  const nav = (patch) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k); go(`#/payments?${n}`); };
  const refresh = () => { if (host.isConnected) app.pages.payments(host, route); };
  const { root, body } = pageShell("Payments", {
    crumb: "Sales & Get paid",
    actions: [el("button", { type: "button", class: "btn primary", text: "Receive payment", onclick: () => openReceivePayment({ onSaved: refresh }) })],
    tabs: salesTabs("payments"),
  });
  const custSel = select([["", "All customers"]], "");
  custSel.setAttribute("aria-label", "Customer");
  custSel.addEventListener("change", () => nav({ customer: custSel.value, start: "" }));
  const tbody = el("tbody", {}, loadingRows(8));
  const foot = el("div");
  const card = el("div", { class: "card" }, [
    el("div", { class: "toolbar" }, [el("label", { class: "filter-label" }, ["Customer", custSel]), el("div", { class: "grow" })]),
    el("div", { class: "table-wrap" }, el("table", { class: "grid" }, [el("thead", {}, el("tr", {}, ["Date", "Type", "No.", "Customer", "Method", "Deposit to", "Amount", "Status", "Action"].map((h, i) => el("th", { class: i === 6 ? "num" : i === 8 ? "act" : "", text: h })))), tbody])),
    foot,
  ]);
  body.append(card);
  host.replaceChildren(root);
  queryAll("select * from Customer where Active IN (true, false) orderby DisplayName").then((cs) => { for (const c of cs) custSel.append(el("option", { value: c.Id, text: c.DisplayName })); custSel.value = customer; }).catch((error) => { if (!isAccessDenied(error)) toast(`Customer filter: ${describe(error)}`, { error: true }); });
  try {
    const clause = customer ? ` where CustomerRef = ${quote(customer)}` : "";
    const total = (await call("query.run", { query: `select count(*) from Payment${clause}` })).QueryResponse.totalCount ?? 0;
    const rows = await query(`select * from Payment${clause} orderby TxnDate desc STARTPOSITION ${start} MAXRESULTS ${SIZE}`);
    tbody.replaceChildren(...(rows.length ? rows.map((pay) => {
      const voided = isVoidedPayment(pay);
      const unapplied = Number(pay.UnappliedAmt ?? 0);
      const caret = el("button", { type: "button", class: "caret", "aria-label": `More actions for payment ${pay.Id}`, "aria-haspopup": "menu" }, icon("chevronDown"));
      caret.addEventListener("click", () => openMenu(caret, [
        { label: "Void", disabled: voided, run: async () => {
          if (!(await confirmDialog("Void payment?", `Voiding sets this ${money(pay.TotalAmt)} payment to zero and reopens the invoices it paid.`, "Yes, void"))) return;
          try { await call("payments.post", { operation: "void", body: { Id: pay.Id, SyncToken: pay.SyncToken } }, newKey()); toast("Payment voided"); refresh(); } catch (error) { toast(describe(error), { error: true }); }
        } },
        { label: "Delete", run: async () => {
          if (!(await confirmDialog("Delete payment?", "Deleting this payment reopens the invoices it paid. This can't be undone.", "Yes, delete", "danger"))) return;
          try { await call("payments.post", { operation: "delete", body: { Id: pay.Id, SyncToken: pay.SyncToken } }, newKey()); toast("Payment deleted"); refresh(); } catch (error) { toast(describe(error), { error: true }); }
        } },
      ]));
      const status = voided ? "Voided" : unapplied > 0 ? `Unapplied ${money(unapplied)}` : "Closed";
      return el("tr", {}, [el("td", { text: mdY(pay.TxnDate) }), el("td", { text: "Payment" }), el("td", { text: pay.PaymentRefNum ?? "" }),
        el("td", {}, el("a", { href: `#/customers/${encodeURIComponent(pay.CustomerRef?.value ?? "")}`, text: pay.CustomerRef?.name ?? "" })),
        el("td", { text: pay.PaymentMethodRef?.name ?? "" }), el("td", { text: pay.DepositToAccountRef?.name ?? "" }),
        el("td", { class: "num", text: money(pay.TotalAmt) }), el("td", { class: voided ? "muted" : "", text: status }),
        el("td", { class: "act" }, el("div", { class: "row-actions" }, [el("span", { class: "muted", text: "" }), caret]))]);
    }) : [emptyRow(9, "No payments yet", "Record a payment when a customer pays an invoice.")]));
    foot.replaceChildren(pager({ start, size: SIZE, total, onChange: (s) => nav({ start: String(s) }) }));
  } catch (error) {
    card.replaceWith(errorBanner(error, isAccessDenied(error) ? "You don't have access to payments" : "We couldn't load payments"));
  }
});
