// Recipient accounts (payout methods): bank-transfer, paypal, check, venmo. Full account numbers are never stored.
import { requireKey } from "../lib/access.mjs";
import { nextId } from "../lib/ids.mjs";
import { accountOrFail, accountsOf, hasPendingOpenPayment, recipientOrFail, refreshRecipient } from "../lib/records.mjs";
import { accountOut, activeAccounts } from "../lib/serialize.mjs";
import { accountRowId } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";
import { IBAN_COUNTRIES, checkCountry, checkCurrency, checkDigits, checkEmail, checkText, empty, fieldError, hasOwn, invalid, requireText } from "../lib/validate.mjs";

const MAX_ACCOUNTS = 20;
const BRANCH_DIGITS = { US: 9, CA: 5, GB: 6, AU: 6 };

function bankName(country) {
  return `Firedrill Test Bank ${country}`;
}

function checkSwift(context, value, field) {
  const text = checkText(context, value, field, 11).toUpperCase();
  if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(text)) invalid(context, field, "SWIFT/BIC is invalid");
  return text;
}

function checkMailing(context, value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) empty(context, field);
  const out = {};
  for (const key of ["name", "street1", "city", "region", "postal", "country"]) out[key] = requireText(context, value, key, 200, `${field}.${key}`);
  out.street2 = hasOwn(value, "street2") && value.street2 !== null ? checkText(context, value.street2, `${field}.street2`, 200) : null;
  out.country = checkCountry(context, out.country, `${field}.country`);
  if (out.country !== "US") invalid(context, `${field}.country`, "Checks can only be mailed within the US");
  return out;
}

function blank(recipientId, id, type, now) {
  return {
    id, recipientId, type, primary: false, status: "active", currency: "USD", country: "US", accountHolderName: null,
    accountNumLast4: null, ibanLast4: null, bankId: null, branchId: null, swiftBic: null, bankName: null,
    emailAddress: null, phoneNumber: null, mailing: null, disabledAt: null, createdAt: now, updatedAt: now,
  };
}

/** Validates a create payload and returns an unsaved account row (ids allocated). `p` prefixes field names. */
export function buildAccount(context, recipient, input, p, now) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) invalid(context, p.replace(/\.$/, "") || "accounts");
  const type = requireText(context, input, "type", 40, `${p}type`);
  if (type === "debit-card" || type === "mobile-wallet") invalid(context, `${p}type`, "This payout method cannot be created via the API");
  if (!["bank-transfer", "paypal", "check", "venmo"].includes(type)) invalid(context, `${p}type`, "Payout method is not supported");
  const fallbackCountry = typeof recipient.address?.country === "string" ? recipient.address.country : "US";
  const row = blank(recipient.id, nextId(context, "A"), type, now);
  if (type === "bank-transfer") {
    row.currency = checkCurrency(context, input.currency, `${p}currency`);
    row.country = checkCountry(context, input.country, `${p}country`);
    row.accountHolderName = requireText(context, input, "accountHolderName", 200, `${p}accountHolderName`);
    const usesIban = hasOwn(input, "iban") && input.iban !== null;
    if (usesIban) {
      const iban = checkText(context, input.iban, `${p}iban`, 42).replace(/ /g, "").toUpperCase();
      if (!IBAN_COUNTRIES.includes(row.country) || !/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban) || iban.slice(0, 2) !== row.country) invalid(context, `${p}iban`, "IBAN is invalid");
      row.ibanLast4 = iban.slice(-4);
    } else {
      if (!hasOwn(input, "accountNum")) empty(context, IBAN_COUNTRIES.includes(row.country) && row.country !== "GB" ? `${p}iban` : `${p}accountNum`);
      row.accountNumLast4 = checkDigits(context, input.accountNum, `${p}accountNum`, 4, 34).slice(-4);
      if (Object.hasOwn(BRANCH_DIGITS, row.country)) {
        if (!hasOwn(input, "branchId")) empty(context, `${p}branchId`);
        const n = BRANCH_DIGITS[row.country];
        row.branchId = checkDigits(context, input.branchId, `${p}branchId`, n, n);
      }
      if (row.country === "CA") {
        if (!hasOwn(input, "bankId")) empty(context, `${p}bankId`);
        row.bankId = checkDigits(context, input.bankId, `${p}bankId`, 3, 3);
      }
    }
    if (hasOwn(input, "swiftBic") && input.swiftBic !== null) row.swiftBic = checkSwift(context, input.swiftBic, `${p}swiftBic`);
    row.bankName = bankName(row.country);
  } else if (type === "paypal") {
    row.emailAddress = checkEmail(context, input.emailAddress, `${p}emailAddress`);
    row.currency = hasOwn(input, "currency") ? checkCurrency(context, input.currency, `${p}currency`) : "USD";
    row.country = hasOwn(input, "country") ? checkCountry(context, input.country, `${p}country`) : fallbackCountry;
  } else if (type === "venmo") {
    if (hasOwn(input, "country") && checkCountry(context, input.country, `${p}country`) !== "US") invalid(context, `${p}country`, "Venmo is only available in the US");
    if (hasOwn(input, "currency") && checkCurrency(context, input.currency, `${p}currency`) !== "USD") invalid(context, `${p}currency`, "Venmo pays in USD");
    row.phoneNumber = checkDigits(context, typeof input.phoneNumber === "string" ? input.phoneNumber.replace(/[-() +]/g, "") : input.phoneNumber, `${p}phoneNumber`, 10, 11);
  } else {
    if (hasOwn(input, "currency") && checkCurrency(context, input.currency, `${p}currency`) !== "USD") invalid(context, `${p}currency`, "Checks are paid in USD");
    row.mailing = checkMailing(context, input.mailing, `${p}mailing`);
  }
  if (hasOwn(input, "primary") && typeof input.primary !== "boolean") invalid(context, `${p}primary`);
  row.primary = input.primary === true;
  return row;
}

/** Stores `row`, making it primary when requested or when no active primary exists, demoting siblings. */
export function attachAccount(context, row, existing) {
  const active = existing.filter((account) => account.status !== "disabled");
  if (active.length >= MAX_ACCOUNTS) invalid(context, "type", "Recipient has the maximum number of payout methods");
  const makePrimary = row.primary || !active.some((account) => account.primary);
  if (makePrimary) {
    for (const sibling of active.filter((account) => account.primary)) {
      context.state.put("recipient_accounts", accountRowId(sibling.recipientId, sibling.id), { ...sibling, primary: false, status: "active", updatedAt: row.updatedAt });
    }
  }
  const stored = { ...row, primary: makePrimary, status: makePrimary ? "primary" : "active" };
  context.state.put("recipient_accounts", accountRowId(row.recipientId, row.id), stored);
  return stored;
}

export function accountsCreate(input, context) {
  requireKey(context, true);
  const recipient = recipientOrFail(context, input.recipientId);
  if (recipient.status === "archived") context.fail({ code: "INVALID_STATUS", message: "Recipient is archived" });
  const now = nowIso(context);
  const existing = accountsOf(context, recipient.id);
  const { recipientId, ...payload } = input;
  const stored = attachAccount(context, buildAccount(context, recipient, payload, "", now), existing);
  refreshRecipient(context, recipient, accountsOf(context, recipient.id), now);
  return { ok: true, account: accountOut(stored) };
}

export function accountsList(input, context) {
  requireKey(context, false);
  const recipient = recipientOrFail(context, input.recipientId);
  return { ok: true, accounts: activeAccounts(accountsOf(context, recipient.id)).map(accountOut) };
}

export function accountsGet(input, context) {
  requireKey(context, false);
  recipientOrFail(context, input.recipientId);
  return { ok: true, account: accountOut(accountOrFail(context, input.recipientId, input.accountId)) };
}

export { fieldError };
