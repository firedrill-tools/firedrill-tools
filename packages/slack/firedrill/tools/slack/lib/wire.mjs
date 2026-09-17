// Slack Web API wire helpers: query/form parameters → typed arguments, and the `{ ok: false, error }` envelope.
// Pure functions with no state access, so the HTTP codecs can use them.
import { lowerSnake } from "./ids.mjs";

/** Seconds a rate-limited client should wait; sent as `Retry-After` with every 429. */
export const RETRY_AFTER_SECONDS = "30";

/**
 * Parameters of a Slack call: the query string on GET; on POST an `application/x-www-form-urlencoded` body (the SDK
 * convention, also assumed when no content type is sent) or an `application/json` object body, as the Web API accepts
 * both with a bearer token. Routes declare the body as raw text so this codec can tell the two apart itself. Every
 * value is normalised to the form shape (name → list of strings; JSON arrays and objects re-encoded as JSON text), so
 * the typed readers below work the same for both encodings.
 */
export function params(request) {
  if (request.method === "GET") return request.query;
  const body = request.body ?? {};
  if (body.kind === "form") return body.value;
  if (body.kind !== "text" || typeof body.value !== "string") return Object.create(null);
  const type = mediaType(last(request.headers?.["content-type"]));
  if (type === "application/json" || type.endsWith("+json")) return jsonParams(body.value);
  if (type === "" || type === "application/x-www-form-urlencoded") return formParams(body.value);
  throw new TypeError("request content type must be application/x-www-form-urlencoded or application/json");
}

function mediaType(header) {
  return typeof header === "string" ? header.split(";", 1)[0].trim().toLowerCase() : "";
}

function formParams(text) {
  const form = Object.create(null);
  for (const [name, value] of new URLSearchParams(text)) {
    if (form[name] === undefined) form[name] = [];
    form[name].push(value);
  }
  return form;
}

/** A JSON body must be an object (Slack: invalid_json / json_not_object); values become form strings. */
function jsonParams(text) {
  if (text.trim().length === 0) return Object.create(null);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("request body must be valid JSON (Slack: invalid_json)");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("request body must be a JSON object (Slack: json_not_object)");
  }
  const form = Object.create(null);
  for (const [name, value] of Object.entries(parsed)) {
    if (value === null || value === undefined) continue;
    form[name] = [typeof value === "object" ? jsonText(name, value) : String(value)];
  }
  return form;
}

function jsonText(name, value) {
  try {
    return JSON.stringify(value);
  } catch {
    throw new TypeError(`${name} nests too deeply`);
  }
}

/** Slack keeps the last value of a repeated parameter. */
function last(values) {
  return values === undefined || values.length === 0 ? undefined : values[values.length - 1];
}

export function str(source, name) {
  return last(source[name]);
}

export function int(source, name) {
  const value = last(source[name]);
  if (value === undefined) return undefined;
  if (!/^-?[0-9]{1,9}$/.test(value)) throw new TypeError(`${name} must be an integer`);
  return Number(value);
}

export function bool(source, name) {
  const value = last(source[name]);
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new TypeError(`${name} must be true, false, 1 or 0`);
}

/** `blocks`/`attachments` travel as a JSON string inside the form, exactly as the official SDKs send them. */
export function json(source, name) {
  const value = last(source[name]);
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError(`${name} must be a JSON string`);
  }
}

/** Drop undefined values so the arguments object validates against the input schema. */
export function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** Mutations accept an optional X-Firedrill-Idempotency-Key header (Slack clients never send one). */
export function operationInput(request, args) {
  const key = last(request.headers["x-firedrill-idempotency-key"]);
  return key === undefined || key.length === 0 ? { arguments: args } : { arguments: args, idempotencyKey: key };
}

/**
 * Slack-shaped error body for every non-ok outcome. Status codes are framework-owned (declared per route);
 * real Slack answers HTTP 200 with ok:false for most of these, which this Tool cannot reproduce.
 */
export function slackError(invocation, outcome) {
  const error = outcome.error ?? {};
  const message = typeof error.message === "string" ? error.message : "";
  if (outcome.status === "denied") {
    const needed = `${invocation.operation.packageId}.${invocation.operation.operationId}`;
    return {
      headers: {},
      body: { kind: "json", value: { ok: false, error: "missing_scope", needed, provided: "" } },
    };
  }
  if (outcome.status === "unsupported") {
    return { headers: {}, body: { kind: "json", value: { ok: false, error: "unknown_method" } } };
  }
  if (outcome.status === "invalid") {
    return {
      headers: {},
      body: {
        kind: "json",
        value: { ok: false, error: "invalid_arguments", response_metadata: { messages: [message || "invalid arguments"] } },
      },
    };
  }
  const code = String(error.code ?? "").replace(/^tool\./, "");
  const wire = code.length > 0 ? lowerSnake(code) : "internal_error";
  const value = { ok: false, error: wire };
  if (message.length > 0 && message !== wire) value.response_metadata = { messages: [message] };
  return { headers: wire === "ratelimited" ? { "retry-after": RETRY_AFTER_SECONDS } : {}, body: { kind: "json", value } };
}
