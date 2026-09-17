// Xero Accounting API 2.0 wire codecs: pure decode (path, query, headers, body → operation arguments) and encode
// (outcome → Xero envelope or error body). No state and no clock; DateTimeUTC comes from handler outputs.
import { ENVELOPE, orderFields } from "./field-order.mjs";
import { NOT_FOUND_MESSAGE, VALIDATION_MESSAGE } from "./access.mjs";
import { inspectJson } from "./util.mjs";

const JSON_TYPE = "application/json; charset=utf-8";

function last(values) {
  return values === undefined || values.length === 0 ? undefined : values[values.length - 1];
}

/** Case-insensitive query parameter (Xero accepts where/Where, IDs/ids). */
function param(request, name) {
  const lower = name.toLowerCase();
  let found;
  for (const key of Object.keys(request.query)) if (key.toLowerCase() === lower) found = request.query[key];
  return last(found);
}

const clip = (value, max) => (typeof value === "string" && value.length > max ? value.slice(0, max) : value);

const header = (request, name) => last(Object.hasOwn(request.headers, name) ? request.headers[name] : undefined);

function args(entries) {
  const out = {};
  for (const [key, value] of entries) if (value !== undefined) out[key] = value;
  return out;
}

/** "3" → 3; anything else that is present → 0 (the handler reports it as a validation error). */
function intParam(request, name) {
  const text = param(request, name);
  if (text === undefined) return undefined;
  if (text.length === 0 || text.length > 9) return 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) < 48 || text.charCodeAt(i) > 57) return 0;
  return Number(text);
}

const boolParam = (request, name) => {
  const text = param(request, name);
  return text === undefined ? undefined : text.toLowerCase() === "true";
};

function listParam(request, name, maxItem = 256) {
  const text = param(request, name);
  if (text === undefined || text.length === 0) return undefined;
  const items = text.split(",", 102).map((item) => clip(item.trim(), maxItem));
  return items;
}

const tenant = (request) => clip(header(request, "xero-tenant-id") ?? "", 64);

function withKey(request, argumentsObject) {
  const key = header(request, "idempotency-key");
  if (key === undefined || key.length === 0) return { arguments: argumentsObject };
  if (key.length > 128) return { arguments: { ...argumentsObject, idempotencyKeyProblem: true } };
  return { arguments: argumentsObject, idempotencyKey: key };
}

/** JSON body, or a bodyProblem argument when the body is hazardous (depth, reserved keys, size). */
function bodyArgs(request) {
  if (request.body.kind !== "json") return { bodyProblem: "Invalid Json data" };
  const problem = inspectJson(request.body.value);
  return problem === null ? { body: request.body.value } : { bodyProblem: problem };
}

const listCommon = (request) => [
  ["tenantId", tenant(request)],
  ["where", clip(param(request, "where"), 2001)],
  ["order", clip(param(request, "order"), 501)],
];

const paged = (request) => [
  ["page", intParam(request, "page")],
  ["pageSize", intParam(request, "pageSize")],
  ["ifModifiedSince", clip(header(request, "if-modified-since"), 64)],
];

const unitdp = (request) => {
  const value = intParam(request, "unitdp");
  return value === undefined ? undefined : value === 4 ? 4 : value === 2 ? 2 : 0;
};

// ---------------------------------------------------------------------------------------------------------------
// Encoders

function errorResponse(invocation, outcome) {
  if (outcome.status === "denied") return problem(403, "Forbidden", invocation);
  if (outcome.status === "unsupported") return { body: { kind: "text", value: NOT_FOUND_MESSAGE, contentType: "text/plain; charset=utf-8" } };
  if (outcome.status === "invalid") {
    const message = typeof outcome.error?.message === "string" ? outcome.error.message.slice(0, 500) : "Invalid request";
    return json({ ErrorNumber: 10, Type: "ValidationException", Message: VALIDATION_MESSAGE, Elements: [{ ValidationErrors: [{ Message: message }] }] });
  }
  const error = outcome.error ?? {};
  const code = String(error.code ?? "").replace(/^tool\./, "");
  const message = typeof error.message === "string" ? error.message : "";
  const details = error.details !== null && typeof error.details === "object" ? error.details : {};
  switch (code) {
    case "VALIDATION_EXCEPTION":
      return json({ ErrorNumber: 10, Type: "ValidationException", Message: VALIDATION_MESSAGE, Elements: Array.isArray(details.Elements) ? details.Elements : [] });
    case "QUERY_PARSE_EXCEPTION":
      return json({ ErrorNumber: 16, Type: "QueryParseException", Message: message });
    case "POST_DATA_INVALID":
      return json({ ErrorNumber: 17, Type: "PostDataInvalidException", Message: message });
    case "NOT_FOUND":
      return { body: { kind: "text", value: NOT_FOUND_MESSAGE, contentType: "text/plain; charset=utf-8" } };
    case "UNAUTHORIZED":
      return problem(401, "Unauthorized", invocation, details.detail);
    case "FORBIDDEN":
      return problem(403, "Forbidden", invocation, details.detail);
    case "RATE_LIMITED":
      return { headers: { "retry-after": "60", "x-rate-limit-problem": "minute", "x-minlimit-remaining": "0" }, body: { kind: "text", value: "Rate Limit Exceeded", contentType: "text/plain; charset=utf-8" } };
    case "SERVICE_UNAVAILABLE":
      return { headers: { "retry-after": "30" }, body: { kind: "text", value: "Service Unavailable", contentType: "text/plain; charset=utf-8" } };
    default:
      return json({ ErrorNumber: 500, Type: "UnknownErrorException", Message: message.length > 0 ? message : "An error occurred" });
  }
}

const json = (value) => ({ headers: {}, body: { kind: "json", value } });

function problem(status, title, invocation, detail) {
  return json({ Type: null, Title: title, Status: status, Detail: "AuthorizationUnsuccessful", Instance: guidOf(invocation.callId), Extensions: typeof detail === "string" ? { reason: detail } : {} });
}

/** Deterministic GUID-shaped rendering of the framework call id for the envelope Id. */
function guidOf(callId) {
  const hex = [];
  const text = String(callId);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < 32; i += 1) {
    const code = i < text.length ? text.charCodeAt(text.length - 1 - (i % text.length)) : i;
    h1 = Math.imul(h1 ^ code ^ i, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (h1 >>> 8) ^ (text.charCodeAt(i % Math.max(1, text.length)) || 0), 2246822519) >>> 0;
    hex.push(((h1 ^ h2) & 15).toString(16));
  }
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

/**
 * Envelope body in Xero field order. Idempotent replays come back from Firedrill's receipt store as canonical JSON
 * (keys sorted), so the body is always projected through `ENVELOPE`; a first response and its replay then differ only
 * in the per-request Id, as on Xero.
 */
function encodeEnvelope({ invocation, outcome }) {
  if (outcome.status !== "ok") return errorResponse(invocation, outcome);
  const value = { Id: guidOf(invocation.callId) };
  for (const [key, inner] of Object.entries(outcome.value)) if (key !== "organisationDate") value[key] = inner;
  return { headers: {}, body: { kind: "json", value: orderFields(value, ENVELOPE) } };
}

function encodeEmpty(result) {
  if (result.outcome.status !== "ok") return errorResponse(result.invocation, result.outcome);
  return { body: { kind: "empty" } };
}

export { args, bodyArgs, boolParam, clip, encodeEmpty, encodeEnvelope, intParam, listCommon, listParam, paged, param, tenant, unitdp, withKey, JSON_TYPE };
