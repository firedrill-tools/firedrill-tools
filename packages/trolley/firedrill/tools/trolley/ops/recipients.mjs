// Recipients: create, get, update, delete (archive). Status is derived on every write (lib/serialize.mjs).
import { requireKey } from "../lib/access.mjs";
import { nextId } from "../lib/ids.mjs";
import { accountsOf, assertUnique, hasPendingOpenPayment, recipientOrFail, refreshRecipient } from "../lib/records.mjs";
import { deriveStatus, primaryAccount, recipientOut } from "../lib/serialize.mjs";
import { isDate, nowIso } from "../lib/time.mjs";
import { checkCountry, checkEmail, checkEnum, checkTags, checkText, empty, hasOwn, invalid, optionalText, rejectReservedKeys, requireText } from "../lib/validate.mjs";
import { attachAccount, buildAccount } from "./accounts.mjs";

const ADDRESS_KEYS = ["street1", "street2", "city", "region", "postalCode", "country", "phone"];

function checkAddress(context, value, base) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(context, "address");
  const out = { ...base };
  for (const key of Object.keys(value)) {
    if (!ADDRESS_KEYS.includes(key)) invalid(context, `address.${key}`, "Field is not allowed");
    const entry = value[key];
    if (entry === null || entry === "") out[key] = null;
    else out[key] = key === "country" ? checkCountry(context, entry, "address.country") : checkText(context, entry, `address.${key}`, 200);
  }
  return out;
}

const EMPTY_ADDRESS = { street1: null, street2: null, city: null, region: null, postalCode: null, country: null, phone: null };

/** Optional profile fields shared by create and update, validated into `row`. */
function applyProfile(context, input, row) {
  const referenceId = optionalText(context, input, "referenceId", 100);
  if (referenceId !== undefined) row.referenceId = referenceId === "" ? null : referenceId;
  if (hasOwn(input, "dob")) {
    if (input.dob !== null && input.dob !== "" && !isDate(input.dob)) invalid(context, "dob", "Date of birth must be YYYY-MM-DD");
    row.dob = input.dob === "" ? null : input.dob;
  }
  const phone = optionalText(context, input, "phone", 32);
  if (phone !== undefined) row.phone = phone === "" ? null : phone;
  const language = optionalText(context, input, "language", 10);
  if (language !== undefined) row.language = language === null || language === "" ? "en" : language;
  if (hasOwn(input, "tags")) row.tags = checkTags(context, input.tags);
  if (hasOwn(input, "address")) row.address = checkAddress(context, input.address, row.address);
}

function applyNames(context, input, row) {
  if (row.type === "individual") {
    for (const key of ["firstName", "lastName"]) {
      if (hasOwn(input, key) || row[key] === null) row[key] = requireText(context, { [key]: hasOwn(input, key) ? input[key] : row[key] }, key, 100);
    }
    row.name = hasOwn(input, "name") ? requireText(context, input, "name", 200) : `${row.firstName} ${row.lastName}`;
  } else {
    if (hasOwn(input, "name") || row.name === null) row.name = requireText(context, { name: hasOwn(input, "name") ? input.name : row.name }, "name", 200);
    for (const key of ["firstName", "lastName"]) {
      const value = optionalText(context, input, key, 100);
      if (value !== undefined) row[key] = value === "" ? null : value;
    }
  }
}

export function recipientsCreate(input, context) {
  requireKey(context, true);
  rejectReservedKeys(context, input);
  const type = requireText(context, input, "type", 20);
  checkEnum(context, type, ["individual", "business"], "type");
  const email = checkEmail(context, hasOwn(input, "email") ? input.email : undefined);
  const now = nowIso(context);
  const row = {
    id: "", referenceId: null, email, type, firstName: null, lastName: null, name: null, status: "incomplete",
    complianceStatus: "pending", holdStatus: "none", dob: null, phone: null, language: "en", tags: [],
    address: { ...EMPTY_ADDRESS }, createdAt: now, updatedAt: now,
  };
  applyNames(context, input, row);
  applyProfile(context, input, row);
  if (hasOwn(input, "accounts") && (!Array.isArray(input.accounts) || input.accounts.length > 5)) invalid(context, "accounts");
  assertUnique(context, { email, referenceId: row.referenceId }, null);
  row.id = nextId(context, "R");
  const accounts = [];
  for (const [index, account] of (input.accounts ?? []).entries()) {
    accounts.push(attachAccount(context, buildAccount(context, row, account, `accounts[${index}].`, now), accounts));
  }
  row.status = deriveStatus(row, primaryAccount(accounts) !== null);
  context.state.put("recipients", row.id, row);
  return { ok: true, recipient: recipientOut(context, row, accountsOf(context, row.id)) };
}

export function recipientsGet(input, context) {
  requireKey(context, false);
  const row = recipientOrFail(context, input.recipientId);
  return { ok: true, recipient: recipientOut(context, row, accountsOf(context, row.id)) };
}

export function recipientsUpdate(input, context) {
  requireKey(context, true);
  rejectReservedKeys(context, input);
  const current = recipientOrFail(context, input.recipientId);
  const { recipientId, ...changes } = input;
  if (Object.keys(changes).length === 0) empty(context, "body");
  const now = nowIso(context);
  const row = { ...current, address: { ...EMPTY_ADDRESS, ...current.address }, tags: [...(current.tags ?? [])] };
  if (hasOwn(changes, "type") && changes.type !== current.type) invalid(context, "type", "Recipient type cannot be changed");
  if (hasOwn(changes, "email")) row.email = checkEmail(context, changes.email);
  applyNames(context, changes, row);
  applyProfile(context, changes, row);
  if (hasOwn(changes, "status")) {
    if (current.status !== "archived") context.fail({ code: "INVALID_STATUS", message: "Only an archived recipient can be restored" });
    if (current.holdStatus !== "none") context.fail({ code: "INVALID_STATUS", message: "Recipient is on hold and cannot be restored" });
    row.status = "incomplete";
  }
  if (hasOwn(changes, "email") || hasOwn(changes, "referenceId") || hasOwn(changes, "status")) {
    assertUnique(context, { email: row.email, referenceId: row.referenceId }, row.id);
  }
  const accounts = accountsOf(context, row.id);
  row.status = deriveStatus(row, primaryAccount(accounts) !== null);
  row.updatedAt = now;
  context.state.put("recipients", row.id, row);
  return { ok: true, recipient: recipientOut(context, row, accounts) };
}

export function recipientsDelete(input, context) {
  requireKey(context, true);
  const row = recipientOrFail(context, input.recipientId);
  if (row.status === "archived") return { ok: true };
  if (hasPendingOpenPayment(context, (payment) => payment.recipientId === row.id)) {
    context.fail({ code: "INVALID_STATUS", message: "Recipient has pending payments" });
  }
  context.state.put("recipients", row.id, { ...row, status: "archived", updatedAt: nowIso(context) });
  return { ok: true };
}

export { refreshRecipient };
