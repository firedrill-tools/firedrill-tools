// Body validation against the state schema bounds. Every problem is BAD_REQUEST naming the field and the bound, with
// caller text clipped. Read-only fields are ignored (as the provider ignores them); unknown fields are refused.
import { badRequest, invalidField } from "./errors.mjs";
import { normaliseIso } from "./time.mjs";
import { clip, isHex24, isPlainObject } from "./util.mjs";
import { SHAPES } from "./shapes.mjs";

export const READ_ONLY = new Set(["id", "created_at", "updated_at", "connection_id", "workspace_id"]);

// Field spec constructors -----------------------------------------------------------------------
export const str = (max, opts = {}) => ({ kind: "str", max, min: opts.min ?? 0, nullable: opts.nullable !== false, pattern: opts.pattern ?? null });
export const bool = () => ({ kind: "bool" });
export const num = (opts = {}) => ({ kind: "num", min: opts.min ?? null, max: opts.max ?? null, integer: opts.integer === true, nullable: opts.nullable !== false });
export const strArray = (maxItems, maxLen) => ({ kind: "strArray", maxItems, maxLen });
export const idArray = (maxItems) => ({ kind: "idArray", maxItems });
export const enumOf = (values, nullable = true) => ({ kind: "enum", values, nullable });
export const iso = () => ({ kind: "iso" });
export const shape = (name) => ({ kind: "shape", name });

const isNullish = (value) => value === undefined || value === null;

/** Validates one value against a spec, returning the normalised value. */
export function checkValue(context, field, spec, value) {
  switch (spec.kind) {
    case "str": {
      if (isNullish(value)) {
        if (!spec.nullable) invalidField(context, field, "a string is required");
        return null;
      }
      if (typeof value !== "string") invalidField(context, field, "must be a string");
      if (value.length < spec.min) invalidField(context, field, `must be at least ${spec.min} characters`);
      if (value.length > spec.max) invalidField(context, field, `must be at most ${spec.max} characters`);
      if (spec.pattern !== null && !spec.pattern.test(value)) invalidField(context, field, "has an invalid format");
      return value;
    }
    case "bool":
      if (isNullish(value)) return null;
      if (typeof value !== "boolean") invalidField(context, field, "must be a boolean");
      return value;
    case "num": {
      if (isNullish(value)) {
        if (!spec.nullable) invalidField(context, field, "a number is required");
        return null;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) invalidField(context, field, "must be a finite number");
      if (spec.integer && !Number.isInteger(value)) invalidField(context, field, "must be an integer");
      if (spec.min !== null && value < spec.min) invalidField(context, field, `must be at least ${spec.min}`);
      if (spec.max !== null && value > spec.max) invalidField(context, field, `must be at most ${spec.max}`);
      return value;
    }
    case "strArray": {
      if (isNullish(value)) return [];
      if (!Array.isArray(value)) invalidField(context, field, "must be an array of strings");
      if (value.length > spec.maxItems) invalidField(context, field, `must have at most ${spec.maxItems} entries`);
      for (const entry of value) {
        if (typeof entry !== "string" || entry.length > spec.maxLen) invalidField(context, field, `entries must be strings of at most ${spec.maxLen} characters`);
      }
      return value.slice();
    }
    case "idArray": {
      if (isNullish(value)) return [];
      if (!Array.isArray(value)) invalidField(context, field, "must be an array of ids");
      if (value.length > spec.maxItems) invalidField(context, field, `must have at most ${spec.maxItems} entries`);
      const out = [];
      for (const entry of value) {
        if (!isHex24(entry)) invalidField(context, field, `contains an invalid id ${clip(String(entry), 40)}`);
        if (!out.includes(entry)) out.push(entry);
      }
      return out;
    }
    case "enum":
      if (isNullish(value)) {
        if (!spec.nullable) invalidField(context, field, `must be one of ${spec.values.join(", ")}`);
        return null;
      }
      if (typeof value !== "string" || !spec.values.includes(value)) invalidField(context, field, `must be one of ${spec.values.join(", ")}`);
      return value;
    case "iso": {
      if (isNullish(value)) return null;
      const normalised = typeof value === "string" ? normaliseIso(value) : null;
      if (normalised === null) invalidField(context, field, "must be an ISO-8601 date-time");
      return normalised;
    }
    case "shape": {
      const validator = SHAPES.get(spec.name);
      return validator(context, field, value);
    }
    default:
      invalidField(context, field, "unsupported");
  }
  return null;
}

/**
 * Validates a request body against `specs` (field -> spec). Returns the normalised present fields only, so the
 * caller can merge them (update) or fill defaults (create). Read-only names are dropped; unknown names fail.
 */
export function validateBody(context, body, specs) {
  if (!isPlainObject(body)) badRequest(context, "Request body must be a JSON object");
  const out = {};
  for (const key of Object.keys(body)) {
    if (READ_ONLY.has(key) || key === "__request_error") continue;
    if (!Object.hasOwn(specs, key)) badRequest(context, `Unknown field "${clip(key, 80)}"`);
    out[key] = checkValue(context, key, specs[key], body[key]);
  }
  return out;
}

/** Splits an operation input into the addressing part and the resource body (everything that is not addressing). */
export function bodyOf(input, addressing) {
  const body = {};
  for (const key of Object.keys(input)) if (!addressing.includes(key)) body[key] = input[key];
  return body;
}
