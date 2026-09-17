// Stripe's form encoding: `metadata[order_id]=42`, `items[0][price]=price_x`, `expand[]=customer`,
// `created[gte]=1700000000`. The framework hands codecs the raw `URLSearchParams` pairs; this module un-flattens
// them into nested objects/arrays and coerces the integer/boolean parameters this Tool knows. Pure functions only.
//
// Tool modules run in the serve process's own JavaScript realm and codecs run inline in its request handler, so the
// decoder is defensive by construction:
// - maps are built from `Object.create(null)` and copied out with `Object.fromEntries` (own data properties only), and
//   the segments `__proto__`, `constructor` and `prototype` are rejected, so no caller key can reach a prototype;
// - nesting depth and array indices are capped, and the walk is iterative, so no request causes deep recursion, a
//   sparse array of length 2^32-1, or other work that is not proportional to the request's own size;
// - it never throws: a request that cannot be mapped yields `{ error: { code, message, param } }`, which the codec
//   turns into Stripe's 400 `invalid_request_error` envelope (see `behavior.mjs`).

/** Bracket segments allowed after the parameter name (`a[b][c]` has two). This Tool's deepest parameter has four. */
export const MAX_NESTING_DEPTH = 20;
/** Largest accepted array index; `expand[]`/`items[]` hold at most `MAX_ARRAY_INDEX + 1` entries. */
export const MAX_ARRAY_INDEX = 999;
/** Argument key the codec uses to carry a decoding error past schema validation to `encode`. */
export const FORM_ERROR_KEY = "firedrill:form_error";

const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const DISPLAY_LIMIT = 120;

const INTEGER_KEYS = new Set([
  "amount",
  "amount_to_capture",
  "limit",
  "quantity",
  "unit_amount",
  "days_until_due",
  "trial_period_days",
  "interval_count",
  "cancel_at",
  "billing_cycle_anchor",
  "start",
  "end",
  "gt",
  "gte",
  "lt",
  "lte",
]);
const INTEGER_OR_OBJECT_KEYS = new Set(["created", "due_date", "current_period_start", "current_period_end"]);
const INTEGER_OR_STRING_KEYS = new Set(["trial_end"]);
const BOOLEAN_KEYS = new Set(["confirm", "active", "cancel_at_period_end", "auto_advance", "paid_out_of_band", "off_session", "deleted", "enabled"]);
const OPAQUE_PARENTS = new Set(["metadata"]);

class FormError {
  constructor(code, message, param) {
    this.error = { code, message, param };
  }
}

function display(key) {
  return key.length > DISPLAY_LIMIT ? `${key.slice(0, DISPLAY_LIMIT)}...` : key;
}

/**
 * `items[0][price]` → `["items", "0", "price"]`. A key that is not of the form `name[seg]...[seg]` stays one opaque
 * parameter name (the canonical schema rejects it as unknown). Linear scan; stops as soon as the depth cap is exceeded.
 */
function segments(key) {
  const open = key.indexOf("[");
  if (open <= 0 || key.indexOf("]") < open) return [key];
  const parts = [key.slice(0, open)];
  let position = open;
  while (position < key.length) {
    if (key[position] !== "[") return [key];
    const close = key.indexOf("]", position + 1);
    if (close === -1) return [key];
    const segment = key.slice(position + 1, close);
    if (segment.includes("[")) return [key];
    if (parts.length > MAX_NESTING_DEPTH) {
      throw new FormError("parameter_invalid", `Invalid parameter: ${display(key)} is nested more than ${MAX_NESTING_DEPTH} levels deep.`, display(key));
    }
    parts.push(segment);
    position = close + 1;
  }
  return parts;
}

function coerce(parent, key, value) {
  if (OPAQUE_PARENTS.has(parent)) return value;
  if (INTEGER_KEYS.has(key) || INTEGER_OR_OBJECT_KEYS.has(key)) {
    if (/^-?[0-9]{1,15}$/.test(value)) return Number(value);
    if (/^-?[0-9]{1,15}\.[0-9]{1,15}$/.test(value)) return Number(value);
    return value;
  }
  if (INTEGER_OR_STRING_KEYS.has(key)) return /^[0-9]{1,15}$/.test(value) ? Number(value) : value;
  if (BOOLEAN_KEYS.has(key)) {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }
  return value;
}

function isMap(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayIndex(key, name, array, segment) {
  // Leading zeros are not significant (`items[0001]` is index 1, as Stripe reads it); a digit run too long to be a
  // safe integer is simply over the cap and gets the same "0 to MAX_ARRAY_INDEX" message.
  const digits = segment === "" ? null : segment.replace(/^0+(?=[0-9])/, "");
  const index = digits === null ? array.length : digits.length <= 15 ? Number(digits) : Number.POSITIVE_INFINITY;
  if (index > MAX_ARRAY_INDEX) {
    throw new FormError(
      "parameter_invalid",
      `Invalid array: ${display(key)}. The ${name} parameter accepts at most ${MAX_ARRAY_INDEX + 1} entries, indexed from 0 to ${MAX_ARRAY_INDEX}.`,
      display(key),
    );
  }
  return index;
}

/** Iterative write of one `parts → value` pair into a null-prototype tree. */
function assign(root, key, parts, value) {
  let target = root;
  let parentKey = "";
  let position = 0;
  while (position < parts.length) {
    const head = parts[position];
    if (position === parts.length - 1) {
      target[head] = coerce(parentKey, head, value);
      return;
    }
    const next = parts[position + 1];
    if (next === "" || /^[0-9]+$/.test(next)) {
      if (!Array.isArray(target[head])) target[head] = [];
      const array = target[head];
      const index = arrayIndex(key, head, array, next);
      if (position + 1 === parts.length - 1) {
        array[index] = coerce(head, head, value);
        return;
      }
      if (next === "" || !isMap(array[index])) array[index] = Object.create(null);
      target = array[index];
      parentKey = head;
      position += 2;
      continue;
    }
    if (!isMap(target[head])) target[head] = Object.create(null);
    target = target[head];
    parentKey = head;
    position += 1;
  }
}

/** Null-prototype tree → plain JSON value. Depth is bounded by `MAX_NESTING_DEPTH`, array length by the index cap. */
function compact(value) {
  if (Array.isArray(value)) {
    // Walk the entries the request actually set (`Object.keys` of an array yields its present indices in ascending
    // order), so a sparse `x[999]=1` costs one step rather than a thousand: the cost stays proportional to the
    // request's own size however many sparse arrays it builds.
    const out = [];
    for (const index of Object.keys(value)) if (value[index] !== undefined) out.push(compact(value[index]));
    return out;
  }
  if (isMap(value)) return Object.fromEntries(Object.keys(value).map((key) => [key, compact(value[key])]));
  return value;
}

function unflattenOrThrow(record) {
  const target = Object.create(null);
  for (const key of Object.keys(record)) {
    const values = record[key];
    const parts = segments(key);
    const reserved = parts.find((part) => RESERVED_SEGMENTS.has(part));
    if (reserved !== undefined || parts[0] === FORM_ERROR_KEY) {
      throw new FormError("parameter_unknown", `Received unknown parameter: ${display(key)}`, display(key));
    }
    for (const value of values) assign(target, key, parts, typeof value === "string" ? value : String(value));
  }
  return compact(target);
}

function guarded(run) {
  try {
    return { value: run() };
  } catch (error) {
    if (error instanceof FormError) return { error: error.error };
    return { error: { code: "parameter_invalid", message: "Invalid request: the form parameters could not be decoded.", param: undefined } };
  }
}

/**
 * `Record<string, string[]>` (form body or query string) → `{ value }` with nested arguments, or `{ error }` when the
 * request cannot be mapped. Repeated plain keys keep the last value (Stripe's behaviour for duplicated scalar
 * parameters); `expand[]`, `ids[]`, `items[0][price]` build arrays. Integer-looking values of known integer parameters
 * become numbers, `true`/`false` of known boolean parameters become booleans; anything else stays a string for the
 * canonical schema to judge.
 */
export function unflatten(record) {
  return guarded(() => unflattenOrThrow(record));
}

/** Path parameters plus query and form arguments merged into one canonical argument object, or `{ error }`. */
export function requestArguments(request) {
  return guarded(() => {
    const query = unflattenOrThrow(request.query);
    const body = request.body.kind === "form" ? unflattenOrThrow(request.body.value) : {};
    return { ...query, ...body, ...request.path };
  });
}
