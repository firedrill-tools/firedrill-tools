// Pure HTTP codecs for the Dropbox API v2 routes: RPC JSON bodies, content-upload/download arguments in the
// Dropbox-API-Arg header (or `arg` query parameter), and Dropbox's error envelopes (400 text; 401/409 JSON
// `{error_summary, error}`; 429 JSON with Retry-After; 500 text). A request that cannot be mapped travels to the
// operation as a single `__request_error` argument, which every closed input schema rejects, so `encode` can answer it
// in Dropbox's 400 text form.
import { asciiJson, base64Decode, utf8Encode } from "./util.mjs";

const MAX_DEPTH = 512;
const TEXT_CODES = new Set(["BAD_REQUEST", "CONTENT_HASH_MISMATCH", "PAYLOAD_TOO_LARGE"]);
const RATE_REASONS = new Map([["RATE_LIMITED", "too_many_requests"], ["TOO_MANY_WRITE_OPERATIONS", "too_many_write_operations"]]);
const JSON_TYPES = new Set(["application/json", "application/json; charset=utf-8", "text/plain; charset=dropbox-cors-hack"]);
const UPLOAD_TYPES = new Set(["application/octet-stream", "text/plain; charset=dropbox-cors-hack"]);

function last(values) {
  return Array.isArray(values) && values.length > 0 ? values[values.length - 1] : undefined;
}

const refuse = (message) => ({ arguments: { __request_error: message } });

function mediaType(value) {
  return typeof value === "string" ? value.toLowerCase().split(";").map((part) => part.trim()).filter((p) => p.length > 0).join("; ") : undefined;
}

/** Walks a parsed JSON value iteratively: "deep" past MAX_DEPTH, "proto" for an own `__proto__` key, else null. */
function shapeProblem(value) {
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > MAX_DEPTH) return "deep";
    if (node !== null && typeof node === "object") {
      if (!Array.isArray(node) && Object.hasOwn(node, "__proto__")) return "proto";
      for (const child of Array.isArray(node) ? node : Object.values(node)) {
        if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
      }
    }
  }
  return null;
}

/** Parses a JSON object argument; returns the object or a refusal message string. */
function parseObject(text, where) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return `${where}: could not decode input as JSON`;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return `${where}: expected an object`;
  const problem = shapeProblem(value);
  if (problem === "deep") return `${where}: input is nested too deeply`;
  if (problem === "proto") return `${where}: unknown field "__proto__"`;
  return value;
}

function unsupportedHeaders(request) {
  for (const name of ["dropbox-api-select-user", "dropbox-api-select-admin", "dropbox-api-path-root"]) {
    if (request.headers[name] !== undefined) return `the "${name}" header is not supported by this synthetic service`;
  }
  return null;
}

export function rpcDecode(request) {
  const unsupported = unsupportedHeaders(request);
  if (unsupported !== null) return refuse(unsupported);
  const text = request.body.kind === "text" ? request.body.value : "";
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "null") return { arguments: {} };
  const type = mediaType(last(request.headers["content-type"]));
  if (!JSON_TYPES.has(type)) {
    return refuse(`Bad HTTP "Content-Type" header: "${type ?? ""}".  Expecting one of "application/json", "application/json; charset=utf-8", "text/plain; charset=dropbox-cors-hack".`);
  }
  const value = parseObject(text, "request body");
  return typeof value === "string" ? refuse(value) : { arguments: value };
}

function contentArguments(request) {
  const unsupported = unsupportedHeaders(request);
  if (unsupported !== null) return unsupported;
  const header = last(request.headers["dropbox-api-arg"]);
  const query = last(request.query.arg);
  if (header !== undefined && query !== undefined) return 'provide either the "Dropbox-API-Arg" header or the "arg" URL parameter, not both';
  if (header === undefined && query === undefined) return 'Must provide HTTP header "Dropbox-API-Arg" or URL parameter "arg".';
  const value = parseObject(header ?? query, header !== undefined ? 'HTTP header "Dropbox-API-Arg"' : 'URL parameter "arg"');
  if (typeof value !== "string" && Object.hasOwn(value, "content")) return 'HTTP header "Dropbox-API-Arg": unknown field "content"';
  return value;
}

export function uploadDecode(request) {
  const args = contentArguments(request);
  if (typeof args === "string") return refuse(args);
  const type = mediaType(last(request.headers["content-type"]));
  if (!UPLOAD_TYPES.has(type)) {
    return refuse(`Bad HTTP "Content-Type" header: "${type ?? ""}".  Expecting one of "application/octet-stream", "text/plain; charset=dropbox-cors-hack".`);
  }
  return { arguments: { ...args, content: request.body.kind === "text" ? request.body.value : "" } };
}

export function downloadDecode(request) {
  const args = contentArguments(request);
  return typeof args === "string" ? refuse(args) : { arguments: args };
}

function errorResponse(fn, invocation, outcome) {
  const error = outcome.error ?? {};
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "request could not be processed";
  const refusal = invocation?.arguments?.__request_error;
  const text = (reason) => ({ body: { kind: "text", value: `Error in call to API function "${fn}": ${reason}` } });
  if (outcome.status === "invalid") return text(typeof refusal === "string" ? refusal : message);
  if (outcome.status === "denied") {
    return { body: { kind: "json", value: { error_summary: "no_permission/...", error: { ".tag": "no_permission" } } } };
  }
  if (outcome.status === "unsupported") return { body: { kind: "text", value: `Unknown API function: "${fn}"` } };
  const code = String(error.code ?? "").replace(/^tool\./, "");
  if (TEXT_CODES.has(code)) return text(message);
  const rate = RATE_REASONS.get(code);
  if (rate !== undefined) {
    return {
      headers: { "retry-after": "1" },
      body: { kind: "json", value: { error_summary: `${rate}/...`, error: { reason: { ".tag": rate }, retry_after: 1 } } },
    };
  }
  const details = error.details;
  if (details !== null && typeof details === "object" && typeof details.error_summary === "string") {
    return { body: { kind: "json", value: { error_summary: details.error_summary, error: details.error } } };
  }
  return { body: { kind: "text", value: "Internal Server Error" } };
}

/** Encoder for a route: `shape` post-processes successful values (download → bytes, revoke → null, …). */
export function encoder(fn, shape) {
  return ({ invocation, outcome }) => {
    if (outcome.status !== "ok") return errorResponse(fn, invocation, outcome);
    return shape === undefined ? { body: { kind: "json", value: outcome.value } } : shape(outcome.value);
  };
}

export const withoutServerTime = (value) => {
  const { server_time, ...rest } = value;
  return { body: { kind: "json", value: rest } };
};

export const nullBody = () => ({ body: { kind: "json", value: null } });

export function downloadBody(value) {
  const bytes = value.content_kind === "base64" ? base64Decode(value.content) ?? new Uint8Array(0) : utf8Encode(value.content);
  return {
    headers: { "dropbox-api-result": asciiJson(value.metadata), etag: `W/"${value.metadata.rev}"` },
    body: { kind: "bytes", value: bytes, contentType: "application/octet-stream" },
  };
}
