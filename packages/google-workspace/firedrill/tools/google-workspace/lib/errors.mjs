// Declared Tool error codes and the google.rpc.Status envelope every route encodes.
import { clip } from "./util.mjs";

/** code -> [http status, canonical status string, default ErrorInfo reason] */
export const ERRORS = new Map([
  ["INVALID_ARGUMENT", [400, "INVALID_ARGUMENT", "INVALID_PARAMETER"]],
  ["FAILED_PRECONDITION", [400, "FAILED_PRECONDITION", "PRECONDITION_FAILED"]],
  ["OUT_OF_RANGE", [400, "OUT_OF_RANGE", "PAGE_SIZE_OUT_OF_RANGE"]],
  ["UNAUTHENTICATED", [401, "UNAUTHENTICATED", "CREDENTIALS_MISSING"]],
  ["PERMISSION_DENIED", [403, "PERMISSION_DENIED", "IAM_PERMISSION_DENIED"]],
  ["NOT_FOUND", [404, "NOT_FOUND", "RESOURCE_NOT_FOUND"]],
  ["ALREADY_EXISTS", [409, "ALREADY_EXISTS", "RESOURCE_ALREADY_EXISTS"]],
  ["RESOURCE_EXHAUSTED", [429, "RESOURCE_EXHAUSTED", "RATE_LIMIT_EXCEEDED"]],
  ["INTERNAL", [500, "INTERNAL", "BACKEND_ERROR"]],
  ["UNAVAILABLE", [503, "UNAVAILABLE", "BACKEND_UNAVAILABLE"]],
]);

export const OBJECT_CAP = 1500;
// The framework caps one state scan at 10,000 rows, so the bound is 9,999 and a full page proves the namespace is larger.
export const SCAN_BOUND = 9999;
export const PAGE_BYTE_BUDGET = 900000;

/** Fails with a declared code. `reason` and `metadata` become the google.rpc.ErrorInfo detail. */
export function fail(context, code, message, reason, metadata) {
  const details = {};
  if (reason !== undefined) details.reason = reason;
  if (metadata !== undefined) details.metadata = metadata;
  context.fail({ code, message: clip(message, 3500), ...(reason === undefined && metadata === undefined ? {} : { details }) });
}

export const invalid = (context, message, reason = "INVALID_PARAMETER") => fail(context, "INVALID_ARGUMENT", message, reason);

export const notFound = (context, message = "Requested entity was not found.") => fail(context, "NOT_FOUND", message, "RESOURCE_NOT_FOUND");

export const denied = (context, message = "The caller does not have permission", reason = "IAM_PERMISSION_DENIED", metadata) =>
  fail(context, "PERMISSION_DENIED", message, reason, metadata);

export const unauthenticated = (context, message = "Request had invalid authentication credentials. Expected OAuth 2 access token.") =>
  fail(context, "UNAUTHENTICATED", message, "CREDENTIALS_MISSING");

export const outOfRange = (context, message) => fail(context, "OUT_OF_RANGE", message, "PAGE_SIZE_OUT_OF_RANGE");

export const precondition = (context, message, reason = "PRECONDITION_FAILED") => fail(context, "FAILED_PRECONDITION", message, reason);

export const scanBoundExceeded = (context, namespace) =>
  fail(
    context,
    "RESOURCE_EXHAUSTED",
    `State namespace "${namespace}" exceeds the supported bound of ${SCAN_BOUND} rows for this simulation.`,
    "STATE_BOUND_EXCEEDED",
  );

/** RESOURCE_EXHAUSTED for the simulation object cap (distinct reason from the rate-limit fault). */
export function objectCapExceeded(context) {
  fail(
    context,
    "RESOURCE_EXHAUSTED",
    `This simulated Workspace domain supports at most ${OBJECT_CAP} objects; delete something before creating more.`,
    "SIMULATION_OBJECT_LIMIT",
  );
}

export const invalidPageToken = (context) => invalid(context, "Invalid page token.", "INVALID_PAGE_TOKEN");
