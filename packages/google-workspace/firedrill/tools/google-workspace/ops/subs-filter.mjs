// The Workspace Events list filter language: a small AND-only grammar over two fields.
//   event_types:"<type>" AND target_resource="//chat.googleapis.com/spaces/AAQA"
import { invalid } from "../lib/errors.mjs";
import { clip, isMangled } from "../lib/util.mjs";

const MAX_CLAUSES = 8;
const FIELDS = new Set(["event_types", "target_resource"]);

/**
 * Parses the filter into clauses. Tokenising is a single linear pass; no caller text reaches a RegExp.
 * Returns `[{ field, operator, value }]`.
 */
export function parseFilter(context, raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    invalid(context, "Request must specify a filter, for example: event_types:\"google.workspace.chat.message.v1.created\".", "MISSING_FILTER");
  }
  if (isMangled(raw)) invalid(context, "The filter contains characters that could not be decoded.", "INVALID_FILTER");
  if (raw.length > 1024) invalid(context, "The filter is longer than 1024 characters.", "INVALID_FILTER");

  const clauses = [];
  let index = 0;
  const text = raw;
  const skipSpace = () => {
    while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1;
  };

  for (;;) {
    skipSpace();
    if (index >= text.length) break;
    if (clauses.length >= MAX_CLAUSES) invalid(context, `The filter accepts at most ${MAX_CLAUSES} clauses.`, "INVALID_FILTER");

    const fieldStart = index;
    while (index < text.length && /[a-z_]/.test(text[index])) index += 1;
    const field = text.slice(fieldStart, index);
    if (!FIELDS.has(field)) {
      invalid(context, `Unsupported filter field "${clip(field.length === 0 ? text.slice(fieldStart, fieldStart + 20) : field, 60)}". Supported fields: event_types, target_resource.`, "INVALID_FILTER");
    }
    skipSpace();
    const operator = text[index];
    if (operator !== ":" && operator !== "=") {
      invalid(context, `Unsupported operator in filter near "${clip(text.slice(index, index + 20), 40)}"; use ":" or "=".`, "INVALID_FILTER");
    }
    index += 1;
    skipSpace();

    let value;
    if (text[index] === '"') {
      index += 1;
      const start = index;
      while (index < text.length && text[index] !== '"') index += 1;
      if (index >= text.length) invalid(context, "The filter has an unbalanced quote.", "INVALID_FILTER");
      value = text.slice(start, index);
      index += 1;
    } else {
      const start = index;
      while (index < text.length && text[index] !== " " && text[index] !== "\t") index += 1;
      value = text.slice(start, index);
    }
    if (value.length === 0) invalid(context, `The filter clause for "${field}" has an empty value.`, "INVALID_FILTER");
    if (value.length > 300) invalid(context, `The filter clause for "${field}" has a value longer than 300 characters.`, "INVALID_FILTER");
    if (field === "target_resource" && operator !== "=") {
      invalid(context, 'The "target_resource" filter supports only the "=" operator.', "INVALID_FILTER");
    }
    clauses.push({ field, operator, value });

    skipSpace();
    if (index >= text.length) break;
    const nextStart = index;
    while (index < text.length && /[A-Za-z]/.test(text[index])) index += 1;
    const keyword = text.slice(nextStart, index);
    if (keyword !== "AND") {
      invalid(context, `Expected "AND" in the filter near "${clip(text.slice(nextStart, nextStart + 20), 40)}".`, "INVALID_FILTER");
    }
  }

  if (clauses.length === 0) invalid(context, "Request must specify a non-empty filter.", "MISSING_FILTER");
  return clauses;
}

/** Applies the parsed clauses to a stored subscription row. */
export function matchesFilter(row, clauses) {
  for (const clause of clauses) {
    if (clause.field === "target_resource") {
      if (row.targetResource !== clause.value) return false;
    } else if (!row.eventTypes.includes(clause.value)) return false;
  }
  return true;
}
