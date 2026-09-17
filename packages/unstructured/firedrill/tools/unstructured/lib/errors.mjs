// Declared error codes, their HTTP statuses and the helpers every handler uses to raise them.
import { clip } from "./util.mjs";

/** code -> HTTP status (FastAPI-style `{ detail }` envelopes are rendered by wire.mjs). */
export const STATUS = new Map([
  ["UNAUTHORIZED", 401],
  ["INVALID_REQUEST", 400],
  ["UNSUPPORTED_FILE_TYPE", 400],
  ["NOT_FOUND", 404],
  ["RESPONSE_TOO_LARGE", 413],
  ["INVALID_FILE", 422],
  ["VALIDATION_ERROR", 422],
  ["RATE_LIMITED", 429],
  ["INTERNAL_ERROR", 500],
  ["SERVICE_OVERLOADED", 503],
]);

export function fail(context, code, message) {
  context.fail({ code, message: clip(message, 3000) });
}

/**
 * Field-level validation failure. `loc` is a dotted location (`body.files`, `query.page_size`); several issues are
 * joined by ` | ` and rendered as the FastAPI `detail` array by the codec.
 */
export function validation(context, loc, message) {
  fail(context, "VALIDATION_ERROR", `loc=${loc}: ${clip(message, 200)}`);
}

export const notFound = (context, message) => fail(context, "NOT_FOUND", message);

/** Fails when the decoder attached a request problem; the prefix chooses the code. */
export function requestProblem(input, context) {
  const problem = input.__request_error;
  if (typeof problem !== "string" || problem.length === 0) return;
  if (problem.startsWith("400:")) fail(context, "INVALID_REQUEST", problem.slice(4));
  fail(context, "VALIDATION_ERROR", problem.startsWith("422:") ? problem.slice(4) : problem);
}

/** Collects `loc=…: message` issues and fails once with all of them (at most 20). */
export class Issues {
  constructor() {
    this.items = [];
  }
  add(loc, message) {
    if (this.items.length < 20) this.items.push(`loc=${loc}: ${clip(message, 200)}`);
    return this;
  }
  get empty() {
    return this.items.length === 0;
  }
  raise(context) {
    if (!this.empty) fail(context, "VALIDATION_ERROR", this.items.join(" | "));
  }
}

export const boundExceeded = (context, namespace, bound) =>
  fail(context, "INTERNAL_ERROR", `state exceeds the supported bound of ${bound} ${namespace} rows`);
