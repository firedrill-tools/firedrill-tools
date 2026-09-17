// Attio REST v2 wire helpers: query/body extraction and the Attio error envelope. Pure functions only (no state,
// no clock), so route codecs can use them. Decoders never throw on caller input: malformed values are passed through
// to the handler as raw strings or as a `request_error` argument, and the handler answers Attio's validation error.

const MAX_MESSAGE = 4_000;

const ERRORS = new Map([
  ["AUTHENTICATION_FAILED", { status_code: 401, type: "auth_error", code: "invalid_api_key" }],
  ["UNAUTHORIZED", { status_code: 403, type: "auth_error", code: "unauthorized" }],
  ["NOT_FOUND", { status_code: 404, type: "invalid_request_error", code: "not_found" }],
  ["VALIDATION_TYPE", { status_code: 400, type: "invalid_request_error", code: "validation_type" }],
  ["VALUE_NOT_FOUND", { status_code: 400, type: "invalid_request_error", code: "value_not_found" }],
  ["MULTIPLE_MATCH_RESULTS", { status_code: 400, type: "invalid_request_error", code: "multiple_match_results" }],
  ["UNIQUENESS_CONFLICT", { status_code: 409, type: "invalid_request_error", code: "uniqueness_conflict" }],
  ["CONTENT_TOO_LARGE", { status_code: 413, type: "invalid_request_error", code: "content_too_large" }],
  ["RATE_LIMITED", { status_code: 429, type: "rate_limit_error", code: "rate_limit_exceeded" }],
  ["SERVICE_UNAVAILABLE", { status_code: 503, type: "api_error", code: "service_unavailable" }],
  ["FAILED_PRECONDITION", { status_code: 400, type: "invalid_request_error", code: "state_bound_exceeded" }],
]);

function last(values) {
  return Array.isArray(values) && values.length > 0 ? values[values.length - 1] : undefined;
}

/** A single-valued query parameter. Repeated parameters are joined with "," so numeric/boolean checks reject them. */
export function queryValue(query, name) {
  if (!Object.hasOwn(query, name)) return undefined;
  const values = query[name];
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const text = values.length === 1 ? values[0] : values.join(",");
  return typeof text === "string" ? text.slice(0, 1_024) : undefined;
}

/** Integer query parameter: a canonical integer becomes a number, anything else stays a string for the handler. */
export function queryInteger(query, name) {
  const value = queryValue(query, name);
  if (value === undefined) return undefined;
  return /^-?[0-9]{1,9}$/.test(value) ? Number(value) : value;
}

/** Boolean query parameter: "true"/"false" become booleans, anything else stays a string for the handler. */
export function queryBoolean(query, name) {
  const value = queryValue(query, name);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

export function headerValue(headers, name) {
  return Object.hasOwn(headers, name) ? last(headers[name]) : undefined;
}

/** The JSON body when it is an object; otherwise `undefined` and a caller-meaningful `request_error` text. */
export function objectBody(request) {
  const body = request.body;
  if (body === null || typeof body !== "object" || body.kind !== "json") {
    return { value: undefined, error: "The request body must be a JSON object." };
  }
  const value = body.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { value: undefined, error: "The request body must be a JSON object." };
  }
  return { value, error: undefined };
}

/** Own property of a caller JSON object, or undefined. */
export function field(object, name) {
  return object !== undefined && object !== null && typeof object === "object" && Object.hasOwn(object, name) ? object[name] : undefined;
}

/** Drop undefined members (JSON arguments cannot carry them). */
export function defined(members) {
  const out = {};
  for (const [key, value] of Object.entries(members)) if (value !== undefined) out[key] = value;
  return out;
}

/** Decoder result with the optional Firedrill idempotency header (Attio has no idempotency header of its own). */
export function operationInput(request, args) {
  const key = headerValue(request.headers, "x-firedrill-idempotency-key");
  return typeof key === "string" && key.length > 0 && key.length <= 255 ? { arguments: args, idempotencyKey: key } : { arguments: args };
}

function clipMessage(text) {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

/** Attio's error envelope `{ status_code, type, code, message }` for any non-ok outcome. */
export function errorEnvelope(outcome) {
  const error = outcome.error !== null && typeof outcome.error === "object" ? outcome.error : {};
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "";
  if (outcome.status === "denied") {
    return { status_code: 403, type: "auth_error", code: "unauthorized", message: "The calling actor is not granted this operation in this Firedrill world." };
  }
  if (outcome.status === "invalid") {
    return { status_code: 400, type: "invalid_request_error", code: "validation_type", message: clipMessage(message.length > 0 ? `Invalid request: ${message}` : "Invalid request.") };
  }
  if (outcome.status === "unsupported") {
    return { status_code: 404, type: "invalid_request_error", code: "not_found", message: "The requested endpoint is not supported." };
  }
  const code = typeof error.code === "string" ? error.code.replace(/^tool\./, "") : "";
  const known = ERRORS.get(code) ?? { status_code: 500, type: "api_error", code: "internal_server_error" };
  return { ...known, message: clipMessage(message.length > 0 ? message : "An unexpected error occurred.") };
}

export function isRateLimited(outcome) {
  return outcome.status === "tool_error" && outcome.error !== null && typeof outcome.error === "object" && outcome.error.code === "tool.RATE_LIMITED";
}

/** Success bodies pass through; `strip` removes canonical-only members (e.g. `server_time`). */
export function encodeResult({ outcome }, strip = []) {
  if (outcome.status === "ok") {
    let value = outcome.value;
    if (strip.length > 0 && value !== null && typeof value === "object" && !Array.isArray(value)) {
      value = { ...value };
      for (const name of strip) delete value[name];
    }
    return { body: { kind: "json", value } };
  }
  return {
    ...(isRateLimited(outcome) ? { headers: { "retry-after": "1" } } : {}),
    body: { kind: "json", value: errorEnvelope(outcome) },
  };
}
