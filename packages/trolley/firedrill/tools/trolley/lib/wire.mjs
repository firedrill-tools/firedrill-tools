// Trolley REST wire helpers: pure request decoding and the `{ ok:false, errors:[{ code, field, message }] }` envelope.
// No state, no clock. Statuses are framework-owned (declared per route in the manifest).
export const DECODE_ERROR_KEY = "__trolleyDecodeError";
const MAX_DEPTH = 512;

function carry(field, message) {
  return { arguments: { [DECODE_ERROR_KEY]: { code: "invalid_field", field, message } } };
}

function lastHeader(request, name) {
  const values = request.headers?.[name];
  return Array.isArray(values) && values.length > 0 ? values[values.length - 1] : undefined;
}

const IDEMPOTENCY_HEADER = "Idempotency-Key";
const MAX_IDEMPOTENCY_KEY = 255;
/** Framework idempotency outcomes rendered as Trolley `invalid_field` on the header (Trolley documents no such header). */
const IDEMPOTENCY_MESSAGES = new Map([
  ["world.IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request body"],
  ["framework.IDEMPOTENCY_NOT_SUPPORTED", "Idempotency-Key is not supported on this endpoint"],
  ["framework.IDEMPOTENCY_REQUIRED", "Idempotency-Key is required on this endpoint"],
]);

/** `{ idempotencyKey }` for a usable header, `{}` when absent or blank, or a carried invalid_field for an over-long key. */
function idempotency(request) {
  const key = lastHeader(request, "idempotency-key");
  if (typeof key !== "string" || key.trim().length === 0) return {};
  if (key.length > MAX_IDEMPOTENCY_KEY) return carry(IDEMPOTENCY_HEADER, `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY} characters`);
  return { idempotencyKey: key };
}

function hasReplacement(value) {
  return typeof value === "string" && value.includes("�");
}

/** Depth of a JSON value, measured with an explicit stack (stops counting past MAX_DEPTH). */
function tooDeep(value) {
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (depth > MAX_DEPTH) return true;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  return false;
}

/**
 * Builds a codec decode function. `query` maps allowed query names to "integer" | "string"; `body` is "json", "empty"
 * or "none". Decode never throws: unmappable input travels under DECODE_ERROR_KEY, which every closed input schema rejects,
 * and `encode` renders it as Trolley's 400 invalid_field.
 */
export function decoder({ query = {}, body = "none", pathKeys = {} } = {}) {
  return (request) => {
    const args = Object.create(null);
    for (const [name, value] of Object.entries(request.path ?? {})) {
      if (hasReplacement(value)) return carry(pathKeys[name] ?? name, "Value contains invalid characters");
      args[pathKeys[name] ?? name] = value;
    }
    for (const [name, values] of Object.entries(request.query ?? {})) {
      if (!Object.hasOwn(query, name)) return carry(name.slice(0, 200), "Unsupported query parameter");
      const value = Array.isArray(values) && values.length > 0 ? values[values.length - 1] : "";
      if (hasReplacement(value)) return carry(name, "Value contains invalid characters");
      if (query[name] === "integer") {
        if (!/^[0-9]{1,9}$/.test(value)) return carry(name, "Value must be a positive integer");
        args[name] = Number(value);
      } else {
        args[name] = value;
      }
    }
    if (body === "json") {
      const value = request.body?.kind === "json" ? request.body.value : undefined;
      if (value === null || typeof value !== "object" || Array.isArray(value)) return carry(null, "Request body must be a JSON object");
      if (tooDeep(value)) return carry(null, "Request body is nested too deeply");
      for (const [key, entry] of Object.entries(value)) {
        if (Object.hasOwn(args, key)) return carry(key.slice(0, 200), "Field is not allowed");
        args[key] = entry;
      }
    } else if (body === "empty") {
      const text = request.body?.kind === "text" ? request.body.value.trim() : "";
      if (text !== "" && text !== "{}") {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          return carry(null, "Request body must be empty or a JSON object");
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return carry(null, "Request body must be empty or a JSON object");
        const first = Object.keys(parsed)[0];
        if (first !== undefined) return carry(first.slice(0, 200), "Field is not allowed");
      }
    }
    const key = idempotency(request);
    if (Object.hasOwn(key, "arguments")) return key;
    return { arguments: { ...args }, ...key };
  };
}

function carried(args) {
  if (args === null || typeof args !== "object") return undefined;
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== DECODE_ERROR_KEY) return undefined;
  const error = args[DECODE_ERROR_KEY];
  return error !== null && typeof error === "object" && typeof error.message === "string" ? error : undefined;
}

function entry(code, field, message) {
  const out = { code, message: String(message).slice(0, 1000) };
  if (typeof field === "string" && field.length > 0) out.field = field.slice(0, 200);
  return out;
}

/** The Trolley error body for a non-ok outcome. */
export function errorBody(invocation, outcome) {
  const error = outcome.error ?? {};
  const decodeError = outcome.status === "invalid" ? carried(invocation.arguments) : undefined;
  if (decodeError !== undefined) return { ok: false, errors: [entry("invalid_field", decodeError.field, decodeError.message)] };
  if (outcome.status === "denied") {
    return { ok: false, errors: [entry("not_authorized", undefined, "Authentication not permitted to access resource: this actor is not granted the operation in this Firedrill world")] };
  }
  if (outcome.status === "unsupported") return { ok: false, errors: [entry("not_found", undefined, "Resource not found")] };
  if (outcome.status === "invalid") {
    const idempotencyMessage = IDEMPOTENCY_MESSAGES.get(error.code);
    if (idempotencyMessage !== undefined) return { ok: false, errors: [entry("invalid_field", IDEMPOTENCY_HEADER, idempotencyMessage)] };
    const issue = Array.isArray(error.issues) ? error.issues.find((item) => Array.isArray(item?.path)) : undefined;
    const field = issue === undefined ? undefined : issue.path.filter((part) => typeof part === "string" || typeof part === "number").join(".");
    return { ok: false, errors: [entry("invalid_field", field, issue?.message ?? "Value is invalid")] };
  }
  const code = String(error.code ?? "tool.INTERNAL_SERVER_ERROR").replace(/^[a-z-]+\./, "").toLowerCase();
  const field = error.details !== null && typeof error.details === "object" ? error.details.field : undefined;
  return { ok: false, errors: [entry(code, field, error.message ?? "Internal server error")] };
}

/** A route codec: decode with `options`, pass success bodies through, render errors in Trolley's envelope. */
export function route(options) {
  return {
    decode: decoder(options),
    encode({ invocation, outcome }) {
      if (outcome.status === "ok") return { body: { kind: "json", value: outcome.value } };
      return { body: { kind: "json", value: errorBody(invocation, outcome) } };
    },
  };
}
