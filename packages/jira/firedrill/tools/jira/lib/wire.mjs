// Jira REST wire helpers: query parsing, the error envelopes and response headers. Pure functions
// only — the HTTP codecs have neither state nor a clock.

import { assertJsonDepth } from "./json-depth.mjs";

function last(values) {
  return values === undefined || values.length === 0 ? undefined : values[values.length - 1];
}

export function str(query, name) {
  return last(query[name]);
}

export function int(query, name) {
  const value = last(query[name]);
  if (value === undefined) return undefined;
  if (!/^-?[0-9]{1,9}$/.test(value)) throw new TypeError(`${name} must be an integer`);
  return Number(value);
}

export function bool(query, name) {
  const value = last(query[name]);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be true or false`);
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

/** Mutations accept an optional X-Firedrill-Idempotency-Key header (Jira clients never send one). */
export function operationInput(request, args) {
  const key = last(request.headers["x-firedrill-idempotency-key"]);
  return key === undefined || key.length === 0 ? { arguments: args } : { arguments: args, idempotencyKey: key };
}

function errorCode(outcome) {
  return String(outcome.error?.code ?? "").replace(/^tool\./, "");
}

export function isRateLimited(outcome) {
  return outcome.status === "tool_error" && errorCode(outcome) === "RATE_LIMITED";
}

export function isUnauthorized(outcome) {
  return outcome.status === "tool_error" && errorCode(outcome) === "UNAUTHORIZED";
}

/**
 * Response headers: the request id, Jira's rate-limit decorations, and the login-failure marker
 * on 401. `X-RateLimit-Reset` is not emitted: codecs have no clock to compute it from.
 */
export function responseHeaders(correlationId, outcome) {
  const limited = isRateLimited(outcome);
  return {
    "x-arequestid": correlationId,
    "x-ratelimit-limit": "100",
    "x-ratelimit-remaining": limited ? "0" : "99",
    "x-ratelimit-nearlimit": "false",
    ...(limited ? { "retry-after": "2" } : {}),
    ...(isUnauthorized(outcome) ? { "x-seraph-loginreason": "AUTHENTICATED_FAILED" } : {}),
  };
}

/** Jira's error body for a non-ok outcome (401 uses the Seraph envelope, everything else errorMessages/errors). */
export function jiraError(outcome) {
  const error = outcome.error ?? {};
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Request failed.";
  if (outcome.status === "denied") {
    return { errorMessages: ["You do not have permission to perform this action."], errors: {} };
  }
  if (outcome.status === "unsupported") {
    return { errorMessages: ["The requested operation is not supported."], errors: {} };
  }
  if (outcome.status === "invalid") {
    return { errorMessages: [message], errors: {} };
  }
  if (errorCode(outcome) === "UNAUTHORIZED") {
    return { message, "status-code": 401 };
  }
  const details = typeof error.details === "object" && error.details !== null ? error.details : {};
  const errors = typeof details.errors === "object" && details.errors !== null && !Array.isArray(details.errors) ? details.errors : {};
  const errorMessages = Array.isArray(details.errorMessages) ? details.errorMessages : [message];
  return { errorMessages, errors };
}
