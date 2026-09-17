// Contact validation and merge rules shared by contacts.save, contacts.create, contacts.update and invoice saves.
import { drawGuid, fold, hasOwn, own } from "./util.mjs";

const PHONE_TYPES = new Set(["DEFAULT", "DDI", "MOBILE", "FAX"]);
const ADDRESS_TYPES = new Set(["POBOX", "STREET"]);
const ADDRESS_FIELDS = ["AddressLine1", "AddressLine2", "AddressLine3", "AddressLine4", "City", "Region", "PostalCode", "Country", "AttentionTo"];
const PHONE_FIELDS = ["PhoneNumber", "PhoneAreaCode", "PhoneCountryCode"];
const TERM_TYPES = new Set(["DAYSAFTERBILLDATE", "DAYSAFTERBILLMONTH", "OFCURRENTMONTH", "OFFOLLOWINGMONTH"]);
const TEXT_LIMITS = [["FirstName", 255], ["LastName", 255], ["ContactNumber", 50], ["AccountNumber", 50], ["CompanyNumber", 50], ["TaxNumber", 50], ["Website", 500]];

/** Syntactic e-mail check without regular expressions: one @, non-empty local part, dotted domain, no spaces. */
export function validEmail(text) {
  if (text.length > 255 || text.includes(" ")) return false;
  const at = text.indexOf("@");
  if (at <= 0 || at !== text.lastIndexOf("@")) return false;
  const domain = text.slice(at + 1);
  const dot = domain.indexOf(".");
  return dot > 0 && dot < domain.length - 1 && !domain.includes("..");
}

const textOrNull = (value, max, name, errors) => {
  if (value === null) return null;
  if (typeof value !== "string") return errors.push(`${name} must be text`), null;
  if (value.length > max) return errors.push(`${name} must be at most ${max} characters`), null;
  return value.length === 0 ? null : value;
};

function addresses(value, errors) {
  if (!Array.isArray(value) || value.length > 2) return errors.push("Addresses must be a list of at most 2 addresses"), [];
  const seen = new Set();
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || !ADDRESS_TYPES.has(own(entry, "AddressType"))) return errors.push("AddressType must be POBOX or STREET"), [];
    if (seen.has(entry.AddressType)) return errors.push(`Only one ${entry.AddressType} address is allowed`), [];
    seen.add(entry.AddressType);
    const out = { AddressType: entry.AddressType };
    for (const field of ADDRESS_FIELDS) out[field] = hasOwn(entry, field) ? textOrNull(entry[field], 500, field, errors) : null;
    return [out];
  });
}

function phones(value, errors) {
  if (!Array.isArray(value) || value.length > 4) return errors.push("Phones must be a list of at most 4 phones"), [];
  const seen = new Set();
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || !PHONE_TYPES.has(own(entry, "PhoneType"))) return errors.push("PhoneType must be DEFAULT, DDI, MOBILE or FAX"), [];
    if (seen.has(entry.PhoneType)) return errors.push(`Only one ${entry.PhoneType} phone is allowed`), [];
    seen.add(entry.PhoneType);
    const out = { PhoneType: entry.PhoneType };
    for (const field of PHONE_FIELDS) out[field] = hasOwn(entry, field) ? textOrNull(entry[field], 50, field, errors) : null;
    return [out];
  });
}

function terms(value, errors) {
  if (value === null) return null;
  const out = {};
  if (typeof value !== "object" || Array.isArray(value)) return errors.push("PaymentTerms must be an object"), null;
  for (const key of ["Sales", "Bills"]) {
    if (!hasOwn(value, key) || value[key] === null) continue;
    const day = own(value[key], "Day");
    const type = own(value[key], "Type");
    if (!Number.isInteger(day) || day < 0 || day > 365 || !TERM_TYPES.has(type)) {
      errors.push(`PaymentTerms.${key} needs an integer Day and a valid Type`);
      continue;
    }
    out[key] = { Day: day, Type: type };
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Merge a caller element into a stored contact (or a blank one). Returns { value, errors }. Fields absent from the
 * element are kept. Uniqueness of Name is checked against ACTIVE contacts other than this one.
 */
export function mergeContact(s, element, existing) {
  const errors = [];
  const base = existing ?? {
    ContactID: null, ContactNumber: null, AccountNumber: null, ContactStatus: "ACTIVE", Name: "", FirstName: null, LastName: null,
    EmailAddress: null, CompanyNumber: null, TaxNumber: null, AccountsReceivableTaxType: null, AccountsPayableTaxType: null,
    Addresses: [], Phones: [], DefaultCurrency: null, Website: null, PaymentTerms: null, UpdatedDateUTC: s.clock.iso,
  };
  const value = { ...base, UpdatedDateUTC: s.clock.iso };
  if (hasOwn(element, "Name") || existing === null) {
    const name = own(element, "Name");
    if (typeof name !== "string" || name.trim().length === 0) errors.push("Contact name is required");
    else if (name.length > 255) errors.push("Contact name must be at most 255 characters");
    else value.Name = name.trim();
  }
  if (hasOwn(element, "EmailAddress")) {
    const email = element.EmailAddress;
    if (email === null || email === "") value.EmailAddress = null;
    else if (typeof email !== "string" || !validEmail(email)) errors.push("Email address must be valid.");
    else value.EmailAddress = email;
  }
  for (const [field, max] of TEXT_LIMITS) if (hasOwn(element, field)) value[field] = textOrNull(element[field], max, field, errors);
  if (hasOwn(element, "ContactStatus")) {
    const status = element.ContactStatus;
    if (status === "GDPRREQUEST") errors.push("ContactStatus GDPRREQUEST is not supported by this Tool");
    else if (status !== "ACTIVE" && status !== "ARCHIVED") errors.push("ContactStatus must be ACTIVE or ARCHIVED");
    else value.ContactStatus = status;
  }
  for (const field of ["AccountsReceivableTaxType", "AccountsPayableTaxType"]) {
    if (!hasOwn(element, field)) continue;
    const taxType = element[field];
    if (taxType === null || taxType === "") value[field] = null;
    else if (typeof taxType !== "string" || taxType.length > 50 || s.get("tax-rates", taxType) === null) errors.push(`${field} '${String(taxType).slice(0, 50)}' is not a valid tax type`);
    else value[field] = taxType;
  }
  if (hasOwn(element, "Addresses")) value.Addresses = addresses(element.Addresses, errors);
  if (hasOwn(element, "Phones")) value.Phones = phones(element.Phones, errors);
  if (hasOwn(element, "PaymentTerms")) value.PaymentTerms = terms(element.PaymentTerms, errors);
  if (hasOwn(element, "DefaultCurrency") && element.DefaultCurrency !== null && element.DefaultCurrency !== "NZD") errors.push("DefaultCurrency must be NZD (multicurrency is not supported by this Tool)");
  else if (hasOwn(element, "DefaultCurrency")) value.DefaultCurrency = element.DefaultCurrency;
  for (const field of ["ContactGroups", "ContactPersons", "SalesTrackingCategories", "PurchasesTrackingCategories"]) {
    if (Array.isArray(own(element, field)) && element[field].length > 0) errors.push(`${field} are not supported by this Tool`);
  }
  if (errors.length === 0 && value.ContactStatus === "ACTIVE") {
    const folded = fold(value.Name);
    for (const other of s.rows("contacts").values()) {
      if (other.ContactID !== base.ContactID && other.ContactStatus === "ACTIVE" && fold(other.Name) === folded) {
        errors.push("Please enter a unique Name.");
        break;
      }
    }
  }
  return { value, errors };
}

/** Persist a merged contact, drawing a GUID for new ones, and emit contact.changed. */
export function storeContact(s, value, isNew) {
  const stored = isNew ? { ...value, ContactID: drawGuid(s.context) } : value;
  s.put("contacts", stored.ContactID, stored);
  s.emit("contact.changed", "Contacts", stored.ContactID, isNew ? "CREATE" : "UPDATE");
  return stored;
}

/** Element projection for error bodies: caller-supplied name plus the id only when the contact already existed. */
export function contactElement(element, existing) {
  const out = {};
  if (typeof own(element, "Name") === "string") out.Name = element.Name.slice(0, 255);
  if (existing !== null) out.ContactID = existing.ContactID;
  return out;
}
