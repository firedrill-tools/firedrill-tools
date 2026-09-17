// Declared error helpers. The HTTP codecs render every failure as Documenso's `{ message, code, issues? }` envelope.

export function fail(context, code, message, issues) {
  context.fail({ code, message, ...(issues === undefined ? {} : { details: { issues } }) });
}

/** Input that parses but is not acceptable (the provider's schema-level 400). */
export const bad = (context, message) => fail(context, "BAD_REQUEST", message, [{ message }]);
/** A business rule refused the request (400). */
export const invalid = (context, message) => fail(context, "INVALID_REQUEST", message);
export const notFound = (context, what) => fail(context, "NOT_FOUND", `${what} not found`);
export const forbidden = (context, message = "You do not have permission to perform this action") => fail(context, "FORBIDDEN", message);
export const unauthorized = (context) => fail(context, "UNAUTHORIZED", "Invalid API key");
export const limitExceeded = (context, message) => fail(context, "LIMIT_EXCEEDED", message);
