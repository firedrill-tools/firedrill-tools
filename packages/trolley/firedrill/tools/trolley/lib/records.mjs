// Shared record lookups. Malformed ids are NOT_FOUND, never a crash.
import { isId } from "./ids.mjs";
import { merchant } from "./access.mjs";
import { deriveStatus, primaryAccount } from "./serialize.mjs";
import { accountRowId, paymentRowId, scanAll, scanChildren } from "./store.mjs";
import { checkEmail, checkText, hasOwn, invalid } from "./validate.mjs";
import { fieldError } from "./validate.mjs";

export const notFound = (context, what, field) => fieldError(context, "NOT_FOUND", field, `${what} not found`);

export function recipientOrFail(context, id, field) {
  const row = isId("R", id) ? context.state.get("recipients", id) : null;
  if (row === null) notFound(context, "Recipient", field);
  return row;
}

export function batchOrFail(context, id) {
  const row = isId("B", id) ? context.state.get("batches", id) : null;
  if (row === null) notFound(context, "Batch");
  return row;
}

export function paymentOrFail(context, batchId, paymentId) {
  const row = isId("B", batchId) && isId("P", paymentId) ? context.state.get("payments", paymentRowId(batchId, paymentId)) : null;
  if (row === null) notFound(context, "Payment");
  return row;
}

export function accountOrFail(context, recipientId, accountId) {
  const row = isId("R", recipientId) && isId("A", accountId) ? context.state.get("recipient_accounts", accountRowId(recipientId, accountId)) : null;
  if (row === null) notFound(context, "Recipient account");
  return row;
}

export const accountsOf = (context, recipientId) => scanChildren(context, "recipient_accounts", recipientId);
export const paymentsOf = (context, batchId) => scanChildren(context, "payments", batchId);
export const merchantId = (context) => merchant(context).id;

/** Re-derives and stores the recipient status after account or profile changes. */
export function refreshRecipient(context, recipient, accounts, now) {
  const status = deriveStatus(recipient, primaryAccount(accounts) !== null);
  if (status === recipient.status) return recipient;
  const next = { ...recipient, status, updatedAt: now };
  context.state.put("recipients", recipient.id, next);
  return next;
}

/** `{ id | email | referenceId }` → recipient row (id wins). Unknown → NOT_FOUND on `field`. */
export function resolveRecipient(context, reference, field) {
  if (reference === null || typeof reference !== "object" || Array.isArray(reference)) invalid(context, field);
  if (hasOwn(reference, "id") && reference.id !== undefined) {
    checkText(context, reference.id, `${field}.id`, 64);
    return recipientOrFail(context, reference.id, field);
  }
  let match;
  if (hasOwn(reference, "email")) {
    const email = checkEmail(context, reference.email, `${field}.email`);
    match = (row) => row.email.toLowerCase() === email;
  } else if (hasOwn(reference, "referenceId")) {
    const ref = checkText(context, reference.referenceId, `${field}.referenceId`, 100);
    match = (row) => row.referenceId === ref;
  } else {
    fieldError(context, "EMPTY_FIELD", field, "Value cannot be empty");
  }
  const rows = scanAll(context, "recipients").filter((row) => row.status !== "archived" && match(row));
  if (rows.length === 0) notFound(context, "Recipient", field);
  return rows[0];
}

/** True when a `pending` payment in an `open` batch satisfies `predicate`. */
export function hasPendingOpenPayment(context, predicate) {
  for (const batch of scanAll(context, "batches")) {
    if (batch.status !== "open") continue;
    if (paymentsOf(context, batch.id).some((payment) => payment.status === "pending" && predicate(payment))) return true;
  }
  return false;
}

/** E-mail and referenceId uniqueness among non-archived recipients other than `selfId`. */
export function assertUnique(context, { email, referenceId }, selfId) {
  const rows = scanAll(context, "recipients");
  for (const row of rows) {
    if (row.id === selfId || row.status === "archived") continue;
    if (email !== undefined && row.email.toLowerCase() === email) invalid(context, "email", "Email already exists");
    if (typeof referenceId === "string" && row.referenceId === referenceId) invalid(context, "referenceId", "Reference ID already exists");
  }
}
