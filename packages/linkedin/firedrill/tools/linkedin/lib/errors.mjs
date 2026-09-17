// Declared Tool error codes, their HTTP status and LinkedIn `serviceErrorCode`, plus failure helpers.

export const ERRORS = new Map([
  ["INVALID_ACCESS_TOKEN", [401, 65600]],
  ["VERSION_MISSING", [400, 0]],
  ["NONEXISTENT_VERSION", [426, 0]],
  ["BAD_REQUEST", [400, 0]],
  ["ACCESS_DENIED", [403, 100]],
  ["NOT_FOUND", [404, 0]],
  ["MISSING_FIELD", [400, 0]],
  ["INVALID_VALUE_FOR_FIELD", [400, 0]],
  ["INVALID_VALUE_BLANK_FIELD", [400, 0]],
  ["FIELD_LENGTH_TOO_LONG", [400, 0]],
  ["INVALID_URN_TYPE", [400, 0]],
  ["INVALID_URN_ID", [400, 0]],
  ["UNPROCESSABLE_ENTITY", [422, 0]],
  ["TOO_MANY_REQUESTS", [429, 0]],
  ["INTERNAL_SERVER_ERROR", [500, 0]],
  ["SERVICE_UNAVAILABLE", [503, 0]],
]);

/** Fails the current operation with a declared code. Messages never name objects created in the same call. */
export function fail(context, code, message) {
  context.fail({ code, message });
}

export const missing = (context, field) => fail(context, "MISSING_FIELD", `${field} is required but missing`);
export const invalidValue = (context, field, value) =>
  fail(context, "INVALID_VALUE_FOR_FIELD", `${field} can't be set to ${shortValue(value)}`);
export const blank = (context, field) => fail(context, "INVALID_VALUE_BLANK_FIELD", `${field} can't be blank`);
export const tooLong = (context, field, length, max) =>
  fail(context, "FIELD_LENGTH_TOO_LONG", `${field} length ${length} can't exceeded maximum ${max} length`);
export const notFound = (context, message = "Not Found") => fail(context, "NOT_FOUND", message);
export const unprocessable = (context, message) => fail(context, "UNPROCESSABLE_ENTITY", message);
export const badRequest = (context, message) => fail(context, "BAD_REQUEST", message);

/** Renders a caller value inside an error message without echoing unbounded text. */
export function shortValue(value) {
  let text;
  if (typeof value === "string") text = value;
  else if (value === undefined) text = "undefined";
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = "an unsupported value";
    }
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
