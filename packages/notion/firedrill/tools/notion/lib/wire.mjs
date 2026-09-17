// Pure HTTP wire helpers: request decoding into the flattened canonical input, and Notion's error
// envelope `{ object: "error", status, code, message, request_id }`. No state, no clock.

import { assertJsonDepth } from "./json-depth.mjs";

const STATUS = Object.freeze({
  VALIDATION_ERROR: [400, "validation_error"],
  FAILED_PRECONDITION: [400, "validation_error"],
  UNAUTHORIZED: [401, "unauthorized"],
  RESTRICTED_RESOURCE: [403, "restricted_resource"],
  OBJECT_NOT_FOUND: [404, "object_not_found"],
  CONFLICT_ERROR: [409, "conflict_error"],
  RATE_LIMITED: [429, "rate_limited"],
  SERVICE_UNAVAILABLE: [503, "service_unavailable"],
});

function last(values) {
  return values === undefined || values.length === 0 ? undefined : values[values.length - 1];
}

export function str(query, name) {
  return last(query[name]);
}

/**
 * Integer query parameter. A plain decimal integer (at most 15 digits, so it is exact) becomes a number; any other
 * value (empty, `abc`, `1e999`, `1.5`) is passed through as the raw string so the handler answers Notion's
 * validation_error envelope. Never throws.
 */
export function intOrRaw(query, name) {
  const value = last(query[name]);
  if (value === undefined) return undefined;
  return /^-?[0-9]{1,15}$/.test(value) ? Number(value) : value;
}

/** Repeatable query parameter (`filter_properties=a&filter_properties=b`, also comma-separated). */
export function list(query, name) {
  const values = query[name];
  if (values === undefined || values.length === 0) return undefined;
  const items = [];
  for (const value of values) for (const part of value.split(",")) if (part.trim().length > 0) items.push(part.trim());
  return items;
}

export function jsonBody(request) {
  const value = request.body.kind === "json" ? assertJsonDepth(request.body.value) : undefined;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

export function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** Mutations accept an optional X-Firedrill-Idempotency-Key header (Notion clients never send one). */
export function operationInput(request, args) {
  const key = last(request.headers["x-firedrill-idempotency-key"]);
  return key === undefined || key.length === 0 ? { arguments: args } : { arguments: args, idempotencyKey: key };
}

export function isRateLimited(outcome) {
  return outcome.status === "tool_error" && outcome.error?.code === "tool.RATE_LIMITED";
}

/** Notion's error body for a non-ok outcome; HTTP statuses themselves are declared per route. */
export function notionError(outcome, requestId) {
  const error = outcome.error ?? {};
  const message = typeof error.message === "string" ? error.message : "";
  if (outcome.status === "denied") {
    return { object: "error", status: 403, code: "restricted_resource", message: "This operation is not granted to the calling actor in this Firedrill world.", request_id: requestId };
  }
  if (outcome.status === "unsupported") {
    return { object: "error", status: 404, code: "object_not_found", message: "Could not find the requested resource.", request_id: requestId };
  }
  if (outcome.status === "invalid") {
    return { object: "error", status: 400, code: "validation_error", message: message.length > 0 ? `body failed validation: ${message}` : "body failed validation.", request_id: requestId };
  }
  const code = String(error.code ?? "").replace(/^tool\./, "");
  const [status, notionCode] = STATUS[code] ?? [500, "internal_server_error"];
  return { object: "error", status, code: notionCode, message: message.length > 0 ? message : "Internal server error.", request_id: requestId };
}

/** Encode any outcome as a Notion-shaped JSON response. */
export function encodeOutcome({ invocation, outcome }) {
  if (outcome.status === "ok") return { body: { kind: "json", value: outcome.value } };
  return {
    ...(isRateLimited(outcome) ? { headers: { "retry-after": "1" } } : {}),
    body: { kind: "json", value: notionError(outcome, invocation.correlationId) },
  };
}
