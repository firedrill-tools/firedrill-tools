// Salesforce REST wire helpers: query-string parsing, the error-array envelope, response headers.
// Pure functions only — the HTTP codecs have neither state nor a clock.

function last(values) {
  return values === undefined || values.length === 0 ? undefined : values[values.length - 1];
}

export function str(query, name) {
  return last(query[name]);
}

/** Comma-separated (and repeatable) query parameter → string array, or undefined when absent. */
export function list(query, name) {
  const values = query[name];
  if (values === undefined || values.length === 0) return undefined;
  const items = [];
  for (const value of values) for (const part of value.split(",")) if (part.trim().length > 0) items.push(part.trim());
  return items;
}

/** `true`/`false` query parameter; anything else is passed through so the schema rejects it. */
export function boolOrRaw(query, name) {
  const value = last(query[name]);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

export function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** JSON bodies nesting deeper than this are refused at decode time (400), before schema validation recurses. */
export const MAX_JSON_DEPTH = 512;

/** True when `value` nests arrays/objects deeper than `max` levels; iterative (explicit stack), never recursive. */
export function nestsDeeperThan(value, max) {
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop();
    if (typeof current !== "object" || current === null) continue;
    if (depth > max) return true;
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      if (typeof child === "object" && child !== null) stack.push([child, depth + 1]);
    }
  }
  return false;
}

export function jsonBody(request) {
  const value = request.body.kind === "json" ? request.body.value : undefined;
  if (nestsDeeperThan(value, MAX_JSON_DEPTH)) throw new Error(`JSON body nests deeper than ${MAX_JSON_DEPTH} levels`);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

/** `Sforce-Query-Options: batchSize=N` → N (undefined when absent or unparsable). */
export function batchSizeHeader(request) {
  const header = last(request.headers["sforce-query-options"]);
  if (header === undefined) return undefined;
  const match = /batchSize\s*=\s*(\d{1,6})/i.exec(header);
  return match === null ? undefined : Number(match[1]);
}

/** Mutations accept an optional X-Firedrill-Idempotency-Key header (Salesforce clients never send one). */
export function operationInput(request, args) {
  const key = last(request.headers["x-firedrill-idempotency-key"]);
  return key === undefined || key.length === 0 ? { arguments: args } : { arguments: args, idempotencyKey: key };
}

export function errorCode(outcome) {
  return String(outcome.error?.code ?? "").replace(/^tool\./, "");
}

/** The `Sforce-Limit-Info` value an outcome carries (object outputs and handler-raised errors only). */
export function limitInfoOf(outcome) {
  if (outcome.status === "ok") {
    const value = outcome.value;
    return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value._limitInfo === "string" ? value._limitInfo : undefined;
  }
  const details = outcome.error?.details;
  return typeof details === "object" && details !== null && typeof details.limitInfo === "string" ? details.limitInfo : undefined;
}

export function responseHeaders(outcome, extra = {}) {
  const info = limitInfoOf(outcome);
  return { ...(info === undefined ? {} : { "sforce-limit-info": info }), ...extra };
}

/** Strip the `_limitInfo` carrier from an object body (arrays pass through). */
export function stripLimitInfo(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const { _limitInfo, ...rest } = value;
  return rest;
}

/** Salesforce's error array `[{ message, errorCode, fields? }]` for a non-ok outcome. */
export function salesforceError(outcome) {
  const error = outcome.error ?? {};
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Request failed.";
  if (outcome.status === "denied") return [{ message: "The REST API is not enabled for this User", errorCode: "API_DISABLED_FOR_ORG" }];
  if (outcome.status === "unsupported") return [{ message: "The requested resource does not exist", errorCode: "NOT_FOUND" }];
  if (outcome.status === "invalid") return [{ message, errorCode: "JSON_PARSER_ERROR" }];
  const code = errorCode(outcome) || "UNKNOWN_EXCEPTION";
  const details = typeof error.details === "object" && error.details !== null ? error.details : {};
  const entry = { message, errorCode: code };
  if (Array.isArray(details.fields) && details.fields.length > 0) entry.fields = details.fields;
  return [entry];
}
