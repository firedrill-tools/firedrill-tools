// Invoice row actions: Receive payment / Send, and the row menu (Edit, Print or download, Send, Void, Delete).
import { app, isVoided } from "../store.js";
import { ToolError, amount, call, confirmDialog, describe, dialog, el, icon, mdY, money, newKey, openMenu, toast } from "../ui.js";
import { field, input } from "./common.js";
import { openInvoiceEditor } from "./invoice-editor.js";
import { openReceivePayment } from "./receive-payment.js";

async function retryable(run, label) {
  try { return await run(); } catch (error) {
    if (error instanceof ToolError && error.is("STALE_OBJECT")) toast("This invoice was changed elsewhere. Refresh and try again.", { error: true });
    else toast(`${label}: ${describe(error)}`, { error: true, action: error instanceof ToolError && error.is("THROTTLE_EXCEEDED") ? { label: "Retry", run } : undefined });
    return undefined;
  }
}

export function sendDialog(inv, onDone) {
  const to = field("To", input({ type: "email", value: inv.BillEmail?.Address ?? "" }));
  const subject = `Invoice ${inv.DocNumber ?? inv.Id} from ${app.company?.CompanyName ?? "your company"}`;
  const key = newKey();
  const { box } = dialog({
    title: `Send invoice ${inv.DocNumber ?? ""}`.trim(), wide: false,
    body: [to.wrap,
      el("div", { class: "field" }, [el("span", { class: "muted", text: "Subject" }), el("div", { text: subject })]),
      el("div", { class: "field" }, [el("span", { class: "muted", text: "Message" }), el("div", { text: `Dear ${inv.CustomerRef?.name ?? "customer"}, here's your invoice! We appreciate your prompt payment. Balance due ${money(inv.Balance)}, due ${mdY(inv.DueDate)}.` })]),
      el("p", { class: "muted", text: "Firedrill records a synthetic send. No e-mail is delivered." })],
    actions: [
      { label: "Cancel", run: (close) => close() },
      { label: "Send invoice", kind: "primary", run: async (close) => {
        const btn = box.querySelector(".dialog-foot .primary");
        btn.disabled = true;
        to.setError("");
        const address = to.input.value.trim();
        try {
          await call("invoices.send", { invoice_id: inv.Id, ...(address && address !== inv.BillEmail?.Address ? { sendTo: address } : address ? { sendTo: address } : {}) }, key);
          close();
          toast(`Invoice ${inv.DocNumber ?? ""} sent to ${address || "the customer"}`);
          onDone?.();
        } catch (error) {
          btn.disabled = false;
          to.setError(describe(error));
        }
      } },
    ],
  });
}

export async function voidInvoice(inv, refresh) {
  const linked = (inv.LinkedTxn ?? []).length;
  const msg = linked ? `Invoice ${inv.DocNumber} has ${linked} payment${linked > 1 ? "s" : ""} applied. Voiding sets its amount to zero and leaves those payments unapplied. Are you sure?` : `Are you sure you want to void invoice ${inv.DocNumber}? Its amount will be set to zero.`;
  if (!(await confirmDialog("Void invoice?", msg, "Yes, void", "primary"))) return;
  const done = await retryable(() => call("invoices.post", { operation: "void", body: { Id: inv.Id, SyncToken: inv.SyncToken } }, newKey()), "Couldn't void the invoice");
  if (done) { toast(`Invoice ${inv.DocNumber} voided`); refresh?.(); }
}

export async function deleteInvoice(inv, refresh) {
  const linked = (inv.LinkedTxn ?? []).length;
  const msg = linked ? `This invoice has payments applied. Deleting it leaves those payments unapplied. Delete invoice ${inv.DocNumber}?` : `Are you sure you want to delete invoice ${inv.DocNumber}? This can't be undone.`;
  if (!(await confirmDialog("Delete invoice?", msg, "Yes, delete", "danger"))) return;
  const done = await retryable(() => call("invoices.post", { operation: "delete", body: { Id: inv.Id, SyncToken: inv.SyncToken } }, newKey()), "Couldn't delete the invoice");
  if (done) { toast(`Invoice ${inv.DocNumber} deleted`); refresh?.(); }
}

export async function pdfPreview(inv) {
  const link = el("a", { class: "btn primary", text: "Preparing PDF…", "aria-disabled": "true" });
  const lines = (inv.Line ?? []).filter((l) => l.DetailType === "SalesItemLineDetail");
  const sheet = el("div", { class: "pdf-frame" }, [
    el("div", { class: "sheet-top" }, [
      el("div", { class: "sheet-company" }, [el("div", { class: "co-name", text: app.company?.CompanyName ?? "" }), el("div", { text: app.company?.CompanyAddr?.Line1 ?? "" }), el("div", { text: app.company?.Email?.Address ?? "" })]),
      el("div", { class: "sheet-balance" }, [el("div", { class: "lbl", text: "Invoice" }), el("div", { text: `No. ${inv.DocNumber ?? inv.Id}` }), el("div", { text: `Due ${mdY(inv.DueDate)}` })]),
    ]),
    el("div", { class: "hr" }),
    el("div", { text: `Bill to: ${inv.CustomerRef?.name ?? ""}` }),
    el("table", { class: "lines" }, [el("thead", {}, el("tr", {}, ["Product or service", "Qty", "Rate", "Amount"].map((h, i) => el("th", { class: i ? "amt" : "", text: h })))),
      el("tbody", {}, lines.map((l) => el("tr", {}, [el("td", { text: l.SalesItemLineDetail?.ItemRef?.name ?? "" }), el("td", { class: "amt", text: String(l.SalesItemLineDetail?.Qty ?? "") }), el("td", { class: "amt", text: amount(l.SalesItemLineDetail?.UnitPrice) }), el("td", { class: "amt", text: amount(l.Amount) })])))]),
    el("div", { class: "totals" }, [el("div", { class: "t big" }, [el("span", { text: "Balance due" }), el("span", { text: money(inv.Balance) })])]),
  ]);
  const { close } = dialog({ title: `Print or download invoice ${inv.DocNumber ?? ""}`, wide: true, body: [sheet, el("div", { class: "line-actions" }, link)] });
  try {
    const out = await call("invoices.pdf", { invoice_id: inv.Id });
    const bytes = Uint8Array.from(atob(out.base64), (ch) => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    link.textContent = `Download PDF (${Math.ceil(out.size_bytes / 1024)} KB)`;
    link.setAttribute("href", url);
    link.setAttribute("download", `Invoice_${inv.DocNumber ?? inv.Id}.pdf`);
    link.removeAttribute("aria-disabled");
  } catch (error) {
    link.replaceWith(el("div", { class: "banner error", role: "alert", text: describe(error) }));
  }
  void close;
}

export function rowActions(inv, refresh) {
  const open = Number(inv.Balance) > 0 && !isVoided(inv);
  const primary = open
    ? el("button", { type: "button", class: "link-btn", text: "Receive payment", onclick: (e) => { e.stopPropagation(); openReceivePayment({ customerId: inv.CustomerRef?.value, invoiceId: inv.Id, onSaved: refresh }); } })
    : el("button", { type: "button", class: "link-btn", text: "Print", onclick: (e) => { e.stopPropagation(); pdfPreview(inv); } });
  const caret = el("button", { type: "button", class: "caret", "aria-label": `More actions for invoice ${inv.DocNumber ?? inv.Id}`, "aria-haspopup": "menu", "aria-expanded": "false" }, icon("chevronDown"));
  caret.addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu(caret, [
      { label: "Edit", run: () => openInvoiceEditor(inv.Id, refresh) },
      { label: "Send", disabled: isVoided(inv), run: () => sendDialog(inv, refresh) },
      { label: "Print or download", run: () => pdfPreview(inv) },
      { label: "Void", disabled: isVoided(inv), run: () => voidInvoice(inv, refresh) },
      { label: "Delete", run: () => deleteInvoice(inv, refresh) },
    ]);
  });
  return el("div", { class: "row-actions" }, [primary, caret]);
}
