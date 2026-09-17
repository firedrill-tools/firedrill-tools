// QuickBooks Online Accounting API v3 wire codecs: pure decode (path, query, body → operation arguments) and
// encode (outcome → QuickBooks body or Fault envelope). No state, no clock; `time` comes from handler outputs.
import { faultInfo } from "./common.mjs";
import { bytesFromBase64 } from "./pdf.mjs";

const MAX_DEPTH = 512;

function last(query, name) {
  const values = Object.hasOwn(query, name) ? query[name] : undefined;
  return values === undefined || values.length === 0 ? undefined : values[values.length - 1];
}

const cap = (value, max) => (typeof value === "string" && value.length > max ? value.slice(0, max) : value);

function checkDepth(value) {
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop();
    if (current === null || typeof current !== "object") continue;
    if (depth > MAX_DEPTH) throw new Error(`Request body nesting exceeds the supported depth of ${MAX_DEPTH} levels.`);
    for (const inner of Array.isArray(current) ? current : Object.values(current)) {
      if (inner !== null && typeof inner === "object") stack.push([inner, depth + 1]);
    }
  }
}

function args(entries) {
  const out = {};
  for (const [key, value] of entries) if (value !== undefined) out[key] = value;
  return out;
}

function withKey(request, argumentsObject) {
  const key = last(request.query, "requestid");
  if (key === undefined || key.length === 0) return { arguments: argumentsObject };
  if (key.length > 255) throw new Error("requestid must be at most 255 characters.");
  return { arguments: argumentsObject, idempotencyKey: key };
}

const realm = (request) => cap(request.path.realmId, 64);

function jsonBody(request) {
  if (request.body.kind !== "json") return undefined;
  checkDepth(request.body.value);
  return request.body.value;
}

const ERROR_TEXT = new Map([
  ["THROTTLE_EXCEEDED", "Throttling limits exceeded."],
  ["SERVICE_UNAVAILABLE", "Service Unavailable"],
]);

/** QuickBooks Fault envelope for any unsuccessful outcome. */
export function faultBody(outcome) {
  const error = outcome.error ?? {};
  const message = typeof error.message === "string" ? error.message : "";
  if (outcome.status === "denied") {
    return envelope("message=ApplicationAuthorizationFailed; errorCode=003100; statusCode=403", "This operation is not granted to the calling actor in this Firedrill world.", "3100", "", "AuthorizationFault");
  }
  if (outcome.status === "unsupported") return envelope("Unsupported Operation", "Operation is not supported by this Tool.", "500", "", "ValidationFault");
  if (outcome.status === "invalid") {
    return envelope("A business validation error has occurred while processing your request", `Business Validation Error: ${message.slice(0, 500)}`, "6000", "", "ValidationFault");
  }
  const code = String(error.code ?? "").replace(/^tool\./, "");
  const info = faultInfo(code) ?? ["10000", "An application error has occurred while processing your request", "SystemFault"];
  const details = error.details !== null && typeof error.details === "object" ? error.details : {};
  const body = envelope(
    code === "SERVICE_UNAVAILABLE" ? info[1] : message.length > 0 ? message : info[1],
    typeof details.detail === "string" ? details.detail : (ERROR_TEXT.get(code) ?? message),
    typeof details.qboCode === "string" ? details.qboCode : info[0],
    typeof details.element === "string" ? details.element : "",
    typeof details.faultType === "string" ? details.faultType : info[2],
  );
  if (typeof details.time === "string") body.time = details.time;
  return body;
}

function envelope(Message, Detail, code, element, type) {
  return { Fault: { Error: [{ Message, Detail, code, element }], type } };
}

function encodeJson({ invocation, outcome }) {
  const headers = { intuit_tid: invocation.callId };
  if (outcome.status !== "ok") return { headers, body: { kind: "json", value: faultBody(outcome) } };
  const value = {};
  for (const [key, inner] of Object.entries(outcome.value)) if (key !== "action") value[key] = inner;
  return { headers, body: { kind: "json", value } };
}

function encodePdf(result) {
  const { outcome, invocation } = result;
  if (outcome.status !== "ok") return encodeJson(result);
  const bytes = bytesFromBase64(outcome.value.base64);
  if (bytes === null) return { headers: { intuit_tid: invocation.callId }, body: { kind: "json", value: envelope("An application error has occurred while processing your request", "PDF rendering failed.", "10000", "", "SystemFault") } };
  return { headers: { intuit_tid: invocation.callId }, body: { kind: "bytes", value: bytes, contentType: "application/pdf" } };
}

const getRoute = (idName) => ({
  decode: (request) => ({ arguments: args([[idName, cap(request.path.id, 64)], ["realmId", realm(request)]]) }),
  encode: encodeJson,
});

const postRoute = (withInclude) => ({
  decode: (request) =>
    withKey(request, args([
      ["body", jsonBody(request)],
      ["operation", cap(last(request.query, "operation"), 64)],
      ["include", withInclude ? cap(last(request.query, "include"), 64) : undefined],
      ["realmId", realm(request)],
    ])),
  encode: encodeJson,
});

export const routes = {
  "companyinfo-get": {
    decode: (request) => ({ arguments: args([["company_id", cap(request.path.companyId, 64)], ["realmId", realm(request)]]) }),
    encode: encodeJson,
  },
  "query-get": {
    decode: (request) => ({ arguments: args([["query", cap(last(request.query, "query") ?? "", 20001)], ["realmId", realm(request)]]) }),
    encode: encodeJson,
  },
  "query-post": {
    decode: (request) => {
      const text = request.body.kind === "text" ? request.body.value : (last(request.query, "query") ?? "");
      return { arguments: args([["query", cap(text, 20001)], ["realmId", realm(request)]]) };
    },
    encode: encodeJson,
  },
  "customer-get": getRoute("id"),
  "customer-post": postRoute(false),
  "item-get": getRoute("item_id"),
  "item-post": postRoute(false),
  "invoice-get": getRoute("invoice_id"),
  "invoice-post": postRoute(true),
  "invoice-send": {
    decode: (request) => withKey(request, args([["invoice_id", cap(request.path.id, 64)], ["sendTo", cap(last(request.query, "sendTo"), 320)], ["realmId", realm(request)]])),
    encode: encodeJson,
  },
  "invoice-pdf": {
    decode: (request) => ({ arguments: args([["invoice_id", cap(request.path.id, 64)], ["realmId", realm(request)]]) }),
    encode: encodePdf,
  },
  "payment-get": getRoute("id"),
  "payment-post": postRoute(false),
  "account-get": getRoute("id"),
};
