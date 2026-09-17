// Shared transaction rules: reference resolution, line building, totals, derived status and document numbers.
import { quote } from "./errors.mjs";
import { round2, round4 } from "./primitives.mjs";
import { numberField, referenceField, stringField } from "./body.mjs";

const TAX_RATES = new Map([["1", 0.086], ["2", 0.05]]);
export const taxRateFor = (subsidiaryId) => TAX_RATES.get(subsidiaryId) ?? 0;

export function resolveCustomer(session, entityId, path = "entity") {
  const customer = session.get("customers", entityId);
  if (customer === null || !session.inScope(customer.subsidiaryId)) {
    session.fail("INVALID_KEY_OR_REF", `Invalid customer reference key ${quote(String(entityId))}.`, { errorPath: path });
  }
  if (customer.isInactive === true) {
    session.fail("USER_ERROR", `The customer ${quote(customer.entityId)} is inactive and cannot be used on a transaction.`, {
      errorPath: path,
    });
  }
  return customer;
}

export function resolveItem(session, itemId, subsidiaryId, path) {
  const item = session.get("items", itemId);
  if (item === null) {
    session.fail("INVALID_KEY_OR_REF", `Invalid item reference key ${quote(String(itemId))}.`, { errorPath: path });
  }
  if (item.isInactive === true) {
    session.fail("USER_ERROR", `The item ${quote(item.itemId)} is inactive and cannot be used on a transaction.`, { errorPath: path });
  }
  if (!item.subsidiaryIds.includes(subsidiaryId)) {
    session.fail("INVALID_KEY_OR_REF", `The item ${quote(item.itemId)} is not available in the subsidiary of this transaction.`, {
      errorPath: path,
    });
  }
  return item;
}

/** Build the item sublist from a wire body; `quantityBilled` is preserved from an existing line when given. */
export function buildLine(session, entry, subsidiaryId, lineNumber, prefix, existing = null) {
  const itemId = referenceField(session, entry, "item", prefix);
  if (itemId === undefined && existing === null) {
    session.fail("INVALID_KEY_OR_REF", `The line ${quote(`${prefix}item`)} must carry an item reference.`, { errorPath: `${prefix}item` });
  }
  const resolvedItemId = itemId ?? existing.itemId;
  const item = resolveItem(session, resolvedItemId, subsidiaryId, `${prefix}item`);
  const quantity = numberField(session, entry, "quantity", { min: 0, max: 1000000, prefix });
  const rate = numberField(session, entry, "rate", { min: 0, max: 100000000, prefix });
  const description = stringField(session, entry, "description", 999, prefix);
  const taxRate = numberField(session, entry, "taxRate", { min: 0, max: 0.25, prefix });
  const finalQuantity = round4(quantity ?? existing?.quantity ?? 1);
  const finalRate = round4(rate ?? existing?.rate ?? item.basePrice);
  const finalTaxRate = taxRate ?? existing?.taxRate ?? taxRateFor(subsidiaryId);
  const amount = round2(finalQuantity * finalRate);
  const billed = existing === null ? 0 : existing.quantityBilled;
  if (finalQuantity < billed) {
    session.fail("USER_ERROR", `The quantity on line ${lineNumber} cannot be lower than the quantity already billed (${billed}).`, {
      errorPath: `${prefix}quantity`,
    });
  }
  return {
    line: lineNumber,
    itemId: resolvedItemId,
    quantity: finalQuantity,
    rate: finalRate,
    amount,
    description: description === undefined ? existing?.description ?? null : description,
    taxRate: finalTaxRate,
    taxAmount: round2(amount * finalTaxRate),
    orderLine: existing === null ? null : existing.orderLine,
    quantityBilled: billed,
  };
}

export function totals(lines) {
  const subtotal = round2(lines.reduce((sum, line) => sum + line.amount, 0));
  const taxTotal = round2(lines.reduce((sum, line) => sum + line.taxAmount, 0));
  return { subtotal, taxTotal, total: round2(subtotal + taxTotal) };
}

/** Billed value of an order, tax included, from each line's quantityBilled. */
export function billedTotal(lines) {
  return round2(lines.reduce((sum, line) => sum + round2(line.quantityBilled * line.rate) * (1 + line.taxRate), 0));
}

/** Sales-order status derived from billed quantities; a closed order stays closed. */
export function orderStatus(order) {
  if (order.status === "closed") return "closed";
  const billedLines = order.lines.filter((line) => line.quantityBilled > 0);
  if (billedLines.length === 0) return order.status === "pendingApproval" ? "pendingApproval" : "pendingFulfillment";
  const fullyBilled = order.lines.every((line) => line.quantityBilled >= line.quantity);
  if (fullyBilled) return "billed";
  return "pendingBillingPartFulfilled";
}

export function invoiceStatus(invoice) {
  if (invoice.status === "voided" || invoice.status === "pendingApproval") return invoice.status;
  return round2(invoice.total - invoice.amountPaid) <= 0 && invoice.total > 0 ? "paidInFull" : "open";
}

const PREFIX_PATTERN = /^([A-Z]+)([0-9]+)$/;

/** Next document number for a transaction namespace, continuing the seeded sequence. */
export function nextTranId(session, namespace, prefix) {
  let highest = 1000;
  for (const row of session.rows(namespace)) {
    const parts = PREFIX_PATTERN.exec(row.tranId);
    if (parts === null || parts[1] !== prefix) continue;
    const value = Number(parts[2]);
    if (Number.isSafeInteger(value) && value > highest) highest = value;
  }
  return `${prefix}${highest + 1}`;
}

export function checkDuplicateTranId(session, namespaces, tranId, ownId) {
  for (const namespace of namespaces) {
    for (const row of session.rows(namespace)) {
      if (row.id !== ownId && row.tranId === tranId) {
        session.fail("USER_ERROR", `The document number ${quote(tranId)} is already in use by another transaction.`, {
          errorPath: "tranId",
        });
      }
    }
  }
}

export function lineCounter(session, transactionId) {
  const row = session.get("line-counters", transactionId);
  return row === null || !Number.isInteger(row.nextLine) ? 1 : row.nextLine;
}

export function setLineCounter(session, transactionId, nextLine) {
  session.put("line-counters", transactionId, { nextLine });
}
