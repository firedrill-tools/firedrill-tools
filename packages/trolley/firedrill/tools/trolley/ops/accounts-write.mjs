// PATCH and DELETE /v1/recipients/{recipientId}/accounts/{accountId}.
import { requireKey } from "../lib/access.mjs";
import { accountOrFail, accountsOf, hasPendingOpenPayment, recipientOrFail, refreshRecipient } from "../lib/records.mjs";
import { accountOut } from "../lib/serialize.mjs";
import { accountRowId } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";
import { checkCountry, checkCurrency, checkDigits, checkEmail, checkText, empty, hasOwn, invalid, rejectReservedKeys, requireText } from "../lib/validate.mjs";

const IMMUTABLE = {
  type: "Create a new account to change the payout method",
  country: "Create a new account to change the bank country",
  accountNum: "Create a new account to change the account number",
  iban: "Create a new account to change the account number",
};
const BRANCH_DIGITS = { US: 9, CA: 5, GB: 6, AU: 6 };

function notApplicable(context, field) {
  invalid(context, field, "Field does not apply to this payout method");
}

function applyChanges(context, account, changes) {
  const next = { ...account };
  const bank = account.type === "bank-transfer";
  for (const key of Object.keys(changes)) {
    if (Object.hasOwn(IMMUTABLE, key)) invalid(context, key, IMMUTABLE[key]);
  }
  if (hasOwn(changes, "primary") && changes.primary !== true) invalid(context, "primary", "Set another account as primary instead");
  if (hasOwn(changes, "accountHolderName")) {
    if (!bank) notApplicable(context, "accountHolderName");
    next.accountHolderName = requireText(context, changes, "accountHolderName", 200);
  }
  if (hasOwn(changes, "currency")) {
    const currency = checkCurrency(context, changes.currency, "currency");
    if (!bank && account.type !== "paypal" && currency !== "USD") invalid(context, "currency", "This payout method pays in USD");
    next.currency = currency;
  }
  if (hasOwn(changes, "emailAddress")) {
    if (account.type !== "paypal") notApplicable(context, "emailAddress");
    next.emailAddress = checkEmail(context, changes.emailAddress, "emailAddress");
  }
  if (hasOwn(changes, "phoneNumber")) {
    if (account.type !== "venmo") notApplicable(context, "phoneNumber");
    const raw = typeof changes.phoneNumber === "string" ? changes.phoneNumber.replace(/[-() +]/g, "") : changes.phoneNumber;
    next.phoneNumber = checkDigits(context, raw, "phoneNumber", 10, 11);
  }
  if (hasOwn(changes, "mailing")) {
    if (account.type !== "check") notApplicable(context, "mailing");
    const value = changes.mailing;
    if (value === null || typeof value !== "object" || Array.isArray(value)) empty(context, "mailing");
    const mailing = { ...account.mailing };
    for (const key of Object.keys(value)) {
      if (!["name", "street1", "street2", "city", "region", "postal", "country"].includes(key)) invalid(context, `mailing.${key}`, "Field is not allowed");
      if (key === "street2") mailing.street2 = value.street2 === null || value.street2 === "" ? null : checkText(context, value.street2, "mailing.street2", 200);
      else mailing[key] = requireText(context, value, key, 200, `mailing.${key}`);
    }
    if (checkCountry(context, mailing.country, "mailing.country") !== "US") invalid(context, "mailing.country", "Checks can only be mailed within the US");
    mailing.country = "US";
    next.mailing = mailing;
  }
  if (hasOwn(changes, "branchId")) {
    if (!bank || !Object.hasOwn(BRANCH_DIGITS, account.country)) notApplicable(context, "branchId");
    const n = BRANCH_DIGITS[account.country];
    next.branchId = checkDigits(context, changes.branchId, "branchId", n, n);
  }
  if (hasOwn(changes, "bankId")) {
    if (!bank || account.country !== "CA") notApplicable(context, "bankId");
    next.bankId = checkDigits(context, changes.bankId, "bankId", 3, 3);
  }
  if (hasOwn(changes, "swiftBic")) {
    if (!bank) notApplicable(context, "swiftBic");
    if (changes.swiftBic === null || changes.swiftBic === "") next.swiftBic = null;
    else {
      const swift = checkText(context, changes.swiftBic, "swiftBic", 11).toUpperCase();
      if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) invalid(context, "swiftBic", "SWIFT/BIC is invalid");
      next.swiftBic = swift;
    }
  }
  return next;
}

export function accountsUpdate(input, context) {
  requireKey(context, true);
  rejectReservedKeys(context, input);
  const recipient = recipientOrFail(context, input.recipientId);
  const account = accountOrFail(context, recipient.id, input.accountId);
  const { recipientId, accountId, ...changes } = input;
  if (Object.keys(changes).length === 0) empty(context, "body");
  if (account.status === "disabled") context.fail({ code: "INVALID_STATUS", message: "Account is disabled" });
  const now = nowIso(context);
  const next = { ...applyChanges(context, account, changes), updatedAt: now };
  const siblings = accountsOf(context, recipient.id);
  if (changes.primary === true && !account.primary) {
    for (const sibling of siblings) {
      if (sibling.id === account.id || !sibling.primary) continue;
      context.state.put("recipient_accounts", accountRowId(recipient.id, sibling.id), { ...sibling, primary: false, status: "active", updatedAt: now });
    }
    next.primary = true;
    next.status = "primary";
  }
  context.state.put("recipient_accounts", accountRowId(recipient.id, account.id), next);
  refreshRecipient(context, recipient, accountsOf(context, recipient.id), now);
  return { ok: true, account: accountOut(next) };
}

export function accountsDelete(input, context) {
  requireKey(context, true);
  const recipient = recipientOrFail(context, input.recipientId);
  const account = accountOrFail(context, recipient.id, input.accountId);
  if (account.status === "disabled") context.fail({ code: "INVALID_STATUS", message: "Account is already disabled" });
  if (hasPendingOpenPayment(context, (payment) => payment.accountId === account.id)) {
    context.fail({ code: "INVALID_STATUS", message: "Account has pending payments" });
  }
  const now = nowIso(context);
  context.state.put("recipient_accounts", accountRowId(recipient.id, account.id), { ...account, primary: false, status: "disabled", disabledAt: now, updatedAt: now });
  refreshRecipient(context, recipient, accountsOf(context, recipient.id), now);
  return { ok: true };
}
