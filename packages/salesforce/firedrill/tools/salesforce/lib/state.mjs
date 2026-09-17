// Session plumbing over context.state: the org row, the calling user (identity resolution with the
// documented fresh-install fallback), the profile's object permissions, org-wide-default sharing,
// bounded scans, timestamps, the id counter, the write journal and the declared-error helpers.
// Every decision is derived from rows; naming conventions never grant anything.

import { mintId } from "./ids.mjs";
import { CHILD_RELATIONSHIPS, NAMESPACES, catalogue, isRecordType } from "./schema.mjs";

const SCAN_STEP = 1000;
export const DEFAULT_ROW_BOUND = 10000;
const SESSION_MESSAGE = "Session expired or invalid";

/** Longest caller-derived name or value quoted in an error message or `fields` entry (declared maxLength 255). */
export const MAX_QUOTED = 255;
/** Longest error message (the framework refuses operation error messages over 4,000 characters). */
export const MAX_MESSAGE = 3000;

/** Clip text to at most `max` code points, ending with "…" when clipped; never splits a surrogate pair. */
export function clip(text, max = MAX_QUOTED) {
  const value = String(text);
  if (value.length <= max) return value;
  let out = "";
  let count = 0;
  for (const char of value) {
    if (count === max - 1) return `${out}…`;
    out += char;
    count += 1;
  }
  return out;
}

function clipFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.map((field) => clip(field)).filter((field) => field.length > 0);
}

/** A declared domain error raised by record processing; single-record operations turn it into context.fail. */
export class RecordError extends Error {
  constructor(statusCode, message, fields = []) {
    super(clip(message, MAX_MESSAGE));
    this.name = "RecordError";
    this.statusCode = statusCode;
    this.fields = clipFields(fields);
  }
}

export function isRecordError(value) {
  return typeof value === "object" && value !== null && value.name === "RecordError" && typeof value.statusCode === "string";
}

export function recordError(statusCode, message, fields) {
  return new RecordError(statusCode, message, fields ?? []);
}

function limitInfo(org) {
  const limits = org.dailyApiRequests ?? { max: 0, used: 0 };
  return `api-usage=${limits.used}/${limits.max}`;
}

/** Stop the operation with a declared Tool error carrying Salesforce's `fields` and the limit header value. */
export function fail(session, statusCode, message, fields) {
  const details = { limitInfo: session.limitInfo };
  const clipped = clipFields(fields);
  if (clipped.length > 0) details.fields = clipped;
  return session.context.fail({ code: statusCode, message: clip(message, MAX_MESSAGE), details });
}

/** Convert a RecordError into the operation's declared failure; rethrow anything else. */
export function raise(session, error) {
  if (isRecordError(error)) return fail(session, error.statusCode, error.message, error.fields);
  throw error;
}

export function boundExceeded(session, namespace, bound) {
  return fail(session, "LIMIT_EXCEEDED", `state exceeds the supported bound of ${bound} rows for ${namespace}`);
}

/** Every row of a namespace in row-id order, failing (never truncating) beyond `bound` rows. */
export function allRows(session, namespace) {
  const bound = session.rowBound;
  const rows = [];
  let after;
  for (;;) {
    const batch = session.context.state.scan(namespace, { ...(after === undefined ? {} : { afterRowId: after }), limit: SCAN_STEP });
    if (batch.length === 0) return rows;
    for (const record of batch) {
      after = record.rowId;
      rows.push(record.value);
      if (rows.length > bound) return boundExceeded(session, namespace, bound);
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

// ---------------------------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------------------------

/** Virtual time → Salesforce's `2026-09-14T09:00:00.000+0000` rendering. */
export function salesforceTimestamp(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, -1)}+0000`;
}

export function nowMs(session) {
  return Math.floor(session.context.clock.nowUs() / 1000);
}

export function timestampNow(session) {
  return salesforceTimestamp(nowMs(session));
}

export function dateNow(session) {
  return new Date(nowMs(session)).toISOString().slice(0, 10);
}

/** ISO-8601 (`Z`, `+0000`, `+00:00`, date-only) → epoch ms, or null when unparseable. */
export function parseInstant(value) {
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text = `${text}T00:00:00Z`;
  const normalized = text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(normalized)) return null;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------------------------
// Session: org, identity, permissions
// ---------------------------------------------------------------------------------------------

function usable(user) {
  return user !== null && user !== undefined && user.IsActive === true;
}

/**
 * The calling Salesforce user: `actor.attributes.username` (case-insensitive, must be active),
 * otherwise the org's `defaultUserId` row (the documented fresh-install identity). An explicit
 * username that matches no active user is an expired/invalid session.
 */
function resolveUser(session) {
  const attributes = session.context.actor.attributes ?? {};
  const username = typeof attributes.username === "string" ? attributes.username.trim().toLowerCase() : "";
  if (username.length > 0) {
    const user = allRows(session, "users").find((row) => typeof row.Username === "string" && row.Username.toLowerCase() === username);
    return usable(user) ? user : fail(session, "INVALID_SESSION_ID", SESSION_MESSAGE);
  }
  const seeded = session.context.state.get("users", session.org.defaultUserId);
  if (usable(seeded)) return seeded;
  const first = allRows(session, "users").find((row) => usable(row));
  return first === undefined ? fail(session, "INVALID_SESSION_ID", SESSION_MESSAGE) : first;
}

const NO_PERMISSIONS = Object.freeze({ create: false, read: false, edit: false, delete: false, viewAll: false, modifyAll: false });
const READ_ONLY_PERMISSIONS = Object.freeze({ create: false, read: true, edit: false, delete: false, viewAll: true, modifyAll: false });

/** Open a session: org row, identity, profile. Authentication happens before anything else. */
export function openSession(context) {
  const org = context.state.get("org", "org");
  const session = {
    context,
    org: org ?? { organizationId: "", name: "", instanceUrl: "", myDomain: "", orgWideDefaults: {}, dailyApiRequests: { max: 0, used: 0 }, dataStorageMB: { max: 0, used: 0 }, defaultUserId: "", limits: { maxRowsPerNamespace: DEFAULT_ROW_BOUND } },
    cache: new Map(),
    journal: [],
    pendingEvents: [],
  };
  session.rowBound = Math.min(DEFAULT_ROW_BOUND, Math.max(1, Number(session.org.limits?.maxRowsPerNamespace ?? DEFAULT_ROW_BOUND)));
  session.limitInfo = limitInfo(session.org);
  if (org === null) return fail(session, "INVALID_SESSION_ID", SESSION_MESSAGE);
  session.user = resolveUser(session);
  session.profile = context.state.get("profiles", session.user.ProfileId);
  return session;
}

export function cached(session, key, load) {
  if (!session.cache.has(key)) session.cache.set(key, load());
  return session.cache.get(key);
}

/** Object permissions of the caller's profile for one sObject type. */
export function permissions(session, type) {
  if (!isRecordType(type)) return READ_ONLY_PERMISSIONS;
  const table = session.profile?.objectPermissions ?? {};
  const entry = table[type];
  return typeof entry === "object" && entry !== null ? { ...NO_PERMISSIONS, ...entry } : NO_PERMISSIONS;
}

export function orgWideDefault(session, type) {
  const value = session.org.orgWideDefaults?.[type];
  return typeof value === "string" ? value : "Private";
}

/** Custom field rows for a type (one `custom-fields` row per sObject, direct lookup — no scan). */
export function customFieldRows(session, type) {
  return cached(session, `custom/${type}`, () => {
    const row = session.context.state.get("custom-fields", type);
    return row === null || !Array.isArray(row.fields) ? [] : row.fields;
  });
}

export function fieldsOf(session, type) {
  return cached(session, `fields/${type}`, () => catalogue(type, customFieldRows(session, type)));
}

/** Parent-reference fields that child relationships group by, per child sObject (e.g. Task → WhoId, WhatId). */
const PARENT_FIELDS = new Map();
for (const relationships of Object.values(CHILD_RELATIONSHIPS)) {
  for (const relationship of relationships) {
    const fields = PARENT_FIELDS.get(relationship.childSObject) ?? [];
    if (!fields.includes(relationship.field)) fields.push(relationship.field);
    PARENT_FIELDS.set(relationship.childSObject, fields);
  }
}
const TYPE_BY_NAMESPACE = new Map(Object.entries(NAMESPACES).map(([type, namespace]) => [namespace, type]));

/** Every row of a type (bounded) plus an Id → position index, cached per operation and kept in sync by putRow. */
function rowTable(session, type) {
  return cached(session, `rows/${type}`, () => {
    const rows = allRows(session, NAMESPACES[type]);
    const byId = new Map();
    rows.forEach((row, index) => byId.set(row.Id, index));
    return { rows, byId };
  });
}

/** All rows of a record namespace, cached per session (bounded). */
export function rowsOf(session, type) {
  return rowTable(session, type).rows;
}

/** One row by id: an O(1) index lookup once the type's rows are cached, a direct state read otherwise. */
export function getRow(session, type, id) {
  const table = session.cache.get(`rows/${type}`);
  if (table !== undefined) {
    const index = table.byId.get(id);
    return index === undefined ? null : table.rows[index];
  }
  return session.context.state.get(NAMESPACES[type], id);
}

function addChild(index, parentId, id) {
  if (typeof parentId !== "string") return;
  const ids = index.get(parentId);
  if (ids === undefined) index.set(parentId, new Set([id]));
  else ids.add(id);
}

/** Rows of `type` whose `field` references `parentId` (deleted ones included), in row order; indexed once per operation. */
export function childRowsOf(session, type, field, parentId) {
  const table = rowTable(session, type);
  const index = cached(session, `children/${type}/${field}`, () => {
    const built = new Map();
    for (const row of table.rows) addChild(built, row.fields?.[field], row.Id);
    return built;
  });
  const ids = index.get(parentId);
  if (ids === undefined) return [];
  return [...ids].map((id) => table.byId.get(id)).sort((left, right) => left - right).map((position) => table.rows[position]);
}

/** Stored field value (`fields` map for record types; flat rows for User/Profile). */
export function valueOf(type, row, fieldName) {
  if (row === null || row === undefined) return null;
  if (!isRecordType(type)) return row[fieldName] === undefined ? null : row[fieldName];
  if (fieldName === "Id" || fieldName === "IsDeleted" || fieldName === "CreatedDate" || fieldName === "CreatedById" || fieldName === "LastModifiedDate" || fieldName === "LastModifiedById" || fieldName === "SystemModstamp") {
    return row[fieldName] === undefined ? null : row[fieldName];
  }
  const value = row.fields?.[fieldName];
  return value === undefined ? null : value;
}

export function isDeleted(row) {
  return row?.IsDeleted === true;
}

// ---------------------------------------------------------------------------------------------
// Sharing (org-wide defaults + ownership + viewAll/modifyAll)
// ---------------------------------------------------------------------------------------------

function parentAccount(session, row) {
  const accountId = valueOf("Contact", row, "AccountId");
  if (typeof accountId !== "string") return null;
  const account = getRow(session, "Account", accountId);
  return account === null || isDeleted(account) ? null : account;
}

/** May the caller see this (existing) record? Unreadable types are handled by the caller. */
export function canRead(session, type, row) {
  if (!isRecordType(type)) return true;
  const perms = permissions(session, type);
  if (!perms.read) return false;
  if (perms.viewAll || perms.modifyAll) return true;
  const owd = orgWideDefault(session, type);
  if (owd === "ReadOnly" || owd === "ReadWrite") return true;
  if (owd === "ControlledByParent") {
    const parent = parentAccount(session, row);
    return parent === null ? valueOf(type, row, "OwnerId") === session.user.Id : canRead(session, "Account", parent);
  }
  return valueOf(type, row, "OwnerId") === session.user.Id;
}

/** May the caller edit (`edit`) or delete (`delete`) this readable record? */
export function canModify(session, type, row, action) {
  if (!isRecordType(type)) return false;
  const perms = permissions(session, type);
  if (!perms[action]) return false;
  if (perms.modifyAll) return true;
  const owd = orgWideDefault(session, type);
  if (owd === "ReadWrite") return true;
  if (owd === "ControlledByParent") {
    const parent = parentAccount(session, row);
    return parent === null ? valueOf(type, row, "OwnerId") === session.user.Id : canModify(session, "Account", parent, action);
  }
  return valueOf(type, row, "OwnerId") === session.user.Id;
}

// ---------------------------------------------------------------------------------------------
// Writes: journal (for allOrNone rollback), id counter, events
// ---------------------------------------------------------------------------------------------

/** Put a row, remembering the previous value so an envelope operation can roll it back. */
export function putRow(session, namespace, rowId, value) {
  const previous = session.context.state.get(namespace, rowId);
  session.journal.push({ namespace, rowId, previous });
  session.context.state.put(namespace, rowId, value);
  const type = TYPE_BY_NAMESPACE.get(namespace);
  if (type === undefined) return;
  const table = session.cache.get(`rows/${type}`);
  if (table === undefined) return;
  const position = table.byId.get(rowId);
  const before = position === undefined ? null : table.rows[position];
  if (position === undefined) {
    table.byId.set(rowId, table.rows.length);
    table.rows.push(value);
  } else table.rows[position] = value;
  for (const field of PARENT_FIELDS.get(type) ?? []) {
    const index = session.cache.get(`children/${type}/${field}`);
    if (index === undefined) continue;
    const oldParent = before?.fields?.[field];
    const newParent = value?.fields?.[field];
    if (oldParent === newParent) continue;
    if (typeof oldParent === "string") index.get(oldParent)?.delete(rowId);
    addChild(index, newParent, rowId);
  }
}

/** Undo every journaled write since `mark` (in reverse order) and drop the events queued since. */
export function rollback(session, mark) {
  while (session.journal.length > mark.journal) {
    const entry = session.journal.pop();
    if (entry.previous === null) session.context.state.delete(entry.namespace, entry.rowId);
    else session.context.state.put(entry.namespace, entry.rowId, entry.previous);
  }
  session.pendingEvents.length = mark.events;
  session.cache.clear();
}

export function mark(session) {
  return { journal: session.journal.length, events: session.pendingEvents.length };
}

export function queueEvent(session, eventId, payload) {
  session.pendingEvents.push({ eventId, payload });
}

/** Emit every queued event (called once the response envelope is final). */
export function flushEvents(session) {
  for (const entry of session.pendingEvents) session.context.events.emit(entry.eventId, entry.payload);
  session.pendingEvents.length = 0;
}

/** Next id for `type` from the single org-wide record-number sequence. */
export function nextId(session, type) {
  const counters = session.context.state.get("meta", "counters") ?? { nextRecordNumber: 1 };
  const number = Number(counters.nextRecordNumber ?? 1);
  putRow(session, "meta", "counters", { ...counters, nextRecordNumber: number + 1 });
  return mintId(type, number);
}
