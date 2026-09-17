// GitLab REST v4 wire helpers: query/body decoding, pagination headers (`x-page`, `x-total`, `link`), the 429
// `Retry later` response and GitLab's error envelopes. Pure functions only; codecs never touch state.

import { assertJsonDepth } from "./json-depth.mjs";

export const RETRY_AFTER_SECONDS = "60";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function last(values) {
  return Array.isArray(values) && values.length > 0 ? values[values.length - 1] : undefined;
}

/** Last value of a query parameter (own lookup only). */
export function q(request, name) {
  return Object.prototype.hasOwnProperty.call(request.query, name) ? last(request.query[name]) : undefined;
}

/** Every value of a query parameter, capped at `max` entries. */
export function qAll(request, name, max = 100) {
  const values = Object.prototype.hasOwnProperty.call(request.query, name) ? request.query[name] : undefined;
  return Array.isArray(values) ? values.slice(0, max) : undefined;
}

/** Integer query value → number; any other text is passed through unchanged so schema/handler validation reports it. */
export function qInt(request, name) {
  const value = q(request, name);
  if (value === undefined) return undefined;
  return /^-?[0-9]{1,9}$/.test(value) ? Number(value) : value;
}

/** Boolean query value (`true`/`false`/`1`/`0`) → boolean; other text passes through (the schema rejects it). */
export function qBool(request, name) {
  const value = q(request, name);
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}

/** Page parameters are validated by the handler (non-integers → 400 `{"error":"per_page is invalid"}`). */
export function qPage(request) {
  return { page: q(request, "page"), per_page: q(request, "per_page") };
}

/** JSON object body or an empty object. */
export function jsonBody(request) {
  const value = request.body.kind === "json" ? assertJsonDepth(request.body.value) : undefined;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

/** Own property of a decoded JSON body; prototype-named keys never resolve. */
export function field(body, name) {
  if (UNSAFE_KEYS.has(name)) return undefined;
  return Object.prototype.hasOwnProperty.call(body, name) ? body[name] : undefined;
}

/** A write parameter: JSON body field first, then the query string (GitLab accepts both). */
export function param(request, body, name) {
  const fromBody = field(body, name);
  return fromBody !== undefined ? fromBody : q(request, name);
}

/** Path iid/id: a positive integer, otherwise 0 (which no record has, so the handler answers GitLab's 404). */
export function pathInt(request, name) {
  const raw = Object.prototype.hasOwnProperty.call(request.path, name) ? request.path[name] : "";
  return /^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : 0;
}

export function pathText(request, name) {
  return Object.prototype.hasOwnProperty.call(request.path, name) ? String(request.path[name]) : "";
}

export function defined(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return out;
}

/** Mutations accept an optional `Idempotency-Key` header as the operation idempotency key. */
export function operationInput(request, args) {
  const values = Object.prototype.hasOwnProperty.call(request.headers, "idempotency-key") ? request.headers["idempotency-key"] : undefined;
  const key = last(values);
  return typeof key === "string" && key.length > 0 && key.length <= 255 ? { arguments: args, idempotencyKey: key } : { arguments: args };
}

function codeOf(outcome) {
  return String(outcome.error?.code ?? "").replace(/^tool\./, "");
}

export function isRateLimited(outcome) {
  return outcome.status === "tool_error" && codeOf(outcome) === "RATE_LIMITED";
}

/** GitLab's Rack::Attack throttle response. The codec has no clock, so `RateLimit-Reset` is not emitted. */
export function rateLimitedResponse() {
  return {
    headers: {
      "ratelimit-name": "throttle_authenticated_api",
      "ratelimit-limit": "2000",
      "ratelimit-observed": "2001",
      "ratelimit-remaining": "0",
      "retry-after": RETRY_AFTER_SECONDS,
    },
    body: { kind: "text", value: "Retry later\n", contentType: "text/plain" },
  };
}

/** GitLab-shaped error body for any non-ok outcome. HTTP statuses are framework-owned (declared per route). */
export function errorBody(outcome) {
  const error = outcome.error ?? {};
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "500 Internal Server Error";
  if (outcome.status === "denied") return { message: "403 Forbidden" };
  if (outcome.status === "unsupported") return { message: "404 Not Found" };
  if (outcome.status === "invalid") return { error: message };
  const details = typeof error.details === "object" && error.details !== null ? error.details : {};
  if (details.shape === "error") return { error: message };
  if (details.shape === "messages") return { message: [message] };
  if (details.shape === "fields" && typeof details.field === "string" && !UNSAFE_KEYS.has(details.field)) {
    const body = { message: {} };
    body.message[details.field] = [message];
    return body;
  }
  return { message };
}

/** Encode the canonical `page` object into GitLab pagination headers plus a relative `link` header. */
export function pageHeaders(page, pathname, args, pathArguments) {
  if (page === undefined || page === null) return {};
  const headers = {
    "x-page": String(page.page),
    "x-per-page": String(page.per_page),
    "x-next-page": page.next_page === null ? "" : String(page.next_page),
    "x-prev-page": page.prev_page === null ? "" : String(page.prev_page),
  };
  if (typeof page.total === "number") {
    headers["x-total"] = String(page.total);
    headers["x-total-pages"] = String(page.total_pages);
  }
  const params = [];
  for (const [name, value] of Object.entries(args)) {
    if (pathArguments.has(name) || name === "page" || name === "per_page" || value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.push(`${encodeURIComponent(`${name}[]`)}=${encodeURIComponent(String(item))}`);
    } else params.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  const target = (number) => `<${pathname}?${[...params, `page=${number}`, `per_page=${page.per_page}`].join("&")}>`;
  const relations = [];
  if (page.prev_page !== null) relations.push(`${target(page.prev_page)}; rel="prev"`);
  if (page.next_page !== null) relations.push(`${target(page.next_page)}; rel="next"`);
  relations.push(`${target(1)}; rel="first"`);
  if (typeof page.total_pages === "number") relations.push(`${target(page.total_pages)}; rel="last"`);
  headers.link = relations.join(", ");
  return headers;
}
