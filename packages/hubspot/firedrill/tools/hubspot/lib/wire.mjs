// HubSpot REST wire helpers: query parsing, the error envelope and the rate-limit headers. Pure
// functions only, so the HTTP codecs can use them without state or a clock.

import { assertJsonDepth } from "./json-depth.mjs";

const OAUTH_DOCS = "https://developers.hubspot.com/docs/methods/auth/oauth-overview";

function last(values) {
  return values === undefined || values.length === 0 ? undefined : values[values.length - 1];
}

export function str(query, name) {
  return last(query[name]);
}

export function int(query, name) {
  const value = last(query[name]);
  if (value === undefined) return undefined;
  // A malformed value is passed through as its raw string; the handler rejects it with VALIDATION_ERROR.
  return /^-?[0-9]{1,9}$/.test(value) ? Number(value) : value;
}

export function bool(query, name) {
  const value = last(query[name]);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return value; // raw string: the handler rejects it with VALIDATION_ERROR
}

/** Comma-separated (and repeatable) query parameter → string array, or undefined when absent. */
export function list(query, name) {
  const values = query[name];
  if (values === undefined || values.length === 0) return undefined;
  const items = [];
  for (const value of values) for (const part of value.split(",")) if (part.trim().length > 0) items.push(part.trim());
  return items;
}

export function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

export function jsonBody(request) {
  const value = request.body.kind === "json" ? request.body.value : undefined;
  assertJsonDepth(value);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

export function jsonArrayBody(request) {
  const value = request.body.kind === "json" ? request.body.value : undefined;
  assertJsonDepth(value);
  return Array.isArray(value) ? value : [];
}

/** Mutations accept an optional X-Firedrill-Idempotency-Key header (HubSpot clients never send one). */
export function operationInput(request, args) {
  const key = last(request.headers["x-firedrill-idempotency-key"]);
  return key === undefined || key.length === 0 ? { arguments: args } : { arguments: args, idempotencyKey: key };
}

export function isRateLimited(outcome) {
  return outcome.status === "tool_error" && outcome.error?.code === "tool.RATE_LIMITED";
}

/** Constant decoration headers; under the rate-limit fault `Remaining` drops to 0 and Retry-After appears. */
export function responseHeaders(correlationId, limited) {
  return {
    "x-hubspot-correlation-id": correlationId,
    "x-hubspot-ratelimit-secondly": "100",
    "x-hubspot-ratelimit-secondly-remaining": limited ? "0" : "99",
    "x-hubspot-ratelimit-daily": "250000",
    "x-hubspot-ratelimit-daily-remaining": limited ? "249000" : "249999",
    "x-hubspot-ratelimit-interval-milliseconds": "10000",
    ...(limited ? { "retry-after": "1" } : {}),
  };
}

const CATEGORIES = {
  UNAUTHORIZED: "INVALID_AUTHENTICATION",
  MISSING_SCOPES: "MISSING_SCOPES",
  NOT_FOUND: "OBJECT_NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITS",
  SERVICE_UNAVAILABLE: "INTERNAL_ERROR",
};

/** HubSpot error envelope for a non-ok outcome; status codes are framework-owned (declared per route). */
export function hubspotError(outcome, correlationId) {
  const error = outcome.error ?? {};
  const message = typeof error.message === "string" ? error.message : "";
  if (outcome.status === "denied") {
    return {
      status: "error",
      message: "This operation is not granted to the calling actor in this Firedrill world.",
      correlationId,
      category: "MISSING_SCOPES",
    };
  }
  if (outcome.status === "unsupported") {
    return { status: "error", message: "resource not found", correlationId, category: "OBJECT_NOT_FOUND" };
  }
  if (outcome.status === "invalid") {
    return {
      status: "error",
      message: message.length > 0 ? `Invalid input JSON: ${message}` : "Invalid input JSON",
      correlationId,
      category: "VALIDATION_ERROR",
      context: { firedrill: [String(error.code ?? "invalid")] },
    };
  }
  const code = String(error.code ?? "").replace(/^tool\./, "");
  const body = {
    status: "error",
    message: message.length > 0 ? message : "internal error",
    correlationId,
    category: Object.hasOwn(CATEGORIES, code) ? CATEGORIES[code] : "INTERNAL_ERROR",
  };
  const details = typeof error.details === "object" && error.details !== null ? error.details : {};
  if (Array.isArray(details.errors)) body.errors = details.errors;
  if (typeof details.context === "object" && details.context !== null) body.context = details.context;
  if (code === "UNAUTHORIZED") body.links = { "oauth-overview": OAUTH_DOCS };
  return body;
}
