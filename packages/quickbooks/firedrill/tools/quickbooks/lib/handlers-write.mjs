// Write operations: REST dispatchers (`*.post`) and the MCP-shaped create / update / delete / send variants.
import { open } from "./access.mjs";
import { clip } from "./common.mjs";
import { deactivateCustomer, renderCustomer, saveCustomer } from "./customers.mjs";
import { has, reservedKeyIn } from "./fields.mjs";
import { deleteInvoice, entityRef, invoiceBodyFromMcp, invoicesPost, renderInvoice, saveInvoice, sendInvoice, updateInvoiceFromMcp } from "./invoices.mjs";
import { renderItem, saveItem } from "./items.mjs";
import { paymentBodyFromMcp, paymentsPost, renderPayment, savePayment } from "./payments.mjs";

function guardBody(s, value) {
  const problem = reservedKeyIn(value);
  if (problem !== null) s.fail("BUSINESS_VALIDATION", `Request has invalid or unsupported property : ${problem}`, "body");
}

function onlyUpdate(s, input, entity) {
  if (input.operation !== undefined && input.operation !== "update") {
    s.fail("BUSINESS_VALIDATION", `Operation ${clip(String(input.operation), 32)} is not supported for ${entity}.`, "operation");
  }
  if (input.operation === "update" && !(has(input.body, "Id") && input.body.Id !== null)) {
    s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: Id", "Id");
  }
}

const deleted = (row) => ({ Id: row.Id, status: "Deleted", domain: "QBO" });

export const writeOperations = {
  "customers.post": (input, context) => {
    const s = open(context, input, "customers.write");
    guardBody(s, input.body);
    onlyUpdate(s, input, "Customer");
    const { row, action } = saveCustomer(s, input.body, input.operation === "update" ? "update" : undefined);
    return { Customer: renderCustomer(s, row), action, time: s.clock.time };
  },
  "customers.create": (input, context) => {
    const s = open(context, input, "customers.write");
    guardBody(s, input.customer);
    return renderCustomer(s, saveCustomer(s, input.customer, "create").row);
  },
  "customers.update": (input, context) => {
    const s = open(context, input, "customers.write");
    guardBody(s, input.customer);
    return renderCustomer(s, saveCustomer(s, input.customer, "update").row);
  },
  "customers.delete": (input, context) => {
    const s = open(context, input, "customers.write");
    return renderCustomer(s, deactivateCustomer(s, input.idOrEntity).row);
  },
  "items.post": (input, context) => {
    const s = open(context, input, "items.write");
    guardBody(s, input.body);
    onlyUpdate(s, input, "Item");
    const { row, action } = saveItem(s, input.body);
    return { Item: renderItem(s, row), action, time: s.clock.time };
  },
  "invoices.post": (input, context) => {
    const s = open(context, input, "invoices.write");
    guardBody(s, input.body);
    const { row, action } = invoicesPost(s, input);
    return { Invoice: action === "delete" ? deleted(row) : renderInvoice(s, row), action, time: s.clock.time };
  },
  "invoices.create": (input, context) => {
    const s = open(context, input, "invoices.write");
    if (input.linked_txn !== undefined && input.linked_txn.length > 0) {
      s.fail("BUSINESS_VALIDATION", "linked_txn is not supported: estimates and other linkable transactions are not modelled by this company.", "linked_txn");
    }
    const body = invoiceBodyFromMcp(input);
    guardBody(s, body);
    return renderInvoice(s, saveInvoice(s, body, null, false, false).row);
  },
  "invoices.update": (input, context) => {
    const s = open(context, input, "invoices.write");
    guardBody(s, input.patch);
    return renderInvoice(s, updateInvoiceFromMcp(s, input.invoice_id, input.patch).row);
  },
  "invoices.delete": (input, context) => {
    const s = open(context, input, "invoices.write");
    return deleted(deleteInvoice(s, entityRef(s, "invoices", input.idOrEntity)).row);
  },
  "invoices.send": (input, context) => {
    const s = open(context, input, "invoices.write");
    return { Invoice: renderInvoice(s, sendInvoice(s, input.invoice_id, input.sendTo)), time: s.clock.time };
  },
  "payments.post": (input, context) => {
    const s = open(context, input, "payments.write");
    guardBody(s, input.body);
    const { row, action } = paymentsPost(s, input);
    return { Payment: action === "delete" ? deleted(row) : renderPayment(s, row), action, time: s.clock.time };
  },
  "payments.create": (input, context) => {
    const s = open(context, input, "payments.write");
    const body = paymentBodyFromMcp(input);
    guardBody(s, body);
    return renderPayment(s, savePayment(s, body, null, false).row);
  },
};
