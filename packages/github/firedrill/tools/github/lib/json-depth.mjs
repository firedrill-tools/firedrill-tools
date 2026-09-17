// Bounded JSON nesting for route codecs. The framework validates operation arguments recursively, so a body nested
// thousands of levels deep would overflow the stack and answer an opaque 500. Every JSON route's decode measures the
// parsed body iteratively (explicit stack, never recursion) and refuses it past MAX_JSON_DEPTH, answering 400.
export const MAX_JSON_DEPTH = 512;

/** Nesting depth of a parsed JSON value (scalars are 0), stopping as soon as it exceeds `limit`. */
export function jsonDepth(value, limit = MAX_JSON_DEPTH) {
  let max = 0;
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (depth > max) max = depth;
    if (max > limit) return max;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  return max;
}

/** Throws (request mapping error, 400) when a parsed JSON body nests deeper than MAX_JSON_DEPTH. */
export function assertJsonDepth(value) {
  if (jsonDepth(value) > MAX_JSON_DEPTH) throw new TypeError(`Problems parsing JSON: nesting is deeper than the maximum depth of ${MAX_JSON_DEPTH}`);
  return value;
}
