// Response byte budgets. The framework refuses any HTTP route response larger than 1 MiB, so every response that carries
// caller-authored cell text (values, grid data, Drive file lists) is measured in UTF-8 bytes of its JSON encoding while it
// is built, and answered with the provider's own validation error before it can cross that cap.
//
// Sizes are computed from UTF-16 code units exactly as `JSON.stringify` encodes them: quotes and backslashes escape to
// 2 bytes, control characters to 2 or 6, a surrogate pair is one 4-byte code point, a lone surrogate is a 6-byte `\uXXXX`
// escape, and everything else is 1, 2 or 3 UTF-8 bytes. No Node built-ins are used.

/** Largest encoded response body this Tool builds, leaving headroom under the framework's 1 MiB cap. */
export const RESPONSE_BYTE_LIMIT = 900_000;

const SHORT_ESCAPES = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

/** UTF-8 bytes of `JSON.stringify(text)` for one string, quotes included. */
export function jsonStringBytes(text) {
  let bytes = 2;
  const length = text.length;
  for (let index = 0; index < length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code < 0x20) bytes += SHORT_ESCAPES.has(code) ? 2 : 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

function scalarBytes(value) {
  if (value === null) return 4;
  if (typeof value === "string") return jsonStringBytes(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  return 4;
}

/**
 * UTF-8 bytes of `JSON.stringify(value)` (compact). Iterative, so caller-controlled nesting cannot overflow the stack.
 * Object members whose value is undefined or a function are skipped, as JSON.stringify skips them.
 */
export function jsonBytes(value) {
  let bytes = 0;
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object") {
      bytes += current === undefined || typeof current === "function" ? 4 : scalarBytes(current);
      continue;
    }
    if (Array.isArray(current)) {
      bytes += 2 + Math.max(0, current.length - 1);
      for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
      continue;
    }
    let members = 0;
    for (const key of Object.keys(current)) {
      const member = current[key];
      if (member === undefined || typeof member === "function") continue;
      members += 1;
      bytes += jsonStringBytes(key) + 1;
      stack.push(member);
    }
    bytes += 2 + Math.max(0, members - 1);
  }
  return bytes;
}

/**
 * A running byte budget for one response. `add(n)` fails through `fail(message)` (which must throw, e.g. a
 * `context.fail` wrapper) as soon as the running total passes `limit`, so an oversized response is refused while it is
 * being built instead of after it has been materialised.
 */
export function byteBudget(fail, message, limit = RESPONSE_BYTE_LIMIT) {
  let used = 0;
  return {
    add(bytes) {
      used += bytes;
      if (used > limit) fail(message);
    },
    get used() {
      return used;
    },
    limit,
  };
}
