// Pure HTTP codecs: Documenso API v2 query/path/JSON/multipart requests into operation arguments, and JSON bodies and
// `{ message, code, issues? }` error envelopes out. A request that cannot be mapped travels as `__request_error`, which
// every closed input schema rejects, so the caller receives the provider's 400 BAD_REQUEST envelope with that message.
import { parseMultipart } from "./multipart.mjs";

const MAX_DEPTH = 512;
const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const last = (values) => (Array.isArray(values) && values.length > 0 ? values[values.length - 1] : undefined);
const refuse = (message) => ({ arguments: { __request_error: message } });

function shapeProblem(value) {
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > MAX_DEPTH) return "request body is nested too deeply";
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const child of node) if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    } else {
      for (const key of Object.keys(node)) {
        if (BANNED_KEYS.has(key)) return `unknown field "${key}"`;
        const child = node[key];
        if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
      }
    }
  }
  return null;
}

/** Decimal id strings become numbers; anything else stays a string so the handler answers BAD_REQUEST. */
const idOrRaw = (value) => (typeof value === "string" && /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : value);
const intOrRaw = (value) => (typeof value === "string" && /^[0-9]{1,9}$/.test(value) ? Number(value) : value);
const boolOrRaw = (value) => (value === "true" ? true : value === "false" ? false : value);
export const Q = { id: idOrRaw, int: intOrRaw, bool: boolOrRaw, str: (value) => value };

function copyInto(args, value) {
  for (const key of Object.keys(value)) if (!Object.hasOwn(args, key)) args[key] = value[key];
}

/** Builds a decoder: `query` maps names to converters, `path` maps names to converters, `body` is "json" or "none". */
export function decoder({ query = {}, path = {}, body = "none" }) {
  return (request) => {
    const args = {};
    for (const [name, convert] of Object.entries(path)) args[name] = convert(request.path[name] ?? "");
    for (const [name, convert] of Object.entries(query)) {
      const value = last(request.query[name]);
      if (value !== undefined) args[name] = convert(value);
    }
    if (body === "json" && request.body.kind === "json") {
      const value = request.body.value;
      if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse("request body must be a JSON object");
      const problem = shapeProblem(value);
      if (problem !== null) return refuse(problem);
      copyInto(args, value);
    }
    return { arguments: args };
  };
}

/** POST /document/create: multipart with a `payload` JSON part and a `file` part carrying UTF-8 text. */
export function createDecoder(request) {
  const text = request.body.kind === "text" ? request.body.value : "";
  const parsed = parseMultipart(last(request.headers["content-type"]), text);
  if (parsed.error !== undefined) return refuse(parsed.error);
  const payloadPart = parsed.parts.find((part) => part.name === "payload");
  const filePart = parsed.parts.find((part) => part.name === "file");
  if (payloadPart === undefined) return refuse("multipart body is missing the payload part");
  if (filePart === undefined || filePart.filename === null) return refuse("multipart body is missing the file part");
  let payload;
  try {
    payload = JSON.parse(payloadPart.body);
  } catch {
    return refuse("payload part is not valid JSON");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return refuse("payload must be a JSON object");
  const problem = shapeProblem(payload);
  if (problem !== null) return refuse(problem);
  return { arguments: { payload, file: { name: filePart.filename, content: filePart.body } } };
}

function errorResponse({ invocation, outcome }) {
  const error = outcome.error ?? {};
  let code = String(error.code ?? "").replace(/^tool\./, "");
  let message = typeof error.message === "string" && error.message.length > 0 ? error.message : "An unknown error occurred";
  let issues = Array.isArray(error.details?.issues) ? error.details.issues : undefined;
  if (outcome.status === "invalid") {
    code = "BAD_REQUEST";
    const refusal = invocation?.arguments?.__request_error;
    if (typeof refusal === "string") {
      message = refusal;
      issues = [{ message: refusal }];
    } else {
      issues = (Array.isArray(error.issues) ? error.issues : []).slice(0, 10).map((issue) => ({
        message: String(issue?.message ?? "Invalid value"), ...(Array.isArray(issue?.path) ? { path: issue.path.map(String) } : {}),
      }));
      message = issues.length > 0 ? `Invalid input: ${issues[0].message}` : "Invalid input";
    }
  } else if (outcome.status === "denied") {
    code = "FORBIDDEN";
  } else if (outcome.status === "unsupported") {
    code = "NOT_FOUND";
  }
  const body = { message, code: code || "UNKNOWN_ERROR", ...(code === "BAD_REQUEST" ? { issues: issues ?? [{ message }] } : {}) };
  const headers = code === "TOO_MANY_REQUESTS" ? { "retry-after": "60", "x-ratelimit-limit": "1000", "x-ratelimit-remaining": "0" } : undefined;
  return { ...(headers ? { headers } : {}), body: { kind: "json", value: body } };
}

export const jsonEncoder = (result) => (result.outcome.status === "ok" ? { body: { kind: "json", value: result.outcome.value } } : errorResponse(result));
