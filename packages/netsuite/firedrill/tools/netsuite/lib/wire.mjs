// Provider-shaped HTTP codecs. Pure: no state is read here and every response body is assembled from the
// operation outcome alone.
import { problemBody } from "./errors.mjs";
import { selfLinks } from "./project.mjs";
import {
  ACCOUNT_CONTENT_TYPE, bodyArguments, COLLECTION_CONTENT_TYPE, decodeSegment, ERROR_CONTENT_TYPE,
  firstHeader, firstQuery, pathValue, readArguments, SCHEMA_CONTENT_TYPE, writeArguments,
} from "./wire-decode.mjs";

// Framework-raised codes (they never reach a handler) that still have an exact NetSuite equivalent.
// Keyed by the outcome status the framework reports, so the NetSuite code always agrees with the HTTP status
// the framework puts on the wire (invalid -> 400, denied -> 403, unsupported -> 404) whatever the internal code is.
const FRAMEWORK_CODES = new Map([
  ["invalid", "INVALID_PARAMETER"],
  ["denied", "INSUFFICIENT_PERMISSION"],
  ["unsupported", "NONEXISTENT_ID"],
]);

const DENIED_DETAIL =
  "Permission Violation: You need a higher level of permission to access this record. Please contact your account administrator.";

// Caller-safe wording for each framework code; framework messages name internal identifiers, so none is quoted.
const FRAMEWORK_DETAIL = new Map([
  ["INSUFFICIENT_PERMISSION", DENIED_DETAIL],
  ["INVALID_PARAMETER", "Invalid request parameter value. One of the supplied parameters is not valid for this request."],
  ["NONEXISTENT_ID", "The requested record operation is not available in this account."],
  ["UNEXPECTED_ERROR", "Unexpected error."],
]);

const codeOf = (outcome) => {
  const code = outcome?.error?.code;
  if (typeof code === "string" && code.startsWith("tool.")) return code.slice(5);
  return FRAMEWORK_CODES.get(outcome?.status) ?? "UNEXPECTED_ERROR";
};

/** True when the outcome carries a framework code, whose message is internal wording we must not quote. */
const isFrameworkError = (outcome) => {
  const code = outcome?.error?.code;
  return typeof code !== "string" || !code.startsWith("tool.");
};

const detailsOf = (outcome) => {
  const details = outcome?.error?.details;
  return typeof details === "object" && details !== null && !Array.isArray(details) ? details : {};
};

function errorBody(outcome) {
  const code = codeOf(outcome);
  if (isFrameworkError(outcome)) {
    // Framework messages name internal identifiers, so they are never quoted into a provider-shaped body.
    return problemBody(code, FRAMEWORK_DETAIL.get(code) ?? "Unexpected error.", {});
  }
  const details = detailsOf(outcome);
  const detail = typeof details.detail === "string" ? details.detail : (outcome?.error?.message ?? "Request failed.");
  return problemBody(code, detail, details);
}

const errorResponse = (outcome) => ({
  headers: {
    "content-type": ERROR_CONTENT_TYPE,
    ...(codeOf(outcome) === "CONCURRENCY_LIMIT_EXCEEDED" ? { "retry-after": "5" } : {}),
  },
  body: { kind: "json", value: errorBody(outcome) },
});

const okObject = (outcome) => {
  const value = outcome?.value;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
};

/** 200 responses carrying a record or a collection. */
function jsonCodec(contentType, transform = (value) => value) {
  return ({ outcome }) => {
    const value = okObject(outcome);
    if (value === null) return errorResponse(outcome);
    return { headers: { "content-type": contentType }, body: { kind: "json", value: transform(value) } };
  };
}

/** 204 responses: no body, a Location header naming the record that was written. */
const writeCodec = ({ outcome }) => {
  const value = okObject(outcome);
  if (value === null) return errorResponse(outcome);
  const location = typeof value.location === "string" ? value.location : undefined;
  return {
    headers: location === undefined ? {} : { location },
    body: { kind: "empty" },
  };
};

const recordCodec = jsonCodec(ACCOUNT_CONTENT_TYPE);
const collectionCodec = jsonCodec(COLLECTION_CONTENT_TYPE);

/** The REST subsidiary route answers the record-collection shape, not the MCP shape. */
const subsidiaryCollectionCodec = jsonCodec(COLLECTION_CONTENT_TYPE, (value) => ({
  ...value,
  items: Array.isArray(value.items)
    ? value.items.map((entry) => ({ links: selfLinks("subsidiary", entry?.id ?? ""), id: entry?.id ?? "" }))
    : [],
}));

const idArguments = (request) => ({ recordId: decodeSegment(pathValue(request, "id")) ?? "" });

const listRoute = (id) => [id, { decode: (request) => ({ arguments: readArguments(request) }), encode: collectionCodec }];

const getRoute = (id) => [id, {
  decode: (request) => ({ arguments: { ...readArguments(request), ...idArguments(request) } }),
  encode: recordCodec,
}];

const createRoute = (id) => [id, {
  decode: (request) => {
    const write = writeArguments(request);
    return {
      arguments: { ...write, ...bodyArguments(request, { optional: false }) },
      ...(write.idempotencyKeyHeader === undefined ? {} : { idempotencyKey: write.idempotencyKeyHeader }),
    };
  },
  encode: writeCodec,
}];

const updateRoute = (id) => [id, {
  decode: (request) => {
    const write = writeArguments(request);
    return {
      arguments: { ...write, ...idArguments(request), ...bodyArguments(request, { optional: false }) },
      ...(write.idempotencyKeyHeader === undefined ? {} : { idempotencyKey: write.idempotencyKeyHeader }),
    };
  },
  encode: writeCodec,
}];

const transformRoute = (id, target) => [id, {
  decode: (request) => {
    const write = writeArguments(request);
    return {
      arguments: {
        ...write,
        ...idArguments(request),
        target,
        transformMarker: decodeSegment(pathValue(request, "transformMarker")) ?? "",
        ...bodyArguments(request, { optional: true }),
      },
      ...(write.idempotencyKeyHeader === undefined ? {} : { idempotencyKey: write.idempotencyKeyHeader }),
    };
  },
  encode: writeCodec,
}];

export const routes = Object.fromEntries([
  listRoute("customer-list"),
  getRoute("customer-get"),
  createRoute("customer-create"),
  updateRoute("customer-update"),
  ["customer-delete", {
    decode: (request) => {
      const write = writeArguments(request);
      return {
        arguments: { ...idArguments(request), ...(write.idempotencyKeyHeader === undefined ? {} : { idempotencyKeyHeader: write.idempotencyKeyHeader }) },
        ...(write.idempotencyKeyHeader === undefined ? {} : { idempotencyKey: write.idempotencyKeyHeader }),
      };
    },
    encode: writeCodec,
  }],
  listRoute("sales-order-list"),
  getRoute("sales-order-get"),
  createRoute("sales-order-create"),
  updateRoute("sales-order-update"),
  ["sales-order-items", {
    decode: (request) => ({
      arguments: {
        ...idArguments(request),
        ...(firstQuery(request, "limit") === undefined ? {} : { limit: firstQuery(request, "limit") }),
        ...(firstQuery(request, "offset") === undefined ? {} : { offset: firstQuery(request, "offset") }),
      },
    }),
    encode: collectionCodec,
  }],
  transformRoute("sales-order-transform", "invoice"),
  listRoute("invoice-list"),
  getRoute("invoice-get"),
  createRoute("invoice-create"),
  updateRoute("invoice-update"),
  transformRoute("invoice-transform", "customerPayment"),
  listRoute("customer-payment-list"),
  getRoute("customer-payment-get"),
  listRoute("inventory-item-list"),
  getRoute("inventory-item-get"),
  ["subsidiary-list", {
    decode: (request) => ({
      arguments: {
        ...(firstQuery(request, "limit") === undefined ? {} : { limit: firstQuery(request, "limit") }),
        ...(firstQuery(request, "offset") === undefined ? {} : { offset: firstQuery(request, "offset") }),
      },
    }),
    encode: subsidiaryCollectionCodec,
  }],
  ["metadata-catalog-list", {
    decode: () => ({ arguments: {} }),
    encode: jsonCodec(COLLECTION_CONTENT_TYPE),
  }],
  ["metadata-catalog-type", {
    decode: (request) => ({ arguments: { recordType: decodeSegment(pathValue(request, "recordType")) ?? "" } }),
    encode: jsonCodec(SCHEMA_CONTENT_TYPE),
  }],
  ["suiteql", {
    decode: (request) => {
      const decoded = bodyArguments(request, { optional: false });
      const args = { ...decoded };
      if (decoded.body !== undefined) {
        const body = decoded.body;
        delete args.body;
        args.q = typeof body.q === "string" ? body.q : "";
        if (Array.isArray(body.params)) args.params = body.params;
      } else if (decoded.bodyError === undefined) {
        args.q = "";
      }
      const prefer = firstHeader(request, "prefer");
      if (prefer !== undefined) args.prefer = prefer;
      const limit = firstQuery(request, "limit");
      if (limit !== undefined) args.limit = limit;
      const offset = firstQuery(request, "offset");
      if (offset !== undefined) args.offset = offset;
      return { arguments: args };
    },
    encode: collectionCodec,
  }],
]);
