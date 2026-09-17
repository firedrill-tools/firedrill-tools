// Check wire codecs: pure request decoding and Check's error envelope
// `{ error: { type, message, input_errors: [{ field, field_path, message }] } }`. No state, no clock.
export const DECODE_ERROR_KEY = "__checkDecodeError";
const MAX_DEPTH = 512;
const MAX_REPEAT = 100;
const GENERIC = "Please correct the required fields and try again.";
const TYPES = {
  VALIDATION_ERROR: "validation_error", NOT_FOUND: "not_found", AUTHENTICATION_ERROR: "authentication_error",
  PERMISSION_DENIED: "permission_denied", PREVIEW_SUPERSEDED: "preview_superseded", THROTTLED: "throttled",
  SERVICE_UNAVAILABLE: "service_unavailable", INTERNAL_ERROR: "internal_error",
};
const clip = (value) => (value.length > 200 ? `${value.slice(0, 200)}…` : value);

const carry = (field, message) => ({ arguments: { [DECODE_ERROR_KEY]: { field, message } } });
const bad = (value) => typeof value === "string" && value.includes("�");

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

/** Decodes one query value by kind: "string", "int", "bool", "list" (repeated or comma-separated, ≤ 100 values). */
function queryValue(kind, values) {
  if (kind === "list") {
    const out = [];
    for (const raw of values) for (const part of raw.split(",")) {
      if (part === "") continue;
      out.push(part);
      if (out.length > MAX_REPEAT) return { error: `At most ${MAX_REPEAT} values are allowed.` };
    }
    return { value: out };
  }
  if (values.length > 1) return { error: "Provide this parameter once." };
  const raw = values[0] ?? "";
  if (kind === "int") return /^[0-9]{1,9}$/.test(raw) ? { value: Number(raw) } : { error: "A valid integer is required." };
  if (kind === "bool") return raw === "true" || raw === "false" ? { value: raw === "true" } : { error: "Must be a valid boolean." };
  return { value: raw };
}

/** `query`: allowed name → kind. `body`: "json" (object required), "optional" (empty or object), "none". */
export function decoder({ query = {}, body = "none" } = {}) {
  return (request) => {
    const args = Object.create(null);
    for (const [name, value] of Object.entries(request.path ?? {})) {
      if (bad(value)) return carry(name, "Contains invalid characters.");
      args[name] = value;
    }
    for (const [name, values] of Object.entries(request.query ?? {})) {
      if (!Object.hasOwn(query, name)) return carry(clip(name), "Unsupported query parameter.");
      const list = Array.isArray(values) ? values : [];
      if (list.length > MAX_REPEAT) return carry(clip(name), `At most ${MAX_REPEAT} values are allowed.`);
      if (list.some(bad)) return carry(name, "Contains invalid characters.");
      const decoded = queryValue(query[name], list);
      if (decoded.error !== undefined) return carry(name, decoded.error);
      args[name] = decoded.value;
    }
    if (body === "json" || body === "optional") {
      let value;
      if (request.body?.kind === "json") value = request.body.value;
      else if (request.body?.kind === "text") {
        const raw = request.body.value.trim();
        if (raw === "") value = body === "optional" ? {} : undefined;
        else {
          try {
            value = JSON.parse(raw);
          } catch {
            return carry(null, "Request body must be valid JSON.");
          }
        }
      } else if (body === "optional") value = {};
      if (value === null || typeof value !== "object" || Array.isArray(value)) return carry(null, "Request body must be a JSON object.");
      if (tooDeep(value)) return carry(null, "Request body is nested too deeply.");
      for (const [key, entry] of Object.entries(value)) {
        if (Object.hasOwn(args, key)) return carry(clip(key), "This field is not supported.");
        args[key] = entry;
      }
    }
    const out = { arguments: { ...args } };
    const keys = request.headers?.["idempotency-key"];
    const key = Array.isArray(keys) ? keys[keys.length - 1] : undefined;
    if (typeof key === "string" && key.length > 0 && key.length <= 255) out.idempotencyKey = key;
    return out;
  };
}

function inputError(path, message) {
  const segments = path.map(String).map(clip);
  const named = segments.filter((part) => !/^[0-9]+$/.test(part));
  return { field: named.length > 0 ? named[named.length - 1] : "non_field_errors", field_path: segments.length > 0 ? segments : ["non_field_errors"], message: clip(String(message)) };
}

/** Splits `field=a.b: text | field=c: text` into input errors; anything else is a plain message. */
function parseMessage(message) {
  const parts = String(message).split(" | ");
  const errors = [];
  for (const part of parts) {
    const match = /^field=([^:]*): ([\s\S]*)$/.exec(part);
    if (match === null) return { message: String(message), errors: [] };
    errors.push(inputError(match[1].split("."), match[2]));
  }
  return { message: errors[0]?.message ?? GENERIC, errors };
}

function envelope(type, message, errors) {
  const error = { type, message: String(message).slice(0, 1000) };
  if (errors.length > 0) error.input_errors = errors.slice(0, 20);
  return { error };
}

export function errorBody(invocation, outcome) {
  const args = invocation?.arguments;
  if (outcome.status === "invalid" && args && Object.hasOwn(args, DECODE_ERROR_KEY)) {
    const carried = args[DECODE_ERROR_KEY] ?? {};
    const field = typeof carried.field === "string" ? [carried.field] : [];
    return envelope("validation_error", field.length > 0 ? GENERIC : carried.message, field.length > 0 ? [inputError(field, carried.message)] : []);
  }
  if (outcome.status === "denied") return envelope("permission_denied", "This API key is not granted this operation in the Firedrill world.", []);
  if (outcome.status === "unsupported") return envelope("not_found", "Not found.", []);
  const error = outcome.error ?? {};
  if (outcome.status === "invalid") {
    const issues = Array.isArray(error.issues) ? error.issues.slice(0, 20) : [];
    const errors = issues.map((issue) => inputError(Array.isArray(issue?.path) ? issue.path : [], issue?.message ?? "Invalid value."));
    return envelope("validation_error", GENERIC, errors);
  }
  const code = String(error.code ?? "INTERNAL_ERROR").replace(/^[a-z-]+\./, "");
  const type = Object.hasOwn(TYPES, code) ? TYPES[code] : "internal_error";
  const parsed = parseMessage(error.message ?? "An internal error occurred.");
  if (parsed.errors.length > 0) {
    // Only a validation envelope carries the "correct the fields" summary; every other type keeps its own
    // message (a not_found reads "Company not found.", not the validation text) even when it names a field.
    const single = parsed.errors.length === 1 ? parsed.errors[0] : null;
    const summary = type === "validation_error" && !(single !== null && single.field === "non_field_errors")
      ? GENERIC
      : (single !== null ? single.message : parsed.message);
    return envelope(type, summary, parsed.errors);
  }
  return envelope(type, parsed.message, []);
}

export function route(options) {
  return {
    decode: decoder(options),
    encode({ invocation, outcome }) {
      if (outcome.status === "ok") return { body: outcome.value === null ? { kind: "empty" } : { kind: "json", value: outcome.value } };
      const code = String(outcome.error?.code ?? "");
      const headers = code.endsWith("THROTTLED") ? { "retry-after": "1" } : undefined;
      return { ...(headers ? { headers } : {}), body: { kind: "json", value: errorBody(invocation, outcome) } };
    },
  };
}
