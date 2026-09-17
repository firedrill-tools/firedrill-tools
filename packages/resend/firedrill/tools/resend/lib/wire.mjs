// Pure HTTP wire helpers: snake_case → canonical argument mapping, Idempotency-Key handling and Resend's error
// envelope `{ statusCode, message, name }`. No state, no clock. HTTP statuses are declared per route in the manifest.

const ERRORS = new Map([
  ["VALIDATION_ERROR", [422, "validation_error"]],
  ["MISSING_REQUIRED_FIELD", [422, "missing_required_field"]],
  ["INVALID_PARAMETER", [422, "invalid_parameter"]],
  ["INVALID_IDEMPOTENCY_KEY", [400, "invalid_idempotency_key"]],
  ["RESTRICTED_API_KEY", [401, "restricted_api_key"]],
  ["INVALID_API_KEY", [403, "invalid_api_key"]],
  ["DOMAIN_NOT_VERIFIED", [403, "validation_error"]],
  ["NOT_FOUND", [404, "not_found"]],
  ["DAILY_QUOTA_EXCEEDED", [429, "daily_quota_exceeded"]],
  ["RATE_LIMIT_EXCEEDED", [429, "rate_limit_exceeded"]],
  ["APPLICATION_ERROR", [500, "application_error"]],
]);

export const ERROR_STATUS = ERRORS;

function last(values) {
  return Array.isArray(values) && values.length > 0 ? values[values.length - 1] : undefined;
}

export function header(request, name) {
  return last(request.headers[name]);
}

export function query(request, name) {
  return last(request.query[name]);
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonObject(request) {
  return request.body.kind === "json" && isPlainObject(request.body.value) ? request.body.value : {};
}

/** Copy `[wireName, argumentName]` pairs that are present in `source` (own properties only) into `target`. */
export function pick(source, pairs, target = {}) {
  for (const [wire, name] of pairs) {
    if (Object.hasOwn(source, wire) && source[wire] !== undefined) target[name] = source[wire];
  }
  return target;
}

/** Pagination query parameters: raw strings; the handler validates them and answers Resend's 422. */
export function pageArguments(request, target = {}) {
  for (const name of ["limit", "after", "before"]) {
    const value = query(request, name);
    if (value !== undefined) target[name] = value;
  }
  return target;
}

/**
 * `Idempotency-Key`: 1–128 characters become the framework idempotency key; 129–256 characters are accepted without
 * deduplication (the framework's evidence records keys up to 128 characters); an empty or longer key travels as an
 * argument so the handler answers 400 `invalid_idempotency_key`.
 */
export function operationInput(request, args) {
  const key = header(request, "idempotency-key");
  if (key === undefined) return { arguments: args };
  if (key.length >= 1 && key.length <= 128) return { arguments: args, idempotencyKey: key };
  if (key.length >= 1 && key.length <= 256) return { arguments: args };
  return { arguments: { ...args, idempotencyKey: key } };
}

/** Contacts accept a UUID or an e-mail address in the same path position. */
export function contactRef(value, idName, target = {}) {
  if (typeof value === "string" && value.includes("@")) target.email = value;
  else target[idName] = value;
  return target;
}

export function resendError(outcome) {
  const error = outcome.error ?? {};
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Internal server error";
  if (outcome.status === "denied") {
    return { statusCode: 403, message: "This operation is not granted to the calling actor in this Firedrill world.", name: "invalid_access" };
  }
  if (outcome.status === "unsupported") return { statusCode: 404, message: "Not found", name: "not_found" };
  // HTTP status of `invalid` outcomes is framework-owned (400), so the body keeps 400 to match it.
  if (outcome.status === "invalid") return { statusCode: 400, message: `Invalid request: ${message}`, name: "validation_error" };
  const code = String(error.code ?? "").replace(/^tool\./, "");
  const [statusCode, name] = ERRORS.get(code) ?? [500, "application_error"];
  return { statusCode, message, name };
}

export function encodeOutcome({ outcome }) {
  if (outcome.status === "ok") return { body: { kind: "json", value: outcome.value } };
  const body = resendError(outcome);
  const headers = body.name === "rate_limit_exceeded"
    ? { "ratelimit-limit": "10", "ratelimit-remaining": "0", "ratelimit-reset": "1", "retry-after": "1" }
    : undefined;
  return { ...(headers === undefined ? {} : { headers }), body: { kind: "json", value: body } };
}
