// Invoice writes: create (optionally from a sales order), merge-patch update and the !transform that
// accepts a customer payment.
import { quote } from "./errors.mjs";
import { addDays, dateToDays, round2, round4 } from "./primitives.mjs";
import { open } from "./session.mjs";
import { loadRecord } from "./handlers-read.mjs";
import {
  checkPropertyNames, checkVersion, dateField, idempotencyKey, numberField,
  referenceField, replaceList, requestBody, stringField, sublistItems,
} from "./body.mjs";
import {
  billedTotal, buildLine, checkDuplicateTranId, invoiceStatus, lineCounter, nextTranId,
  orderStatus, resolveCustomer, setLineCounter, totals,
} from "./tran.mjs";
import { checkMarker } from "./write-order.mjs";

const KNOWN = new Set(["entity", "createdFrom", "tranDate", "dueDate", "tranId", "memo", "otherRefNum", "terms", "item"]);
const REPLACEABLE = new Set(["item", "memo", "otherRefNum", "terms"]);
const TERMS = new Set(["1", "2", "3"]);

function checkTerms(session, termsId) {
  if (termsId === undefined || termsId === null) return termsId ?? null;
  if (!TERMS.has(termsId)) session.fail("INVALID_KEY_OR_REF", `Invalid terms reference key ${quote(termsId)}.`, { errorPath: "terms" });
  return termsId;
}

function checkDueDate(session, tranDate, dueDate) {
  const from = dateToDays(tranDate);
  const to = dateToDays(dueDate);
  if (from !== null && to !== null && to < from) {
    session.fail("USER_ERROR", "The due date cannot be earlier than the transaction date.", { errorPath: "dueDate" });
  }
  return dueDate;
}

export const invoiceWrites = {
  "invoice.create": (input, context) => {
    const session = open(context);
    session.permit("TRAN_CUSTINVC", "create");
    idempotencyKey(session, input);
    const body = requestBody(session, input);
    checkPropertyNames(session, input, body, KNOWN);
    session.rows("invoices");
    const entityId = referenceField(session, body, "entity");
    if (entityId === undefined || entityId === null) {
      session.fail("INVALID_KEY_OR_REF", "An invoice must carry an entity reference.", { errorPath: "entity" });
    }
    const customer = resolveCustomer(session, entityId);
    const subsidiaryId = customer.subsidiaryId;
    const createdFromId = referenceField(session, body, "createdFrom");
    let order = null;
    if (createdFromId !== undefined && createdFromId !== null) {
      order = session.get("sales-orders", createdFromId);
      if (order === null || !session.inScope(order.subsidiaryId)) {
        session.fail("INVALID_KEY_OR_REF", `Invalid sales order reference key ${quote(createdFromId)}.`, { errorPath: "createdFrom" });
      }
      if (order.entityId !== customer.id) {
        session.fail("USER_ERROR", "The sales order named by createdFrom belongs to a different customer.", { errorPath: "createdFrom" });
      }
      if (order.status === "closed") session.fail("USER_ERROR", "This sales order is closed and cannot be billed.");
    }

    const entries = sublistItems(session, body, "item", 200);
    let lines;
    let updatedOrder = null;
    if (order !== null) {
      const remaining = new Map();
      for (const line of order.lines) {
        const openQuantity = round4(line.quantity - line.quantityBilled);
        if (openQuantity > 0) remaining.set(line.line, openQuantity);
      }
      if (remaining.size === 0) session.fail("USER_ERROR", "There are no items to be billed on this sales order.");
      const billing = new Map();
      if (entries === undefined || entries.length === 0) {
        for (const [line, quantity] of remaining) billing.set(line, quantity);
      } else {
        for (const [index, entry] of entries.entries()) {
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
      updatedOrder = { ...order, lines: order.lines.map((line) => ({ ...line })) };
      lines = [];
      let number = 1;
      for (const line of updatedOrder.lines) {
        const quantity = billing.get(line.line);
        if (quantity === undefined) continue;
        line.quantityBilled = round4(line.quantityBilled + quantity);
        const amount = round2(quantity * line.rate);
        lines.push({
          line: number, itemId: line.itemId, quantity, rate: line.rate, amount,
          description: line.description, taxRate: line.taxRate, taxAmount: round2(amount * line.taxRate),
          orderLine: line.line, quantityBilled: 0,
        });
        number += 1;
      }
    } else {
      if (entries === undefined || entries.length === 0) {
        session.fail("USER_ERROR", "Please enter at least one line item for this transaction.", { errorPath: "item.items" });
      }
      lines = entries.map((entry, index) => buildLine(session, entry, subsidiaryId, index + 1, `item.items[${index}].`));
    }

    const tranDate = dateField(session, body, "tranDate") ?? session.today;
    const dueDate = checkDueDate(session, tranDate, dateField(session, body, "dueDate") ?? addDays(tranDate, 30));
    const suppliedTranId = stringField(session, body, "tranId", 45);
    const id = session.nextId("nextTransactionId", "invoices");
    const tranId = suppliedTranId ?? nextTranId(session, "invoices", "INV");
    checkDuplicateTranId(session, ["invoices"], tranId, null);
    const row = {
      id, tranId, tranDate, dueDate,
      entityId: customer.id,
      subsidiaryId,
      createdFromId: order === null ? null : order.id,
      status: "open",
      memo: stringField(session, body, "memo", 999) ?? null,
      otherRefNum: stringField(session, body, "otherRefNum", 45) ?? null,
      currencyId: customer.currencyId,
      termsId: checkTerms(session, referenceField(session, body, "terms")) ?? customer.termsId,
      lines,
      ...totals(lines),
      amountPaid: 0,
      appliedPaymentIds: [],
      createdDate: session.now,
      lastModifiedDate: session.now,
      createdById: session.employee.id,
      lastModifiedById: session.employee.id,
      version: 1,
    };
    session.put("invoices", id, row);
    setLineCounter(session, id, lines.length + 1);
    session.recordChanged("invoice", id, "CREATE", subsidiaryId);
    session.statusChanged("invoice", row, null, row.total);
    if (updatedOrder !== null) {
      updatedOrder.billedTotal = billedTotal(updatedOrder.lines);
      updatedOrder.status = orderStatus(updatedOrder);
      updatedOrder.lastModifiedDate = session.now;
      updatedOrder.lastModifiedById = session.employee.id;
      updatedOrder.version = order.version + 1;
      session.put("sales-orders", order.id, updatedOrder);
      session.recordChanged("salesOrder", order.id, "UPDATE", updatedOrder.subsidiaryId);
      if (updatedOrder.status !== order.status) session.statusChanged("salesOrder", updatedOrder, order.status, null);
    }
    return { id, location: `/services/rest/record/v1/invoice/${id}` };
  },

  "invoice.update": (input, context) => {
    const session = open(context);
    session.permit("TRAN_CUSTINVC", "edit");
    idempotencyKey(session, input);
    const body = requestBody(session, input);
    checkPropertyNames(session, input, body, KNOWN);
    const replace = replaceList(session, input, REPLACEABLE);
    const current = loadRecord(session, "invoice", input.recordId);
    checkVersion(session, input, current);
    session.rows("invoices");
    if (current.status === "paidInFull") {
      session.fail("USER_ERROR", "This invoice is paid in full and can no longer be edited.");
    }
    const updated = { ...current, lines: current.lines.map((line) => ({ ...line })) };
    if (replace.has("memo")) updated.memo = null;
    if (replace.has("otherRefNum")) updated.otherRefNum = null;
    if (replace.has("terms")) updated.termsId = null;
    if (replace.has("item")) updated.lines = [];

    const tranDate = dateField(session, body, "tranDate");
    if (tranDate !== undefined && tranDate !== null) updated.tranDate = tranDate;
    const dueDate = dateField(session, body, "dueDate");
    if (dueDate !== undefined && dueDate !== null) updated.dueDate = dueDate;
    checkDueDate(session, updated.tranDate, updated.dueDate);
    const memo = stringField(session, body, "memo", 999);
    if (memo !== undefined) updated.memo = memo;
    const otherRefNum = stringField(session, body, "otherRefNum", 45);
    if (otherRefNum !== undefined) updated.otherRefNum = otherRefNum;
    const termsId = referenceField(session, body, "terms");
    if (termsId !== undefined) updated.termsId = checkTerms(session, termsId);
    const tranId = stringField(session, body, "tranId", 45);
    if (tranId !== undefined && tranId !== null) {
      checkDuplicateTranId(session, ["invoices"], tranId, current.id);
      updated.tranId = tranId;
    }

    const entries = sublistItems(session, body, "item", 200);
    const touchesLines = entries !== undefined || replace.has("item");
    if (touchesLines && current.amountPaid > 0) {
      session.fail("USER_ERROR", "Lines cannot be changed on an invoice that already has payments applied.", { errorPath: "item.items" });
    }
    if (entries !== undefined) {
      let counter = lineCounter(session, current.id);
      for (const [index, entry] of entries.entries()) {
        const prefix = `item.items[${index}].`;
        const lineNumber = numberField(session, entry, "line", { min: 1, max: 100000, prefix });
        if (lineNumber === undefined || lineNumber === null) {
          updated.lines.push(buildLine(session, entry, updated.subsidiaryId, counter, prefix));
          counter += 1;
          continue;
        }
        const position = updated.lines.findIndex((line) => line.line === lineNumber);
        if (position < 0) {
          session.fail("INVALID_KEY_OR_REF", `Line ${lineNumber} does not exist on this invoice.`, { errorPath: `${prefix}line` });
        }
        updated.lines[position] = buildLine(session, entry, updated.subsidiaryId, lineNumber, prefix, updated.lines[position]);
      }
      setLineCounter(session, current.id, counter);
    }
    Object.assign(updated, totals(updated.lines));
    if (updated.total < current.amountPaid) {
      session.fail("USER_ERROR", "The invoice total cannot be lowered below the amount already paid.", { errorPath: "item.items" });
    }
    updated.status = invoiceStatus(updated);
    updated.lastModifiedDate = session.now;
    updated.lastModifiedById = session.employee.id;
    updated.version = current.version + 1;
    session.put("invoices", current.id, updated);
    session.recordChanged("invoice", current.id, "UPDATE", updated.subsidiaryId);
    if (updated.status !== current.status) {
      session.statusChanged("invoice", updated, current.status, round2(updated.total - updated.amountPaid));
    }
    return { id: current.id, location: `/services/rest/record/v1/invoice/${current.id}` };
  },

  "invoice.transform": (input, context) => {
    const session = open(context);
    session.permit("TRAN_CUSTINVC", "view");
    session.permit("TRAN_CUSTPYMT", "create");
    checkMarker(session, input.transformMarker);
    idempotencyKey(session, input);
    const body = requestBody(session, input);
    const invoice = loadRecord(session, "invoice", input.recordId);
    checkVersion(session, input, invoice);
    session.rows("customer-payments");
    if (invoice.status === "paidInFull") session.fail("USER_ERROR", "This invoice is already paid in full.");
    if (invoice.status === "voided") session.fail("USER_ERROR", "This invoice is voided and cannot be paid.");
    const remaining = round2(invoice.total - invoice.amountPaid);
    if (remaining <= 0) session.fail("USER_ERROR", "This invoice has no remaining balance to apply a payment to.");

    const requested = numberField(session, body, "payment", { min: 0, max: 1000000000 });
    const applications = sublistItems(session, body, "apply", 20);
    let applied;
    if (applications !== undefined && applications.length > 0) {
      applied = 0;
      for (const [index, entry] of applications.entries()) {
        const prefix = `apply.items[${index}].`;
        const doc = Object.hasOwn(entry, "doc") ? String(entry.doc) : undefined;
        if (doc !== invoice.id) {
          session.fail("USER_ERROR", `The apply line ${quote(String(doc))} does not belong to this invoice.`, { errorPath: `${prefix}doc` });
        }
        if (Object.hasOwn(entry, "apply") && entry.apply === false) continue;
        const amount = numberField(session, entry, "amount", { min: 0, max: 1000000000, prefix }) ?? remaining;
        applied = round2(applied + amount);
      }
    } else {
      // Without an apply sublist NetSuite applies the payment to this invoice, up to its remaining balance.
      applied = requested === undefined || requested === null ? remaining : Math.min(round2(requested), remaining);
    }
    const payment = requested ?? applied;
    if (payment <= 0) session.fail("USER_ERROR", "The payment amount must be greater than zero.", { errorPath: "payment" });
    if (applied > remaining) {
      session.fail("USER_ERROR", `The applied amount cannot exceed the invoice balance of ${remaining}.`, { errorPath: "apply.items" });
    }
    if (applied > payment) {
      session.fail("USER_ERROR", "The applied amount cannot exceed the payment amount.", { errorPath: "apply.items" });
    }

    const paymentId = session.nextId("nextTransactionId", "customer-payments");
    const tranDate = dateField(session, body, "tranDate") ?? session.today;
    const accountBody = Object.hasOwn(body, "account") && typeof body.account === "object" && body.account !== null
      ? body.account
      : {};
    const row = {
      id: paymentId,
      tranId: nextTranId(session, "customer-payments", "CP"),
      tranDate,
      entityId: invoice.entityId,
      subsidiaryId: invoice.subsidiaryId,
      payment,
      unapplied: round2(payment - applied),
      accountName: stringField(session, accountBody, "refName", 80) ?? "1000 Operating Bank Account",
      memo: stringField(session, body, "memo", 999) ?? null,
      currencyId: invoice.currencyId,
      applied: [{ invoiceId: invoice.id, amount: applied }],
      status: "notDeposited",
      createdDate: session.now,
      lastModifiedDate: session.now,
      createdById: session.employee.id,
      version: 1,
    };
    const updatedInvoice = {
      ...invoice,
      amountPaid: round2(invoice.amountPaid + applied),
      appliedPaymentIds: [...invoice.appliedPaymentIds, paymentId],
      lastModifiedDate: session.now,
      lastModifiedById: session.employee.id,
      version: invoice.version + 1,
    };
    updatedInvoice.status = invoiceStatus(updatedInvoice);
    session.put("customer-payments", paymentId, row);
    session.put("invoices", invoice.id, updatedInvoice);
    session.recordChanged("customerPayment", paymentId, "CREATE", row.subsidiaryId);
    session.recordChanged("invoice", invoice.id, "UPDATE", updatedInvoice.subsidiaryId);
    if (updatedInvoice.status !== invoice.status) {
      session.statusChanged("invoice", updatedInvoice, invoice.status, round2(updatedInvoice.total - updatedInvoice.amountPaid));
    }
    return { id: paymentId, location: `/services/rest/record/v1/customerPayment/${paymentId}` };
  },
};
