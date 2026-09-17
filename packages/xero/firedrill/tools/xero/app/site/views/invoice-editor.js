// New / edit invoice or bill: contact typeahead, dates, numbers, Amounts are, line grid; Save (draft), Submit, Approve.
import { DOC, app, go, listAll, register } from "../store.js";
import { addDays, call, el, errorBanner, icon, newKey, toast } from "../ui.js";
import { openMenu } from "../overlay.js";
import { pageHead } from "./common.js";
import { lineGrid } from "./editor-lines.js";
import { contactPicker } from "./contact-picker.js";

async function renderEditor(host, route, doc) {
  const editing = route.id !== "new";
  host.replaceChildren(el("div", { class: "loading" }, [el("span", { class: "spinner", "aria-hidden": "true" }), el("span", { text: "Loading…" })]));
  let accounts, taxRates, inv = null;
  try {
    [accounts, taxRates, inv] = await Promise.all([
      listAll("accounts.list", "Accounts", { where: `Status=="ACTIVE"&&Type!="BANK"` }),
      call("tax-rates.list", {}).then((o) => o.TaxRates ?? []),
      editing ? call("invoices.get", { invoiceId: route.id }).then((o) => o.Invoices?.[0] ?? null) : Promise.resolve(null),
    ]);
  } catch (error) {
    host.replaceChildren(el("div", { class: "page-inner" }, errorBanner(error, `We couldn't open the ${doc.noun.toLowerCase()} editor`)));
    return;
  }
  taxRates = taxRates.filter((t) => t.Status !== "DELETED");
  const title = editing ? `Edit ${doc.noun.toLowerCase()} ${inv?.InvoiceNumber ?? ""}`.trim() : doc.newLabel;
  let key = newKey();
  const changed = () => { app.dirty = true; key = newKey(); };

  const picker = contactPicker({ id: "ed-contact", label: doc.party, initial: inv?.Contact ?? null, onChange: changed });
  const date = el("input", { class: "input", id: "ed-date", type: "date", value: String(inv?.DateString ?? app.today).slice(0, 10) });
  const due = el("input", { class: "input", id: "ed-due", type: "date", value: inv ? String(inv.DueDateString ?? "").slice(0, 10) : addDays(app.today, 30) });
  const number = el("input", { class: "input", id: "ed-number", maxlength: "255", value: inv?.InvoiceNumber ?? "", placeholder: doc.type === "ACCREC" ? "Automatic (INV-…)" : "" });
  const ref = el("input", { class: "input", id: "ed-ref", maxlength: "255", value: inv?.Reference ?? "" });
  const field = (id, label, input) => el("div", { class: "field" }, [el("label", { for: id, text: label }), input]);
  const headFields = el("div", { class: "editor-head" }, [picker.node, field("ed-date", doc.type === "ACCREC" ? "Issue date" : "Date", date), field("ed-due", "Due date", due),
    field("ed-number", doc.type === "ACCREC" ? "Invoice number" : "Reference", number), doc.type === "ACCREC" ? field("ed-ref", "Reference", ref) : el("div")]);
  const amountsAre = el("select", { class: "select", id: "ed-amounts" }, [["Exclusive", "Tax exclusive"], ["Inclusive", "Tax inclusive"], ["NoTax", "No tax"]].map(([v, t]) => el("option", { value: v, text: t })));
  amountsAre.value = inv?.LineAmountTypes ?? (doc.type === "ACCREC" ? "Exclusive" : "Inclusive");

  const defaultAccount = doc.type === "ACCREC" ? "200" : "429";
  const grid = lineGrid({ lines: inv?.LineItems ?? [], accounts, taxRates, defaultAccount: accounts.some((a) => a.Code === defaultAccount) ? defaultAccount : "", onChange: changed });
  grid.setAmountsAre(amountsAre.value);
  amountsAre.addEventListener("change", () => { grid.setAmountsAre(amountsAre.value); changed(); });
  for (const input of [date, due, number, ref]) input.addEventListener("input", changed);
  const errors = el("div", { class: "errors-box" });

  let busy = false;
  const buttons = [];
  async function save(status, { email = false } = {}) {
    if (busy) return;
    errors.replaceChildren();
    const contact = picker.value();
    const { items, error } = grid.collect();
    const problems = [];
    if (!contact) problems.push(`Choose who the ${doc.noun.toLowerCase()} is ${doc.type === "ACCREC" ? "to" : "from"}.`);
    if (error) problems.push(error);
    if (problems.length) { errors.replaceChildren(errorBanner(new Error(problems.join(" ")), "Please fix the following")); return; }
    const body = { Type: doc.type, Contact: contact, Date: date.value || undefined, DueDate: due.value || undefined, LineAmountTypes: amountsAre.value, LineItems: items, Status: status };
    if (editing) body.InvoiceID = inv.InvoiceID;
    if (number.value.trim() || editing) body.InvoiceNumber = number.value.trim();
    if (doc.type === "ACCREC") body.Reference = ref.value.trim();
    busy = true;
    for (const b of buttons) b.disabled = true;
    try {
      const out = await call("invoices.save", { method: "POST", ...(editing ? { pathInvoiceId: inv.InvoiceID } : {}), body: { Invoices: [body] }, summarizeErrors: false }, key);
      const saved = out.Invoices?.[0];
      if (saved?.StatusAttributeString === "ERROR") {
        errors.replaceChildren(errorBanner(new Error((saved.ValidationErrors ?? []).map((v) => v.Message).join(" ")), `This ${doc.noun.toLowerCase()} could not be saved`));
        return;
      }
      if (email) {
        try { await call("invoices.email", { invoiceId: saved.InvoiceID }, newKey()); } catch (e) { toast(`Approved, but the email was not sent: ${e.message}`, { error: true }); }
      }
      app.dirty = false;
      toast(`${doc.noun} ${saved.InvoiceNumber || ""} ${status === "DRAFT" ? "saved as draft" : status === "SUBMITTED" ? "submitted for approval" : email ? "approved and sent" : "approved"}`.replace(/\s+/g, " "));
      go(`#/${doc.route}/${encodeURIComponent(saved.InvoiceID)}`);
    } catch (e) {
      errors.replaceChildren(errorBanner(e, `This ${doc.noun.toLowerCase()} could not be saved`));
    } finally {
      busy = false;
      for (const b of buttons) b.disabled = false;
    }
  }
  const keepStatus = inv && inv.Status === "AUTHORISED";
  const saveBtn = el("button", { type: "button", class: "btn", text: "Save", onclick: () => save(keepStatus ? "AUTHORISED" : inv?.Status === "SUBMITTED" ? "SUBMITTED" : "DRAFT") });
  const saveMore = el("button", { type: "button", class: "btn standard", "aria-label": "More save options", "aria-haspopup": "menu", onclick: (e) => { e.stopPropagation(); openMenu(e.currentTarget, [{ label: "Save as draft", run: () => save("DRAFT"), disabled: keepStatus }, { label: "Save & submit for approval", run: () => save("SUBMITTED"), disabled: keepStatus }], { align: "right" }); } }, icon("chevron", 18));
  const approve = el("button", { type: "button", class: "btn create", text: "Approve", onclick: () => save("AUTHORISED") });
  const approveMore = el("button", { type: "button", class: "btn create", "aria-label": "More approve options", "aria-haspopup": "menu", onclick: (e) => { e.stopPropagation(); openMenu(e.currentTarget, [{ label: "Approve", run: () => save("AUTHORISED") }, ...(doc.type === "ACCREC" ? [{ label: "Approve & email", run: () => save("AUTHORISED", { email: true }) }] : []), { label: "Approve & print" }], { align: "right" }); } }, icon("chevron", 18));
  buttons.push(saveBtn, saveMore, approve, approveMore);
  const cancel = el("a", { class: "btn borderless", href: editing ? `#/${doc.route}/${encodeURIComponent(inv.InvoiceID)}` : `#/${doc.route}`, text: "Cancel", onclick: () => { app.dirty = false; } });

  const head = pageHead({ crumbs: [[doc.plural, `#/${doc.route}`]], title });
  const editor = el("div", { class: "editor" }, [headFields, el("div", { class: "editor-opts" }, [el("label", { for: "ed-amounts", text: "Amounts are" }), amountsAre]), errors,
    el("div", { class: "grid-scroll" }, grid.table),
    el("div", { class: "editor-foot" }, [el("div", {}, el("button", { type: "button", class: "btn", onclick: grid.addRow }, [icon("plus", 18), "Add a new line"])), grid.totals])]);
  const bar = el("div", { class: "savebar" }, [cancel, el("div", { class: "actions" }, [el("div", { class: "btn-split" }, [saveBtn, saveMore]), el("div", { class: "btn-split" }, [approve, approveMore])])]);
  host.replaceChildren(head, el("div", { class: "page-inner" }, [editor]), bar);
}

register("editor", (host, route) => renderEditor(host, route, route.page === "bills" ? DOC.ACCPAY : DOC.ACCREC));
