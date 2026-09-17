// Pure HTTP codec helpers: query/path/body relocation into canonical snake_case arguments, hostile-body refusal and
// Datadog's error envelope `{ "errors": ["…"] }`. HTTP statuses per error code are declared on each route.

const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 512;

function last(values) {
  return Array.isArray(values) && values.length > 0 ? values[values.length - 1] : undefined;
}

export const header = (request, name) => last(request.headers?.[name]);
export const query = (request, name) => last(request.query?.[name]);

/** Reason to refuse a JSON value (nesting depth > 512 or a reserved key at any depth), or `null`. Iterative. */
export function refusal(value) {
  const stack = [[value, 1]];
  let nodes = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (typeof node !== "object" || node === null) continue;
    nodes += 1;
    if (depth > MAX_DEPTH) return "request body is nested too deeply";
    if (nodes > 200_000) return "request body has too many values";
    if (Array.isArray(node)) {
      for (const item of node) stack.push([item, depth + 1]);
    } else {
      for (const key of Object.keys(node)) {
        if (RESERVED.has(key)) return `request body uses the reserved key ${key}`;
        stack.push([node[key], depth + 1]);
      }
    }
  }
  return null;
}

/**
 * Build the operation input. `pathNames` map path params, `queryNames` copy raw query strings, `body` copies the
 * JSON object's own members (path params win). A refused body becomes a single argument the closed input schema
 * rejects, so the response is still rendered by `encode` in Datadog's envelope.
 */
export function decodeInput(request, { path = [], queryNames = [], body = false } = {}) {
  const args = {};
  if (body) {
    const payload = request.body?.kind === "json" ? request.body.value : undefined;
    if (payload !== undefined) {
      const reason = refusal(payload);
      if (reason !== null) return { arguments: { refused_request: reason } };
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return { arguments: { refused_request: "request body must be a JSON object" } };
      }
      for (const key of Object.keys(payload)) args[key] = payload[key];
    } else if (request.body?.kind === "text" || request.body?.kind === "form") {
      return { arguments: { refused_request: "request body must be JSON" } };
    }
  }
  for (const name of queryNames) {
    const value = query(request, name);
    if (value !== undefined) args[name] = value;
  }
  for (const name of path) {
    const value = request.path?.[name];
    if (typeof value === "string") args[name] = value;
  }
  const key = header(request, "idempotency-key");
  return typeof key === "string" && key.length >= 1 && key.length <= 128 ? { arguments: args, idempotencyKey: key } : { arguments: args };
}

const RATE_LIMIT_HEADERS = {
  "x-ratelimit-limit": "1000", "x-ratelimit-period": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60", "x-ratelimit-name": "metrics_submit",
};

export function errorMessage(outcome) {
  const message = typeof outcome.error?.message === "string" && outcome.error.message.length > 0 ? outcome.error.message : "Internal Server Error";
  if (outcome.status === "denied") return "Forbidden: this operation is not granted to the calling actor in this Firedrill world";
  if (outcome.status === "unsupported") return "Not found";
  if (outcome.status === "invalid") return `Invalid request: ${message}`;
  return message;
}

export function encodeOutcome({ outcome }) {
  if (outcome.status === "ok") return { headers: { "content-type": "application/json" }, body: { kind: "json", value: outcome.value } };
  const code = String(outcome.error?.code ?? "").replace(/^tool\./, "");
  const response = { body: { kind: "json", value: { errors: [errorMessage(outcome)] } } };
  return code === "RATE_LIMITED" ? { headers: RATE_LIMIT_HEADERS, ...response } : response;
}
