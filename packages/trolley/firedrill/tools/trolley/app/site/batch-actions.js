// Batch mutations: add/edit/remove payment (recipient search picker), generate quote, review summary, process, delete.
import { app, go, refreshNow } from "./app.js";
import { btn, call, confirmDialog, describe, el, field, human, input, money, newKey, openModal, select, showFieldError, toast } from "./ui.js";

const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "MXN"].map((c) => [c, c]);

async function run(operation, args, key, success, reload) {
  try {
    await call(operation, args, key);
    toast(success);
  } catch (error) {
    toast(describe(error), { error: true, timeout: 8000 });
  }
  reload();
}

export function openPaymentForm(batch, payment, reload) {
  let recipient = payment ? payment.recipient : undefined;
  const chosen = el("div", { class: "method-sub", text: recipient ? `Selected: ${recipient.name} (${recipient.email ?? recipient.id})` : "No recipient selected" });
  const results = el("div", { class: "picker-list", attrs: { role: "listbox", "aria-label": "Matching recipients" } });
  const query = input("recipientSearch", "", { type: "search", autocomplete: "off", placeholder: "Type a name, email or reference ID" });
  let timer;
  let seq = 0;
  const search = async () => {
    const mine = (seq += 1);
    const text = query.value.trim();
    try {
      const value = await call("recipients.list", { pageSize: 8, status: "active", ...(text ? { search: text } : {}) });
      if (mine !== seq) return;
      results.replaceChildren(...(value.recipients.length ? value.recipients.map((r) => el("button", { attrs: { type: "button", role: "option", "aria-selected": String(recipient?.id === r.id) }, on: { click: () => { recipient = r; chosen.textContent = `Selected: ${r.name} (${r.email ?? r.id})`; void search(); } } }, [el("strong", { text: r.name }), el("span", { class: "method-sub", text: `${r.email ?? ""} · ${human(r.payoutMethod ?? "")} ${r.primaryCurrency ?? ""}` })]))
        : [el("div", { class: "state", text: "No active recipients match." })]));
      if (value.meta.records > value.recipients.length) results.append(el("div", { class: "menu-note", text: `Showing ${value.recipients.length} of ${value.meta.records}; refine the search.` }));
    } catch (error) {
      if (mine === seq) results.replaceChildren(el("div", { class: "form-error", text: describe(error) }));
    }
  };
  query.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 250); });
  const form = el("form", { class: "form-grid", attrs: { novalidate: true } }, [
    payment ? null : el("div", { class: "field-full", attrs: { "data-field": "recipient" } }, [field("Recipient", query, { full: true }), results, chosen, el("div", { class: "field-error" })]),
    field("Amount", input("amount", payment?.sourceAmount ?? "", { inputmode: "decimal", placeholder: "0.00" })),
    field("Currency", select("currency", CURRENCIES, payment?.sourceCurrency ?? batch.currency)),
    field("Memo", input("memo", payment?.memo ?? ""), { full: true }),
    field("External ID", input("externalId", payment?.externalId ?? "")),
    field("Category", select("category", [["", "None"], ...["services", "rent", "royalties", "royalties_film", "prizes", "education", "refunds"].map((c) => [c, human(c)])], payment?.category ?? "")),
    el("label", { class: "field-full method-sub" }, [el("input", { attrs: { type: "checkbox", name: "coverFees", checked: payment?.coverFees ?? false } }), el("span", { text: " Merchant covers the fees" })]),
  ]);
  const formError = el("div", { class: "form-error", attrs: { role: "alert" } });
  const save = btn(payment ? "Save payment" : "Add payment", "primary");
  const key = newKey();
  app.editing += 1;
  const modal = openModal({ title: payment ? "Edit payment" : "Add payment", body: [form, formError], wide: true, actions: [btn("Cancel", "secondary", { onClick: () => modal.close() }), save], onClose: () => { app.editing -= 1; } });
  if (!payment) void search();
  save.addEventListener("click", async () => {
    const d = new FormData(form);
    const args = { batchId: batch.id, amount: String(d.get("amount")).trim(), currency: d.get("currency"), coverFees: d.get("coverFees") === "on" };
    for (const name of ["memo", "externalId"]) if (String(d.get(name)).trim()) args[name] = String(d.get(name)).trim();
    if (d.get("category")) args.category = d.get("category");
    if (payment) args.paymentId = payment.id;
    else if (recipient) args.recipient = { id: recipient.id };
    save.disabled = true;
    formError.textContent = "";
    try {
      await call(payment ? "payments.update" : "payments.create", args, key);
      modal.close();
      toast(payment ? "Payment updated." : "Payment added to the batch.");
      reload();
    } catch (error) {
      if (!showFieldError(form, error)) formError.textContent = describe(error);
      save.disabled = false;
    }
  });
}

export async function removePayment(batch, payment, reload) {
  if (await confirmDialog("Remove payment?", `The ${money(payment.sourceAmount, payment.sourceCurrency)} payment to ${payment.recipient?.name ?? "this recipient"} will be removed from the batch.`, "Remove", { danger: true })) {
    await run("payments.delete", { batchId: batch.id, paymentId: payment.id }, newKey(), "Payment removed.", reload);
  }
}

export async function generateQuote(batch, reload) {
  await run("batches.generate_quote", { batchId: batch.id }, newKey(), "Quote generated. Process the batch before it expires.", reload);
  await refreshNow();
}

export async function reviewSummary(batch) {
  const body = el("div", {}, el("div", { class: "skeleton" }));
  openModal({ title: "Batch review", body, wide: true });
  try {
    const { batchSummary } = await call("batches.summary", { batchId: batch.id });
    const rows = Object.entries(batchSummary.detail);
    body.replaceChildren(rows.length === 0 ? el("p", { text: "This batch has no payments." }) : el("div", { class: "table-wrap" }, el("table", { class: "table" }, [
      el("thead", {}, el("tr", {}, ["Payout method", "Payments", "Sending", "Fees", "Merchant fees", "Debit"].map((h, i) => el("th", { class: i ? "num" : "", text: h, attrs: { scope: "col" } })))),
      el("tbody", {}, rows.map(([method, s]) => el("tr", {}, [el("td", { text: human(method) }), el("td", { class: "num", text: String(s.count) }), el("td", { class: "num", text: money(s.sendingAmount, batch.currency) }), el("td", { class: "num", text: money(s.totalFees, batch.currency) }), el("td", { class: "num", text: money(s.merchantFees, batch.currency) }), el("td", { class: "num", text: money(s.debitAmount, batch.currency) })]))),
    ])));
  } catch (error) {
    body.replaceChildren(el("p", { class: "form-error", text: describe(error) }));
  }
}

export async function processBatch(batch, reload) {
  let debit = "—";
  let balance = "—";
  try {
    const [{ batchSummary }, balances] = await Promise.all([call("batches.summary", { batchId: batch.id }), call("balances.list", { kind: "paymentrails" })]);
    const cents = Object.values(batchSummary.detail).reduce((sum, s) => sum + Math.round(Number(s.debitAmount) * 100), 0);
    debit = money((cents / 100).toFixed(2), batch.currency);
    const funding = balances.balances.find((b) => b.currency === batch.currency);
    balance = funding ? money(funding.amount, funding.currency) : `no ${batch.currency} balance`;
  } catch (error) {
    toast(describe(error), { error: true });
  }
  const message = el("div", {}, [
    el("p", { text: `You are about to send ${batch.totalPayments} payments from "${batch.description || batch.id}".` }),
    el("dl", { class: "dl" }, [el("dt", { text: "Total debit" }), el("dd", { text: debit }), el("dt", { text: "Available balance" }), el("dd", { text: balance })]),
    el("p", { class: "method-sub", text: "Synthetic processing: balances and payment statuses change in this world only; no money moves." }),
  ]);
  if (!(await confirmDialog("Process batch?", message, "Process batch"))) return;
  const key = newKey();
  try {
    await call("batches.start_processing", { batchId: batch.id }, key);
    toast("Batch sent for processing.");
  } catch (error) {
    const unknown = error.is?.("INTERNAL_SERVER_ERROR") || error.is?.("PARTNER_INTEGRATION_ERROR");
    toast(unknown ? "The result is unknown. Refresh before retrying." : describe(error), { error: true, timeout: 10000 });
  }
  reload();
}

export async function deleteBatch(batch) {
  if (!(await confirmDialog("Delete batch?", `"${batch.description || batch.id}" and its ${batch.totalPayments} payments will be deleted.`, "Delete", { danger: true }))) return;
  try {
    await call("batches.delete", { batchId: batch.id }, newKey());
    toast("Batch deleted.");
    go("payments");
  } catch (error) {
    toast(describe(error), { error: true });
    go("payments", batch.id);
  }
}
