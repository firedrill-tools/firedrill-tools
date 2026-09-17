// "Make a payment" panel on an approved invoice or bill: payments.create with an idempotency key per submission.
import { app, listAll } from "../store.js";
import { amount, call, el, newKey, toast } from "../ui.js";

export function paymentPanel(inv, doc, refresh) {
  const ids = { amount: "pay-amount", date: "pay-date", account: "pay-account", ref: "pay-ref" };
  const amountIn = el("input", { class: "input", id: ids.amount, inputmode: "decimal", value: Number(inv.AmountDue).toFixed(2) });
  const dateIn = el("input", { class: "input", id: ids.date, type: "date", value: app.today });
  const accountSel = el("select", { class: "select", id: ids.account }, el("option", { value: "", text: "Loading accounts…" }));
  const refIn = el("input", { class: "input", id: ids.ref, maxlength: "255" });
  const err = el("div", { class: "err", role: "alert" });
  let key = newKey();
  for (const input of [amountIn, dateIn, accountSel, refIn]) input.addEventListener("input", () => { key = newKey(); });

  listAll("accounts.list", "Accounts", { where: `Status=="ACTIVE"&&(Type=="BANK"||EnablePaymentsToAccount==true)` }).then((rows) => {
    accountSel.replaceChildren(el("option", { value: "", text: "Choose an account" }), ...rows.map((a) => el("option", { value: a.Code, text: `${a.Code} - ${a.Name}` })));
    if (rows.length === 1) accountSel.value = rows[0].Code;
  }).catch((error) => { accountSel.replaceChildren(el("option", { value: "", text: "Accounts unavailable" })); err.textContent = error.message; });

  const submit = el("button", { type: "submit", class: "btn create", text: "Add payment" });
  const form = el("form", { class: "form-grid", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    const value = Number(amountIn.value.replace(/,/g, ""));
    if (!Number.isFinite(value) || value <= 0) { err.textContent = "Enter an amount greater than zero."; amountIn.classList.add("invalid"); return; }
    if (!accountSel.value) { err.textContent = `Choose the account the payment was ${doc.type === "ACCREC" ? "paid to" : "paid from"}.`; accountSel.classList.add("invalid"); return; }
    submit.disabled = true;
    try {
      const out = await call("payments.create", { method: "PUT", summarizeErrors: false, body: { Payments: [{ Invoice: { InvoiceID: inv.InvoiceID }, Account: { Code: accountSel.value }, Date: dateIn.value, Amount: value, ...(refIn.value.trim() ? { Reference: refIn.value.trim() } : {}) }] } }, key);
      const row = out.Payments?.[0];
      if (row?.StatusAttributeString === "ERROR") throw new Error((row.ValidationErrors ?? []).map((v) => v.Message).join(" ") || "The payment could not be added.");
      toast(`Payment of ${amount(value)} added`);
      await refresh();
    } catch (error) {
      err.textContent = error.message;
      submit.disabled = false;
    }
  } }, [
    el("div", { class: "field" }, [el("label", { for: ids.amount, text: "Amount paid" }), amountIn]),
    el("div", { class: "field" }, [el("label", { for: ids.date, text: "Date paid" }), dateIn]),
    el("div", { class: "field" }, [el("label", { for: ids.account, text: doc.type === "ACCREC" ? "Paid to" : "Paid from" }), accountSel]),
    el("div", { class: "field" }, [el("label", { for: ids.ref, text: "Reference" }), refIn]),
    el("div", { class: "field" }, submit),
  ]);
  return el("section", { class: "paypanel", "aria-label": "Make a payment" }, [el("h2", { text: "Make a payment" }), form, err]);
}
