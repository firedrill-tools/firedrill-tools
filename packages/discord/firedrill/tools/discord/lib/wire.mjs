// Discord HTTP API wire helpers: request mapping and Discord-shaped error bodies. Pure (no state access).

/** Declared error code → Discord JSON error `code` and `message`. */
export const DISCORD_ERRORS = Object.freeze({
  UNAUTHORIZED: { code: 0, message: "401: Unauthorized" },
  UNKNOWN_CHANNEL: { code: 10003, message: "Unknown Channel" },
  UNKNOWN_GUILD: { code: 10004, message: "Unknown Guild" },
  UNKNOWN_MEMBER: { code: 10007, message: "Unknown Member" },
  UNKNOWN_MESSAGE: { code: 10008, message: "Unknown Message" },
  UNKNOWN_USER: { code: 10013, message: "Unknown User" },
  UNKNOWN_EMOJI: { code: 10014, message: "Unknown Emoji" },
  MAX_REACTIONS: { code: 30010, message: "Maximum number of reactions reached (20)" },
  MISSING_ACCESS: { code: 50001, message: "Missing Access" },
  CANNOT_EDIT_OTHERS_MESSAGE: { code: 50005, message: "Cannot edit a message authored by another user" },
  CANNOT_SEND_EMPTY_MESSAGE: { code: 50006, message: "Cannot send an empty message" },
  CANNOT_SEND_TO_USER: { code: 50007, message: "Cannot send messages to this user" },
  MISSING_PERMISSIONS: { code: 50013, message: "Missing Permissions" },
  SYSTEM_MESSAGE_ACTION: { code: 50021, message: "Cannot execute action on a system message" },
  INVALID_CHANNEL_TYPE: { code: 50024, message: "Cannot execute action on this channel type" },
  INVALID_FORM_BODY: { code: 50035, message: "Invalid Form Body" },
  THREAD_ARCHIVED: { code: 50083, message: "Thread is archived" },
  THREAD_ALREADY_CREATED: { code: 160004, message: "A thread has already been created for this message" },
  THREAD_LOCKED: { code: 160005, message: "Thread is locked" },
  RATE_LIMITED: {
    code: 20028,
    message: "The write action you are performing on the channel has hit the write rate limit.",
  },
  SERVICE_UNAVAILABLE: { code: 0, message: "503: Service Unavailable" },
  STATE_BOUND_EXCEEDED: { code: 0, message: "500: Internal Server Error" },
});

export const RATE_LIMIT_HEADERS = Object.freeze({
  "retry-after": "2",
  "x-ratelimit-limit": "5",
  "x-ratelimit-remaining": "0",
  "x-ratelimit-reset-after": "1.5",
  "x-ratelimit-bucket": "firedrill-channel-write",
  "x-ratelimit-scope": "shared",
});

function last(values) {
  return Array.isArray(values) && values.length > 0 ? values[values.length - 1] : undefined;
}

/** Integer query parameter; a non-integer is passed through as the raw string so input validation reports it. */
export function queryInt(request, name) {
  const value = last(request.query[name]);
  if (value === undefined) return undefined;
  if (/^-?[0-9]{1,15}$/.test(value)) return Number(value);
  return value;
}

/** Boolean query parameter (true/false/1/0, any case); anything else is passed through as the raw string. */
export function queryBool(request, name) {
  const value = last(request.query[name]);
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "1") return true;
  if (lower === "false" || lower === "0") return false;
  return value;
}

export function queryString(request, name) {
  return last(request.query[name]);
}

/** The JSON request body as an object; an absent body is `{}`. A non-object body cannot be mapped at all. */
export function jsonBody(request) {
  if (request.body.kind === "none") return {};
  if (request.body.kind !== "json") throw new TypeError("request body must be a JSON object");
  const value = request.body.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("request body must be a JSON object");
  }
  return value;
}

/** Copy only the named keys (Discord ignores unknown body keys). */
export function pick(source, names) {
  const out = {};
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(source, name) && source[name] !== undefined) out[name] = source[name];
  }
  return out;
}

export function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** Writes accept an optional `X-Firedrill-Idempotency-Key` header (Discord clients never send one). */
export function withIdempotency(request, args) {
  const key = last(request.headers["x-firedrill-idempotency-key"]);
  return typeof key === "string" && key.length > 0 && key.length <= 255
    ? { arguments: args, idempotencyKey: key }
    : { arguments: args };
}

// Issue paths can carry caller-chosen keys, so the error tree uses prototype-less objects and own-property checks: a
// `__proto__` or `constructor` segment becomes an ordinary field and can never reach Object.prototype.
function nestError(tree, path, entry) {
  let node = tree;
  for (const segment of path) {
    const key = String(segment);
    if (!Object.hasOwn(node, key) || typeof node[key] !== "object" || node[key] === null || Array.isArray(node[key])) {
      node[key] = Object.create(null);
    }
    node = node[key];
  }
  if (!Array.isArray(node._errors)) node._errors = [];
  node._errors.push(entry);
}

function json(value, headers = {}) {
  return { headers, body: { kind: "json", value } };
}

/** Discord-shaped body for every non-ok outcome (the status itself is framework-owned, declared per route). */
export function discordError(outcome) {
  const error = outcome.error ?? {};
  if (outcome.status === "denied") return json({ message: "Missing Permissions", code: 50013 });
  if (outcome.status === "unsupported") return json({ message: "404: Not Found", code: 0 });
  if (outcome.status === "invalid") {
    const errors = Object.create(null);
    const issues = Array.isArray(error.issues) ? error.issues : [];
    for (const issue of issues) {
      const path = Array.isArray(issue.path) ? issue.path.filter((segment) => segment !== "arguments") : [];
      nestError(errors, path, {
        code: "BASE_TYPE_INVALID",
        message: typeof issue.message === "string" ? issue.message : "Invalid value.",
      });
    }
    const body = { message: "Invalid Form Body", code: 50035 };
    if (Object.keys(errors).length > 0) body.errors = errors;
    return json(body);
  }
  const code = error.source === "tool" && typeof error.code === "string" ? error.code.replace(/^tool\./, "") : "";
  const known = Object.hasOwn(DISCORD_ERRORS, code) ? DISCORD_ERRORS[code] : undefined;
  if (known === undefined) return json({ message: "500: Internal Server Error", code: 0 });
  if (code === "RATE_LIMITED") {
    return json({ message: known.message, retry_after: 1.5, global: false, code: known.code }, RATE_LIMIT_HEADERS);
  }
  const body = { message: known.message, code: known.code };
  const details = error.details;
  if (code === "INVALID_FORM_BODY" && typeof details === "object" && details !== null && typeof details.errors === "object") {
    body.errors = details.errors;
  }
  return json(body);
}

/**
 * Build an encoder. `shape` is "object" (the canonical value), "empty" (204), or `{ unwrap: key }` for list endpoints
 * whose wire body is a bare array.
 */
export function encoder(shape) {
  return ({ outcome }) => {
    if (outcome.status !== "ok") return discordError(outcome);
    if (shape === "empty") return { body: { kind: "empty" } };
    if (shape === "object") return json(outcome.value);
    return json(outcome.value[shape.unwrap]);
  };
}
