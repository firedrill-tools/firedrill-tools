// Validation and normalisation of a Person write body into the stored `contacts` shape.
// Every derived value is checked against the state-schema bound before the row is written.
import { fail, invalid } from "../lib/errors.mjs";
import { clip, daysInMonth, fold, isMangled } from "../lib/util.mjs";

export const LIMITS = {
  names: 1, nicknames: 3, emailAddresses: 10, phoneNumbers: 10, organizations: 3, addresses: 3, urls: 5,
  userDefined: 10, memberships: 16, biography: 4000, sortName: 240, searchText: 1200,
};

const READ_ONLY = ["resourceName", "etag", "metadata", "photos", "coverPhotos", "ageRanges", "fileAses"];

const str = (context, value, field, max) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") invalid(context, `Field "${field}" must be a string.`);
  if (isMangled(value)) invalid(context, `Field "${field}" contains characters that could not be decoded.`);
  if (value.length > max) invalid(context, `Field "${field}" is longer than ${max} characters.`);
  return value;
};

const arrayOf = (context, value, field, max) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(context, `Field "${field}" must be an array.`);
  if (value.length > max) invalid(context, `Field "${field}" accepts at most ${max} entries, got ${value.length}.`);
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) invalid(context, `Each entry of "${field}" must be an object.`);
  }
  return value;
};

/** Rejects the fields the API never accepts on a write. */
export function rejectReadOnly(context, person) {
  for (const field of READ_ONLY) {
    if (person[field] !== undefined) invalid(context, `Field "${field}" is output only and cannot be set.`, "READ_ONLY_FIELD");
  }
}

const PHONE_RE = /^[0-9+().\-\s]{1,40}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

export function buildNames(context, raw) {
  const entries = arrayOf(context, raw, "names", LIMITS.names);
  return entries.map((entry) => {
    const givenName = str(context, entry.givenName, "names.givenName", 120);
    const familyName = str(context, entry.familyName, "names.familyName", 120);
    const middleName = str(context, entry.middleName, "names.middleName", 120);
    const unstructured = str(context, entry.unstructuredName, "names.unstructuredName", 120);
    const parts = [givenName, middleName, familyName].filter((part) => part !== null && part.length > 0);
    const displayName = str(context, entry.displayName, "names.displayName", 120) ?? unstructured ?? parts.join(" ");
    if (displayName.length === 0) invalid(context, "A name entry must carry at least a givenName, familyName or unstructuredName.");
    return {
      givenName: givenName ?? "",
      familyName: familyName ?? "",
      middleName,
      displayName: displayName.slice(0, 120),
      unstructuredName: (unstructured ?? parts.join(" ") ?? displayName).slice(0, 120),
    };
  });
}

export function buildNicknames(context, raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) invalid(context, 'Field "nicknames" must be an array.');
  if (raw.length > LIMITS.nicknames) invalid(context, `Field "nicknames" accepts at most ${LIMITS.nicknames} entries.`);
  return raw.map((entry) => {
    const value = typeof entry === "string" ? entry : entry === null || typeof entry !== "object" ? null : entry.value;
    const text = str(context, value, "nicknames.value", 80);
    if (text === null || text.length === 0) invalid(context, 'Each entry of "nicknames" needs a non-empty value.');
    return text;
  });
}

const TYPES = new Set(["home", "work", "other", "mobile", "main", "homeFax", "workFax", "blog", "profile", "ftp", "reserved"]);
const typeOf = (context, value, field, fallback) => {
  const text = str(context, value, field, 40);
  if (text === null || text.length === 0) return fallback;
  if (!TYPES.has(text)) invalid(context, `Invalid ${field} "${clip(text, 40)}".`);
  return text;
};

export function buildEmails(context, raw) {
  const entries = arrayOf(context, raw, "emailAddresses", LIMITS.emailAddresses);
  return entries.map((entry, index) => {
    const value = str(context, entry.value, "emailAddresses.value", 254);
    if (value === null || !EMAIL_RE.test(value)) invalid(context, `Invalid e-mail address "${clip(String(entry.value ?? ""), 60)}".`);
    return {
      value,
      type: typeOf(context, entry.type, "emailAddresses.type", "other"),
      displayName: str(context, entry.displayName, "emailAddresses.displayName", 120),
      primary: entry.metadata?.primary === true || index === 0,
    };
  });
}

export function buildPhones(context, raw) {
  const entries = arrayOf(context, raw, "phoneNumbers", LIMITS.phoneNumbers);
  return entries.map((entry, index) => {
    const value = str(context, entry.value, "phoneNumbers.value", 40);
    if (value === null || value.trim().length === 0 || !PHONE_RE.test(value)) {
      invalid(context, `Invalid phone number "${clip(String(entry.value ?? ""), 40)}".`);
    }
    const digits = value.replace(/[^0-9+]/g, "");
    return {
      value,
      canonicalForm: digits.startsWith("+") ? digits.slice(0, 40) : `+1${digits}`.slice(0, 40),
      type: typeOf(context, entry.type, "phoneNumbers.type", "mobile"),
      primary: entry.metadata?.primary === true || index === 0,
    };
  });
}

export function buildOrganizations(context, raw) {
  const entries = arrayOf(context, raw, "organizations", LIMITS.organizations);
  return entries.map((entry, index) => {
    const name = str(context, entry.name, "organizations.name", 120);
    if (name === null || name.length === 0) invalid(context, 'Each entry of "organizations" needs a name.');
    return {
      name,
      title: str(context, entry.title, "organizations.title", 120),
      department: str(context, entry.department, "organizations.department", 120),
      current: entry.current === true || index === 0,
    };
  });
}

export function buildAddresses(context, raw) {
  const entries = arrayOf(context, raw, "addresses", LIMITS.addresses);
  return entries.map((entry) => {
    const parts = [entry.streetAddress, entry.city, entry.region, entry.postalCode, entry.country]
      .filter((part) => typeof part === "string" && part.length > 0);
    const formatted = str(context, entry.formattedValue, "addresses.formattedValue", 300) ?? parts.join(", ");
    if (formatted.length === 0) invalid(context, 'Each entry of "addresses" needs a formattedValue or its components.');
    if (formatted.length > 300) invalid(context, 'Field "addresses.formattedValue" is longer than 300 characters.');
    return {
      formattedValue: formatted,
      type: typeOf(context, entry.type, "addresses.type", "home"),
      city: str(context, entry.city, "addresses.city", 120),
      region: str(context, entry.region, "addresses.region", 120),
      postalCode: str(context, entry.postalCode, "addresses.postalCode", 20),
      country: str(context, entry.country, "addresses.country", 120),
    };
  });
}

export function buildBiography(context, raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) invalid(context, 'Field "biographies" must be an array.');
  if (raw.length === 0) return null;
  if (raw.length > 1) invalid(context, 'Field "biographies" accepts at most one entry.');
  const entry = raw[0];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) invalid(context, 'Each entry of "biographies" must be an object.');
  return str(context, entry.value, "biographies.value", LIMITS.biography);
}

export function buildBirthday(context, raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) invalid(context, 'Field "birthdays" must be an array.');
  if (raw.length === 0) return null;
  if (raw.length > 1) invalid(context, 'Field "birthdays" accepts at most one entry.');
  const date = raw[0]?.date;
  if (date === null || date === undefined || typeof date !== "object" || Array.isArray(date)) {
    invalid(context, 'Field "birthdays[0].date" is required.');
  }
  const month = date.month;
  const day = date.day;
  if (!Number.isInteger(month) || month < 1 || month > 12) invalid(context, "A birthday needs a month between 1 and 12.");
  if (!Number.isInteger(day) || day < 1 || day > 31) invalid(context, "A birthday needs a day between 1 and 31.");
  const out = { month, day };
  if (date.year !== undefined && date.year !== null) {
    if (!Number.isInteger(date.year) || date.year < 1900 || date.year > 2100) invalid(context, "A birthday year must be between 1900 and 2100.");
    out.year = date.year;
  }
  // Without a year, February 29 is allowed (a leap-day birthday); with one, the day must exist in that month.
  const maxDay = out.year === undefined ? daysInMonth(2000, month) : daysInMonth(out.year, month);
  if (day > maxDay) {
    invalid(context, `A birthday of ${out.year === undefined ? "" : `${out.year}-`}${month}-${day} is not a valid calendar date.`);
  }
  return out;
}

/** Simulation bound: a contact belongs to at most this many contact groups (including myContacts). */
export const MAX_MEMBERSHIPS = LIMITS.memberships;

/** Fails INVALID_ARGUMENT before any write when `memberships` would exceed the per-contact bound. */
export function checkMembershipBound(context, memberships, resourceNames = []) {
  if (memberships.length <= MAX_MEMBERSHIPS) return;
  const named = resourceNames.length === 0 ? "This contact" : resourceNames.slice(0, 5).join(", ");
  fail(
    context,
    "INVALID_ARGUMENT",
    `A contact can belong to at most ${MAX_MEMBERSHIPS} contact groups in this simulation; ${named} would exceed that bound.`,
    "MEMBERSHIP_LIMIT_EXCEEDED",
    { limit: String(MAX_MEMBERSHIPS) },
  );
}

export function buildUrls(context, raw) {
  const entries = arrayOf(context, raw, "urls", LIMITS.urls);
  return entries.map((entry) => {
    const value = str(context, entry.value, "urls.value", 500);
    if (value === null || value.length === 0) invalid(context, 'Each entry of "urls" needs a value.');
    return { value, type: typeOf(context, entry.type, "urls.type", "profile") };
  });
}

export function buildUserDefined(context, raw) {
  const entries = arrayOf(context, raw, "userDefined", LIMITS.userDefined);
  return entries.map((entry) => {
    const key = str(context, entry.key, "userDefined.key", 80);
    const value = str(context, entry.value, "userDefined.value", 300);
    if (key === null || key.length === 0) invalid(context, 'Each entry of "userDefined" needs a key.');
    return { key, value: value ?? "" };
  });
}

/** Group ids named by `memberships`; the caller's groups are validated by the handler. */
export function buildMemberships(context, raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) invalid(context, 'Field "memberships" must be an array.');
  if (raw.length > LIMITS.memberships) invalid(context, `Field "memberships" accepts at most ${LIMITS.memberships} entries.`);
  const out = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) invalid(context, 'Each entry of "memberships" must be an object.');
    const membership = entry.contactGroupMembership;
    if (membership === null || membership === undefined || typeof membership !== "object" || Array.isArray(membership)) {
      invalid(context, "Only contactGroupMembership entries are supported.");
    }
    let id = membership.contactGroupId;
    if (id === undefined && typeof membership.contactGroupResourceName === "string") {
      const name = membership.contactGroupResourceName;
      if (!name.startsWith("contactGroups/")) invalid(context, `Invalid contactGroupResourceName "${clip(name, 80)}".`);
      id = name.slice("contactGroups/".length);
    }
    if (typeof id !== "string" || id.length === 0 || id.length > 64) invalid(context, "A membership needs a contactGroupId.");
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Recomputes the derived sort and search text, checking the state-schema bounds before the write. */
export function deriveIndexes(context, contact) {
  const name = contact.names[0];
  const display = name?.displayName ?? contact.emailAddresses[0]?.value ?? contact.phoneNumbers[0]?.value ?? "";
  const sortName = fold(name?.familyName ? `${name.familyName} ${name.givenName ?? ""}`.trim() : display);
  if (sortName.length > LIMITS.sortName) invalid(context, "The derived sort name is longer than the supported bound of 240 characters.");
  const tokens = [];
  const push = (value) => {
    if (typeof value === "string" && value.length > 0) tokens.push(fold(value));
  };
  for (const entry of contact.names) {
    push(entry.displayName);
    push(entry.givenName);
    push(entry.familyName);
    push(entry.middleName);
  }
  for (const nickname of contact.nicknames) push(nickname);
  for (const email of contact.emailAddresses) push(email.value);
  for (const phone of contact.phoneNumbers) {
    push(phone.value.replace(/[^0-9+]/g, ""));
    push(phone.canonicalForm);
  }
  for (const org of contact.organizations) {
    push(org.name);
    push(org.title);
    push(org.department);
  }
  const searchText = [...new Set(tokens)].join(" ");
  if (searchText.length > LIMITS.searchText) {
    invalid(context, "The derived search text is longer than the supported bound of 1200 characters; shorten the contact's fields.");
  }
  return { sortName, searchText, displayName: display.length > 0 ? display.slice(0, 240) : null };
}
