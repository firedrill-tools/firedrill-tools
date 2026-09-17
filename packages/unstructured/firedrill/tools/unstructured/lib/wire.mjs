// Pure HTTP codecs. `decode` folds path, query and JSON body into snake_case arguments; a request that cannot be
// mapped travels as `__request_error` ("400:…" or "422:…") so the handler answers the FastAPI `{ detail }` envelope.
// `encode` renders success bodies and every failure as `{ "detail": "…" }` or `{ "detail": [ { loc, msg, type } ] }`.
import { STATUS } from "./errors.mjs";
import { clip } from "./util.mjs";

const MAX_DEPTH = 512;
const MAX_REPEATS = 50;
const MAX_MEMBERS = 20000;
const BANNED = new Set(["__proto__", "constructor", "prototype"]);
export const RESERVED = "__request_error";

/** Iterative shape check (explicit stack): nesting depth, member count and prototype-poisoning keys. */
export function shapeProblem(value) {
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
        if (BANNED.has(key)) return `Invalid key "${clip(key, 60)}"`;
        const child = node[key];
        if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
      }
    }
  }
  return null;
}

export const Q = {
  str: (value) => value,
  int: (value) => (typeof value === "string" && /^-?[0-9]{1,15}$/.test(value) ? Number(value) : value),
};

export function headerOf(request, name) {
  const values = request.headers[name];
  return Array.isArray(values) && values.length > 0 ? values[values.length - 1] : null;
}

/**
 * Builds a decoder: `path` lists path parameters copied verbatim; `query` maps names to converters; `body` is "json"
 * (object required; known `fields` copied, unknown keys reported as 422 extra inputs) or "none".
 */
export function decoder({ path = [], query = {}, body = "none", fields = [], idem = true }) {
  const known = new Set(fields);
  return (request) => {
    const args = {};
    for (const name of path) args[name] = typeof request.path[name] === "string" ? request.path[name] : "";
    const refuse = (message) => ({ arguments: { ...args, [RESERVED]: clip(message, 300) } });
    for (const [name, convert] of Object.entries(query)) {
      const values = request.query[name];
      if (!Array.isArray(values) || values.length === 0) continue;
      if (values.length > MAX_REPEATS) return refuse(`422:loc=query.${name}: Parameter is repeated more than ${MAX_REPEATS} times`);
      args[name] = convert(values[values.length - 1]);
    }
    if (body === "json") {
      if (request.body.kind === "json") {
        const value = request.body.value;
        if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse("422:loc=body: Input should be a valid dictionary or object");
        const problem = shapeProblem(value);
        if (problem !== null) return refuse(`422:loc=body: ${problem}`);
        const extra = [];
        for (const key of Object.keys(value)) {
          if (key === RESERVED || Object.hasOwn(args, key)) continue;
          if (known.has(key)) args[key] = value[key];
          else extra.push(key);
        }
        if (extra.length > 0) return refuse(`422:${extra.slice(0, 20).map((key) => `loc=body.${clip(key, 100)}: Extra inputs are not permitted`).join(" | ")}`);
      } else if (request.body.kind === "form" || (request.body.kind === "text" && request.body.value.trim().length > 0)) {
        return refuse("422:loc=body: Input should be a valid dictionary or object");
      } else if (request.body.kind === "none" || request.body.kind === "text") {
        if (request.method === "POST" || request.method === "PUT") {
          if (fields.length > 0) return refuse("422:loc=body: Field required");
        }
      }
    }
    const out = { arguments: args };
    if (idem) {
      const key = headerOf(request, "idempotency-key");
      if (typeof key === "string" && key.length > 0 && key.length <= 255) out.idempotencyKey = key;
    }
    return out;
  };
}

const TYPE_BY_TEXT = [
  ["Field required", "missing"],
  ["Input should be a valid integer", "int_parsing"],
  ["Input should be a valid boolean", "bool_parsing"],
  ["Input should be a valid dictionary", "dict_type"],
  ["Input should be a valid list", "list_type"],
  ["Input should be a valid string", "string_type"],
  ["Extra inputs are not permitted", "extra_forbidden"],
  ["Input should be less than max_characters", "value_error"],
  ["Input should be greater than or equal to", "greater_than_equal"],
  ["Input should be greater than", "greater_than"],
  ["Input should be less than or equal to", "less_than_equal"],
  ["Input should be less than", "less_than"],
  ["String should have at least", "string_too_short"],
  ["String should have at most", "string_too_long"],
  ["String should match pattern", "string_pattern_mismatch"],
  ["List should have at most", "too_long"],
  ["Input should be ", "enum"],
];

/** "loc=body.files: Field required | loc=query.page: …" -> FastAPI detail array. */
export function detailArray(message) {
  const out = [];
  for (const piece of message.split(" | ")) {
    const match = /^loc=([^:]*): ?(.*)$/s.exec(piece);
    const loc = match ? match[1].split(".").filter((s) => s.length > 0) : ["body"];
    const msg = clip(match ? match[2] : piece, 300);
    let type = "value_error";
    for (const [prefix, name] of TYPE_BY_TEXT) if (msg.startsWith(prefix)) {
      type = name;
      break;
    }
    out.push({ loc, msg, type });
  }
  return out;
}

export function encodeError({ invocation, outcome }) {
  const error = outcome.error ?? {};
  const refusal = invocation?.arguments?.[RESERVED];
  const json = (value, headers) => (headers ? { headers, body: { kind: "json", value } } : { body: { kind: "json", value } });
  if (outcome.status === "invalid") {
    if (typeof refusal === "string") return json({ detail: detailArray(refusal.replace(/^\d{3}:/, "")) });
    const issues = Array.isArray(error.issues) ? error.issues.slice(0, 20) : [];
    const detail = issues.map((issue) => ({
      loc: ["body", ...(Array.isArray(issue.path) ? issue.path.slice(0, 8).map((p) => clip(String(p), 100)) : [])],
      msg: clip(String(issue.message ?? "Input is invalid"), 300),
      type: "value_error",
    }));
    return json({ detail: detail.length > 0 ? detail : [{ loc: ["body"], msg: "Input is invalid", type: "value_error" }] });
  }
  if (outcome.status === "denied") return json({ detail: "This API key is not granted this operation in the Firedrill world." });
  if (outcome.status === "unsupported") return json({ detail: "Not Found" });
  const code = String(error.code ?? "").replace(/^tool\./, "");
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Internal Server Error";
  if (code === "VALIDATION_ERROR" && message.startsWith("loc=")) return json({ detail: detailArray(message) });
  if (code === "RATE_LIMITED") return json({ detail: message }, { "retry-after": "1" });
  return json({ detail: STATUS.has(code) ? message : "Internal Server Error" });
}

/** Success -> the canonical value verbatim; failure -> the envelope. */
export const encoder = (result) => (result.outcome.status === "ok" ? { body: { kind: "json", value: result.outcome.value } } : encodeError(result));
