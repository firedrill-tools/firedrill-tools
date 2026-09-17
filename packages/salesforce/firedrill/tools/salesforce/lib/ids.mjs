// Salesforce-shaped record ids: 3-character key prefix + `Fd0` + 9-digit record number (15
// characters, case-sensitive) + the 3-character case-safe suffix computed with Salesforce's real
// algorithm. The record number comes from the `meta/counters` row; nothing here is random.

import { KEY_PREFIXES, typeByPrefix } from "./schema.mjs";

const SUFFIX_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
const ID_15 = /^[a-zA-Z0-9]{15}$/;
const ID_18 = /^[a-zA-Z0-9]{18}$/;

/** The case-safe suffix of a 15-character id (per 5-character chunk, bit i set when char i is upper-case). */
export function caseSafeSuffix(id15) {
  let suffix = "";
  for (let chunk = 0; chunk < 3; chunk += 1) {
    let bits = 0;
    for (let index = 0; index < 5; index += 1) {
      const char = id15[chunk * 5 + index];
      if (char >= "A" && char <= "Z") bits |= 1 << index;
    }
    suffix += SUFFIX_ALPHABET[bits];
  }
  return suffix;
}

/** True when `value` has the shape of a Salesforce id (15 or 18 alphanumerics). */
export function isWellFormedId(value) {
  return typeof value === "string" && (ID_15.test(value) || ID_18.test(value));
}

/**
 * 15- or 18-character id → canonical 18-character id. A 15-character id is case-sensitive and gets
 * its suffix computed. An 18-character id is case-insensitive as in Salesforce: the suffix (any
 * case) re-cases the first 15 characters, and a suffix that is not a valid checksum for them (a
 * character outside the suffix alphabet, or a case bit set on a digit) is MALFORMED (returns null).
 */
export function normalizeId(value) {
  if (!isWellFormedId(value)) return null;
  if (value.length === 15) return `${value}${caseSafeSuffix(value)}`;
  const suffix = value.slice(15).toUpperCase();
  let base = "";
  for (let chunk = 0; chunk < 3; chunk += 1) {
    const bits = SUFFIX_ALPHABET.indexOf(suffix[chunk]);
    if (bits < 0) return null;
    for (let index = 0; index < 5; index += 1) {
      const char = value[chunk * 5 + index];
      base += (bits & (1 << index)) !== 0 ? char.toUpperCase() : char.toLowerCase();
    }
  }
  if (caseSafeSuffix(base) !== suffix) return null;
  return `${base}${suffix}`;
}

export function prefixOf(id) {
  return id.slice(0, 3);
}

/** The sObject type a well-formed id belongs to, by key prefix (null for unknown prefixes). */
export function typeOfId(id) {
  return typeByPrefix(prefixOf(id));
}

/** Mint the id for record number `n` of `type` (n < 10^9). */
export function mintId(type, recordNumber) {
  const prefix = KEY_PREFIXES[type];
  const body = String(recordNumber).padStart(9, "0");
  const base = `${prefix}Fd0${body}`;
  return `${base}${caseSafeSuffix(base)}`;
}
