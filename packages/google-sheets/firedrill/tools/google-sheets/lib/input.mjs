// `valueInputOption` parsing: RAW stores JSON values as they are; USER_ENTERED parses text the way the Sheets UI parses
// typing (en_US): formulas, a leading apostrophe, booleans, numbers, percentages, dollar amounts and dates. Pure.

import { DEFAULT_PATTERNS, serialFromParts } from "./format.mjs";

const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const PERCENT = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s?%$/;
const CURRENCY = /^(-)?\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)$/;
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const DATE_FUNCTION = /^=\s*(NOW|TODAY)\s*\(\s*\)\s*$/i;
const ISO_DATE_TIME = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** Parses a plain en_US number (`-1,234.5`, `.5`, `1e3`); undefined when the text is not one. */
export function parseNumberText(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0 || !/\d/.test(trimmed) || !NUMBER.test(trimmed)) return undefined;
  const value = Number(trimmed.replaceAll(",", ""));
  return Number.isFinite(value) ? value : undefined;
}

/** A JSON cell from a `values` array under RAW: strings stay strings (a leading `=` stays text). */
export function rawCellValue(json) {
  if (typeof json === "number") return { kind: "number", number: json };
  if (typeof json === "boolean") return { kind: "bool", bool: json };
  if (json === "") return null;
  return { kind: "string", string: String(json) };
}

/**
 * USER_ENTERED parsing. Returns `{ value, numberFormat? }` where `value` is the stored value or `null` (clear).
 * `numberFormat` is only a suggestion applied when the cell has no number format yet.
 */
export function parseUserEntered(json) {
  if (typeof json === "number") return { value: { kind: "number", number: json } };
  if (typeof json === "boolean") return { value: { kind: "bool", bool: json } };
  const text = String(json);
  if (text.length === 0) return { value: null };
  if (text.startsWith("=") && text.length > 1) {
    // Like the Sheets UI, a bare =NOW() or =TODAY() gets an automatic date-time or date format.
    const dateFunction = DATE_FUNCTION.exec(text);
    if (dateFunction === null) return { value: { kind: "formula", formula: text } };
    const type = dateFunction[1].toUpperCase() === "NOW" ? "DATE_TIME" : "DATE";
    return { value: { kind: "formula", formula: text }, numberFormat: { type, pattern: DEFAULT_PATTERNS[type] } };
  }
  if (text.startsWith("'")) return { value: text.length === 1 ? null : { kind: "string", string: text.slice(1) } };
  const trimmed = text.trim();
  if (/^(true|false)$/i.test(trimmed)) return { value: { kind: "bool", bool: trimmed.toLowerCase() === "true" } };
  const plain = parseNumberText(trimmed);
  if (plain !== undefined) {
    const grouped = trimmed.includes(",");
    return grouped
      ? { value: { kind: "number", number: plain }, numberFormat: { type: "NUMBER", pattern: trimmed.includes(".") ? "#,##0.00" : "#,##0" } }
      : { value: { kind: "number", number: plain } };
  }
  const percent = PERCENT.exec(trimmed);
  if (percent !== null) {
    const number = Number(percent[1]) / 100;
    return { value: { kind: "number", number }, numberFormat: { type: "PERCENT", pattern: percent[1].includes(".") ? "0.00%" : "0%" } };
  }
  const currency = CURRENCY.exec(trimmed);
  if (currency !== null) {
    const magnitude = Number(currency[2].replaceAll(",", ""));
    return {
      value: { kind: "number", number: currency[1] === "-" ? -magnitude : magnitude },
      numberFormat: { type: "CURRENCY", pattern: currency[2].includes(".") ? '"$"#,##0.00' : '"$"#,##0' },
    };
  }
  let match = ISO_DATE.exec(trimmed);
  if (match !== null) {
    const serial = serialFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
    if (serial !== undefined) return { value: { kind: "number", number: serial }, numberFormat: { type: "DATE", pattern: "yyyy-mm-dd" } };
  }
  match = US_DATE.exec(trimmed);
  if (match !== null) {
    const serial = serialFromParts(Number(match[3]), Number(match[1]), Number(match[2]));
    if (serial !== undefined) return { value: { kind: "number", number: serial }, numberFormat: { type: "DATE", pattern: "M/d/yyyy" } };
  }
  match = ISO_DATE_TIME.exec(trimmed);
  if (match !== null) {
    const serial = serialFromParts(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] ?? 0),
    );
    if (serial !== undefined) {
      return { value: { kind: "number", number: serial }, numberFormat: { type: "DATE_TIME", pattern: "yyyy-mm-dd hh:mm" } };
    }
  }
  return { value: { kind: "string", string: text } };
}
