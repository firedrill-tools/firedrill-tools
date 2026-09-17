// Declared Tool errors carrying Linear's GraphQL error entries in `details.errors`, so the wire
// codec renders `{ errors: [{ message, path?, extensions: { type, code, userError,
// userPresentableMessage } }] }` from what the handler decided rather than inventing it.

export const RATE_LIMIT_REQUESTS = 1500;

const TYPES = Object.freeze({
  AUTHENTICATION_ERROR: "authentication error",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "invalid input",
  INVALID_INPUT: "invalid input",
  GRAPHQL_VALIDATION_FAILED: "graphql error",
  NOT_IMPLEMENTED: "graphql error",
  RATELIMITED: "ratelimited",
  INTERNAL_ERROR: "internal error",
  FAILED_PRECONDITION: "internal error",
});

/**
 * The framework rejects a Tool failure whose message exceeds 4000 characters, and many messages echo caller text
 * (ids, field names, filter keys, GraphQL tokens). Every message is clipped here so no caller value can turn a declared
 * error into a framework mapping failure. Echoed values are clipped first (see `clipValue`) so the message keeps its tail.
 */
export const MAX_MESSAGE_LENGTH = 4000;
const ELLIPSIS = "\u2026";

/** Clip a string to `limit` UTF-16 code units, never splitting a surrogate pair, marking the cut with an ellipsis. */
function clip(text, limit) {
  if (text.length <= limit) return text;
  let end = limit - ELLIPSIS.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${ELLIPSIS}`;
}

/** Bound one caller-supplied value before it is interpolated into an error message. */
export const MAX_ECHOED_VALUE_LENGTH = 200;
export function clipValue(value) {
  return clip(String(value), MAX_ECHOED_VALUE_LENGTH);
}

export function boundMessage(message) {
  const text = typeof message === "string" && message.length > 0 ? message : "Request failed";
  return clip(text, MAX_MESSAGE_LENGTH);
}

function boundPath(path) {
  if (!Array.isArray(path)) return undefined;
  return path.slice(0, 64).map((segment) => (typeof segment === "number" ? segment : clipValue(segment)));
}

export function errorEntry(code, rawMessage, options = {}) {
  const message = boundMessage(rawMessage);
  const path = boundPath(options.path);
  return {
    message,
    ...(path === undefined ? {} : { path }),
    extensions: {
      type: TYPES[code] ?? "internal error",
      code,
      userError: options.userError ?? (code === "INVALID_INPUT" || code === "NOT_FOUND" || code === "FORBIDDEN"),
      userPresentableMessage: options.userPresentableMessage === undefined ? message : boundMessage(options.userPresentableMessage),
    },
  };
}

/** Stop the operation with a declared Linear-shaped error. */
export function fail(context, code, rawMessage, options = {}) {
  const message = boundMessage(rawMessage);
  return context.fail({
    code,
    message,
    retryable: options.retryable ?? false,
    // Every error the handler raises carries the rate-limit metadata, so the codec renders X-RateLimit-Requests-Reset on it too.
    details: { errors: [errorEntry(code, message, options)], rateLimit: options.rateLimit ?? rateLimitMeta(Math.floor(context.clock.nowUs() / 1000)) },
  });
}

export function authenticationError(context) {
  return fail(context, "AUTHENTICATION_ERROR", "Authentication required, not authenticated", { userError: false });
}

export function forbidden(context, message) {
  return fail(context, "FORBIDDEN", message);
}

/** Linear's wording for a missing or invisible entity, e.g. `Entity not found: Issue - Could not find referenced Issue.` */
export function notFound(context, entity, path) {
  return fail(context, "NOT_FOUND", `Entity not found: ${entity} - Could not find referenced ${entity}.`, { path });
}

export function invalidInput(context, message, path) {
  return fail(context, "INVALID_INPUT", message, { path });
}

export function boundExceeded(context, namespace, bound) {
  return fail(context, "FAILED_PRECONDITION", `state exceeds the supported bound of ${String(bound)} rows for ${namespace}`, { userError: false });
}

export function graphqlValidation(context, message, path) {
  return fail(context, "GRAPHQL_VALIDATION_FAILED", message, { path, userError: false });
}

export function notImplemented(context, message, path) {
  return fail(context, "NOT_IMPLEMENTED", message, { path, userError: false });
}

/** Rate-limit metadata rendered into the `X-RateLimit-Requests-*` headers by the codec. */
export function rateLimitMeta(nowMs) {
  return { requestsLimit: RATE_LIMIT_REQUESTS, requestsRemaining: RATE_LIMIT_REQUESTS - 1, requestsReset: nowMs + 3_600_000 };
}
