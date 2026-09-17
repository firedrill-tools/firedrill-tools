// Wire-body validation for the write operations: typed field readers that raise NetSuite's INVALID_CONTENT,
// INVALID_KEY_OR_REF and INVALID_REQUEST rather than any incidental JavaScript message.
import { quote } from "./errors.mjs";
import { isInternalId, isUnsafeKey, parseDate, round4 } from "./primitives.mjs";

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Turn a decoder's body-shape flag into the documented INVALID_REQUEST failure. */
export function checkBodyError(session, input) {
  if (input.bodyError === undefined) return;
  const reasons = {
    depth: "The request body nests deeper than the supported maximum of 512 levels.",
    prototype: "The request body carries a reserved property name (__proto__, constructor or prototype).",
    "not-json": "The request body could not be parsed as JSON.",
  };
  session.fail("INVALID_REQUEST", reasons[input.bodyError] ?? reasons["not-json"]);
}

export function requestBody(session, input) {
  checkBodyError(session, input);
  const body = input.body;
  if (body === undefined) return {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    session.fail("INVALID_CONTENT", "The request body must be a JSON object.");
  }
  for (const key of Object.keys(body)) {
    if (isUnsafeKey(key)) {
      session.fail("INVALID_REQUEST", "The request body carries a reserved property name.");
    }
  }
  return body;
}

export function idempotencyKey(session, input) {
  const key = input.idempotencyKeyHeader;
  if (key === undefined) return;
  if (typeof key !== "string" || !UUID.test(key)) {
    session.fail("INVALID_PARAMETER", "The X-NetSuite-Idempotency-Key header must be an RFC 4122 UUID.", {
      errorHeader: "X-NetSuite-Idempotency-Key",
    });
  }
}

/** `propertyNameValidation: error` rejects any body property the record does not define. */
export function checkPropertyNames(session, input, body, known, prefix = "") {
  const mode = input.propertyNameValidation ?? "warning";
  if (mode !== "error") return;
  for (const key of Object.keys(body)) {
    if (!known.has(key)) {
      session.fail("INVALID_CONTENT", `Unknown property ${quote(`${prefix}${key}`)} for this record type.`, {
        errorPath: `${prefix}${key}`,
      });
    }
  }
}

export function checkVersion(session, input, row) {
  if (input.ifMatchVersion === undefined) return;
  const claimed = String(input.ifMatchVersion).replaceAll('"', "").replace(/^W\//, "");
  if (claimed !== String(row.version)) {
    session.fail(
      "RCRD_HAS_BEEN_CHANGED",
      "Record has been changed. Please refresh the record and try again.",
    );
  }
}

export function field(session, body, name, prefix = "") {
  return Object.hasOwn(body, name) ? body[name] : undefined;
}

export function stringField(session, body, name, maxLength, prefix = "") {
  const value = field(session, body, name);
  if (value === undefined || value === null) return value === null ? null : undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    session.fail("INVALID_CONTENT", `Invalid value for ${quote(`${prefix}${name}`)}. Expected a string of at most ${maxLength} characters.`, {
      errorPath: `${prefix}${name}`,
    });
  }
  return value;
}

export function numberField(session, body, name, { min = -1e12, max = 1e12, prefix = "" } = {}) {
  const value = field(session, body, name);
  if (value === undefined || value === null) return value === null ? null : undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    session.fail("INVALID_CONTENT", `Invalid value for ${quote(`${prefix}${name}`)}. Expected a number between ${min} and ${max}.`, {
      errorPath: `${prefix}${name}`,
    });
  }
  return round4(value);
}

export function booleanField(session, body, name, prefix = "") {
  const value = field(session, body, name);
  if (value === undefined || value === null) return value === null ? null : undefined;
  if (typeof value !== "boolean") {
    session.fail("INVALID_CONTENT", `Invalid value for ${quote(`${prefix}${name}`)}. Expected true or false.`, {
      errorPath: `${prefix}${name}`,
    });
  }
  return value;
}

export function dateField(session, body, name, prefix = "") {
  const value = field(session, body, name);
  if (value === undefined || value === null) return value === null ? null : undefined;
  if (typeof value !== "string") {
    session.fail("INVALID_CONTENT", `Invalid value for ${quote(`${prefix}${name}`)}. Expected a date.`, { errorPath: `${prefix}${name}` });
  }
  const parsed = parseDate(value);
  if (parsed === null) {
    session.fail("INVALID_CONTENT", `Invalid value ${quote(value)} for ${quote(`${prefix}${name}`)}. Expected M/D/YYYY or YYYY-MM-DD.`, {
      errorPath: `${prefix}${name}`,
    });
  }
  return parsed;
}

/** Read a `{ id }` reference; the id must be syntactically valid before any state lookup. */
export function referenceField(session, body, name, prefix = "") {
  const value = field(session, body, name);
  if (value === undefined || value === null) return value === null ? null : undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    session.fail("INVALID_CONTENT", `Invalid value for ${quote(`${prefix}${name}`)}. Expected an object carrying an id.`, {
      errorPath: `${prefix}${name}`,
    });
  }
  const id = Object.hasOwn(value, "id") ? value.id : undefined;
  if (id === undefined) {
    session.fail("INVALID_KEY_OR_REF", `The reference ${quote(`${prefix}${name}`)} must carry an id.`, { errorPath: `${prefix}${name}` });
  }
  const text = typeof id === "number" && Number.isSafeInteger(id) ? String(id) : id;
  if (!isInternalId(text)) {
    session.fail("INVALID_KEY_OR_REF", `Invalid reference key ${quote(String(id))} for ${quote(`${prefix}${name}`)}.`, {
      errorPath: `${prefix}${name}`,
    });
  }
  return text;
}

/** Read `item.items` (or `apply.items`) as a bounded array of objects. */
export function sublistItems(session, body, name, maxItems, prefix = "") {
  const container = field(session, body, name);
  if (container === undefined || container === null) return undefined;
  if (typeof container !== "object" || Array.isArray(container)) {
    session.fail("INVALID_CONTENT", `Invalid value for ${quote(`${prefix}${name}`)}. Expected an object carrying items.`, {
      errorPath: `${prefix}${name}`,
    });
  }
  const items = Object.hasOwn(container, "items") ? container.items : undefined;
  if (items === undefined) return [];
  if (!Array.isArray(items) || items.length > maxItems) {
    session.fail("INVALID_CONTENT", `Invalid value for ${quote(`${prefix}${name}.items`)}. Expected at most ${maxItems} entries.`, {
      errorPath: `${prefix}${name}.items`,
    });
  }
  for (const [index, entry] of items.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      session.fail("INVALID_CONTENT", `Invalid entry at ${quote(`${prefix}${name}.items[${index}]`)}. Expected an object.`, {
        errorPath: `${prefix}${name}.items[${index}]`,
      });
    }
    for (const key of Object.keys(entry)) {
      if (isUnsafeKey(key)) session.fail("INVALID_REQUEST", "The request body carries a reserved property name.");
    }
  }
  return items;
}

/** Bounded list of field names for the `replace` parameter. */
export function replaceList(session, input, allowed) {
  if (input.replace === undefined) return new Set();
  if (!Array.isArray(input.replace)) {
    session.fail("INVALID_PARAMETER", "The replace parameter must be a comma-separated list of field names.", { errorQueryParam: "replace" });
  }
  const names = new Set();
  for (const name of input.replace) {
    if (typeof name !== "string" || !allowed.has(name)) {
      session.fail("INVALID_PARAMETER", `Field ${quote(String(name))} cannot be replaced on this record.`, { errorQueryParam: "replace" });
    }
    names.add(name);
  }
  return names;
}
