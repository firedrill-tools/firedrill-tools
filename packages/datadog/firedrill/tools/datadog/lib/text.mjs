// Validation of caller strings, tag lists and objects. Regexes only ever run on length-bounded input.
import { bad, present, RESERVED_KEYS } from "./core.mjs";

export const FFFD = "�";

/** Optional/required bounded string. Returns the string or `null` when absent and not required. */
export function text(context, raw, name, { min = 0, max, required = false, trim = false, noFffd = false } = {}) {
  if (!present(raw)) {
    if (required) bad(context, `Missing required parameter: ${name}`);
    return null;
  }
  if (typeof raw !== "string") bad(context, `Invalid parameter: ${name} must be a string`);
  const value = trim ? raw.trim() : raw;
  if (value.length < min || value.length > max) {
    bad(context, `Invalid parameter: ${name} must be between ${min} and ${max} characters`);
  }
  if (noFffd && value.includes(FFFD)) bad(context, `Invalid parameter: ${name} contains malformed encoding`);
  return value;
}

export function oneOf(context, raw, name, allowed, fallback) {
  if (!present(raw)) return fallback;
  if (typeof raw !== "string" || !allowed.includes(raw)) {
    bad(context, `Invalid parameter: ${name} must be one of ${allowed.join(", ")}`);
  }
  return raw;
}

/** Comma-separated string → trimmed non-empty entries (bounded). */
export function csv(context, raw, name, { maxItems = 100, maxLen = 200 } = {}) {
  if (!present(raw)) return [];
  if (typeof raw !== "string" || raw.length > 10_000) bad(context, `Invalid parameter: ${name} must be a comma-separated string`);
  if (raw.includes(FFFD)) bad(context, `Invalid parameter: ${name} contains malformed encoding`);
  const parts = raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length > maxItems || parts.some((part) => part.length > maxLen)) {
    bad(context, `Invalid parameter: ${name} accepts at most ${maxItems} entries of ${maxLen} characters`);
  }
  return parts;
}

/** Tag array (`key:value` or `key`), trimmed, deduplicated in order. */
export function tagList(context, raw, name, { maxItems = 50 } = {}) {
  if (!present(raw)) return [];
  if (!Array.isArray(raw) || raw.length > maxItems) bad(context, `Invalid parameter: ${name} must be an array of at most ${maxItems} tags`);
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== "string") bad(context, `Invalid parameter: ${name} entries must be strings`);
    const tag = entry.trim();
    if (tag.length === 0 || tag.length > 200 || tag.includes(FFFD) || /[\s,]/.test(tag)) {
      bad(context, `Invalid tag in ${name}: tags must be 1-200 characters without spaces or commas`);
    }
    const key = tag.split(":")[0];
    if (RESERVED_KEYS.has(key)) bad(context, `Invalid tag in ${name}: reserved key`);
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Plain JSON object without reserved keys at any depth (iterative walk, bounded depth and size). */
export function object(context, raw, name, { required = false } = {}) {
  if (!present(raw)) {
    if (required) bad(context, `Missing required parameter: ${name}`);
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) bad(context, `Invalid parameter: ${name} must be an object`);
  const check = jsonShape(raw);
  if (check !== null) bad(context, `Invalid parameter: ${name} ${check}`);
  return raw;
}

/** `null` when the value nests ≤ 64 levels, has ≤ 20,000 nodes and no reserved keys; otherwise a reason. */
export function jsonShape(value, maxDepth = 64) {
  const stack = [[value, 1]];
  let nodes = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    nodes += 1;
    if (nodes > 20_000) return "is too large";
    if (depth > maxDepth) return "is nested too deeply";
    if (typeof node !== "object" || node === null) continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push([item, depth + 1]);
      continue;
    }
    for (const key of Object.keys(node)) {
      if (RESERVED_KEYS.has(key)) return `uses the reserved key ${key}`;
      stack.push([node[key], depth + 1]);
    }
  }
  return null;
}

/** Refuse fields the provider treats as read-only. */
export function rejectReadOnly(context, input, fields) {
  for (const field of fields) {
    if (Object.hasOwn(input, field) && present(input[field])) bad(context, `Invalid parameter: ${field} is read-only`);
  }
}

export function finiteNumber(context, raw, name, { nullable = true } = {}) {
  if (!present(raw)) {
    if (nullable) return null;
    bad(context, `Missing required parameter: ${name}`);
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) bad(context, `Invalid parameter: ${name} must be a finite number`);
  return raw;
}
