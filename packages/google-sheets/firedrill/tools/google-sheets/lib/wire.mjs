// Two provider error envelopes, REST resource projections and pure HTTP codec helpers.
//
// A Sheets agent meets two Google families at once: the Sheets API v4 answers the google.rpc error model
// (`{"error":{"code","message","status"}}`) and the Drive API v3 answers the classic envelope
// (`{"error":{"errors":[{domain,reason,message,locationType,location}],"code","message"}}`).

import { applyFields, parseFields } from "./fields.mjs";
import { assertJsonDepth } from "./json-depth.mjs";

const SHEETS_STATUS = {
  INVALID_ARGUMENT: { status: 400, name: "INVALID_ARGUMENT" },
  FAILED_PRECONDITION: { status: 400, name: "FAILED_PRECONDITION" },
  NOT_FOUND: { status: 404, name: "NOT_FOUND" },
  PERMISSION_DENIED: { status: 403, name: "PERMISSION_DENIED" },
  RATE_LIMITED: { status: 429, name: "RESOURCE_EXHAUSTED" },
  UNAVAILABLE: { status: 503, name: "UNAVAILABLE" },
};

const DRIVE_STATUS = {
  NOT_FOUND: { status: 404, domain: "global", reason: "notFound" },
  INVALID_ARGUMENT: { status: 400, domain: "global", reason: "invalid" },
  FAILED_PRECONDITION: { status: 400, domain: "global", reason: "failedPrecondition" },
  PERMISSION_DENIED: { status: 403, domain: "global", reason: "insufficientFilePermissions" },
  RATE_LIMITED: { status: 403, domain: "usageLimits", reason: "userRateLimitExceeded" },
  UNAVAILABLE: { status: 503, domain: "global", reason: "backendError" },
};

function toolErrorCode(outcome) {
  const code = String(outcome.error?.code ?? "");
  return code.startsWith("tool.") ? code.slice(5) : undefined;
}

/** google.rpc envelope for every `/v4/spreadsheets…` route. */
export function sheetsError(outcome) {
  const error = outcome.error ?? {};
  let message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Invalid request.";
  let mapping = { status: 400, name: "INVALID_ARGUMENT" };
  if (outcome.status === "tool_error") {
    mapping = SHEETS_STATUS[toolErrorCode(outcome)] ?? { status: 500, name: "INTERNAL" };
  } else if (outcome.status === "denied") {
    mapping = { status: 403, name: "PERMISSION_DENIED" };
    message = "Request had insufficient authentication scopes.";
  } else if (outcome.status === "unsupported") {
    mapping = { status: 404, name: "NOT_FOUND" };
    message = "Requested entity was not found.";
  }
  return {
    headers: mapping.name === "RESOURCE_EXHAUSTED" ? { "retry-after": "30" } : {},
    body: { kind: "json", value: { error: { code: mapping.status, message, status: mapping.name } } },
  };
}

/** Drive v3 classic envelope for every `/drive/v3/…` route. */
export function driveError(outcome) {
  const error = outcome.error ?? {};
  let message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Bad Request";
  let mapping;
  if (outcome.status === "tool_error") {
    mapping = { ...(DRIVE_STATUS[toolErrorCode(outcome)] ?? { status: 500, domain: "global", reason: "backendError" }) };
    const details = error.details;
    if (details !== null && typeof details === "object") {
      if (typeof details.reason === "string") mapping.reason = details.reason;
      if (typeof details.location === "string") {
        mapping.location = details.location;
        mapping.locationType = "parameter";
      }
    }
  } else if (outcome.status === "denied") {
    mapping = { status: 403, domain: "global", reason: "insufficientPermissions" };
    message = "Insufficient Permission";
  } else if (outcome.status === "unsupported") {
    mapping = { status: 404, domain: "global", reason: "notFound" };
    message = "Not Found";
  } else {
    mapping = { status: 400, domain: "global", reason: "badRequest" };
  }
  const detail = { domain: mapping.domain, reason: mapping.reason, message };
  if (mapping.locationType !== undefined) {
    detail.locationType = mapping.locationType;
    detail.location = mapping.location;
  }
  return {
    headers: mapping.reason === "userRateLimitExceeded" ? { "retry-after": "30" } : {},
    body: { kind: "json", value: { error: { errors: [detail], code: mapping.status, message } } },
  };
}

// ---------------------------------------------------------------------------------------------
// `fields` masks
// ---------------------------------------------------------------------------------------------

const ANY = { known: /^[A-Za-z][A-Za-z0-9]*$/, sub: {}, anySub: true };

export const FIELD_VOCABULARY = {
  any: ANY,
  spreadsheet: {
    known: ["spreadsheetId", "properties", "sheets", "namedRanges", "spreadsheetUrl", "developerMetadata", "dataSources", "dataSourceSchedules"],
    sub: {},
    anySub: true,
  },
  user: { known: ["kind", "displayName", "emailAddress", "me", "permissionId", "photoLink"], sub: {} },
  capabilities: { known: /^can[A-Z][A-Za-z]*$/, sub: {} },
  file: {
    known: [
      "kind", "id", "name", "mimeType", "starred", "trashed", "explicitlyTrashed", "trashedTime", "createdTime", "modifiedTime",
      "modifiedByMe", "modifiedByMeTime", "viewedByMe", "viewedByMeTime", "sharedWithMeTime", "owners", "lastModifyingUser",
      "shared", "ownedByMe", "capabilities", "permissionIds", "version", "webViewLink", "iconLink", "spaces", "description",
      "size", "quotaBytesUsed", "parents", "exportLinks", "permissions",
    ],
    sub: { owners: "user", lastModifyingUser: "user", capabilities: "capabilities", permissions: "permission" },
  },
  fileList: { known: ["kind", "nextPageToken", "incompleteSearch", "files"], sub: { files: "file" } },
  permission: {
    known: ["kind", "id", "type", "emailAddress", "domain", "role", "allowFileDiscovery", "displayName", "deleted", "pendingOwner"],
    sub: {},
  },
  permissionList: { known: ["kind", "nextPageToken", "permissions"], sub: { permissions: "permission" } },
  about: { known: ["kind", "user", "storageQuota", "maxUploadSize", "appInstalled", "canCreateDrives"], sub: { user: "user" } },
  // Sheets v4 response shapes (Google's `fields` system parameter applies to every method).
  valueRange: { known: ["range", "majorDimension", "values"], sub: {} },
  batchGetValues: { known: ["spreadsheetId", "valueRanges"], sub: { valueRanges: "valueRange" } },
  updateValues: {
    known: ["spreadsheetId", "updatedRange", "updatedRows", "updatedColumns", "updatedCells", "updatedData"],
    sub: { updatedData: "valueRange" },
  },
  appendValues: { known: ["spreadsheetId", "tableRange", "updates"], sub: { updates: "updateValues" } },
  batchUpdateValues: {
    known: ["spreadsheetId", "totalUpdatedRows", "totalUpdatedColumns", "totalUpdatedCells", "totalUpdatedSheets", "responses"],
    sub: { responses: "updateValues" },
  },
  batchUpdateSpreadsheet: { known: ["spreadsheetId", "replies", "updatedSpreadsheet"], sub: { replies: "any", updatedSpreadsheet: "spreadsheet" } },
  sheetProperties: {
    known: ["sheetId", "title", "index", "sheetType", "gridProperties", "hidden", "tabColor", "tabColorStyle", "rightToLeft", "dataSourceSheetProperties"],
    sub: {},
    anySub: true,
  },
};

/** Parses a mask against one vocabulary; throws FieldsError. */
export function parseMask(text, resource) {
  return parseFields(text, FIELD_VOCABULARY[resource], (key) => FIELD_VOCABULARY[key]);
}

/** Applies an already-validated mask. Sheets resources have no `kind`, which applyFields keeps only when present. */
export function maskResource(resource, fieldsText, vocabulary) {
  if (fieldsText === undefined) return resource;
  try {
    return applyFields(resource, parseMask(fieldsText, vocabulary));
  } catch {
    return resource;
  }
}

export function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** Canonical About → REST About: `serverTime` and `limits` exist for the browser app and drills only. */
export function restAbout(about) {
  const { serverTime, limits, ...rest } = about;
  return rest;
}

// ---------------------------------------------------------------------------------------------
// Codec helpers (pure; never throw for provider-validatable input). A value of the wrong type is forwarded unchanged so
// the operation's input schema rejects it and the route answers the provider's 400 envelope.
// ---------------------------------------------------------------------------------------------

export function one(values, name) {
  const list = values[name];
  return list === undefined || list.length === 0 ? undefined : list[0];
}

export function all(values, name) {
  return values[name] === undefined ? undefined : [...values[name]];
}

export function booleanParam(query, name) {
  const value = one(query, name);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

export function integerParam(query, name) {
  const value = one(query, name);
  if (value === undefined) return undefined;
  if (!/^-?\d{1,9}$/.test(value)) return value;
  return Number.parseInt(value, 10);
}

export function pathParam(request, name) {
  const value = request.path[name];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}

export function jsonBody(request) {
  if (request.body.kind !== "json") return {};
  // Refuse over-nested bodies before argument validation recurses on them (see lib/json-depth.mjs).
  const value = assertJsonDepth(request.body.value);
  return value === null || typeof value !== "object" || Array.isArray(value) ? {} : value;
}

export function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

export function mutation(request, args) {
  const key = one(request.headers, "idempotency-key");
  const value = request.body.kind === "json" ? assertJsonDepth(request.body.value) : undefined;
  // A JSON body that is not an object becomes an undeclared argument, which every input schema rejects.
  if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) args = { ...args, requestBody: value };
  return { arguments: compact(args), ...(key === undefined || key.length === 0 ? {} : { idempotencyKey: key }) };
}

/**
 * Google's colon method suffix on a captured segment (`<id>:batchUpdate`, `<range>:append`, `0:copyTo`). Returns the
 * value before the last `:` when the suffix is exactly `method`, otherwise undefined.
 */
export function splitMethod(raw, method) {
  const cut = raw.lastIndexOf(":");
  if (cut <= 0) return undefined;
  return raw.slice(cut + 1) === method ? raw.slice(0, cut) : undefined;
}

export function encodeSheets(render = (value) => value) {
  return ({ outcome }) => {
    if (outcome.status !== "ok") return sheetsError(outcome);
    return { body: { kind: "json", value: render(outcome.value) } };
  };
}

/** Sheets encoder that sends the resource through the route's validated `fields` mask (see checkFields in behavior.mjs). */
export function encodeSheetsMasked(vocabulary) {
  return ({ invocation, outcome }) => {
    if (outcome.status !== "ok") return sheetsError(outcome);
    return { body: { kind: "json", value: maskResource(outcome.value, invocation.arguments.fields, vocabulary) } };
  };
}

export function encodeDrive(render, vocabulary) {
  return ({ invocation, outcome }) => {
    if (outcome.status !== "ok") return driveError(outcome);
    return { body: { kind: "json", value: maskResource(render(outcome.value), invocation.arguments.fields, vocabulary) } };
  };
}

export function encodeEmptyDrive({ outcome }) {
  if (outcome.status !== "ok") return driveError(outcome);
  return { body: { kind: "empty" } };
}
