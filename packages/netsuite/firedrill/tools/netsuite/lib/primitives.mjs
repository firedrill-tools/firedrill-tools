// Deterministic primitives: internal ids, money, account-local dates and safe caller-key maps.
import { fail } from "./errors.mjs";

const ID_PATTERN = /^[1-9][0-9]{0,14}$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const isInternalId = (value) => typeof value === "string" && ID_PATTERN.test(value);
export const isUnsafeKey = (key) => UNSAFE_KEYS.has(key);

/** A prototype-free map built from caller-chosen keys. */
export function safeMap(entries) {
  const map = new Map();
  for (const [key, value] of entries) map.set(key, value);
  return map;
}

/** Validate a caller-supplied path id before any state lookup. */
export function requireId(context, value, label = "id") {
  if (!isInternalId(value)) {
    fail(context, "INVALID_ID", `Invalid value for the ${label} parameter. A NetSuite internal id is a positive integer.`);
  }
  return value;
}

export const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
export const round4 = (value) => Math.round((value + Number.EPSILON) * 10000) / 10000;
export const cents = (value) => Math.round(value * 100);
export const fromCents = (value) => round2(value / 100);

const DAY_MS = 86400000;
const pad = (value, width) => String(value).padStart(width, "0");

/** Days since the Unix epoch for an account-local civil date. */
export function dayNumber(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function civilFromDay(days) {
  const date = new Date(days * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Account-local ISO date (YYYY-MM-DD) for a virtual-time microsecond value at a fixed UTC offset. */
export function accountDate(nowUs, offsetMinutes) {
  const localMs = Math.floor(nowUs / 1000) + offsetMinutes * 60000;
  const date = new Date(localMs);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

/** ISO-8601 UTC timestamp with a trailing Z, truncated to whole seconds. */
export function timestamp(nowUs) {
  const date = new Date(Math.floor(nowUs / 1000000) * 1000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}Z`;
}

const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const US_DATE = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/;

/** Parse an account-local date literal (YYYY-MM-DD or M/D/YYYY). Returns null when unparsable. */
export function parseDate(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  let year;
  let month;
  let day;
  const iso = ISO_DATE.exec(text);
  if (iso !== null) {
    year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]);
  } else {
    const us = US_DATE.exec(text);
    if (us === null) return null;
    month = Number(us[1]); day = Number(us[2]); year = Number(us[3]);
  }
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2999) return null;
  const civil = civilFromDay(dayNumber(year, month, day));
  if (civil.year !== year || civil.month !== month || civil.day !== day) return null;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

export const dateToDays = (iso) => {
  const parts = ISO_DATE.exec(iso);
  return parts === null ? null : dayNumber(Number(parts[1]), Number(parts[2]), Number(parts[3]));
};

export function addDays(iso, days) {
  const base = dateToDays(iso);
  if (base === null) return iso;
  const civil = civilFromDay(base + days);
  return `${pad(civil.year, 4)}-${pad(civil.month, 2)}-${pad(civil.day, 2)}`;
}

/** UTF-8 byte length of a string, computed from its code points (no Buffer in behavior modules). */
export function utf8Length(text) {
  let total = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x80) total += 1;
    else if (code < 0x800) total += 2;
    else if (code < 0x10000) total += 3;
    else total += 4;
  }
  return total;
}

export const jsonBytes = (value) => utf8Length(JSON.stringify(value));
