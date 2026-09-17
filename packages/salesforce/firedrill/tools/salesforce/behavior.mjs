// Synthetic Salesforce org. Every operation computes from context.state: record ids come from the
// `meta/counters` row, timestamps from the virtual clock, visibility from the calling user's profile
// and the org-wide defaults. Nothing here contacts Salesforce; no e-mail, Chatter post, workflow or
// trigger ever runs.
import { normalizeId, typeOfId } from "./lib/ids.mjs";
import { NOT_FOUND_MESSAGE, createRecord, deleteRecord, findByExternalId, recentItems, recordUrl, renderPaths, renderRecord, requireExternalIdField, requireId, requireReadableType, requireRecord, requireWritableType, resolvePath, updateRecord, upsertRecord } from "./lib/records.mjs";
import { ALL_TYPES, DEFAULT_VERSION, canonicalType, describeSObject, fieldByName, isRecordType, isSupportedVersion, sobjectSummary, versionsTable } from "./lib/schema.mjs";
import { parameterizedSearch } from "./lib/search.mjs";
import { clampBatchSize, decodeLocator, executeQuery, parseQuery, tooLargeMessage } from "./lib/soql.mjs";
import { allRows, canRead, clip, fieldsOf, flushEvents, getRow, isDeleted, isRecordError, mark, openSession, permissions, raise, recordError, rollback } from "./lib/state.mjs";
import { RESPONSE_BYTE_BUDGET, byteBudget, jsonBytes } from "./lib/bytes.mjs";
import { batchSizeHeader, boolOrRaw, defined, jsonBody, list, operationInput, responseHeaders, salesforceError, str, stripLimitInfo } from "./lib/wire.mjs";

const MAX_COLLECTION = 200;
const MAX_RETRIEVE_IDS = 2000;
const MAX_SUBREQUESTS = 25;
const MAX_QUERY_SUBREQUESTS = 5;
const ROLLED_BACK = "Record rolled back because not all records were valid and the request was using AllOrNone header";
const HALTED = "The transaction was rolled back since another operation in the same transaction failed.";
const JSON_TYPE = "application/json;charset=UTF-8";

// ---------------------------------------------------------------------------------------------
// Operation plumbing
// ---------------------------------------------------------------------------------------------

/** Open the session, run, flush events, attach the limit carrier; RecordErrors become declared failures. */
function operation(handler) {
  return (input, context) => {
    const session = openSession(context);
    let value;
    try {
      value = handler(session, input);
    } catch (error) {
      return raise(session, error);
    }
    flushEvents(session);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return { ...value, _limitInfo: session.limitInfo };
    return value;
  };
}

function requireVersion(session, input) {
  const version = input.version === undefined ? DEFAULT_VERSION : input.version;
  if (!isSupportedVersion(version)) throw recordError("NOT_FOUND", NOT_FOUND_MESSAGE);
  return version;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parserError(message) {
  return recordError("JSON_PARSER_ERROR", message);
}

function itemError(error) {
  if (!isRecordError(error)) throw error;
  return { statusCode: error.statusCode, message: error.message, fields: error.fields };
}

// ---------------------------------------------------------------------------------------------
// Handshake, identity, limits, describe
// ---------------------------------------------------------------------------------------------

function userinfo(session, input) {
  if (input.defaultDevHub === true) throw recordError("NOT_FOUND", "No Dev Hub org is configured for this Tool");
  const org = session.org;
  const user = session.user;
  const base = String(org.instanceUrl ?? "").replace(/\/$/, "");
  const modified = Math.floor(Date.parse(String(user.LastModifiedDate ?? "1970-01-01T00:00:00.000+0000").replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) / 1000);
  return {
    sub: `${base}/id/${org.organizationId}/${user.Id}`,
    user_id: user.Id,
    organization_id: org.organizationId,
    preferred_username: user.Username,
    nickname: user.Alias,
    name: user.Name,
    email: user.Email,
    email_verified: true,
    given_name: user.FirstName ?? "",
    family_name: user.LastName,
    zoneinfo: user.TimeZoneSidKey,
    photos: { picture: `${base}/profilephoto/005/F`, thumbnail: `${base}/profilephoto/005/T` },
    profile: `${base}/${user.Id}`,
    picture: `${base}/profilephoto/005/F`,
    address: { country: String(user.LocaleSidKey ?? "en_US").split("_")[1] ?? "US" },
    urls: {
      enterprise: `${base}/services/Soap/c/{version}/${org.organizationId}`,
      metadata: `${base}/services/Soap/m/{version}/${org.organizationId}`,
      partner: `${base}/services/Soap/u/{version}/${org.organizationId}`,
      rest: `${base}/services/data/v{version}/`,
      sobjects: `${base}/services/data/v{version}/sobjects/`,
      search: `${base}/services/data/v{version}/search/`,
      query: `${base}/services/data/v{version}/query/`,
      recent: `${base}/services/data/v{version}/recent/`,
      profile: `${base}/${user.Id}`,
      custom_domain: base,
    },
    active: user.IsActive === true,
    user_type: user.UserType ?? "Standard",
    language: user.LanguageLocaleKey ?? "en_US",
    locale: user.LocaleSidKey ?? "en_US",
    utcOffset: 0,
    updated_at: new Date(modified * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    is_app_installed: false,
  };
}

function limits(session, input) {
  requireVersion(session, input);
  const api = session.org.dailyApiRequests ?? { max: 0, used: 0 };
  const storage = session.org.dataStorageMB ?? { max: 0, used: 0 };
  const pair = (max, used = 0) => ({ Max: max, Remaining: Math.max(0, max - used) });
  return {
    DailyApiRequests: pair(api.max, api.used),
    DailyBulkApiBatches: pair(15000),
    DailyBulkV2QueryJobs: pair(10000),
    DailyAsyncApexExecutions: pair(250000),
    DailyStreamingApiEvents: pair(50000),
    DataStorageMB: pair(storage.max, storage.used),
    FileStorageMB: pair(Math.max(storage.max, 1) * 10, 0),
    HourlyODataCallout: pair(20000),
    ConcurrentAsyncGetReportInstances: pair(200),
    MassEmail: pair(5000),
    SingleEmail: pair(5000),
    PermissionSets: { ...pair(1500), CreateCustom: pair(1000) },
  };
}

function readableTypes(session) {
  return ALL_TYPES.filter((type) => permissions(session, type).read).sort();
}

function sobjectsList(session, input) {
  const version = requireVersion(session, input);
  return { encoding: "UTF-8", maxBatchSize: MAX_COLLECTION, sobjects: readableTypes(session).map((type) => sobjectSummary(type, version, permissions(session, type))) };
}

function describableType(session, input) {
  const type = canonicalType(input.sobjectType);
  if (type === null || !permissions(session, type).read) throw recordError("NOT_FOUND", NOT_FOUND_MESSAGE);
  return type;
}

function basicInfo(session, input) {
  const version = requireVersion(session, input);
  const type = describableType(session, input);
  return { objectDescribe: sobjectSummary(type, version, permissions(session, type)), recentItems: recentItems(session, type, version) };
}

function describe(session, input) {
  const version = requireVersion(session, input);
  const type = describableType(session, input);
  return describeSObject(type, version, permissions(session, type), fieldsOf(session, type));
}

// ---------------------------------------------------------------------------------------------
// sObject rows
// ---------------------------------------------------------------------------------------------

function create(session, input) {
  requireVersion(session, input);
  const type = requireWritableType(session, input.sobjectType, "create");
  const row = createRecord(session, type, input.record);
  return { id: row.Id, success: true, errors: [] };
}

function retrieve(session, input) {
  const version = requireVersion(session, input);
  const type = requireReadableType(session, input.sobjectType);
  let row;
  if (input.externalIdField !== undefined || input.value !== undefined) {
    const field = requireExternalIdField(session, type, input.externalIdField);
    const matches = findByExternalId(session, type, field, input.value ?? "");
    row = matches[0] ?? null;
    if (row === null || !canRead(session, type, row)) throw recordError("NOT_FOUND", NOT_FOUND_MESSAGE);
  } else {
    if (input.id === undefined) throw recordError("MALFORMED_ID", "malformed id (missing)");
    row = requireRecord(session, type, input.id);
  }
  if (Array.isArray(input.fields)) {
    const paths = input.fields.map((path) => resolvePath(session, type, path, "sobject"));
    const rendered = renderPaths(session, type, row, version, paths);
    if (rendered.Id === undefined) rendered.Id = row.Id;
    return rendered;
  }
  return renderRecord(session, type, row, version);
}

function update(session, input) {
  requireVersion(session, input);
  const type = requireWritableType(session, input.sobjectType, "update");
  updateRecord(session, type, input.id, input.record);
  return {};
}

function remove(session, input) {
  requireVersion(session, input);
  const type = requireWritableType(session, input.sobjectType, "delete");
  deleteRecord(session, type, input.id);
  return {};
}

function upsert(session, input) {
  requireVersion(session, input);
  const type = requireWritableType(session, input.sobjectType, "upsert");
  const result = upsertRecord(session, type, input.externalIdField, input.value, input.record);
  return { id: result.id, success: true, errors: [], created: result.created };
}

// ---------------------------------------------------------------------------------------------
// SOQL and search
// ---------------------------------------------------------------------------------------------

function requireAlias(session, value) {
  if (value === undefined) return;
  const wanted = String(value).toLowerCase();
  const hit = allRows(session, "users").some((user) => user.IsActive === true && (String(user.Username).toLowerCase() === wanted || String(user.Alias ?? "").toLowerCase() === wanted));
  if (!hit) throw recordError("NOT_FOUND", `No authorization information found for ${clip(value)}.`);
}

/** `byteLimit` is internal (composite passes the bytes left in its response); callers cannot set it. */
function query(session, input, byteLimit = RESPONSE_BYTE_BUDGET) {
  const version = requireVersion(session, input);
  const spellings = [input.q, input.query].filter((value) => typeof value === "string");
  if (spellings.length !== 1) throw recordError("MALFORMED_QUERY", "exactly one of 'q' or 'query' must carry the SOQL statement");
  if (input.useToolingApi === true) throw recordError("INVALID_TYPE", "Tooling API objects are not simulated by this Tool (useToolingApi must be false)");
  requireAlias(session, input.usernameOrAlias);
  const text = spellings[0];
  if (text.trim().length === 0) throw recordError("MALFORMED_QUERY", "the q parameter is required");
  // The HTTP layer decodes undecodable percent-encoding (e.g. %E0%A4%A) to U+FFFD and codecs never see the
  // raw bytes, so a statement carrying U+FFFD is rejected rather than run with corrupted literals.
  if (text.includes("\uFFFD")) throw recordError("MALFORMED_QUERY", "the q parameter is not valid percent-encoded UTF-8");
  const parsed = parseQuery(text);
  return executeQuery(session, parsed, { text, version, includeDeleted: input.includeDeleted === true, batchSize: clampBatchSize(input.batchSize), offset: 0, byteLimit });
}

function queryMore(session, input) {
  const version = requireVersion(session, input);
  const locator = decodeLocator(input.locator);
  if (locator === null || locator.userId !== session.user.Id) throw recordError("INVALID_QUERY_LOCATOR", "invalid query locator");
  const parsed = parseQuery(locator.q);
  return executeQuery(session, parsed, { text: locator.q, version, includeDeleted: locator.includeDeleted, batchSize: locator.batchSize, offset: locator.offset });
}

function search(session, input) {
  const version = requireVersion(session, input);
  return parameterizedSearch(session, input, version);
}

// ---------------------------------------------------------------------------------------------
// sObject Collections
// ---------------------------------------------------------------------------------------------

function requireRecordsEnvelope(input) {
  if (!Array.isArray(input.records) || input.records.length === 0) throw parserError("records must be a non-empty array of sObject records");
  if (input.records.length > MAX_COLLECTION) throw recordError("LIMIT_EXCEEDED", `Cannot process more than ${MAX_COLLECTION} records at once`);
  for (const record of input.records) {
    if (!isPlainObject(record) || !isPlainObject(record.attributes) || typeof record.attributes.type !== "string") {
      throw parserError("Each record must carry attributes.type naming its sObject");
    }
  }
  return input.records;
}

function bodyWithout(record, keys) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key) && key !== "attributes"));
}

/** Run one item per record; under allOrNone a single failure rolls everything back. */
function envelope(session, items, allOrNone, run) {
  const start = mark(session);
  const results = items.map((item) => {
    try {
      return run(item);
    } catch (error) {
      return { id: null, success: false, errors: [itemError(error)] };
    }
  });
  if (allOrNone === true && results.some((result) => result.success === false)) {
    rollback(session, start);
    return results.map((result) => (result.success ? { id: result.id, success: false, errors: [{ statusCode: "ALL_OR_NONE_OPERATION_ROLLED_BACK", message: ROLLED_BACK, fields: [] }] } : result));
  }
  return results;
}

function collectionsCreate(session, input) {
  requireVersion(session, input);
  const records = requireRecordsEnvelope(input);
  return envelope(session, records, input.allOrNone, (record) => {
    const type = requireWritableType(session, record.attributes.type, "create");
    const row = createRecord(session, type, bodyWithout(record, []));
    return { id: row.Id, success: true, errors: [] };
  });
}

function collectionsRetrieve(session, input) {
  const version = requireVersion(session, input);
  const type = requireReadableType(session, input.sobjectType);
  if (!Array.isArray(input.ids) || input.ids.length === 0) throw parserError("ids must be a non-empty array of record ids");
  if (input.ids.length > MAX_RETRIEVE_IDS) throw recordError("LIMIT_EXCEEDED", `Cannot retrieve more than ${MAX_RETRIEVE_IDS} records at once`);
  if (!Array.isArray(input.fields) || input.fields.length === 0) throw parserError("fields must be a non-empty array of field names");
  const paths = input.fields.map((path) => resolvePath(session, type, path, "sobject"));
  // Each entry is measured before it is admitted; a response past the byte budget fails LIMIT_EXCEEDED.
  const budget = byteBudget(RESPONSE_BYTE_BUDGET, 2);
  return input.ids.map((raw) => {
    const id = requireId(raw);
    const row = typeOfId(id) === type ? getRow(session, type, id) : null;
    let rendered = null;
    if (row !== null && !isDeleted(row) && canRead(session, type, row)) {
      rendered = renderPaths(session, type, row, version, paths);
      if (rendered.Id === undefined) rendered.Id = row.Id;
    }
    if (!budget.admit(rendered)) throw recordError("LIMIT_EXCEEDED", tooLargeMessage(RESPONSE_BYTE_BUDGET));
    return rendered;
  });
}

function collectionsUpdate(session, input) {
  requireVersion(session, input);
  const records = requireRecordsEnvelope(input);
  return envelope(session, records, input.allOrNone, (record) => {
    const type = requireWritableType(session, record.attributes.type, "update");
    const idKey = Object.keys(record).find((key) => key.toLowerCase() === "id");
    if (idKey === undefined || typeof record[idKey] !== "string") throw recordError("MISSING_ARGUMENT", "Id not specified in an update call", ["Id"]);
    const { row } = updateRecord(session, type, record[idKey], bodyWithout(record, [idKey]));
    return { id: row.Id, success: true, errors: [] };
  });
}

function collectionsDelete(session, input) {
  requireVersion(session, input);
  if (!Array.isArray(input.ids) || input.ids.length === 0) throw parserError("ids must be a non-empty list of record ids");
  if (input.ids.length > MAX_COLLECTION) throw recordError("LIMIT_EXCEEDED", `Cannot process more than ${MAX_COLLECTION} records at once`);
  return envelope(session, input.ids, input.allOrNone, (raw) => {
    const id = requireId(raw);
    const type = typeOfId(id);
    if (type === null) throw recordError("MALFORMED_ID", `malformed id ${clip(id)}`);
    requireWritableType(session, type, "delete");
    deleteRecord(session, type, id);
    return { id, success: true, errors: [] };
  });
}

function collectionsUpsert(session, input) {
  requireVersion(session, input);
  const type = requireWritableType(session, input.sobjectType, "upsert");
  const field = fieldByName(fieldsOf(session, type), input.externalIdField);
  if (field === null) throw recordError("INVALID_FIELD", `No such column '${clip(input.externalIdField)}' on sobject of type ${type}`, [String(input.externalIdField)]);
  if (field.name !== "Id" && !field.externalId) throw recordError("INVALID_FIELD", `${field.name} is not an external ID field on ${type}`, [field.name]);
  const records = requireRecordsEnvelope(input);
  return envelope(session, records, input.allOrNone, (record) => {
    if (canonicalType(record.attributes.type) !== type) throw recordError("INVALID_TYPE", `sObject type '${clip(record.attributes.type)}' does not match the collection type ${type}`);
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === field.name.toLowerCase());
    if (key === undefined || record[key] === null || record[key] === undefined) throw recordError("MISSING_ARGUMENT", `External ID field ${field.name} not specified`, [field.name]);
    const result = upsertRecord(session, type, field.name, String(record[key]), bodyWithout(record, [key]));
    return { id: result.id, success: true, errors: [], created: result.created };
  });
}

// ---------------------------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------------------------

const REFERENCE = /@\{([A-Za-z0-9_]+)((?:\.[A-Za-z0-9_]+|\[\d+\])*)\}/g;

function referenceError(text) {
  return { statusCode: "INVALID_INPUT", message: `Invalid reference specified. No value for ${clip(text)} found in ${clip(text.replace(/^@\{|\}$/g, "").split(/[.[]/)[0])}`, fields: [] };
}

function lookupReference(refs, name, path) {
  const body = refs.get(name);
  if (body === undefined) return undefined;
  let current = body;
  const segments = path.match(/\.[A-Za-z0-9_]+|\[\d+\]/g) ?? [];
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    if (segment.startsWith("[")) current = current[Number(segment.slice(1, -1))];
    else {
      const key = segment.slice(1);
      const actual = Object.keys(current).find((candidate) => candidate === key) ?? Object.keys(current).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      current = actual === undefined ? undefined : current[actual];
    }
  }
  return current;
}

function substitute(value, refs) {
  if (typeof value === "string") {
    return value.replace(REFERENCE, (match, name, path) => {
      const resolved = lookupReference(refs, name, path);
      if (resolved === undefined || resolved === null || typeof resolved === "object") throw { reference: match };
      return String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, refs));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, refs)]));
  return value;
}

/** decodeURIComponent that answers null for malformed percent-encoding instead of throwing. */
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Split a subrequest url into version, decoded path segments and query parameters. Malformed
 * percent-encoding never throws: an undecodable path segment makes the url unresolvable (the caller
 * answers NOT_FOUND like any other unknown resource) and an undecodable parameter is recorded in
 * `invalid` so the route that reads it raises its own Salesforce error.
 */
function parseSubrequestUrl(url) {
  const match = /^\/services\/data\/(v\d{2}\.\d)\/([^?]*)(?:\?(.*))?$/.exec(url);
  if (match === null) return null;
  const query = {};
  const invalid = new Set();
  for (const pair of (match[3] ?? "").split("&")) {
    if (pair.length === 0) continue;
    const [rawKey, ...rest] = pair.split("=");
    const key = safeDecode(rawKey.replace(/\+/g, " "));
    const value = safeDecode(rest.join("=").replace(/\+/g, " "));
    if (key === null) continue;
    if (value === null) invalid.add(key);
    else query[key] = value;
  }
  const segments = [];
  for (const raw of match[2].split("/")) {
    if (raw.length === 0) continue;
    const segment = safeDecode(raw);
    if (segment === null) return null;
    segments.push(segment);
  }
  return { version: match[1], segments, query, invalid };
}

const SOBJECT_STATUSES = { INVALID_SESSION_ID: 401, INSUFFICIENT_ACCESS_OR_READONLY: 403, NOT_FOUND: 404, ENTITY_IS_DELETED: 404, INVALID_TYPE: 404 };
const QUERY_STATUSES = { INVALID_SESSION_ID: 401, INSUFFICIENT_ACCESS_OR_READONLY: 403, NOT_FOUND: 404 };

/** Dispatch one composite subrequest; returns `{ status, body, headers }` or throws a RecordError. */
function dispatch(session, method, parsed, byteLimit) {
  const { version, segments, query: params, invalid } = parsed;
  const input = { version };
  if (invalid.has("fields")) throw recordError("INVALID_FIELD", "the fields parameter is not valid percent-encoded UTF-8", ["fields"]);
  const [head, type, third, fourth] = segments;
  if (head === "limits" && segments.length === 1 && method === "GET") return { status: 200, body: limits(session, input), headers: {} };
  if ((head === "query" || head === "queryAll") && segments.length === 1 && method === "GET") {
    if (invalid.has("q")) throw recordError("MALFORMED_QUERY", "the q parameter is not valid percent-encoded UTF-8");
    if (typeof params.q !== "string") throw recordError("MALFORMED_QUERY", "the q parameter is required");
    return { status: 200, body: query(session, { ...input, q: params.q, includeDeleted: head === "queryAll" }, byteLimit), headers: {}, kind: "query" };
  }
  if (head === "sobjects" && segments.length === 2) {
    if (method === "POST") return { status: 201, kind: "create", body: create(session, { ...input, sobjectType: type, record: parsed.body ?? {} }) };
    if (method === "GET") return { status: 200, body: basicInfo(session, { ...input, sobjectType: type }), headers: {} };
  }
  if (head === "sobjects" && segments.length === 3) {
    if (third === "describe" && method === "GET") return { status: 200, body: describe(session, { ...input, sobjectType: type }), headers: {} };
    if (method === "GET") return { status: 200, body: retrieve(session, { ...input, sobjectType: type, id: third, ...(typeof params.fields === "string" ? { fields: params.fields.split(",").map((part) => part.trim()).filter((part) => part.length > 0) } : {}) }), headers: {} };
    if (method === "PATCH") {
      update(session, { ...input, sobjectType: type, id: third, record: parsed.body ?? {} });
      return { status: 204, body: null, headers: {} };
    }
    if (method === "DELETE") {
      remove(session, { ...input, sobjectType: type, id: third });
      return { status: 204, body: null, headers: {} };
    }
  }
  if (head === "sobjects" && segments.length === 4) {
    if (method === "GET") return { status: 200, body: retrieve(session, { ...input, sobjectType: type, externalIdField: third, value: fourth, ...(typeof params.fields === "string" ? { fields: params.fields.split(",").map((part) => part.trim()).filter((part) => part.length > 0) } : {}) }), headers: {} };
    if (method === "PATCH") return { status: 200, body: upsert(session, { ...input, sobjectType: type, externalIdField: third, value: fourth, record: parsed.body ?? {} }), headers: {} };
  }
  throw recordError("NOT_FOUND", NOT_FOUND_MESSAGE);
}

function composite(session, input) {
  const outerVersion = requireVersion(session, input);
  const subrequests = input.compositeRequest;
  if (!Array.isArray(subrequests) || subrequests.length === 0) throw parserError("compositeRequest must be a non-empty array of subrequests");
  if (subrequests.length > MAX_SUBREQUESTS) throw recordError("LIMIT_EXCEEDED", `Composite requests may contain at most ${MAX_SUBREQUESTS} subrequests`);
  const seen = new Set();
  let queries = 0;
  for (const sub of subrequests) {
    if (!isPlainObject(sub) || !["GET", "POST", "PATCH", "DELETE"].includes(sub.method) || typeof sub.url !== "string" || typeof sub.referenceId !== "string" || !/^[A-Za-z0-9_]+$/.test(sub.referenceId)) {
      throw parserError("Each subrequest needs a method (GET, POST, PATCH or DELETE), a url and an alphanumeric referenceId");
    }
    if (seen.has(sub.referenceId)) throw parserError(`Duplicate referenceId: ${sub.referenceId}`);
    seen.add(sub.referenceId);
    if (/^\/services\/data\/v\d{2}\.\d\/query(All)?(\?|$)/.test(sub.url)) queries += 1;
  }
  if (queries > MAX_QUERY_SUBREQUESTS) throw recordError("LIMIT_EXCEEDED", `Composite requests may contain at most ${MAX_QUERY_SUBREQUESTS} query subrequests`);

  const start = mark(session);
  const refs = new Map();
  const responses = [];
  // Every entry is measured before it is admitted. Reads that would pass the response budget, and error
  // entries echoing oversized caller text, become a fixed-size LIMIT_EXCEEDED entry (reserved below the
  // 1 MiB cap: at most 25 × a few hundred bytes); write results are small and always admitted.
  const budget = byteBudget(RESPONSE_BYTE_BUDGET, jsonBytes({ compositeResponse: [] }));
  const admit = (entry, sub, alwaysFits) => {
    const size = budget.measure({ ...entry, body: entry.body === null ? null : stripLimitInfo(entry.body) });
    if (alwaysFits || budget.fits(size)) {
      budget.add(size);
      return entry;
    }
    const tooLarge = { body: [{ message: tooLargeMessage(RESPONSE_BYTE_BUDGET), errorCode: "LIMIT_EXCEEDED" }], httpHeaders: {}, httpStatusCode: 400, referenceId: sub.referenceId };
    budget.add(budget.measure(tooLarge));
    return tooLarge;
  };
  let failed = false;
  for (const sub of subrequests) {
    if (failed && input.allOrNone === true) {
      responses.push(admit({ body: [{ errorCode: "PROCESSING_HALTED", message: HALTED }], httpHeaders: {}, httpStatusCode: 400, referenceId: sub.referenceId }, sub, true));
      continue;
    }
    let outcome;
    try {
      const url = substitute(sub.url, refs);
      const body = substitute(sub.body ?? null, refs);
      const parsed = parseSubrequestUrl(url);
      if (parsed === null) throw recordError("NOT_FOUND", NOT_FOUND_MESSAGE);
      if (!isSupportedVersion(parsed.version)) throw recordError("NOT_FOUND", NOT_FOUND_MESSAGE);
      // A query page shrinks to the bytes left (done:false with a working nextRecordsUrl).
      const room = RESPONSE_BYTE_BUDGET - budget.used - jsonBytes({ body: null, httpHeaders: {}, httpStatusCode: 200, referenceId: sub.referenceId }) + 4 - 1;
      const result = dispatch(session, sub.method, { ...parsed, body }, room);
      const headers = result.kind === "create" ? { Location: recordUrl(parsed.version, canonicalType(parsed.segments[1]), result.body.id) } : {};
      const admitted = admit({ body: result.body, httpHeaders: headers, httpStatusCode: result.status, referenceId: sub.referenceId }, sub, sub.method !== "GET");
      outcome = admitted;
      if (admitted.httpStatusCode >= 400) failed = true;
      else if (result.body !== null && typeof result.body === "object") refs.set(sub.referenceId, result.body);
    } catch (error) {
      let entry;
      if (isRecordError(error)) {
        const table = /^\/services\/data\/v\d{2}\.\d\/(query|queryAll|parameterizedSearch)/.test(sub.url) ? QUERY_STATUSES : SOBJECT_STATUSES;
        const entryBody = { message: error.message, errorCode: error.statusCode };
        if (error.fields.length > 0) entryBody.fields = error.fields;
        entry = { body: [entryBody], httpHeaders: {}, httpStatusCode: table[error.statusCode] ?? 400, referenceId: sub.referenceId };
      } else if (isPlainObject(error) && typeof error.reference === "string") {
        const problem = referenceError(error.reference);
        entry = { body: [{ message: problem.message, errorCode: problem.statusCode }], httpHeaders: {}, httpStatusCode: 400, referenceId: sub.referenceId };
      } else throw error;
      outcome = admit(entry, sub, false);
      failed = true;
    }
    responses.push(outcome);
  }
  if (failed && input.allOrNone === true) {
    rollback(session, start);
    return {
      compositeResponse: responses.map((entry) => (entry.httpStatusCode >= 400 && entry.body?.[0]?.errorCode !== "PROCESSING_HALTED" ? entry : { body: [{ errorCode: "PROCESSING_HALTED", message: HALTED }], httpHeaders: {}, httpStatusCode: 400, referenceId: entry.referenceId })),
    };
  }
  return { compositeResponse: responses.map((entry) => ({ ...entry, body: entry.body === null ? null : stripLimitInfo(entry.body) })) };
}

// ---------------------------------------------------------------------------------------------
// HTTP codecs (pure): Salesforce paths in, Salesforce bodies/headers out
// ---------------------------------------------------------------------------------------------

function route(decode, options = {}) {
  return {
    decode,
    encode({ invocation, outcome }) {
      const extra = { "content-type": JSON_TYPE };
      if (outcome.status !== "ok") return { headers: responseHeaders(outcome, extra), body: { kind: "json", value: salesforceError(outcome) } };
      if (options.empty) return { headers: responseHeaders(outcome), body: { kind: "empty" } };
      if (options.location) {
        const id = String(outcome.value?.id ?? "");
        const version = typeof invocation.arguments?.version === "string" ? invocation.arguments.version : DEFAULT_VERSION;
        const type = typeOfId(normalizeId(id) ?? "") ?? String(invocation.arguments?.sobjectType ?? "");
        extra.location = recordUrl(version, type, id);
      }
      return { headers: responseHeaders(outcome, extra), body: { kind: "json", value: stripLimitInfo(outcome.value) } };
    },
  };
}

const versioned = (request) => ({ version: request.path.version });
const typed = (request) => ({ ...versioned(request), sobjectType: request.path.sobjectType });
const withFields = (request, args) => defined({ ...args, fields: list(request.query, "fields") });

function queryArguments(request, includeDeleted) {
  return defined({ ...versioned(request), q: str(request.query, "q") ?? "", includeDeleted, batchSize: batchSizeHeader(request) });
}

const http = {
  "list-versions": route(() => ({ arguments: {} })),
  "get-userinfo": route(() => ({ arguments: {} })),
  "get-limits": route((request) => ({ arguments: versioned(request) })),
  "list-sobjects": route((request) => ({ arguments: versioned(request) })),
  "get-sobject-basic-info": route((request) => ({ arguments: typed(request) })),
  "create-record": route((request) => operationInput(request, { ...typed(request), record: jsonBody(request) }), { location: true }),
  "retrieve-record": route((request) => ({ arguments: withFields(request, { ...typed(request), id: request.path.id }) })),
  "update-record": route((request) => operationInput(request, { ...typed(request), id: request.path.id, record: jsonBody(request) }), { empty: true }),
  "delete-record": route((request) => operationInput(request, { ...typed(request), id: request.path.id }), { empty: true }),
  "retrieve-record-by-external-id": route((request) => ({ arguments: withFields(request, { ...typed(request), externalIdField: request.path.externalIdField, value: request.path.value }) })),
  "upsert-record": route((request) => operationInput(request, { ...typed(request), externalIdField: request.path.externalIdField, value: request.path.value, record: jsonBody(request) })),
  query: route((request) => ({ arguments: queryArguments(request, undefined) })),
  "query-all": route((request) => ({ arguments: queryArguments(request, true) })),
  "query-more": route((request) => ({ arguments: { ...versioned(request), locator: request.path.locator } })),
  "query-all-more": route((request) => ({ arguments: { ...versioned(request), locator: request.path.locator, includeDeleted: true } })),
  "parameterized-search": route((request) => ({ arguments: { ...versioned(request), ...jsonBody(request) } })),
  "collections-create": route((request) => operationInput(request, { ...versioned(request), ...jsonBody(request) })),
  "collections-update": route((request) => operationInput(request, { ...versioned(request), ...jsonBody(request) })),
  "collections-delete": route((request) => operationInput(request, defined({ ...versioned(request), ids: list(request.query, "ids") ?? [], allOrNone: boolOrRaw(request.query, "allOrNone") }))),
  "collections-retrieve": route((request) => ({ arguments: { ...typed(request), ...jsonBody(request) } })),
  "collections-retrieve-get": route((request) => ({ arguments: defined({ ...typed(request), ids: list(request.query, "ids") ?? [], fields: list(request.query, "fields") ?? [] }) })),
  "collections-upsert": route((request) => operationInput(request, { ...typed(request), externalIdField: request.path.externalIdField, ...jsonBody(request) })),
  composite: route((request) => operationInput(request, { ...versioned(request), ...jsonBody(request) })),
};

const operations = {
  "versions.list": operation(() => versionsTable()),
  "userinfo.get": operation(userinfo),
  "limits.get": operation(limits),
  "sobjects.list": operation(sobjectsList),
  "sobjects.basic-info": operation(basicInfo),
  "sobjects.describe": operation(describe),
  "records.create": operation(create),
  "records.retrieve": operation(retrieve),
  "records.update": operation(update),
  "records.delete": operation(remove),
  "records.upsert": operation(upsert),
  "query.execute": operation(query),
  "query.more": operation(queryMore),
  "search.parameterized": operation(search),
  "collections.create": operation(collectionsCreate),
  "collections.retrieve": operation(collectionsRetrieve),
  "collections.update": operation(collectionsUpdate),
  "collections.delete": operation(collectionsDelete),
  "collections.upsert": operation(collectionsUpsert),
  "composite.execute": operation(composite),
};

export default { operations, http };
