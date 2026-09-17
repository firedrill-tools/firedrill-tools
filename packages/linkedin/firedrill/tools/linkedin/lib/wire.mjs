// Pure HTTP helpers: request inspection that never throws, and LinkedIn success/error responses.
// Problems a decoder finds travel to the handler as `wire.error` (→ BAD_REQUEST) or `wire.fieldError` (→ INVALID_VALUE_FOR_FIELD),
// so every refusal is answered in LinkedIn's envelope.
import { ERRORS } from "./errors.mjs";

const MAX_DEPTH = 512;
const MAX_REPEAT = 20;
const BANNED = new Set(["__proto__", "constructor", "prototype"]);
const PROTOCOL = { "x-restli-protocol-version": "2.0.0" };

export const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const last = (values) => (Array.isArray(values) && values.length > 0 ? values[values.length - 1] : undefined);
const clip = (value) => (typeof value === "string" ? value.slice(0, 64) : null);

/** Iterative depth and reserved-key check for a JSON body. */
export function shapeProblem(value) {
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > MAX_DEPTH) return "Request body is nested too deeply";
    if (node === null || typeof node !== "object") continue;
    if (!Array.isArray(node)) for (const key of Object.keys(node)) if (BANNED.has(key)) return `Unpermitted fields present in REQUEST_BODY: [/${key}]`;
    for (const child of Array.isArray(node) ? node : Object.values(node)) if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
  }
  return null;
}

/** Starts a request decode: the `wire` block plus query-level checks shared by every route. */
export function begin(request, { rest, requireMethod = false }) {
  const headers = isObject(request.headers) ? request.headers : {};
  const query = isObject(request.query) ? request.query : {};
  const wire = {
    route: String(request.routeId ?? "").slice(0, 64), rest, linkedinVersion: clip(last(headers["linkedin-version"])),
    restliMethod: clip(last(headers["x-restli-method"])), requireMethod, error: null, fieldError: null,
  };
  for (const name of Object.keys(query)) {
    const values = query[name];
    if (Array.isArray(values) && values.length > MAX_REPEAT) wire.error = "Invalid query parameters passed to request";
    if (name === "ids") wire.error = "Batch get is not supported: Invalid query parameters passed to request";
  }
  return { wire, args: {}, query };
}

/** Reads one query value; U+FFFD (mangled percent-encoding) marks the request invalid. */
export function queryValue(state, name) {
  const value = last(state.query[name]);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.includes("�")) {
    state.wire.error = "Invalid query parameters passed to request";
    return undefined;
  }
  return value;
}

/** Decimal integer query value (`start`, `count`). */
export function queryInt(state, name) {
  const value = queryValue(state, name);
  if (value === undefined) return undefined;
  if (!/^[0-9]{1,7}$/.test(value)) {
    state.wire.error = `Invalid query parameters passed to request: ${name}`;
    return undefined;
  }
  return Number(value);
}

/** The JSON object body, or null after recording a refusal (absent bodies read as an empty object). */
export function jsonBody(state, request) {
  const body = request.body;
  if (!isObject(body) || body.kind === "none") return {};
  if (body.kind !== "json" || !isObject(body.value)) {
    state.wire.error = "Request body must be a JSON object";
    return null;
  }
  const problem = shapeProblem(body.value);
  if (problem !== null) {
    state.wire.error = problem;
    return null;
  }
  return body.value;
}

/** Copies allowed body fields; any other field is refused like LinkedIn's unpermitted-field check. */
export function copyFields(state, body, allowed) {
  if (body === null) return;
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) state.args[key] = body[key];
    else if (state.wire.error === null) state.wire.error = `Unpermitted fields present in REQUEST_BODY: [/${key}]`;
  }
}

export const pathValue = (request, name) => (isObject(request.path) && typeof request.path[name] === "string" ? request.path[name] : "");

export const finish = (state) => ({ arguments: { ...state.args, wire: state.wire } });

function errorResponse({ invocation, outcome }, v2) {
  const error = isObject(outcome?.error) ? outcome.error : {};
  let code = String(error.code ?? "");
  code = code.slice(code.lastIndexOf(".") + 1);
  let message = typeof error.message === "string" && error.message !== "" ? error.message : "Request could not be processed";
  if (outcome?.status === "invalid") {
    code = "BAD_REQUEST";
    const issue = Array.isArray(error.issues) && error.issues.length > 0 ? error.issues[0] : null;
    const where = issue !== null && Array.isArray(issue.path) ? issue.path.join("/") : "";
    message = issue === null ? "Invalid request" : `Invalid value for field ${where}: ${String(issue.message ?? "invalid value")}`;
  } else if (outcome?.status === "denied") {
    code = "ACCESS_DENIED";
    message = "Not enough permissions to access this resource";
  } else if (outcome?.status === "unsupported") {
    code = "NOT_FOUND";
  }
  const [status, serviceErrorCode] = ERRORS.get(code) ?? [500, 0];
  if (!ERRORS.has(code)) code = "INTERNAL_SERVER_ERROR";
  void invocation;
  const body = v2 ? { status, serviceErrorCode, message } : { status, serviceErrorCode, code, message };
  return { headers: PROTOCOL, body: { kind: "json", value: body } };
}

/** Encoder factory: `shape(value)` → `{ headers?, body? }` for the success case; `v2` selects the envelope without `code`. */
export function encoder(shape, v2 = false) {
  return (result) => {
    if (result.outcome?.status !== "ok") return errorResponse(result, v2);
    const { headers = {}, body } = shape(result.outcome.value);
    return { headers: { ...PROTOCOL, ...headers }, body: body === undefined ? { kind: "empty" } : { kind: "json", value: body } };
  };
}
