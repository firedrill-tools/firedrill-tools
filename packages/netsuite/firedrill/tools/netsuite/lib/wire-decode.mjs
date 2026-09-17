// Pure decoder helpers. Every property access is guarded, JSON bodies are depth-checked with an explicit stack,
// and reserved property names are reported to the handler so the NetSuite envelope survives.
const MAX_DEPTH = 512;
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

export function firstQuery(request, name) {
  const values = Object.hasOwn(request.query, name) ? request.query[name] : undefined;
  return Array.isArray(values) && values.length > 0 ? values[0] : undefined;
}

export function firstHeader(request, name) {
  const values = Object.hasOwn(request.headers, name) ? request.headers[name] : undefined;
  return Array.isArray(values) && values.length > 0 ? values[0] : undefined;
}

export function pathValue(request, name) {
  return Object.hasOwn(request.path, name) ? request.path[name] : undefined;
}

/** Decode one path segment; a mangled percent-encoding is returned unchanged so the handler can reject it. */
export function decodeSegment(value) {
  if (typeof value !== "string") return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const list = (value) => (typeof value === "string" && value.length > 0
  ? value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  : undefined);

/** Query parameters shared by the read routes. */
export function readArguments(request) {
  const args = {};
  for (const name of ["q", "limit", "offset", "expandSubResources", "simpleEnumFormat"]) {
    const value = firstQuery(request, name);
    if (value !== undefined) args[name] = value;
  }
  const fields = list(firstQuery(request, "fields"));
  if (fields !== undefined) args.fields = fields;
  return args;
}

/** Headers shared by the write routes. */
export function writeArguments(request) {
  const args = {};
  const key = firstHeader(request, "x-netsuite-idempotency-key");
  if (key !== undefined) args.idempotencyKeyHeader = key;
  const validation = firstHeader(request, "x-netsuite-propertynamevalidation");
  if (validation === "ignore" || validation === "warning" || validation === "error") {
    args.propertyNameValidation = validation;
  }
  const ifMatch = firstHeader(request, "if-match");
  if (ifMatch !== undefined) args.ifMatchVersion = ifMatch;
  const replace = list(firstQuery(request, "replace"));
  if (replace !== undefined) args.replace = replace;
  return args;
}

/** Depth and reserved-name check over a decoded JSON value, with an explicit stack. */
function inspect(value) {
  const stack = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry.depth > MAX_DEPTH) return "depth";
    const node = entry.node;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (typeof child === "object" && child !== null) stack.push({ node: child, depth: entry.depth + 1 });
      }
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    for (const key of Object.keys(node)) {
      if (UNSAFE.has(key)) return "prototype";
      const child = node[key];
      if (typeof child === "object" && child !== null) stack.push({ node: child, depth: entry.depth + 1 });
    }
  }
  return null;
}

/**
 * Decode a JSON request body. `body` is always present so the operation's strict input schema is satisfied;
 * a shape problem travels as `bodyError`, which the handler turns into INVALID_REQUEST with NetSuite's envelope.
 */
export function bodyArguments(request, { optional = true } = {}) {
  const body = request.body;
  if (body === undefined || body.kind === "none") {
    return optional ? { body: {} } : { body: {}, bodyError: "not-json" };
  }
  if (body.kind !== "json") return { body: {}, bodyError: "not-json" };
  const value = body.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { body: {}, bodyError: "not-json" };
  }
  const problem = inspect(value);
  if (problem !== null) return { body: {}, bodyError: problem };
  return { body: value };
}

export const ACCOUNT_CONTENT_TYPE = "application/vnd.oracle.resource+json; type=singular";
export const COLLECTION_CONTENT_TYPE = "application/vnd.oracle.resource+json; type=collection";
export const ERROR_CONTENT_TYPE = "application/vnd.oracle.resource+json; type=error";
export const SCHEMA_CONTENT_TYPE = "application/schema+json";
