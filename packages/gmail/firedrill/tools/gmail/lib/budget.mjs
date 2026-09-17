// Response byte budget. The framework refuses any HTTP route response larger than 1 MiB (after the operation has
// committed), so every route that can return large content measures what it is about to return first. Sizes are UTF-8
// bytes of compact JSON computed from code points: never `JSON.stringify(x).length`, which counts UTF-16 code units and
// under-counts CJK text and emoji by up to three times.

/** Largest response body (UTF-8 bytes of compact JSON) a route of this Tool builds; leaves room under the 1 MiB cap. */
export const RESPONSE_BUDGET_BYTES = 900_000;

/** UTF-8 bytes of a string as JSON.stringify writes it, quotes included. Linear in the string length. */
export function jsonStringBytes(text) {
  let bytes = 2;
  const length = text.length;
  for (let index = 0; index < length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) bytes += 2;
      else if (code < 0x20) bytes += 6;
      else bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6; // lone high surrogate: JSON.stringify writes \udXXX
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6; // lone low surrogate
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * UTF-8 bytes of `JSON.stringify(value)` (compact). Iterative with an explicit stack, so nesting depth cannot overflow
 * the call stack; values are plain JSON built by this Tool (objects, arrays, strings, finite numbers, booleans, null).
 * `undefined` object members are skipped exactly as JSON.stringify skips them.
 */
export function jsonBytes(value) {
  let bytes = 0;
  const stack = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === null) bytes += 4;
    else if (typeof item === "string") bytes += jsonStringBytes(item);
    else if (typeof item === "number") bytes += Number.isFinite(item) ? String(item).length : 4;
    else if (typeof item === "boolean") bytes += item ? 4 : 5;
    else if (Array.isArray(item)) {
      bytes += 2 + Math.max(0, item.length - 1);
      for (const element of item) stack.push(element === undefined ? null : element);
    } else if (typeof item === "object") {
      let members = 0;
      for (const key of Object.keys(item)) {
        const member = item[key];
        if (member === undefined || typeof member === "function") continue;
        members += 1;
        bytes += jsonStringBytes(key) + 1;
        stack.push(member);
      }
      bytes += 2 + Math.max(0, members - 1);
    }
  }
  return bytes;
}
