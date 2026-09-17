// NetSuite problem-envelope helpers. Handlers raise declared Tool errors carrying the envelope fields in
// `details`; the route codecs turn those into the documented `o:errorDetails` body.

/** Longest piece of caller text ever quoted back in a `detail` string. */
export const QUOTE_LIMIT = 200;

export function quote(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}…` : text;
}

const TITLES = new Map([
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [409, "Conflict"],
  [429, "Bad Request"],
  [500, "Internal Server Error"],
]);

const STATUS = new Map([
  ["INVALID_LOGIN", 401],
  ["INSUFFICIENT_PERMISSION", 403],
  ["NONEXISTENT_ID", 404],
  ["INVALID_ID", 400],
  ["INVALID_CONTENT", 400],
  ["INVALID_KEY_OR_REF", 400],
  ["INVALID_PARAMETER", 400],
  ["INVALID_REQUEST", 400],
  ["USER_ERROR", 400],
  ["RCRD_HAS_BEEN_CHANGED", 409],
  ["CONCURRENCY_LIMIT_EXCEEDED", 429],
  ["UNEXPECTED_ERROR", 500],
  ["RESULT_SET_TOO_LARGE", 400],
]);

const TYPES = new Map([
  [400, "https://www.rfc-editor.org/rfc/rfc9110#section-15.5.1"],
  [401, "https://www.rfc-editor.org/rfc/rfc9110#section-15.5.2"],
  [403, "https://www.rfc-editor.org/rfc/rfc9110#section-15.5.4"],
  [404, "https://www.rfc-editor.org/rfc/rfc9110#section-15.5.5"],
  [409, "https://www.rfc-editor.org/rfc/rfc9110#section-15.5.10"],
  [429, "https://www.rfc-editor.org/rfc/rfc6585#section-4"],
  [500, "https://www.rfc-editor.org/rfc/rfc9110#section-15.6.1"],
]);

export function statusFor(code) {
  return STATUS.get(code) ?? 400;
}

/** Build the documented NetSuite problem body for one Tool error code. */
export function problemBody(code, detail, extra = {}) {
  const status = statusFor(code);
  const entry = { detail, "o:errorCode": code };
  for (const [key, value] of [
    ["o:errorPath", extra.errorPath],
    ["o:urlPath", extra.urlPath],
    ["o:errorQueryParam", extra.errorQueryParam],
    ["o:errorHeader", extra.errorHeader],
  ]) {
    if (typeof value === "string" && value.length > 0) entry[key] = value;
  }
  const body = {
    type: TYPES.get(status) ?? TYPES.get(400),
    title: TITLES.get(status) ?? "Bad Request",
    status,
    "o:errorDetails": [entry],
  };
  if (code === "CONCURRENCY_LIMIT_EXCEEDED") body["o:errorCode"] = "USER_ERROR";
  return body;
}

/** Raise one of the declared errors with the envelope fields the codec needs. */
export function fail(context, code, detail, extra = {}) {
  context.fail({
    code,
    message: detail.length > 3900 ? `${detail.slice(0, 3900)}…` : detail,
    retryable: code === "CONCURRENCY_LIMIT_EXCEEDED" || code === "UNEXPECTED_ERROR",
    details: {
      detail,
      ...(typeof extra.errorPath === "string" ? { errorPath: extra.errorPath } : {}),
      ...(typeof extra.urlPath === "string" ? { urlPath: extra.urlPath } : {}),
      ...(typeof extra.errorQueryParam === "string" ? { errorQueryParam: extra.errorQueryParam } : {}),
      ...(typeof extra.errorHeader === "string" ? { errorHeader: extra.errorHeader } : {}),
    },
  });
}

export const LOGIN_DETAIL =
  "Invalid login attempt. For more details, see the Login Audit Trail in the NetSuite UI at Setup > Users/Roles > User Management > View Login Audit Trail.";
