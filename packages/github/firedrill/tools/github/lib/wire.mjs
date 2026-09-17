// GitHub REST wire helpers: query/body decoding, the `link` pagination header, rate-limit headers and the
// GitHub error envelope. Pure functions only, so the HTTP codecs can use them without state.
import { assertJsonDepth } from "./json-depth.mjs";

export const API_VERSION = "2022-11-28";
export const RETRY_AFTER_SECONDS = "60";
export const MAX_PER_PAGE = 100;
const DOCS = "https://docs.github.com/rest";

function last(values) {
  return values === undefined || values.length === 0 ? undefined : values[values.length - 1];
}

export function str(query, name) {
  return last(query[name]);
}

/** A positive integer of at most nine digits, or undefined for anything else (GitHub ignores such values). */
function positiveInt(value) {
  if (value === undefined || !/^[0-9]{1,9}$/.test(value)) return undefined;
  const number = Number(value);
  return number >= 1 ? number : undefined;
}

export function bool(query, name) {
  const value = last(query[name]);
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new TypeError(`${name} must be true or false`);
}

/**
 * `page` and `per_page` → canonical `page`/`perPage`, coerced as api.github.com does: a value that is not a
 * positive integer (`abc`, `0`, `-5`, `2.5`, blank) falls back to the default (page 1, 30 items) and `per_page`
 * above 100 is clamped to 100, so the request answers 200 instead of a framework mapping error.
 */
export function pagination(query) {
  const perPage = positiveInt(last(query.per_page));
  return defined({ page: positiveInt(last(query.page)), perPage: perPage === undefined ? undefined : Math.min(perPage, MAX_PER_PAGE) });
}

export function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

export function jsonBody(request) {
  const value = request.body.kind === "json" ? assertJsonDepth(request.body.value) : undefined;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

export function pathNumber(request, name) {
  const raw = request.path[name];
  if (!/^[1-9][0-9]{0,8}$/.test(raw ?? "")) throw new TypeError(`${name} must be a positive integer`);
  return Number(raw);
}

/** Re-join the per-depth path parameters (p1..p4, b1..b2, r1..r2) into one slash-separated value. */
export function joinSegments(request, prefix, count) {
  const parts = [];
  for (let index = 1; index <= count; index += 1) {
    const value = request.path[`${prefix}${index}`];
    if (value === undefined) break;
    parts.push(value);
  }
  return parts.join("/");
}

/** Mutations accept an optional X-Firedrill-Idempotency-Key header (GitHub clients never send one). */
export function operationInput(request, args) {
  const key = last(request.headers["x-firedrill-idempotency-key"]);
  return key === undefined || key.length === 0 ? { arguments: args } : { arguments: args, idempotencyKey: key };
}

/**
 * Constant rate-limit headers (the codec has no clock, so `x-ratelimit-reset` is not emitted); under the
 * rate-limit fault `remaining` drops to 0 and `retry-after` is added, as GitHub does.
 */
export function rateLimitHeaders(limited) {
  return {
    "x-github-api-version-selected": API_VERSION,
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": limited ? "0" : "4999",
    "x-ratelimit-used": limited ? "5000" : "1",
    "x-ratelimit-resource": "core",
    ...(limited ? { "retry-after": RETRY_AFTER_SECONDS } : {}),
  };
}

/**
 * GitHub's `link` header for page-based lists, built from the request path and query (host-less targets).
 * `lastPage` is the operation's page count (pages are cut by count and bytes). Undefined when all fits on one page.
 */
export function linkHeader(request, page, perPage, lastPage) {
  if (lastPage <= 1 && page <= 1) return undefined;
  const target = (number) => {
    const params = [];
    for (const [name, values] of Object.entries(request.query)) {
      if (name === "page" || name === "per_page") continue;
      for (const value of values) params.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
    params.push(`page=${String(number)}`, `per_page=${String(perPage)}`);
    return `<${request.pathname}?${params.join("&")}>`;
  };
  const relations = [];
  if (page > 1) {
    relations.push(`${target(Math.min(page - 1, lastPage))}; rel="prev"`);
    relations.push(`${target(1)}; rel="first"`);
  }
  if (page < lastPage) {
    relations.push(`${target(page + 1)}; rel="next"`);
    relations.push(`${target(lastPage)}; rel="last"`);
  }
  return relations.length === 0 ? undefined : relations.join(", ");
}

/** GitHub-shaped error body for a non-ok outcome; status codes are framework-owned (declared per route). */
export function githubError(outcome) {
  const error = outcome.error ?? {};
  const message = typeof error.message === "string" ? error.message : "";
  if (outcome.status === "denied") {
    return { message: "Resource not accessible by personal access token", documentation_url: DOCS, status: "403" };
  }
  if (outcome.status === "unsupported") return { message: "Not Found", documentation_url: DOCS, status: "404" };
  if (outcome.status === "invalid") {
    const detail = message.length > 0 ? `Invalid request.\n\n${message}` : "Problems parsing JSON";
    return { message: detail, documentation_url: DOCS, status: "400" };
  }
  const code = String(error.code ?? "").replace(/^tool\./, "");
  const status =
    {
      UNAUTHORIZED: "401",
      FORBIDDEN: "403",
      RATE_LIMITED: "403",
      NOT_FOUND: "404",
      METHOD_NOT_ALLOWED: "405",
      CONFLICT: "409",
      VALIDATION_FAILED: "422",
      SERVICE_UNAVAILABLE: "503",
    }[code] ?? "500";
  const body = { message: message.length > 0 ? message : "Server Error" };
  const details = typeof error.details === "object" && error.details !== null ? error.details : {};
  if (Array.isArray(details.errors)) body.errors = details.errors;
  body.documentation_url =
    code === "RATE_LIMITED" ? "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api" : DOCS;
  body.status = status;
  return body;
}

export function isRateLimited(outcome) {
  return outcome.status === "tool_error" && outcome.error?.code === "tool.RATE_LIMITED";
}
