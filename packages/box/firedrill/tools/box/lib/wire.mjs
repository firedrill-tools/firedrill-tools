// Pure HTTP codecs: Box query/path/header/JSON/multipart requests into operation arguments, and Box responses and
// error envelopes out. A request that cannot be mapped travels as `__request_error`, which every closed input schema
// rejects, so the caller gets Box's 400 `bad_request` envelope carrying that message.
import { ERRORS } from "./errors.mjs";
import { parseMultipart } from "./multipart.mjs";
import { utf8Encode } from "./util.mjs";

const MAX_DEPTH = 512;
const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const HELP = "https://developer.box.com/guides/api-calls/permissions-and-errors/common-errors/";

const last = (values) => (Array.isArray(values) && values.length > 0 ? values[values.length - 1] : undefined);
const refuse = (message) => ({ arguments: { __request_error: message } });

function shapeProblem(value) {
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > MAX_DEPTH) return "request body is nested too deeply";
    if (node === null || typeof node !== "object") continue;
    if (!Array.isArray(node)) {
      for (const key of Object.keys(node)) if (BANNED_KEYS.has(key)) return `unknown field "${key}"`;
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  if (Object.hasOwn(value, "__proto__")) return 'unknown field "__proto__"';
  return null;
}

/** Common headers and query parameters shared by every route. */
function base(request, withIfMatch) {
  const args = {};
  const asUser = last(request.headers["as-user"]);
  if (asUser !== undefined) args.as_user = asUser;
  if (withIfMatch) {
    const ifMatch = last(request.headers["if-match"]);
    if (ifMatch !== undefined) args.if_match = ifMatch;
  }
  const fields = last(request.query.fields);
  if (fields !== undefined) args.fields = fields;
  return args;
}

const intOrRaw = (value) => (typeof value === "string" && /^[0-9]{1,6}$/.test(value) ? Number(value) : value);
const boolOrRaw = (value) => (value === "true" ? true : value === "false" ? false : value);
const listOrRaw = (value) => (typeof value === "string" ? value.split(",").slice(0, 1001).map((v) => v.trim()) : value);

function idempotency(request) {
  const key = last(request.headers["idempotency-key"]);
  return typeof key === "string" && key.length > 0 && key.length <= 255 ? { idempotencyKey: key } : {};
}

/** Builds a decoder from a spec: path params, query params with converters, header options and body kind. */
export function decoder({ path = [], query = {}, ifMatch = false, body = "none" }) {
  return (request) => {
    const args = base(request, ifMatch);
    for (const [name, convert] of Object.entries(query)) {
      const value = last(request.query[name]);
      if (value !== undefined) args[name] = convert(value);
    }
    let bodyValue = request.body.kind === "json" ? request.body.value : undefined;
    if (body === "textjson" && request.body.kind === "text" && request.body.value.trim().length > 0) {
      try {
        bodyValue = JSON.parse(request.body.value);
      } catch {
        return refuse("request body must be valid JSON");
      }
    }
    if ((body === "json" || body === "textjson") && bodyValue !== undefined) {
      const value = bodyValue;
      if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse("request body must be a JSON object");
      const problem = shapeProblem(value);
      if (problem !== null) return refuse(problem);
      for (const [key, v] of Object.entries(value)) if (!Object.hasOwn(args, key)) args[key] = v;
    }
    for (const name of path) args[name] = request.path[name] ?? "";
    return { arguments: args, ...idempotency(request) };
  };
}

export const Q = { int: intOrRaw, bool: boolOrRaw, list: listOrRaw, str: (v) => v };

/** Upload decoder: multipart `attributes` JSON part first, then the `file` part. */
export function uploadDecoder(withFileId) {
  return (request) => {
    const args = base(request, withFileId);
    const text = request.body.kind === "text" ? request.body.value : "";
    const parsed = parseMultipart(last(request.headers["content-type"]), text);
    if (parsed.error !== undefined) return refuse(parsed.error);
    const attributesPart = parsed.parts.findIndex((p) => p.name === "attributes");
    const filePart = parsed.parts.findIndex((p) => p.name === "file");
    if (filePart < 0) return refuse("multipart body is missing the file part");
    if (attributesPart < 0 && !withFileId) return refuse("multipart body is missing the attributes part");
    if (attributesPart > filePart) return refuse("the attributes part must come before the file part");
    if (attributesPart >= 0) {
      let attributes;
      try {
        attributes = JSON.parse(parsed.parts[attributesPart].body);
      } catch {
        return refuse("attributes part is not valid JSON");
      }
      if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) return refuse("attributes must be a JSON object");
      const problem = shapeProblem(attributes);
      if (problem !== null) return refuse(problem);
      for (const [key, v] of Object.entries(attributes)) if (!Object.hasOwn(args, key)) args[key] = v;
    }
    args.content = parsed.parts[filePart].body;
    if (withFileId) args.file_id = request.path.file_id ?? "";
    return { arguments: args, ...idempotency(request) };
  };
}

function requestId(invocation) {
  const raw = String(invocation?.callId ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return (raw.slice(-16) || "0").padStart(16, "0");
}

function errorResponse({ invocation, outcome }) {
  const error = outcome.error ?? {};
  const refusal = invocation?.arguments?.__request_error;
  let code = String(error.code ?? "").replace(/^tool\./, "");
  if (outcome.status === "invalid") code = "BAD_REQUEST";
  else if (outcome.status === "denied") code = "ACCESS_DENIED";
  else if (outcome.status === "unsupported") code = "NOT_FOUND";
  const [status, boxCode] = ERRORS.get(code) ?? [500, "internal_server_error"];
  let message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Request could not be processed";
  if (outcome.status === "invalid") message = typeof refusal === "string" ? `Bad Request: ${refusal}` : `Bad Request: ${message}`;
  let contextInfo = error.details?.context_info;
  if (outcome.status === "invalid" && Array.isArray(error.issues) && error.issues.length > 0) {
    contextInfo = { errors: error.issues.slice(0, 10).map((issue) => ({
      reason: "invalid_parameter", name: Array.isArray(issue.path) ? issue.path.join(".") : "", message: String(issue.message ?? "invalid value"),
    })) };
  }
  const body = { type: "error", status, code: boxCode, message, ...(contextInfo !== undefined ? { context_info: contextInfo } : {}), help_url: HELP, request_id: requestId(invocation) };
  const retry = code === "RATE_LIMITED" || code === "UNAVAILABLE";
  return { ...(retry ? { headers: { "retry-after": "1" } } : {}), body: { kind: "json", value: body } };
}

export const jsonEncoder = (result) => (result.outcome.status === "ok" ? { body: { kind: "json", value: result.outcome.value } } : errorResponse(result));
export const emptyEncoder = (result) => (result.outcome.status === "ok" ? { body: { kind: "empty" } } : errorResponse(result));

const TYPES = new Map([["csv", "text/csv"], ["md", "text/markdown; charset=utf-8"], ["json", "application/json"], ["txt", "text/plain; charset=utf-8"]]);

export function downloadEncoder(result) {
  if (result.outcome.status !== "ok") return errorResponse(result);
  const value = result.outcome.value;
  const dot = value.name.lastIndexOf(".");
  const ext = dot > 0 ? value.name.slice(dot + 1).toLowerCase() : "";
  let disposition = 'attachment; filename="download"';
  try {
    disposition = `attachment; filename*=UTF-8''${encodeURIComponent(value.name)}`;
  } catch {
    // a lone surrogate in the name cannot be percent-encoded; keep the generic filename
  }
  return {
    headers: { "content-disposition": disposition, etag: `"${value.version_id}"` },
    body: { kind: "bytes", value: utf8Encode(value.content), contentType: TYPES.get(ext) ?? "text/plain; charset=utf-8" },
  };
}
