// Pure HTTP codecs for the provider-shaped routes. `decode` maps path, query and JSON body into the canonical
// snake_case arguments; a request that cannot be mapped travels as `__request_error`, which every handler checks
// first so the caller receives the provider envelope and status instead of a framework message. `encode` passes
// success bodies through and renders `{ statusCode, message, error }` for every failure.
import { ERRORS } from "./errors.mjs";
import { clip } from "./util.mjs";

const MAX_DEPTH = 512;
const MAX_REPEATS = 16;
const MAX_MEMBERS = 20000;
const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RESERVED = "__request_error";

/** Iterative shape check (explicit stack): depth, member count and prototype-poisoning keys. */
function shapeProblem(value) {
  const stack = [[value, 1]];
  let visited = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > MAX_DEPTH) return "Request body is nested too deeply";
    if (node === null || typeof node !== "object") continue;
    visited += 1;
    if (visited > MAX_MEMBERS) return "Request body has too many members";
    if (Array.isArray(node)) {
      if (node.length > MAX_MEMBERS) return "Request body has too many array entries";
      for (const child of node) if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    } else {
      for (const key of Object.keys(node)) {
        if (BANNED_KEYS.has(key)) return `Invalid key "${clip(key, 60)}"`;
        const child = node[key];
        if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
      }
    }
  }
  return null;
}

const intOrRaw = (value) => (typeof value === "string" && /^-?[0-9]{1,15}$/.test(value) ? Number(value) : value);

export const Q = {
  str: (value) => value,
  int: intOrRaw,
  list: null, // marker: collect every repetition into an array
};

/**
 * Builds a decoder. `path` lists path parameter names copied verbatim; `query` maps query names to converters
 * (Q.list collects repetitions); `body` is "json" or "none"; `idem` reads the Idempotency-Key header.
 */
export function decoder({ path = [], query = {}, body = "none", idem = false }) {
  return (request) => {
    const args = {};
    for (const name of path) args[name] = typeof request.path[name] === "string" ? request.path[name] : "";
    const refuse = (message) => ({ arguments: { ...args, [RESERVED]: clip(message, 300) } });

    for (const [name, convert] of Object.entries(query)) {
      const values = request.query[name];
      if (!Array.isArray(values) || values.length === 0) continue;
      if (values.length > MAX_REPEATS) return refuse(`Query parameter ${name} is repeated more than ${MAX_REPEATS} times`);
      if (convert === null) args[name] = values.slice();
      else args[name] = convert(values[values.length - 1]);
    }

    if (body === "json") {
      if (request.body.kind === "json") {
        const value = request.body.value;
        if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse("Request body must be a JSON object");
        const problem = shapeProblem(value);
        if (problem !== null) return refuse(problem);
        for (const key of Object.keys(value)) {
          if (key === RESERVED || Object.hasOwn(args, key)) continue;
          args[key] = value[key];
        }
      } else if (request.body.kind === "text" && request.body.value.trim().length > 0) {
        return refuse("Request body must be JSON");
      } else if (request.body.kind === "form") {
        return refuse("Request body must be JSON");
      }
    }

    const out = { arguments: args };
    if (idem) {
      const keys = request.headers["idempotency-key"];
      const key = Array.isArray(keys) && keys.length > 0 ? keys[keys.length - 1] : undefined;
      if (typeof key === "string" && key.length > 0 && key.length <= 255) out.idempotencyKey = key;
    }
    return out;
  };
}

function envelope(status, message, reason) {
  return { statusCode: status, message: clip(message, 2000), error: reason };
}

/** Renders the failure envelope; framework outcomes keep the framework's fixed statuses (400/403/404). */
export function encodeError({ invocation, outcome }) {
  const error = outcome.error ?? {};
  const refusal = invocation?.arguments?.[RESERVED];
  if (outcome.status === "invalid") {
    let message = "Required parameters are missing or in the wrong format";
    if (typeof refusal === "string") message = refusal;
    else if (Array.isArray(error.issues) && error.issues.length > 0) {
      const issue = error.issues[0];
      const where = Array.isArray(issue.path) && issue.path.length > 0 ? clip(issue.path.join("."), 80) : "request";
      message = `${message}: ${where} ${clip(String(issue.message ?? "is invalid"), 200)}`;
    }
    return { body: { kind: "json", value: envelope(400, message, "Bad Request") } };
  }
  if (outcome.status === "denied") return { body: { kind: "json", value: envelope(403, "Forbidden", "Forbidden") } };
  if (outcome.status === "unsupported") return { body: { kind: "json", value: envelope(404, "Not Found", "Not Found") } };
  const code = String(error.code ?? "").replace(/^tool\./, "");
  const [status, reason] = ERRORS.get(code) ?? [500, "Internal Server Error"];
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : reason;
  const response = { body: { kind: "json", value: envelope(status, message, reason) } };
  if (code === "RATE_LIMITED") response.headers = { "retry-after": "1" };
  return response;
}

/** Success -> the canonical value verbatim; failure -> the envelope. */
export const encoder = (result) => (result.outcome.status === "ok" ? { body: { kind: "json", value: result.outcome.value } } : encodeError(result));
