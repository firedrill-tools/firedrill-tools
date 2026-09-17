// Iterative JSON nesting-depth guard for HTTP codecs. A body nested past the framework's recursive argument
// validation would otherwise answer an opaque 500, so every JSON route's decode rejects bodies deeper than
// MAX_JSON_DEPTH before the request reaches validation. An explicit stack, never recursion.

export const MAX_JSON_DEPTH = 512;

/** Throws a TypeError when `value` nests objects or arrays more than `max` levels deep. */
export function assertJsonDepth(value, max = MAX_JSON_DEPTH) {
  if (value === null || typeof value !== "object") return;
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > max) throw new TypeError(`request body is nested more than ${String(max)} levels deep`);
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
  }
}
