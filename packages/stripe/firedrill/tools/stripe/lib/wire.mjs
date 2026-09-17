// Stripe REST wire helpers: the error envelope and the response headers. Pure functions only, so the HTTP
// codecs can use them without state or a clock. Statuses are framework-owned (declared per route).

export const API_VERSION = "2026-08-26.dahlia";

const TYPES = {
  INVALID_REQUEST: "invalid_request_error",
  INVALID_STATE: "invalid_request_error",
  RESOURCE_MISSING: "invalid_request_error",
  PERMISSION_DENIED: "invalid_request_error",
  RATE_LIMITED: "invalid_request_error",
  CARD_DECLINED: "card_error",
  API_ERROR: "api_error",
};

export function docUrl(code) {
  return `https://stripe.com/docs/error-codes/${code.replace(/_/g, "-")}`;
}

function requestLogUrl(correlationId) {
  return `https://dashboard.stripe.test/logs/req_${correlationId}`;
}

/** Response decoration every Stripe response carries; `Idempotency-Key` is echoed when the request sent one. */
export function responseHeaders(invocation) {
  const headers = {
    "request-id": `req_${invocation.correlationId}`,
    "stripe-version": API_VERSION,
  };
  if (typeof invocation.idempotencyKey === "string") headers["idempotency-key"] = invocation.idempotencyKey;
  return headers;
}

/** `{ error: { ... } }` for a non-ok outcome, in Stripe's shape. */
export function stripeError(outcome, correlationId) {
  const error = outcome.error ?? {};
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : "An unknown error occurred.";
  const base = { request_log_url: requestLogUrl(correlationId) };
  if (outcome.status === "denied") {
    return {
      error: {
        ...base,
        type: "invalid_request_error",
        message: "This API key is not granted the requested operation in this Firedrill world. Grant the operation to the calling actor to continue.",
      },
    };
  }
  if (outcome.status === "unsupported") {
    return { error: { ...base, type: "invalid_request_error", message: `Unrecognized request: ${message}` } };
  }
  if (outcome.status === "invalid") {
    // Framework schema rejection: its message ("arguments do not match stripe.<operation>") names no property,
    // so no `param` can be derived (README "Wire format").
    return {
      error: {
        ...base,
        type: "invalid_request_error",
        code: "parameter_invalid",
        message: `Invalid request: ${message}`,
        doc_url: docUrl("parameter_invalid"),
      },
    };
  }
  const code = String(error.code ?? "").replace(/^tool\./, "");
  const details = typeof error.details === "object" && error.details !== null ? error.details : {};
  const body = { ...base, type: TYPES[code] ?? "api_error", message };
  if (code === "RATE_LIMITED") {
    body.code = "rate_limit";
    body.doc_url = docUrl("rate_limit");
  }
  if (typeof details.code === "string") {
    body.code = details.code;
    body.doc_url = docUrl(details.code);
  }
  if (typeof details.param === "string") body.param = details.param;
  if (typeof details.decline_code === "string") body.decline_code = details.decline_code;
  if (typeof details.payment_intent === "object" && details.payment_intent !== null) body.payment_intent = details.payment_intent;
  if (typeof details.payment_method === "object" && details.payment_method !== null) body.payment_method = details.payment_method;
  if (typeof details.advice_code === "string") body.advice_code = details.advice_code;
  return { error: body };
}

/** The decoding error `behavior.mjs` carried under `key`, when the arguments hold exactly that shape. */
export function formError(args, key) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== key) return undefined;
  const error = args[key];
  if (typeof error !== "object" || error === null || typeof error.code !== "string" || typeof error.message !== "string") return undefined;
  return error;
}

/** Stripe's 400 `invalid_request_error` for a form or query string the decoder could not map. */
export function formErrorEnvelope(error, correlationId) {
  const body = { request_log_url: requestLogUrl(correlationId), type: "invalid_request_error", code: error.code, message: error.message, doc_url: docUrl(error.code) };
  if (typeof error.param === "string") body.param = error.param;
  return { error: body };
}
