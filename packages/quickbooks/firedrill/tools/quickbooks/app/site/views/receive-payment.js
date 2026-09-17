// Receive payment form: customer, outstanding invoices with per-line payment amounts, deposit account → payments.post.
import { app, queryAll } from "../store.js";
import { ToolError, amount, call, confirmDialog, describe, el, errorBanner, mdY, money, newKey, quote, toast } from "../ui.js";
import { field, input, select } from "./common.js";
import { txnFrame } from "./txn-frame.js";

const METHODS = [["", ""], ["1", "Cash"], ["2", "Check"], ["3", "Credit card"], ["4", "ACH / bank transfer"]];

export async function openReceivePayment({ customerId = "", invoiceId = "", onSaved } = {}) {
  let touched = false;
  const t = txnFrame("Receive payment", { onClose: async (close) => { if (!touched || (await confirmDialog("Leave without saving?", "Do you want to leave without saving? Your changes will be lost.", "Yes, leave"))) close(); } });
  t.canvas.append(el("div", { class: "loading" }, [el("span", { class: "spinner" }), el("span", { text: "Loading…" })]));
  let customers; let deposit;
  try {
    [customers, deposit] = await Promise.all([
      queryAll("select * from Customer orderby DisplayName"),
      queryAll("select * from Account").then((a) => a.filter((x) => x.AccountType === "Bank" || x.AccountSubType === "UndepositedFunds")),
    ]);
  } catch (error) { t.canvas.replaceChildren(errorBanner(error, "We couldn't open Receive payment")); return; }
  const undeposited = deposit.find((a) => a.AccountSubType === "UndepositedFunds");
  const cust = field("Customer", select([["", "Choose a customer"], ...customers.map((c) => [c.Id, c.DisplayName])], customerId));
  const email = field("Email", input({ type: "email", readonly: true, value: "" }));
  const date = field("Payment date", input({ type: "date", value: app.today }));
  const method = field("Payment method", select(METHODS, ""));
  const ref = field("Reference no.", input({ maxlength: "21" }));
  const dep = field("Deposit to", select(deposit.map((a) => [a.Id, a.Name]), undeposited?.Id ?? deposit[0]?.Id ?? ""));
  const received = field("Amount received", input({ type: "number", step: "0.01", min: "0", class: "num" }));
  const memo = field("Memo", el("textarea"));
  const big = el("div", { class: "val", text: money(0) });
  const formError = el("div");
  const tbody = el("tbody");
  let rows = [];
  const sum = () => rows.reduce((s, r) => s + (r.check.checked ? Math.round(Number(r.pay.value || 0) * 100) : 0), 0);
  const syncTotal = () => { const c = sum(); received.input.value = (c / 100).toFixed(2); big.textContent = money(c / 100); };
  received.input.addEventListener("input", () => { touched = true; big.textContent = money(Number(received.input.value || 0)); });

  async function loadOpen() {
    rows = [];
    const c = customers.find((x) => x.Id === cust.input.value);
    email.input.value = c?.PrimaryEmailAddr?.Address ?? "";
    if (!c) { tbody.replaceChildren(el("tr", {}, el("td", { class: "empty", colspan: 6, text: "Select a customer to see outstanding transactions." }))); syncTotal(); return; }
    tbody.replaceChildren(el("tr", {}, el("td", { colspan: 6, class: "empty", text: "Loading outstanding transactions…" })));
    try {
      const open = await queryAll(`select * from Invoice where CustomerRef = ${quote(c.Id)} AND Balance > '0'`);
      open.sort((a, b) => (a.DueDate < b.DueDate ? -1 : 1));
      rows = open.map((inv) => {
        const check = el("input", { type: "checkbox", "aria-label": `Apply payment to invoice ${inv.DocNumber}`, checked: invoiceId ? inv.Id === invoiceId : false });
        const pay = el("input", { class: "cell-input num", type: "number", step: "0.01", min: "0", "aria-label": `Payment for invoice ${inv.DocNumber}`, value: check.checked ? String(inv.Balance) : "" });
        check.addEventListener("change", () => { touched = true; pay.value = check.checked ? String(inv.Balance) : ""; pay.classList.remove("invalid"); syncTotal(); });
        pay.addEventListener("input", () => { touched = true; check.checked = Number(pay.value) > 0; syncTotal(); });
        const tr = el("tr", {}, [el("td", {}, check), el("td", { text: `Invoice # ${inv.DocNumber ?? inv.Id} (${mdY(inv.TxnDate)})` }), el("td", { text: mdY(inv.DueDate) }), el("td", { class: "amt", text: amount(inv.TotalAmt) }), el("td", { class: "amt", text: amount(inv.Balance) }), el("td", {}, pay)]);
        return { inv, check, pay, tr };
      });
      tbody.replaceChildren(...(rows.length ? rows.map((r) => r.tr) : [el("tr", {}, el("td", { class: "empty", colspan: 6, text: "There are no outstanding transactions for this customer." }))]));
      syncTotal();
    } catch (error) { tbody.replaceChildren(el("tr", {}, el("td", { colspan: 6 }, errorBanner(error)))); }
  }
  cust.input.addEventListener("change", () => { touched = true; invoiceId = ""; loadOpen(); });

  t.canvas.replaceChildren(el("div", { class: "sheet" }, [formError,
    el("div", { class: "sheet-top" }, [el("div", { class: "row2" }, [cust.wrap, email.wrap]), el("div", { class: "sheet-balance" }, [el("div", { class: "lbl", text: "Amount received" }), big])]),
    el("div", { class: "row3" }, [date.wrap, method.wrap, ref.wrap]),
    el("div", { class: "row3" }, [dep.wrap, el("div"), received.wrap]),
    el("div", { class: "section-title", text: "Outstanding transactions" }),
    el("div", { class: "table-wrap" }, el("table", { class: "lines outstanding" }, [el("thead", {}, el("tr", {}, [el("th", {}, el("span", { class: "visually-hidden", text: "Apply" })), el("th", { text: "Description" }), el("th", { text: "Due date" }), el("th", { class: "amt", text: "Original amount" }), el("th", { class: "amt", text: "Open balance" }), el("th", { class: "amt", text: "Payment" })])), tbody])),
    el("div", { class: "sheet-bottom" }, [el("div", { class: "notes" }, memo.wrap)]),
  ]));
  await loadOpen();

  let key = newKey();
  const save = el("button", { type: "button", class: "btn primary", text: "Save and close" });
  save.addEventListener("click", async () => {
    formError.replaceChildren(); for (const f of [cust, received, dep]) f.setError("");
    if (!cust.input.value) { cust.setError("Choose a customer."); return cust.input.focus(); }
    const total = Math.round(Number(received.input.value || 0) * 100);
    const applied = sum();
    if (total <= 0) { received.setError("Enter the amount received."); return received.input.focus(); }
    if (applied > total) { received.setError("The amount received is less than the payments applied."); return; }
    const body = { CustomerRef: { value: cust.input.value }, TotalAmt: total / 100, TxnDate: date.input.value || app.today, DepositToAccountRef: { value: dep.input.value },
      Line: rows.filter((r) => r.check.checked && Number(r.pay.value) > 0).map((r) => ({ Amount: Math.round(Number(r.pay.value) * 100) / 100, LinkedTxn: [{ TxnId: r.inv.Id, TxnType: "Invoice" }] })) };
    if (method.input.value) body.PaymentMethodRef = { value: method.input.value, name: METHODS.find((m) => m[0] === method.input.value)[1] };
    if (ref.input.value.trim()) body.PaymentRefNum = ref.input.value.trim();
    if (memo.input.value.trim()) body.PrivateNote = memo.input.value.trim();
    save.disabled = true;
    try {
      const out = await call("payments.post", { body }, key);
      key = newKey();
      t.close();
      toast(`Payment of ${money(out.Payment.TotalAmt)} saved${Number(out.Payment.UnappliedAmt) > 0 ? ` (${money(out.Payment.UnappliedAmt)} unapplied)` : ""}`);
      onSaved?.();
    } catch (error) {
      save.disabled = false;
      if (error instanceof ToolError && /Line|LinkedTxn|Amount/.test(error.element)) rows.forEach((r) => { if (r.check.checked) r.pay.classList.add("invalid"); });
      if (error instanceof ToolError && error.element === "DepositToAccountRef") dep.setError(describe(error));
      formError.replaceChildren(errorBanner(error, "We couldn't save this payment"));
      if (!(error instanceof ToolError && error.is("THROTTLE_EXCEEDED"))) key = newKey();
    }
  });
  t.foot.append(el("button", { type: "button", class: "btn", text: "Cancel", onclick: t.requestClose }),
    el("button", { type: "button", class: "foot-link", text: "Clear payment", onclick: () => { rows.forEach((r) => { r.check.checked = false; r.pay.value = ""; }); syncTotal(); } }),
    el("div", { class: "grow" }), save);
}
