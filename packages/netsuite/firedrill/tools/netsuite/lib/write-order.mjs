// Sales-order writes: create, merge-patch update and the !transform that bills an order into an invoice.
import { quote } from "./errors.mjs";
import { addDays, round2, round4 } from "./primitives.mjs";
import { open } from "./session.mjs";
import { loadRecord } from "./handlers-read.mjs";
import {
  checkPropertyNames, checkVersion, dateField, idempotencyKey, numberField,
  referenceField, replaceList, requestBody, stringField, sublistItems,
} from "./body.mjs";
import {
  billedTotal, buildLine, checkDuplicateTranId, lineCounter, nextTranId, orderStatus,
  resolveCustomer, setLineCounter, totals,
} from "./tran.mjs";

const KNOWN = new Set(["entity", "tranDate", "tranId", "memo", "otherRefNum", "terms", "item", "subsidiary"]);
const REPLACEABLE = new Set(["item", "memo", "otherRefNum", "terms"]);
const TERMS = new Set(["1", "2", "3"]);
const MARKER = "!transform";

export function checkMarker(session, marker) {
  if (marker !== MARKER) {
    session.fail("INVALID_REQUEST", `Invalid transform marker ${quote(String(marker))}. The transform path segment must be !transform.`);
  }
}

function checkTerms(session, termsId) {
  if (termsId === undefined || termsId === null) return termsId ?? null;
  if (!TERMS.has(termsId)) session.fail("INVALID_KEY_OR_REF", `Invalid terms reference key ${quote(termsId)}.`, { errorPath: "terms" });
  return termsId;
}

export const orderWrites = {
  "sales-order.create": (input, context) => {
    const session = open(context);
    session.permit("TRAN_SALESORD", "create");
    idempotencyKey(session, input);
    const body = requestBody(session, input);
    checkPropertyNames(session, input, body, KNOWN);
    session.rows("sales-orders");
    const entityId = referenceField(session, body, "entity");
    if (entityId === undefined || entityId === null) {
      session.fail("INVALID_KEY_OR_REF", "A sales order must carry an entity reference.", { errorPath: "entity" });
    }
    const customer = resolveCustomer(session, entityId);
    const subsidiaryId = customer.subsidiaryId;
    const bodySubsidiary = referenceField(session, body, "subsidiary");
    if (bodySubsidiary !== undefined && bodySubsidiary !== null && bodySubsidiary !== subsidiaryId) {
      session.fail("USER_ERROR", "The subsidiary of this transaction must match the subsidiary of the customer.", {
        errorPath: "subsidiary",
      });
    }
    const entries = sublistItems(session, body, "item", 200);
    if (entries === undefined || entries.length === 0) {
      session.fail("USER_ERROR", "Please enter at least one line item for this transaction.", { errorPath: "item.items" });
    }
    const lines = entries.map((entry, index) =>
      buildLine(session, entry, subsidiaryId, index + 1, `item.items[${index}].`));
    const tranDate = dateField(session, body, "tranDate") ?? session.today;
    const suppliedTranId = stringField(session, body, "tranId", 45);
    const id = session.nextId("nextTransactionId", "sales-orders");
    const tranId = suppliedTranId ?? nextTranId(session, "sales-orders", "SO");
    checkDuplicateTranId(session, ["sales-orders"], tranId, null);
    const amounts = totals(lines);
    const row = {
      id,
      tranId,
      tranDate,
      entityId: customer.id,
      subsidiaryId,
      status: "pendingFulfillment",
      memo: stringField(session, body, "memo", 999) ?? null,
      otherRefNum: stringField(session, body, "otherRefNum", 45) ?? null,
      currencyId: customer.currencyId,
      termsId: checkTerms(session, referenceField(session, body, "terms")) ?? customer.termsId,
      lines,
      ...amounts,
      billedTotal: 0,
      createdFromId: null,
      createdDate: session.now,
      lastModifiedDate: session.now,
      createdById: session.employee.id,
      lastModifiedById: session.employee.id,
      version: 1,
    };
    session.put("sales-orders", id, row);
    setLineCounter(session, id, lines.length + 1);
    session.recordChanged("salesOrder", id, "CREATE", subsidiaryId);
    session.statusChanged("salesOrder", row, null, null);
    return { id, location: `/services/rest/record/v1/salesOrder/${id}` };
  },

  "sales-order.update": (input, context) => {
    const session = open(context);
    session.permit("TRAN_SALESORD", "edit");
    idempotencyKey(session, input);
    const body = requestBody(session, input);
    checkPropertyNames(session, input, body, KNOWN);
    const replace = replaceList(session, input, REPLACEABLE);
    const current = loadRecord(session, "sales-order", input.recordId);
    checkVersion(session, input, current);
    session.rows("sales-orders");
    if (current.status === "billed" || current.status === "closed") {
      session.fail("USER_ERROR", `This sales order is ${current.status === "billed" ? "fully billed" : "closed"} and can no longer be edited.`);
    }
    const updated = { ...current, lines: current.lines.map((line) => ({ ...line })) };
    if (replace.has("memo")) updated.memo = null;
    if (replace.has("otherRefNum")) updated.otherRefNum = null;
    if (replace.has("terms")) updated.termsId = null;
    if (replace.has("item")) updated.lines = [];

    const tranDate = dateField(session, body, "tranDate");
    if (tranDate !== undefined && tranDate !== null) updated.tranDate = tranDate;
    const memo = stringField(session, body, "memo", 999);
    if (memo !== undefined) updated.memo = memo;
    const otherRefNum = stringField(session, body, "otherRefNum", 45);
    if (otherRefNum !== undefined) updated.otherRefNum = otherRefNum;
    const termsId = referenceField(session, body, "terms");
    if (termsId !== undefined) updated.termsId = checkTerms(session, termsId);
    const tranId = stringField(session, body, "tranId", 45);
    if (tranId !== undefined && tranId !== null) {
      checkDuplicateTranId(session, ["sales-orders"], tranId, current.id);
      updated.tranId = tranId;
    }

    const entries = sublistItems(session, body, "item", 200);
    if (entries !== undefined) {
      let counter = lineCounter(session, current.id);
      for (const [index, entry] of entries.entries()) {
        const prefix = `item.items[${index}].`;
        const lineNumber = numberField(session, entry, "line", { min: 1, max: 100000, prefix });
        if (lineNumber === undefined || lineNumber === null) {
          const built = buildLine(session, entry, updated.subsidiaryId, counter, prefix);
          updated.lines.push(built);
          counter += 1;
          continue;
        }
        const position = updated.lines.findIndex((line) => line.line === lineNumber);
        if (position < 0) {
          session.fail("INVALID_KEY_OR_REF", `Line ${lineNumber} does not exist on this sales order.`, { errorPath: `${prefix}line` });
        }
        updated.lines[position] = buildLine(session, entry, updated.subsidiaryId, lineNumber, prefix, updated.lines[position]);
      }
      setLineCounter(session, current.id, counter);
    }
    if (updated.lines.length === 0) {
      session.fail("USER_ERROR", "Please enter at least one line item for this transaction.", { errorPath: "item.items" });
    }
    Object.assign(updated, totals(updated.lines));
    updated.billedTotal = billedTotal(updated.lines);
    updated.status = orderStatus(updated);
    updated.lastModifiedDate = session.now;
    updated.lastModifiedById = session.employee.id;
    updated.version = current.version + 1;
    session.put("sales-orders", current.id, updated);
    session.recordChanged("salesOrder", current.id, "UPDATE", updated.subsidiaryId);
    if (updated.status !== current.status) session.statusChanged("salesOrder", updated, current.status, null);
    return { id: current.id, location: `/services/rest/record/v1/salesOrder/${current.id}` };
  },

  "sales-order.transform": (input, context) => {
    const session = open(context);
    session.permit("TRAN_SALESORD", "view");
    session.permit("TRAN_CUSTINVC", "create");
    checkMarker(session, input.transformMarker);
    idempotencyKey(session, input);
    const body = requestBody(session, input);
    const order = loadRecord(session, "sales-order", input.recordId);
    checkVersion(session, input, order);
    session.rows("invoices");
    if (order.status === "closed") {
      session.fail("USER_ERROR", "This sales order is closed and cannot be billed.");
    }
    const remaining = new Map();
    for (const line of order.lines) {
      const openQuantity = round4(line.quantity - line.quantityBilled);
      if (openQuantity > 0) remaining.set(line.line, openQuantity);
    }
    if (remaining.size === 0) {
      session.fail("USER_ERROR", "There are no items to be billed on this sales order.");
    }
    const requested = sublistItems(session, body, "item", 200);
    const billing = new Map();
    if (requested === undefined || requested.length === 0) {
      for (const [line, quantity] of remaining) billing.set(line, quantity);
    } else {
      for (const [index, entry] of requested.entries()) {
        const prefix = `item.items[${index}].`;
        const orderLine = numberField(session, entry, "orderLine", { min: 1, max: 100000, prefix });
        if (orderLine === undefined || orderLine === null || !remaining.has(orderLine)) {
          session.fail("USER_ERROR", `Order line ${quote(String(orderLine))} cannot be billed on this sales order.`, {
            errorPath: `${prefix}orderLine`,
          });
        }
        const quantity = numberField(session, entry, "quantity", { min: 0, max: 1000000, prefix }) ?? remaining.get(orderLine);
        if (quantity > remaining.get(orderLine)) {
          session.fail("USER_ERROR", `Line ${orderLine} has only ${remaining.get(orderLine)} units left to bill.`, {
            errorPath: `${prefix}quantity`,
          });
        }
        if (quantity > 0) billing.set(orderLine, round4(quantity));
      }
      if (billing.size === 0) session.fail("USER_ERROR", "There are no items to be billed on this sales order.");
    }

    const updatedOrder = { ...order, lines: order.lines.map((line) => ({ ...line })) };
    const invoiceLines = [];
    let number = 1;
    for (const line of updatedOrder.lines) {
      const quantity = billing.get(line.line);
      if (quantity === undefined) continue;
      line.quantityBilled = round4(line.quantityBilled + quantity);
      const amount = round2(quantity * line.rate);
      invoiceLines.push({
        line: number,
        itemId: line.itemId,
        quantity,
        rate: line.rate,
        amount,
        description: line.description,
        taxRate: line.taxRate,
        taxAmount: round2(amount * line.taxRate),
        orderLine: line.line,
        quantityBilled: 0,
      });
      number += 1;
    }
    const amounts = totals(invoiceLines);
    const invoiceId = session.nextId("nextTransactionId", "invoices");
    const tranDate = dateField(session, body, "tranDate") ?? session.today;
    const dueDate = dateField(session, body, "dueDate") ?? addDays(tranDate, 30);
    const invoice = {
      id: invoiceId,
      tranId: nextTranId(session, "invoices", "INV"),
      tranDate,
      dueDate,
      entityId: order.entityId,
      subsidiaryId: order.subsidiaryId,
      createdFromId: order.id,
      status: "open",
      memo: stringField(session, body, "memo", 999) ?? order.memo,
      otherRefNum: order.otherRefNum,
      currencyId: order.currencyId,
      termsId: order.termsId,
      lines: invoiceLines,
      ...amounts,
      amountPaid: 0,
      appliedPaymentIds: [],
      createdDate: session.now,
      lastModifiedDate: session.now,
      createdById: session.employee.id,
      lastModifiedById: session.employee.id,
      version: 1,
    };
    updatedOrder.billedTotal = billedTotal(updatedOrder.lines);
    updatedOrder.status = orderStatus(updatedOrder);
    updatedOrder.lastModifiedDate = session.now;
    updatedOrder.lastModifiedById = session.employee.id;
    updatedOrder.version = order.version + 1;

    session.put("invoices", invoiceId, invoice);
    setLineCounter(session, invoiceId, invoiceLines.length + 1);
    session.put("sales-orders", order.id, updatedOrder);
    session.recordChanged("invoice", invoiceId, "CREATE", invoice.subsidiaryId);
    session.statusChanged("invoice", invoice, null, invoice.total);
    session.recordChanged("salesOrder", order.id, "UPDATE", updatedOrder.subsidiaryId);
    if (updatedOrder.status !== order.status) session.statusChanged("salesOrder", updatedOrder, order.status, null);
    return { id: invoiceId, location: `/services/rest/record/v1/invoice/${invoiceId}` };
  },
};
