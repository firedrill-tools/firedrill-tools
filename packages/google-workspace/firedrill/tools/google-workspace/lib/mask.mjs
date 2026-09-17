// People API field masks: `personFields`, `readMask`, `groupFields` and `updatePersonFields`.
import { invalid } from "./errors.mjs";
import { clip, isMangled } from "./util.mjs";

/** Mask entries this Tool can actually populate. */
export const SUPPORTED_PERSON_FIELDS = [
  "addresses", "biographies", "birthdays", "emailAddresses", "memberships", "metadata", "names", "nicknames",
  "organizations", "phoneNumbers", "photos", "urls", "userDefined",
];

/** Valid People fields the Tool stores nothing for: accepted, and they simply return nothing. */
export const EMPTY_PERSON_FIELDS = [
  "ageRanges", "braggingRights", "calendarUrls", "clientData", "coverPhotos", "events", "externalIds", "genders",
  "imClients", "interests", "locales", "locations", "miscKeywords", "occupations", "relations", "sipAddresses", "skills",
];

const ALL_PERSON_FIELDS = new Set([...SUPPORTED_PERSON_FIELDS, ...EMPTY_PERSON_FIELDS]);

/** Fields a caller may name in `updatePersonFields`. */
export const MUTABLE_PERSON_FIELDS = new Set([
  "addresses", "biographies", "birthdays", "emailAddresses", "memberships", "names", "nicknames", "organizations",
  "phoneNumbers", "urls", "userDefined",
]);

export const OTHER_CONTACT_FIELDS = new Set(["emailAddresses", "metadata", "names", "phoneNumbers"]);

export const GROUP_FIELDS = new Set(["clientData", "groupType", "metadata", "name"]);

function splitMask(context, raw, parameterName) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    invalid(context, `Request must specify a non-empty ${parameterName} parameter.`, "MISSING_FIELD_MASK");
  }
  if (isMangled(raw)) invalid(context, `The ${parameterName} parameter contains characters that could not be decoded.`);
  if (raw.length > 2000) invalid(context, `The ${parameterName} parameter is too long.`);
  const entries = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry.length === 0) continue;
    if (entry.length > 60) invalid(context, `Invalid ${parameterName} entry "${clip(entry, 60)}".`);
    entries.push(entry);
  }
  if (entries.length === 0) invalid(context, `Request must specify a non-empty ${parameterName} parameter.`, "MISSING_FIELD_MASK");
  if (entries.length > 40) invalid(context, `The ${parameterName} parameter names too many fields.`);
  return entries;
}

/** Validates a person field mask and returns the set of entries the Tool can populate. */
export function parsePersonFields(context, raw, parameterName = "personFields") {
  const entries = splitMask(context, raw, parameterName);
  const wanted = new Set();
  for (const entry of entries) {
    if (!ALL_PERSON_FIELDS.has(entry)) {
      invalid(
        context,
        `Invalid ${parameterName} mask path: "${clip(entry, 60)}". Valid paths are: ${SUPPORTED_PERSON_FIELDS.join(", ")}.`,
        "INVALID_FIELD_MASK",
      );
    }
    wanted.add(entry);
  }
  return wanted;
}

/** `otherContacts.list` accepts only four mask entries, as the real API does. */
export function parseOtherContactMask(context, raw) {
  const entries = splitMask(context, raw, "readMask");
  const wanted = new Set();
  for (const entry of entries) {
    if (!OTHER_CONTACT_FIELDS.has(entry)) {
      invalid(
        context,
        `Invalid readMask mask path: "${clip(entry, 60)}". Valid paths for otherContacts are: ${[...OTHER_CONTACT_FIELDS].join(", ")}.`,
        "INVALID_FIELD_MASK",
      );
    }
    wanted.add(entry);
  }
  return wanted;
}

/** `groupFields` is optional; an absent value means the default group projection. */
export function parseGroupFields(context, raw) {
  if (raw === undefined || raw === null) return new Set(GROUP_FIELDS);
  const entries = splitMask(context, raw, "groupFields");
  const wanted = new Set();
  for (const entry of entries) {
    if (!GROUP_FIELDS.has(entry)) {
      invalid(context, `Invalid groupFields mask path: "${clip(entry, 60)}". Valid paths are: ${[...GROUP_FIELDS].join(", ")}.`, "INVALID_FIELD_MASK");
    }
    wanted.add(entry);
  }
  return wanted;
}

/** `updatePersonFields` names the fields the write replaces; immutable entries are rejected. */
export function parseUpdateMask(context, raw) {
  const entries = splitMask(context, raw, "updatePersonFields");
  const wanted = new Set();
  for (const entry of entries) {
    if (MUTABLE_PERSON_FIELDS.has(entry)) {
      wanted.add(entry);
      continue;
    }
    if (ALL_PERSON_FIELDS.has(entry)) {
      invalid(context, `Field "${clip(entry, 60)}" cannot be updated; it is read-only on a contact.`, "IMMUTABLE_FIELD");
    }
    invalid(
      context,
      `Invalid updatePersonFields mask path: "${clip(entry, 60)}". Valid paths are: ${[...MUTABLE_PERSON_FIELDS].join(", ")}.`,
      "INVALID_FIELD_MASK",
    );
  }
  return wanted;
}
