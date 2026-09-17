// Invoice / bill view: status header with options, line table, totals, payments with Remove, and the Make a payment panel.
import { DOC, app, go, isOverdue, listAll, register } from "../store.js";
import { amount, call, dmy, el, errorBanner, icon, newKey, toast, wireDate } from "../ui.js";
import { confirmDialog, notSimulated, openMenu } from "../overlay.js";
import { pageHead, statusTag } from "./common.js";
import { paymentPanel } from "./payment-panel.js";

const TAX_LABEL = { Exclusive: "Tax Exclusive", Inclusive: "Tax Inclusive", NoTax: "No Tax" };

export async function saveStatus(inv, status, key = newKey()) {
  const out = await call("invoices.save", { method: "POST", pathInvoiceId: inv.InvoiceID, body: { InvoiceID: inv.InvoiceID, Status: status }, summarizeErrors: false }, key);
  const el0 = out.Invoices?.[0];
  if (el0?.StatusAttributeString === "ERROR") throw new Error((el0.ValidationErrors ?? []).map((v) => v.Message).join(" ") || "Xero could not update this invoice.");
  return el0;
}

async function renderDocument(host, route, doc) {
  host.replaceChildren(el("div", { class: "loading" }, [el("span", { class: "spinner", "aria-hidden": "true" }), el("span", { text: "Loading…" })]));
  let inv;
  try {
    const out = await call("invoices.get", { invoiceId: route.id });
    inv = out.Invoices?.[0];
  } catch (error) {
    host.replaceChildren(el("div", { class: "page-inner" }, errorBanner(error, error?.is?.("NOT_FOUND") ? `This ${doc.noun.toLowerCase()} doesn't exist` : `We couldn't load this ${doc.noun.toLowerCase()}`)));
    return;
  }
  const [accounts, rates] = await Promise.all([listAll("accounts.list", "Accounts", {}).catch(() => []), listAll("tax-rates.list", "TaxRates", {}).catch(() => [])]);
  const accountName = new Map(accounts.map((a) => [a.Code, `${a.Code} - ${a.Name}`]));
  const rateName = new Map(rates.map((t) => [t.TaxType, t.Name]));
  if (inv.Type !== doc.type) { go(`#/${DOC[inv.Type]?.route ?? "invoices"}/${encodeURIComponent(inv.InvoiceID)}`); return; }
  const refresh = () => renderDocument(host, route, doc);
  const act = async (label, run) => {
    try { await run(); toast(label); await refresh(); } catch (error) { toast(error.message, { error: true }); }
  };
  const editable = inv.Status === "DRAFT" || inv.Status === "SUBMITTED" || (inv.Status === "AUTHORISED" && (inv.Payments ?? []).length === 0);
  const options = [
    { label: "Edit", disabled: !editable, run: () => go(`#/${doc.route}/${encodeURIComponent(inv.InvoiceID)}/edit`) },
    { label: "Copy to…" }, { label: "Add note" },
    { divider: true },
  ];
  if (inv.Status === "DRAFT" || inv.Status === "SUBMITTED") {
    options.push({ label: "Delete", run: async () => { if (await confirmDialog(`Delete ${doc.noun.toLowerCase()}`, `Delete ${inv.InvoiceNumber || `this ${doc.noun.toLowerCase()}`}? It will be removed from your lists.`, "Delete", "negative")) act(`${doc.noun} deleted`, () => saveStatus(inv, "DELETED")); } });
  } else if (inv.Status === "AUTHORISED") {
    options.push({ label: "Void", run: async () => { if (await confirmDialog(`Void ${doc.noun.toLowerCase()}`, `Void ${inv.InvoiceNumber}? A voided ${doc.noun.toLowerCase()} can't be changed or paid.`, "Void", "negative")) act(`${doc.noun} voided`, () => saveStatus(inv, "VOIDED")); } });
  }
  const actions = [
    el("button", { type: "button", class: "btn", "aria-haspopup": "menu", onclick: (e) => { e.stopPropagation(); openMenu(e.currentTarget, options, { align: "right" }); } }, [`${doc.noun} options`, icon("chevron", 18)]),
    el("button", { type: "button", class: "btn", onclick: () => notSimulated("Print PDF") }, [icon("print", 18), "Print PDF"]),
  ];
  if (doc.type === "ACCREC" && inv.Status !== "DRAFT" && inv.Status !== "DELETED" && inv.Status !== "VOIDED") {
    actions.push(el("button", { type: "button", class: "btn", onclick: async (e) => {
      if (!inv.Contact?.EmailAddress) { toast(`${inv.Contact?.Name ?? "This contact"} has no email address. Add one to the contact first.`, { error: true }); return; }
      if (!(await confirmDialog("Send invoice", `Email ${inv.InvoiceNumber} to ${inv.Contact.EmailAddress}? In this Firedrill world the email is recorded, never delivered.`, "Send", "main"))) return;
      e.target.disabled = true;
      act("Invoice sent", () => call("invoices.email", { invoiceId: inv.InvoiceID }, newKey()));
    } }, [icon("mail", 18), "Email"]));
  }
  if (inv.Status === "DRAFT" || inv.Status === "SUBMITTED") {
    if (inv.Status === "DRAFT") actions.push(el("button", { type: "button", class: "btn", text: "Submit for approval", onclick: () => act("Submitted for approval", () => saveStatus(inv, "SUBMITTED")) }));
    actions.push(el("button", { type: "button", class: "btn create", text: "Approve", onclick: () => act(`${doc.noun} approved`, () => saveStatus(inv, "AUTHORISED")) }));
  }
  const head = pageHead({
    crumbs: [[doc.plural, `#/${doc.route}`]], title: `${doc.noun} ${inv.InvoiceNumber || ""}`.trim(),
    titleExtra: statusTag(inv), actions,
  });

  const meta = el("div", { class: "doc-meta" }, [
    [doc.party, inv.Contact?.Name ?? "", inv.Contact?.ContactID ? `#/contacts/${encodeURIComponent(inv.Contact.ContactID)}` : null],
    ["Date", dmy(inv.DateString)], ["Due date", dmy(inv.DueDateString), null, isOverdue(inv)],
    [doc.type === "ACCREC" ? "Invoice number" : "Reference", inv.InvoiceNumber || "—"],
    [doc.type === "ACCREC" ? "Reference" : "Bill reference", inv.Reference || "—"],
    ["Amounts are", TAX_LABEL[inv.LineAmountTypes] ?? inv.LineAmountTypes],
  ].map(([k, v, href, over]) => el("div", { class: "meta" }, [el("div", { class: "k", text: k }), el("div", { class: `v${over ? " overdue" : ""}` }, href ? el("a", { href, text: v }) : v)])));

  const lines = el("tbody", {}, (inv.LineItems ?? []).map((li) => el("tr", {}, [
    el("td", { text: li.ItemCode ?? "" }), el("td", { text: li.Description ?? "" }), el("td", { class: "num", text: String(li.Quantity ?? "") }),
    el("td", { class: "num", text: amount(li.UnitAmount) }), el("td", { text: accountName.get(li.AccountCode) ?? li.AccountCode ?? "" }), el("td", { text: rateName.get(li.TaxType) ?? li.TaxType ?? "" }),
    el("td", { class: "num", text: amount(li.TaxAmount) }), el("td", { class: "num", text: amount(li.LineAmount) }),
  ])));
  if (!lines.children.length) lines.append(el("tr", {}, el("td", { colspan: "8" }, el("div", { class: "empty", text: "No line items" }))));
  const table = el("table", { class: "xt" }, [el("thead", {}, el("tr", {}, ["Item", "Description", "Qty.", "Price", "Account", "Tax rate", "Tax amount", "Amount NZD"].map((h, i) => el("th", { class: i === 2 || i === 3 || i >= 6 ? "num" : "", text: h })))), lines]);
  const trow = (k, v, cls = "") => el("div", { class: `trow ${cls}` }, [el("span", { text: k }), el("span", { class: "num", text: v })]);
  const paid = (inv.Payments ?? []);
  const totals = el("div", { class: "totals" }, [
    trow("Subtotal", amount(inv.SubTotal)), trow(`Total GST`, amount(inv.TotalTax)), trow("Total", amount(inv.Total), "grand"),
    ...paid.map((pm) => trow(`Less Payment ${dmy(wireDate(pm.Date))}`.trim(), amount(pm.Amount))),
    trow("Amount due", amount(inv.AmountDue), "due"),
  ]);
  const docBox = el("div", { class: "doc" }, [meta, el("div", { class: "table-scroll" }, table), el("div", { class: "editor-foot" }, [el("div"), totals])]);

  const payments = el("div", { class: "history" }, [el("h2", { text: "Payments" })]);
  if (paid.length === 0) payments.append(el("p", { class: "muted", text: "No payments have been recorded." }));
  else payments.append(el("table", { class: "xt" }, [el("thead", {}, el("tr", {}, ["Date", "Reference", "Amount", ""].map((h, i) => el("th", { class: i === 2 ? "num" : "", text: h })))),
    el("tbody", {}, paid.map((pm) => el("tr", {}, [el("td", { text: dmy(wireDate(pm.Date)) }), el("td", { text: pm.Reference ?? "" }), el("td", { class: "num", text: amount(pm.Amount) }),
      el("td", { class: "num" }, el("button", { type: "button", class: "btn small borderless", text: "Remove", onclick: async () => {
        if (!(await confirmDialog("Remove payment", `Remove the payment of ${amount(pm.Amount)}? The ${doc.noun.toLowerCase()} will show the amount as owing again.`, "Remove", "negative"))) return;
        act("Payment removed", () => call("payments.delete", { paymentId: pm.PaymentID, body: { Status: "DELETED" } }, newKey()));
      } }))])))]));
  const sections = [docBox];
  if (inv.Status === "AUTHORISED" && Number(inv.AmountDue) > 0) sections.push(paymentPanel(inv, doc, refresh));
  sections.push(payments);
  sections.push(el("div", { class: "history" }, [el("h2", { text: "History and notes" }), el("p", { class: "muted", text: inv.SentToContact ? "This invoice has been marked as sent to the contact." : "Not yet sent to the contact." }),
    el("button", { type: "button", class: "btn small", text: "Show history", onclick: () => notSimulated("History and notes") })]));
  host.replaceChildren(head, el("div", { class: "page-inner" }, sections));
  void app;
}

register("document", (host, route) => renderDocument(host, route, route.page === "bills" ? DOC.ACCPAY : DOC.ACCREC));
