// Pure HTTP wire helpers: JSON bodies pass through after guarding, query parameters map to arguments, and every
// error renders Waterfall's envelope `{ status: "error", message, error: [detail…], category, code }`.
// No state, no clock. HTTP statuses are declared per route in the manifest.

const CATEGORIES = ["VALIDATION", "AUTH", "PERMISSION", "QUOTA", "NOT_FOUND", "RATE_LIMIT", "INTERNAL", "ROUTING"];
const RATE_LIMIT_HEADERS = { "x-ratelimit-limit": "50", "x-ratelimit-remaining": "0", "x-ratelimit-interval": "60", "retry-after": "12" };

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON object body → arguments (own keys copied onto a fresh object). A missing body, or one that is not a JSON
 * object, becomes `{ missing_body: true }` so the handler answers VALIDATION_MISSING_BODY in the provider envelope.
 */
export function jsonArguments(request) {
  const body = request?.body;
  if (!isPlainObject(body) || body.kind !== "json" || !isPlainObject(body.value)) return { arguments: { missing_body: true } };
  if (hasForbiddenKey(body.value)) return { arguments: { body_has_forbidden_key: true } };
  const args = {};
  for (const key of Object.keys(body.value)) args[key] = body.value[key];
  return { arguments: args };
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * True when any object in the body (walked iteratively) has an own key that would poison a plain object
 * (`__proto__`, `constructor`, `prototype`). Such a body maps to an undeclared marker argument, so the framework's
 * strict input validation answers 400 and the codec renders VALIDATION_BAD_REQUEST.
 */
export function hasForbiddenKey(value) {
  const stack = [value];
  let visited = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    visited += 1;
    if (visited > 100000) return true;
    if (Array.isArray(node)) {
      for (const item of node) if (item !== null && typeof item === "object") stack.push(item);
      continue;
    }
    for (const key of Object.keys(node)) {
      if (FORBIDDEN_KEYS.has(key)) return true;
      const child = node[key];
      if (child !== null && typeof child === "object") stack.push(child);
    }
  }
  return false;
}

/**
 * Query parameters → arguments. A parameter given once maps to its value; one repeated maps to the values joined with
 * a comma (the handler reports it as malformed); an absent parameter is left out.
 */
export function queryArguments(request, names) {
  const args = {};
  const query = isPlainObject(request?.query) ? request.query : {};
  for (const name of names) {
    if (!Object.hasOwn(query, name)) continue;
    const values = query[name];
    if (!Array.isArray(values) || values.length === 0) continue;
    args[name] = values.length === 1 ? String(values[0]) : values.map(String).join(",");
  }
  return { arguments: args };
}

function categoryOf(code) {
  for (const category of CATEGORIES) if (code.startsWith(`${category}_`)) return category;
  return "INTERNAL";
}

export function waterfallError(outcome) {
  const error = outcome.error ?? {};
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Internal server error";
  if (outcome.status === "denied") {
    return { status: "error", message: "Operation not permitted for this api key", error: ["Operation not permitted for this api key"], category: "PERMISSION", code: "PERMISSION_NEED_ADMIN_API_KEY" };
  }
  if (outcome.status === "unsupported") {
    return { status: "error", message: "Invalid path or method", error: ["Invalid path or method"], category: "ROUTING", code: "ROUTING_INVALID_PATH_OR_METHOD" };
  }
  if (outcome.status === "invalid") {
    return { status: "error", message: "Bad request", error: [message.length > 400 ? `${message.slice(0, 400)}…` : message], category: "VALIDATION", code: "VALIDATION_BAD_REQUEST" };
  }
  const code = String(error.code ?? "").replace(/^[a-z]+\./, "") || "INTERNAL_UNCLASSIFIED_ERROR";
  const details = isPlainObject(error.details) && Array.isArray(error.details.error) ? error.details.error.filter((item) => typeof item === "string") : null;
  const list = details !== null && details.length > 0 ? details : [message];
  return { status: "error", message, error: list, category: categoryOf(code), code };
}

export function encodeOutcome({ outcome }) {
  if (outcome.status === "ok") return { body: { kind: "json", value: outcome.value } };
  const body = waterfallError(outcome);
  if (body.category === "RATE_LIMIT") return { headers: RATE_LIMIT_HEADERS, body: { kind: "json", value: body } };
  return { body: { kind: "json", value: body } };
}

export const jsonRoute = () => ({ decode: jsonArguments, encode: encodeOutcome });
export const finderRoute = () => ({ decode: (request) => queryArguments(request, ["job_id"]), encode: encodeOutcome });
export const queryRoute = (names) => ({ decode: (request) => queryArguments(request, names), encode: encodeOutcome });
