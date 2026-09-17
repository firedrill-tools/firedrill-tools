// Bounded JSON nesting guard for route decoders. The framework's body parser accepts bodies nested about 3,000 levels,
// which later overflow recursive argument validation and answer an opaque 500. Every route decode measures depth
// iteratively (an explicit stack, never recursion); a body deeper than MAX_JSON_DEPTH is replaced by a marker argument
// the strict input schema rejects, so the request answers 400 VALIDATION_BAD_REQUEST in the provider envelope.

export const MAX_JSON_DEPTH = 512;

/** Nesting depth of a JSON value (a scalar is 0, `[]` or `{}` is 1), stopping as soon as `limit` is exceeded. */
export function jsonDepth(value, limit = MAX_JSON_DEPTH) {
  let deepest = 0;
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (depth > deepest) deepest = depth;
    if (deepest > limit) return deepest;
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
  }
  return deepest;
}

/** True when a JSON request body (or a text body that parses as JSON) is nested deeper than MAX_JSON_DEPTH. */
export function bodyTooDeep(request) {
  const body = request?.body;
  if (body === null || typeof body !== "object") return false;
  let value;
  if (body.kind === "json") value = body.value;
  else if (body.kind === "text" && typeof body.value === "string") {
    try {
      value = JSON.parse(body.value);
    } catch {
      return false;
    }
  } else return false;
  return jsonDepth(value) > MAX_JSON_DEPTH;
}

/** Wrap every route codec's decode with the depth guard. */
export function guardRoutes(http) {
  for (const [id, codec] of Object.entries(http)) {
    const decode = codec.decode;
    http[id] = {
      ...codec,
      decode: (request, ...rest) => (bodyTooDeep(request) ? { arguments: { body_depth_exceeded: true } } : decode(request, ...rest)),
    };
  }
  return http;
}
