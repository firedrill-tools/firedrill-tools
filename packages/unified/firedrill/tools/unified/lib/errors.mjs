// Declared Tool error codes, their HTTP status on every route and the reason phrases of the wire envelope.
import { clip } from "./util.mjs";

/** code -> [HTTP status, reason phrase] */
export const ERRORS = new Map([
  ["BAD_REQUEST", [400, "Bad Request"]],
  ["UNAUTHORIZED", [401, "Unauthorized"]],
  ["FORBIDDEN", [403, "Forbidden"]],
  ["NOT_FOUND", [404, "Not Found"]],
  ["PAYLOAD_TOO_LARGE", [413, "Payload Too Large"]],
  ["RATE_LIMITED", [429, "Too Many Requests"]],
  ["INTERNAL_ERROR", [500, "Internal Server Error"]],
  ["FAILED_PRECONDITION", [500, "Internal Server Error"]],
  ["NOT_IMPLEMENTED", [501, "Not Implemented"]],
]);

/** Encoded page budget in UTF-8 bytes; the framework refuses route responses above 1 MiB. */
export const PAGE_BYTE_BUDGET = 900000;

/** Hard ceiling for the per-connection scan bound (`workspaces.limits.max_rows_per_namespace` can only lower it). */
export const MAX_SCAN_BOUND = 10000;

const DEFAULT_MESSAGE = "Required parameters are missing or in the wrong format";

/** Fails with a declared code; an empty or non-string message falls back to the provider's generic wording. */
export function fail(context, code, message) {
  const text = typeof message === "string" ? clip(message, 3000).trim() : "";
  context.fail({ code, message: text.length > 0 ? text : DEFAULT_MESSAGE });
}

export const badRequest = (context, message = "Required parameters are missing or in the wrong format") =>
  fail(context, "BAD_REQUEST", message);

export const unauthorized = (context, message = "Unauthorized") => fail(context, "UNAUTHORIZED", message);

export const forbidden = (context, message = "Forbidden") => fail(context, "FORBIDDEN", message);

export const notFound = (context, message = "Not found") => fail(context, "NOT_FOUND", message);

export const notImplemented = (context) =>
  fail(context, "NOT_IMPLEMENTED", "The requested functionality is not supported by this integration");

export const tooLarge = (context) =>
  fail(context, "PAYLOAD_TOO_LARGE", "Response exceeds 1 MB; lower limit or restrict fields");

export const scanBoundExceeded = (context, namespace, bound) =>
  fail(context, "FAILED_PRECONDITION", `State exceeds the supported bound of ${bound} rows for ${namespace}`);

/** A field whose value is not what the schema allows: names the field and the bound, clipping any caller text. */
export const invalidField = (context, field, detail) => badRequest(context, `Invalid value for ${clip(field, 80)}: ${detail}`);
