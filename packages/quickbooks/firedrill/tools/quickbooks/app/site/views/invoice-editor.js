// Invoice form (new / edit): customer, terms, dates, lines, memos, totals; Save / Save and send via invoices.post.
import { app, isVoided, queryAll } from "../store.js";
import { ToolError, addDays, call, confirmDialog, describe, el, errorBanner, money, newKey, toast } from "../ui.js";
import { field, input, select } from "./common.js";
import { deleteInvoice, pdfPreview, sendDialog, voidInvoice } from "./invoice-actions.js";
import { linesTable } from "./invoice-lines.js";
import { txnFrame } from "./txn-frame.js";

const TERMS = [["", "Select terms"], ["1", "Due on receipt", 0], ["2", "Net 15", 15], ["3", "Net 30", 30]];

export async function openInvoiceEditor(invoiceId = null, onSaved, { customerId = "" } = {}) {
  let touched = false;
  const t = txnFrame(invoiceId ? "Invoice" : "Invoice", {
    onClose: async (close) => { if (!touched || (await confirmDialog("Leave without saving?", "Do you want to leave without saving? Your changes will be lost.", "Yes, leave"))) close(); },
  });
  t.canvas.append(el("div", { class: "loading" }, [el("span", { class: "spinner" }), el("span", { text: "Loading invoice…" })]));
  let inv = null; let customers; let items;
  try {
    [inv, customers, items] = await Promise.all([
      invoiceId ? call("invoices.get", { invoice_id: invoiceId }).then((o) => o.Invoice) : null,
      queryAll("select * from Customer where Active IN (true, false) orderby DisplayName"),
      queryAll("select * from Item orderby Name"),
    ]);
  } catch (error) {
    t.canvas.replaceChildren(errorBanner(error, "We couldn't open this invoice"));
    return;
  }
  const voided = inv ? isVoided(inv) : false;
  t.setTitle(inv ? `Invoice no.${inv.DocNumber ?? inv.Id}` : "Invoice");
  const custOptions = [["", "Add customer"], ...customers.filter((c) => c.Active || c.Id === inv?.CustomerRef?.value).map((c) => [c.Id, c.DisplayName])];
  const cust = field("Customer", select(custOptions, inv?.CustomerRef?.value ?? customerId));
  const email = field("Customer email", input({ type: "email", value: inv?.BillEmail?.Address ?? "", placeholder: "Separate emails with a comma" }));
  const terms = field("Terms", select(TERMS.map(([v, l]) => [v, l]), inv?.SalesTermRef?.value ?? ""));
  const txnDate = field("Invoice date", input({ type: "date", value: inv?.TxnDate ?? app.today }));
  const dueDate = field("Due date", input({ type: "date", value: inv?.DueDate ?? addDays(app.today, 30) }));
  const docNo = field("Invoice no.", input({ value: inv?.DocNumber ?? "", placeholder: "Auto" }));
  const message = field("Message on invoice", el("textarea", { value: inv?.CustomerMemo?.value ?? "", placeholder: "Thank you for your business and have a great day!" }));
  const memo = field("Internal customer notes (hidden)", el("textarea", { value: inv?.PrivateNote ?? "" }));
  const bigBalance = el("div", { class: "val" });
  const subtotal = el("span"); const total = el("span"); const paidRow = el("span"); const balance = el("span");
  const paidCents = inv ? Math.round((Number(inv.TotalAmt) - Number(inv.Balance)) * 100) : 0;
  let lines = null;
  const refreshTotals = () => {
    if (!lines) return;
    const c = lines.totalCents();
    subtotal.textContent = money(c / 100); total.textContent = money(c / 100); paidRow.textContent = money(-paidCents / 100);
    const bal = voided ? 0 : Math.max(0, c - paidCents) / 100;
    balance.textContent = money(bal); bigBalance.textContent = money(bal);
  };
  lines = linesTable(items.filter((i) => i.Active), (inv?.Line ?? []).filter((l) => l.DetailType === "SalesItemLineDetail"), () => refreshTotals());
  const applyTerms = () => { const d = TERMS.find((x) => x[0] === terms.input.value)?.[2]; if (d !== undefined && txnDate.input.value) dueDate.input.value = addDays(txnDate.input.value, d); };
  cust.input.addEventListener("change", () => {
    const c = customers.find((x) => x.Id === cust.input.value);
    if (c) { email.input.value = c.PrimaryEmailAddr?.Address ?? ""; if (c.SalesTermRef?.value && TERMS.some((x) => x[0] === c.SalesTermRef.value)) { terms.input.value = c.SalesTermRef.value; applyTerms(); } }
  });
  terms.input.addEventListener("change", applyTerms);
  txnDate.input.addEventListener("change", applyTerms);
  const formError = el("div");
  const co = app.company ?? {};
  t.canvas.replaceChildren(el("div", { class: "sheet" }, [
    voided ? errorBanner(new Error("This invoice has been voided. Its amounts are zero and it can't be edited."), "Voided") : null,
    formError,
    el("div", { class: "sheet-top" }, [
      el("div", { class: "sheet-company" }, [el("div", { class: "co-name", text: co.CompanyName ?? "" }), el("div", { text: co.CompanyAddr ? `${co.CompanyAddr.Line1 ?? ""}, ${co.CompanyAddr.City ?? ""}, ${co.CompanyAddr.CountrySubDivisionCode ?? ""} ${co.CompanyAddr.PostalCode ?? ""}` : "" }), el("div", { text: co.Email?.Address ?? "" })]),
      el("div", { class: "sheet-balance" }, [el("div", { class: "lbl", text: "Balance due" }), bigBalance]),
    ]),
    el("div", { class: "hr" }),
    el("div", { class: "sheet-grid" }, [el("div", {}, [cust.wrap, email.wrap]), el("div", {}, [terms.wrap]), el("div", { class: "meta" }, [txnDate.wrap, dueDate.wrap, docNo.wrap])]),
    lines.node,
    el("div", { class: "sheet-bottom" }, [
      el("div", { class: "notes" }, [message.wrap, memo.wrap]),
      el("div", { class: "totals" }, [el("div", { class: "t" }, [el("span", { text: "Subtotal" }), subtotal]), el("div", { class: "t" }, [el("span", { text: "Total" }), total]),
        inv ? el("div", { class: "t" }, [el("span", { text: "Amount received" }), paidRow]) : null, el("div", { class: "t big" }, [el("span", { text: "Balance due" }), balance])]),
    ]),
  ]));
  refreshTotals();
  t.canvas.addEventListener("input", () => { touched = true; });
  t.canvas.addEventListener("change", () => { touched = true; });
  t.canvas.addEventListener("click", (e) => { if (e.target.closest(".line-actions, .lines button")) touched = true; });
  if (voided) for (const x of t.canvas.querySelectorAll("input, select, textarea, .line-actions button, .lines button")) x.disabled = true;

  let key = newKey();
  async function save(andSend, allowDuplicate = false) {
    formError.replaceChildren();
    for (const f of [cust, email, txnDate, dueDate, docNo]) f.setError("");
    if (!cust.input.value) { cust.setError("Select a customer."); cust.input.focus(); return; }
    const collected = lines.collect();
    if (collected.error) { formError.replaceChildren(errorBanner(new Error(collected.error), "Check the product and service lines")); collected.focus?.focus(); return; }
    const body = { CustomerRef: { value: cust.input.value }, TxnDate: txnDate.input.value, DueDate: dueDate.input.value, Line: collected.lines,
      CustomerMemo: message.input.value.trim() ? { value: message.input.value.trim() } : null, PrivateNote: memo.input.value.trim() || null };
    if (terms.input.value) body.SalesTermRef = { value: terms.input.value };
    if (email.input.value.trim()) body.BillEmail = { Address: email.input.value.trim() };
    if (docNo.input.value.trim()) body.DocNumber = docNo.input.value.trim();
    if (inv) Object.assign(body, { Id: inv.Id, SyncToken: inv.SyncToken, sparse: true });
    for (const b of t.foot.querySelectorAll("button")) b.disabled = true;
    try {
      const out = await call("invoices.post", { body, ...(allowDuplicate ? { include: "allowduplicatedocnum" } : {}) }, key);
      key = newKey();
      inv = out.Invoice; touched = false;
      toast(`Invoice ${inv.DocNumber ?? ""} saved`);
      onSaved?.();
      if (andSend) { t.close(); sendDialog(inv, onSaved); } else t.close();
    } catch (error) {
      for (const b of t.foot.querySelectorAll("button")) b.disabled = false;
      if (error instanceof ToolError && error.is("DUPLICATE_DOC_NUMBER")) {
        key = newKey();
        if (await confirmDialog("Duplicate invoice number", `Invoice no. ${body.DocNumber} is already used. Use it anyway?`, "Use anyway")) save(andSend, true);
        return;
      }
      if (error instanceof ToolError && error.is("STALE_OBJECT")) { formError.replaceChildren(errorBanner(error, "This invoice was changed elsewhere. Close it and open it again to see the latest version")); return; }
      const target = error instanceof ToolError ? { CustomerRef: cust, BillEmail: email, TxnDate: txnDate, DueDate: dueDate, DocNumber: docNo }[error.element] : undefined;
      if (target) target.setError(describe(error));
      formError.replaceChildren(errorBanner(error, "We couldn't save this invoice"));
      if (!(error instanceof ToolError && error.is("THROTTLE_EXCEEDED"))) key = newKey();
    }
  }
  const more = [];
  if (inv) {
    more.push(el("button", { type: "button", class: "foot-link", text: "Print or download", onclick: () => pdfPreview(inv) }));
    if (!voided) more.push(el("button", { type: "button", class: "foot-link", text: "Void", onclick: () => voidInvoice(inv, () => { t.close(); onSaved?.(); }) }));
    more.push(el("button", { type: "button", class: "foot-link", text: "Delete", onclick: () => deleteInvoice(inv, () => { t.close(); onSaved?.(); }) }));
  }
  t.foot.append(el("button", { type: "button", class: "btn", text: "Cancel", onclick: t.requestClose }), ...more, el("div", { class: "grow" }),
    el("button", { type: "button", class: "btn", text: "Save", disabled: voided, onclick: () => save(false) }),
    el("button", { type: "button", class: "btn primary", text: "Save and send", disabled: voided, onclick: () => save(true) }));
}
