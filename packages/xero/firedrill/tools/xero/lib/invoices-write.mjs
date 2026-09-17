// Invoice writes: PUT/POST /Invoices, POST /Invoices/{InvoiceID}, POST /Invoices/{InvoiceID}/Email, MCP create-invoice and update-invoice.
import { elementsOf, failElements, lookupsOf, open } from "./access.mjs";
import { invoiceElement, mergeInvoice, storeInvoice } from "./invoice-rules.mjs";
import { renderInvoice } from "./views-docs.mjs";
import { hasOwn, normalGuid } from "./util.mjs";

const mcpLines = (lineItems) =>
  lineItems.map((line) => {
    const raw = { Description: line.description, Quantity: line.quantity, UnitAmount: line.unitAmount, AccountCode: line.accountCode, TaxType: line.taxType };
    if (line.itemCode !== undefined) raw.ItemCode = line.itemCode;
    if (line.tracking !== undefined) raw.Tracking = line.tracking;
    return raw;
  });

export const invoiceWriteOperations = {
  "invoices.save": (input, context) => {
    const s = open(context, input, "transactions", "write");
    if (input.idempotencyKeyProblem === true) s.validation("Idempotency-Key must be at most 128 characters");
    const unitdp = input.unitdp === undefined ? 2 : input.unitdp;
    if (unitdp !== 2 && unitdp !== 4) s.validation("unitdp must be 2 or 4");
    const elements = elementsOf(s, input, "Invoices");
    let pathId = null;
    if (input.pathInvoiceId !== undefined) {
      pathId = normalGuid(input.pathInvoiceId);
      if (pathId === null || s.get("invoices", pathId) === null) s.notFound();
    }
    const summarize = input.summarizeErrors !== false;
    const results = [];
    const failed = [];
    for (const element of elements) {
      const hasBodyId = hasOwn(element, "InvoiceID") && element.InvoiceID !== null;
      const bodyId = hasBodyId ? normalGuid(element.InvoiceID) : null;
      let errors = [];
      let existing = null;
      if (hasBodyId && bodyId === null) errors.push("InvoiceID must be a GUID");
      if (pathId !== null && bodyId !== null && bodyId !== pathId) errors.push("InvoiceID in the body does not match the InvoiceID in the URL");
      const targetId = pathId ?? bodyId;
      if (targetId !== null && errors.length === 0) {
        existing = s.get("invoices", targetId);
        if (existing === null) s.notFound();
        if (input.method === "PUT" && pathId === null) errors.push("An invoice with this InvoiceID already exists; use POST to update it");
      }
      if (errors.length === 0) {
        const merged = mergeInvoice(s, element, existing);
        errors = merged.errors;
        if (errors.length === 0) {
          results.push({ ok: true, invoice: storeInvoice(s, merged, existing === null) });
          continue;
        }
      }
      const projection = { ...invoiceElement(element, existing), ValidationErrors: errors.map((Message) => ({ Message })) };
      failed.push(projection);
      results.push({ ok: false, projection });
    }
    if (failed.length > 0 && summarize) failElements(s, failed);
    const lookups = lookupsOf(s);
    const Invoices = results.map((result) => {
      if (!result.ok) return { ...result.projection, StatusAttributeString: "ERROR" };
      const rendered = renderInvoice(result.invoice, lookups, { unitdp });
      return summarize ? rendered : { ...rendered, StatusAttributeString: "OK" };
    });
    return s.envelope({ Invoices });
  },
  "invoices.create": (input, context) => {
    const s = open(context, input, "transactions", "write");
    const contactId = normalGuid(input.contactId);
    if (contactId === null || s.get("contacts", contactId) === null) s.notFound("Contact not found");
    const element = { Type: input.type, Contact: { ContactID: contactId }, LineItems: mcpLines(input.lineItems), Status: "DRAFT" };
    if (input.reference !== undefined) element.Reference = input.reference;
    if (input.date !== undefined) element.Date = input.date;
    const merged = mergeInvoice(s, element, null);
    if (merged.errors.length > 0) s.validation(merged.errors, invoiceElement(element, null));
    return renderInvoice(storeInvoice(s, merged, true), lookupsOf(s));
  },
  "invoices.update": (input, context) => {
    const s = open(context, input, "transactions", "write");
    const id = normalGuid(input.invoiceId);
    const existing = id === null ? null : s.get("invoices", id);
    if (existing === null) s.notFound();
    if (existing.Status !== "DRAFT") s.validation("Invoice not of valid status for modification", invoiceElement({}, existing));
    const element = {};
    if (input.lineItems !== undefined) element.LineItems = mcpLines(input.lineItems);
    if (input.reference !== undefined) element.Reference = input.reference;
    if (input.dueDate !== undefined) element.DueDate = input.dueDate;
    if (input.date !== undefined) element.Date = input.date;
    if (input.contactId !== undefined) {
      const contactId = normalGuid(input.contactId);
      if (contactId === null || s.get("contacts", contactId) === null) s.notFound("Contact not found");
      element.Contact = { ContactID: contactId };
    }
    const merged = mergeInvoice(s, element, existing);
    if (merged.errors.length > 0) s.validation(merged.errors, invoiceElement(element, existing));
    return renderInvoice(storeInvoice(s, merged, false), lookupsOf(s));
  },
  "invoices.email": (input, context) => {
    const s = open(context, input, "transactions", "write");
    if (input.idempotencyKeyProblem === true) s.validation("Idempotency-Key must be at most 128 characters");
    const id = normalGuid(input.invoiceId);
    const invoice = id === null ? null : s.get("invoices", id);
    if (invoice === null) s.notFound();
    const element = invoiceElement({}, invoice);
    if (invoice.Type !== "ACCREC") s.validation("Only sales invoices (ACCREC) can be emailed", element);
    if (invoice.Status !== "AUTHORISED" && invoice.Status !== "PAID" && invoice.Status !== "SUBMITTED") s.validation(`Invoices with status ${invoice.Status} cannot be emailed`, element);
    const contact = s.get("contacts", invoice.ContactID);
    if (contact === null || contact.EmailAddress === null) s.validation("The contact does not have an email address", element);
    const prefix = `${invoice.InvoiceID}/`;
    let sequence = 1;
    for (const record of context.state.scan("invoice-emails", { afterRowId: prefix, limit: 10000 })) {
      if (!record.rowId.startsWith(prefix)) break;
      sequence += 1;
    }
    if (sequence > 9999) s.validation("The daily email limit for this invoice has been reached", element);
    s.put("invoice-emails", `${prefix}${String(sequence).padStart(4, "0")}`, { invoiceId: invoice.InvoiceID, to: contact.EmailAddress, sentAtUtc: s.clock.iso, actorId: context.actor.id });
    const updated = { ...invoice, SentToContact: true, UpdatedDateUTC: s.clock.iso };
    s.put("invoices", updated.InvoiceID, updated);
    s.emit("invoice.changed", "Invoices", updated.InvoiceID, "UPDATE", { status: updated.Status });
    return { emailed: true, to: contact.EmailAddress };
  },
};
