// Record semantics: sObject type resolution against the profile, body validation and coercion,
// derived fields, the seeded validation rule, uniqueness, sharing-aware create/retrieve/update/
// delete/upsert with Salesforce's cascade, and the record renderers (with one-level relationship
// paths such as `Account.Name`, `Owner.Username`, `Who.Type`). Domain failures are RecordErrors;
// the operation layer turns them into declared Tool errors or per-item results.

import { normalizeId, typeOfId } from "./ids.mjs";
import {
  CHILD_RELATIONSHIPS,
  FORECAST_LABELS,
  NAMESPACES,
  SYSTEM_FIELD_NAMES,
  canonicalType,
  fieldByName,
  isRecordType,
  nameFieldOf,
  relationshipByName,
  stageByName,
} from "./schema.mjs";
import {
  canModify,
  canRead,
  clip,
  childRowsOf,
  fieldsOf,
  getRow,
  isDeleted,
  nextId,
  parseInstant,
  permissions,
  putRow,
  queueEvent,
  recordError,
  rowsOf,
  salesforceTimestamp,
  timestampNow,
  valueOf,
} from "./state.mjs";

export const NOT_FOUND_MESSAGE = "The requested resource does not exist";
export const INSUFFICIENT_ACCESS = "insufficient access rights on object id";

export function unsupportedTypeMessage(name) {
  return `sObject type '${clip(name)}' is not supported. If you are attempting to use a custom object, be sure to append the '__c' after the entity name. Please reference your WSDL or the describe call for the appropriate names.`;
}

// ---------------------------------------------------------------------------------------------
// Type resolution
// ---------------------------------------------------------------------------------------------

/** An sObject the caller's profile can read (`INVALID_TYPE` otherwise — unknown and unreadable look alike). */
export function requireReadableType(session, name) {
  const type = canonicalType(name);
  if (type === null || !permissions(session, type).read) throw recordError("INVALID_TYPE", unsupportedTypeMessage(String(name ?? "")));
  return type;
}

/** A writable record sObject: unknown/unreadable → INVALID_TYPE, User/Profile → INVALID_TYPE_FOR_OPERATION. */
export function requireWritableType(session, name, action) {
  const type = requireReadableType(session, name);
  if (!isRecordType(type)) {
    throw recordError("INVALID_TYPE_FOR_OPERATION", `Cannot ${action} ${type} through this Tool; User and Profile are read only`);
  }
  return type;
}

export function requireObjectPermission(session, type, action) {
  if (!permissions(session, type)[action]) throw recordError("INSUFFICIENT_ACCESS_OR_READONLY", INSUFFICIENT_ACCESS);
}

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

export function requireId(value) {
  const id = normalizeId(value);
  if (id === null) throw recordError("MALFORMED_ID", `malformed id ${clip(value)}`);
  return id;
}

/** A visible, non-deleted record of `type` by id (NOT_FOUND / ENTITY_IS_DELETED / MALFORMED_ID). */
export function requireRecord(session, type, rawId) {
  const id = requireId(rawId);
  const row = typeOfId(id) === type ? getRow(session, type, id) : null;
  if (row === null) throw recordError("NOT_FOUND", NOT_FOUND_MESSAGE);
  if (isDeleted(row)) throw recordError("ENTITY_IS_DELETED", "entity is deleted");
  if (!canRead(session, type, row)) throw recordError("NOT_FOUND", NOT_FOUND_MESSAGE);
  return row;
}

/** The external-id field of a type (`Id` is allowed as Salesforce does), else NOT_FOUND. */
export function requireExternalIdField(session, type, name) {
  const field = fieldByName(fieldsOf(session, type), name);
  if (field === null || (field.name !== "Id" && !field.externalId)) {
    throw recordError("NOT_FOUND", `Provided external ID field does not exist or is not accessible: ${clip(name)}`);
  }
  return field;
}

/** Non-deleted records whose external-id field equals `value` (case-insensitive), sharing ignored. */
export function findByExternalId(session, type, field, value) {
  if (field.name === "Id") {
    const id = normalizeId(value);
    if (id === null) return [];
    const row = typeOfId(id) === type ? getRow(session, type, id) : null;
    return row === null || isDeleted(row) ? [] : [row];
  }
  const wanted = String(value).toLowerCase();
  return rowsOf(session, type).filter((row) => !isDeleted(row) && String(valueOf(type, row, field.name) ?? "").toLowerCase() === wanted && valueOf(type, row, field.name) !== null);
}

/** Every non-deleted (or all, with `includeDeleted`) record of a readable type the caller may see. */
export function visibleRows(session, type, includeDeleted = false) {
  return rowsOf(session, type).filter((row) => (includeDeleted || !isDeleted(row)) && canRead(session, type, row));
}

// ---------------------------------------------------------------------------------------------
// Validation and coercion
// ---------------------------------------------------------------------------------------------

function jsonType(value) {
  if (value === null) return "VALUE_NULL";
  if (typeof value === "string") return "VALUE_STRING";
  if (typeof value === "boolean") return value ? "VALUE_TRUE" : "VALUE_FALSE";
  if (typeof value === "number") return Number.isInteger(value) ? "VALUE_NUMBER_INT" : "VALUE_NUMBER_FLOAT";
  return Array.isArray(value) ? "START_ARRAY" : "START_OBJECT";
}

function deserializeError(kind, value) {
  const rendered = typeof value === "object" ? JSON.stringify(value) : String(value);
  return recordError("JSON_PARSER_ERROR", `Cannot deserialize instance of ${kind} from ${jsonType(value)} value ${clip(rendered)} or request may be missing a required field`);
}

function coerceText(field, value) {
  let text;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else throw deserializeError("string", value);
  if (field.length !== null && text.length > field.length) {
    throw recordError("INVALID_FIELD", `${field.label}: data value too large: ${text.slice(0, 40)}${text.length > 40 ? "…" : ""} (max length=${field.length})`, [field.name]);
  }
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw recordError("INVALID_FIELD", `${field.label}: invalid email address: ${clip(text)}`, [field.name]);
  }
  return text;
}

function coerceNumber(field, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw deserializeError(field.type === "int" ? "int" : "double", value);
  if (field.type === "int" && !Number.isInteger(value)) throw deserializeError("int", value);
  return value;
}

function coerceDate(field, value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || parseInstant(value) === null) throw deserializeError("date", value);
  return value;
}

function coerceDatetime(field, value) {
  const ms = typeof value === "string" ? parseInstant(value) : null;
  if (ms === null) throw deserializeError("dateTime", value);
  return salesforceTimestamp(ms);
}

function coercePicklist(field, value, type) {
  if (typeof value !== "string") throw deserializeError("string", value);
  const settable = field.picklist.filter((option) => !(type === "Lead" && field.name === "Status" && option === "Closed - Converted"));
  const match = settable.find((option) => option.toLowerCase() === value.toLowerCase());
  if (match === undefined) throw recordError("INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", `${field.label}: bad value for restricted picklist field: ${clip(value)}`, [field.name]);
  return match;
}

function coerceReference(session, field, value) {
  const id = typeof value === "string" ? normalizeId(value) : null;
  if (id === null) throw recordError("MALFORMED_ID", `malformed id ${clip(typeof value === "object" ? JSON.stringify(value) : String(value))}`, [field.name]);
  const targetType = typeOfId(id);
  if (targetType === null || !field.referenceTo.includes(targetType)) {
    throw recordError("FIELD_INTEGRITY_EXCEPTION", `${field.label}: id value of incorrect type: ${clip(id)}`, [field.name]);
  }
  const target = getRow(session, targetType, id);
  const alive = target !== null && !isDeleted(target) && (targetType !== "User" || target.IsActive === true);
  if (!alive) throw recordError("INVALID_CROSS_REFERENCE_KEY", "invalid cross reference id", [field.name]);
  return id;
}

function coerceValue(session, type, field, value) {
  if (value === null) return null;
  switch (field.type) {
    case "boolean":
      if (typeof value !== "boolean") throw deserializeError("boolean", value);
      return value;
    case "int":
    case "double":
    case "currency":
    case "percent":
      return coerceNumber(field, value);
    case "date":
      return coerceDate(field, value);
    case "datetime":
      return coerceDatetime(field, value);
    case "picklist":
      return coercePicklist(field, value, type);
    case "reference":
      return coerceReference(session, field, value);
    default:
      return coerceText(field, value);
  }
}

function readOnlyError(name) {
  return recordError("INVALID_FIELD_FOR_INSERT_UPDATE", `Unable to create/update fields: ${clip(name)}. Please check the security settings of this field and verify that it is read/write for your profile or permission set.`, [name]);
}

/**
 * Validate a request body against the catalogue: returns the coerced `{ fieldName: value }` map of
 * the fields actually sent (catalogue spelling). `Id` must match `targetId` (update) and is never
 * accepted on create; `attributes` is ignored.
 */
function coerceBody(session, type, body, targetId) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw deserializeError("object", body);
  const fields = fieldsOf(session, type);
  const sent = {};
  for (const [key, raw] of Object.entries(body)) {
    if (key === "attributes") continue;
    const field = fieldByName(fields, key);
    if (field === null) throw recordError("INVALID_FIELD", `No such column '${clip(key)}' on sobject of type ${type}`, [key]);
    if (field.name === "Id") {
      if (targetId !== null && typeof raw === "string" && normalizeId(raw) === targetId) continue;
      throw readOnlyError("Id");
    }
    if (field.readOnly || SYSTEM_FIELD_NAMES.includes(field.name)) throw readOnlyError(field.name);
    sent[field.name] = coerceValue(session, type, field, raw);
  }
  return sent;
}

function requireRequired(session, type, values) {
  const missing = fieldsOf(session, type).filter((field) => field.required && !field.readOnly && (values[field.name] === null || values[field.name] === undefined || values[field.name] === ""));
  if (missing.length > 0) {
    throw recordError("REQUIRED_FIELD_MISSING", `Required fields are missing: [${missing.map((field) => field.name).join(", ")}]`, missing.map((field) => field.name));
  }
}

/** Derived fields recomputed on every write (Name, stage flags, IsClosed) plus the validation rule. */
function derive(type, values, previous, sent) {
  const next = { ...values };
  if (type === "Contact" || type === "Lead") {
    next.Name = [next.FirstName, next.LastName].filter((part) => typeof part === "string" && part.length > 0).join(" ");
  }
  if (type === "Lead" && previous === null) {
    next.IsConverted = false;
    next.ConvertedDate = null;
    next.ConvertedAccountId = null;
    next.ConvertedContactId = null;
    next.ConvertedOpportunityId = null;
  }
  if (type === "Opportunity") {
    const stage = stageByName(next.StageName);
    if (stage !== null) {
      const stageChanged = previous === null || previous.StageName !== next.StageName;
      if (stageChanged && !("Probability" in sent)) next.Probability = stage.probability;
      next.IsClosed = stage.closed;
      next.IsWon = stage.won;
      next.ForecastCategory = stage.forecastCategory;
      next.ForecastCategoryName = FORECAST_LABELS[stage.forecastCategory];
      if (stage.won && (typeof next.Amount !== "number" || next.Amount <= 0)) {
        throw recordError("FIELD_CUSTOM_VALIDATION_EXCEPTION", "Closed Won opportunities must have an Amount.", ["Amount"]);
      }
    }
  }
  if (type === "Task") next.IsClosed = next.Status === "Completed";
  return next;
}

function requireUnique(session, type, values, selfId) {
  for (const field of fieldsOf(session, type)) {
    if (!field.unique) continue;
    const value = values[field.name];
    if (value === null || value === undefined) continue;
    const wanted = String(value).toLowerCase();
    const clash = rowsOf(session, type).find((row) => row.Id !== selfId && !isDeleted(row) && valueOf(type, row, field.name) !== null && String(valueOf(type, row, field.name)).toLowerCase() === wanted);
    if (clash !== undefined) {
      throw recordError("DUPLICATE_VALUE", `duplicate value found: ${field.name} duplicates value on record with id: ${clash.Id}`, [field.name]);
    }
  }
}

function requireNoParentCycle(session, values, selfId) {
  let parentId = values.ParentId;
  let hops = 0;
  while (typeof parentId === "string") {
    if (parentId === selfId) throw recordError("FIELD_INTEGRITY_EXCEPTION", "Parent Account ID: an account cannot be its own parent or one of its own subsidiaries", ["ParentId"]);
    const parent = getRow(session, "Account", parentId);
    parentId = parent === null ? null : valueOf("Account", parent, "ParentId");
    hops += 1;
    if (hops > 50) throw recordError("FIELD_INTEGRITY_EXCEPTION", "Parent Account ID: account hierarchy is too deep", ["ParentId"]);
  }
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

function stamp(session, row, created) {
  const now = timestampNow(session);
  const me = session.user.Id;
  return {
    ...row,
    ...(created ? { CreatedDate: now, CreatedById: me } : {}),
    LastModifiedDate: now,
    LastModifiedById: me,
    SystemModstamp: now,
  };
}

/** Insert one record: permission, body, defaults, derived fields, uniqueness; queues `record.created`. */
export function createRecord(session, type, body) {
  requireObjectPermission(session, type, "create");
  const sent = coerceBody(session, type, body, null);
  const values = {};
  for (const field of fieldsOf(session, type)) {
    if (SYSTEM_FIELD_NAMES.includes(field.name)) continue;
    if (field.name in sent) values[field.name] = sent[field.name];
    else if (field.name === "OwnerId") values.OwnerId = session.user.Id;
    else if (field.picklistDefault !== null) values[field.name] = field.picklistDefault;
    else values[field.name] = field.defaultValue;
  }
  requireRequired(session, type, values);
  const fields = derive(type, values, null, sent);
  if (type === "Account") requireNoParentCycle(session, fields, null);
  requireUnique(session, type, fields, null);
  const id = nextId(session, type);
  const row = stamp(session, { Id: id, fields, IsDeleted: false, DeletedDate: null }, true);
  putRow(session, NAMESPACES[type], id, row);
  queueEvent(session, "record.created", { sobjectType: type, id, ownerId: fields.OwnerId, createdById: session.user.Id });
  return row;
}

/** Partial update of a visible, editable record; queues `record.updated` when something changed. */
export function updateRecord(session, type, rawId, body) {
  requireObjectPermission(session, type, "edit");
  const current = requireRecord(session, type, rawId);
  if (!canModify(session, type, current, "edit")) throw recordError("INSUFFICIENT_ACCESS_OR_READONLY", INSUFFICIENT_ACCESS);
  if (type === "Lead" && current.fields.IsConverted === true) throw recordError("CANNOT_UPDATE_CONVERTED_LEAD", "cannot reference converted lead");
  const sent = coerceBody(session, type, body, current.Id);
  const values = { ...current.fields, ...sent };
  requireRequired(session, type, values);
  const fields = derive(type, values, current.fields, sent);
  if (type === "Account") requireNoParentCycle(session, fields, current.Id);
  requireUnique(session, type, fields, current.Id);
  const changed = Object.keys(fields).filter((name) => !sameValue(fields[name], current.fields[name])).sort();
  if (changed.length === 0) return { row: current, changed };
  const row = stamp(session, { ...current, fields }, false);
  putRow(session, NAMESPACES[type], current.Id, row);
  queueEvent(session, "record.updated", { sobjectType: type, id: current.Id, changedFields: changed });
  return { row, changed };
}

function sameValue(left, right) {
  return (left ?? null) === (right ?? null);
}

function softDelete(session, type, row, cascadedFrom) {
  if (isDeleted(row)) return;
  const now = timestampNow(session);
  const next = stamp(session, { ...row, IsDeleted: true, DeletedDate: now }, false);
  putRow(session, NAMESPACES[type], row.Id, next);
  queueEvent(session, "record.deleted", { sobjectType: type, id: row.Id, cascadedFrom });
  for (const relationship of CHILD_RELATIONSHIPS[type] ?? []) {
    if (!relationship.cascadeDelete) continue;
    for (const snapshot of childRowsOf(session, relationship.childSObject, relationship.field, row.Id)) {
      // Re-read: an earlier cascade branch (e.g. Contact → Tasks before Account → Tasks) may have deleted it already.
      const child = getRow(session, relationship.childSObject, snapshot.Id);
      if (child !== null && !isDeleted(child)) softDelete(session, relationship.childSObject, child, row.Id);
    }
  }
}

/** Soft-delete a visible, deletable record and cascade to its children as Salesforce does. */
export function deleteRecord(session, type, rawId) {
  requireObjectPermission(session, type, "delete");
  const current = requireRecord(session, type, rawId);
  if (!canModify(session, type, current, "delete")) throw recordError("INSUFFICIENT_ACCESS_OR_READONLY", INSUFFICIENT_ACCESS);
  softDelete(session, type, current, null);
  return current.Id;
}

/** Upsert by external id: exactly one non-deleted match → update, none → create with the field set. */
export function upsertRecord(session, type, externalIdFieldName, value, body) {
  const field = requireExternalIdField(session, type, externalIdFieldName);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw deserializeError("object", body);
  const bodyKey = Object.keys(body).find((key) => key.toLowerCase() === field.name.toLowerCase());
  if (bodyKey !== undefined && field.name !== "Id" && String(body[bodyKey]).toLowerCase() !== String(value).toLowerCase()) {
    throw recordError("INVALID_FIELD", `External ID field value in body does not match the value in the URL: ${field.name}`, [field.name]);
  }
  const matches = findByExternalId(session, type, field, value);
  if (field.name === "Id") {
    if (normalizeId(value) === null) throw recordError("MALFORMED_ID", `malformed id ${clip(value)}`);
    const { row } = updateRecord(session, type, value, body);
    return { id: row.Id, created: false };
  }
  const cleaned = Object.fromEntries(Object.entries(body).filter(([key]) => key !== bodyKey));
  if (matches.length === 1) {
    const { row } = updateRecord(session, type, matches[0].Id, cleaned);
    return { id: row.Id, created: false };
  }
  const row = createRecord(session, type, { ...cleaned, [field.name]: value });
  return { id: row.Id, created: true };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

export function recordUrl(version, type, id) {
  return `/services/data/${version}/sobjects/${type}/${id}`;
}

export function attributesOf(version, type, id) {
  return { type, url: recordUrl(version, type, id) };
}

/** The full record JSON (every catalogue field in order) with Salesforce's `attributes`. */
export function renderRecord(session, type, row, version) {
  const out = { attributes: attributesOf(version, type, row.Id) };
  for (const field of fieldsOf(session, type)) out[field.name] = valueOf(type, row, field.name);
  return out;
}

/** A parsed field path: `{ field }` or `{ via, field | typeField }` (one relationship level). */
export function resolvePath(session, type, path, wording) {
  const parts = String(path).split(".");
  const fields = fieldsOf(session, type);
  const unknown = (name) =>
    wording === "entity"
      ? recordError("INVALID_FIELD", `No such column '${clip(name)}' on entity '${type}'. If you are attempting to use a custom field, be sure to append the '__c' after the custom field name. Please reference your WSDL or the describe call for the appropriate names.`, [name])
      : recordError("INVALID_FIELD", `No such column '${clip(name)}' on sobject of type ${type}`, [name]);
  if (parts.length === 1) {
    const field = fieldByName(fields, parts[0]);
    if (field === null) throw unknown(parts[0]);
    return { path: field.name, field, via: null };
  }
  if (parts.length > 2) {
    const message = `relationship path '${clip(path)}': relationship fields deeper than one level are unsupported in this synthetic Salesforce Tool`;
    throw wording === "entity" ? recordError("MALFORMED_QUERY", message) : recordError("INVALID_FIELD", message, [String(path)]);
  }
  const via = relationshipByName(fields, parts[0]);
  if (via === null) throw recordError("INVALID_FIELD", `Didn't understand relationship '${clip(parts[0])}' in field path. If you are attempting to use a custom relationship, be sure to append the '__r' after the custom relationship name. Please reference your WSDL or the describe call for the appropriate names.`, [parts[0]]);
  if (parts[1].toLowerCase() === "type") return { path: `${via.relationshipName}.Type`, field: null, via, typeField: true };
  const targets = via.referenceTo.map((target) => ({ target, field: fieldByName(fieldsOf(session, target), parts[1]) })).filter((entry) => entry.field !== null);
  if (targets.length === 0) throw recordError("INVALID_FIELD", `No such column '${clip(parts[1])}' on entity '${via.referenceTo[0]}'. If you are attempting to use a custom field, be sure to append the '__c' after the custom field name. Please reference your WSDL or the describe call for the appropriate names.`, [parts[1]]);
  return { path: `${via.relationshipName}.${targets[0].field.name}`, field: targets[0].field, via, targetFields: Object.fromEntries(targets.map((entry) => [entry.target, entry.field.name])) };
}

function relatedRow(session, type, row, resolved) {
  const id = valueOf(type, row, resolved.via.name);
  if (typeof id !== "string") return null;
  const targetType = typeOfId(id);
  if (targetType === null || !resolved.via.referenceTo.includes(targetType)) return null;
  const target = getRow(session, targetType, id);
  return target === null ? null : { targetType, target };
}

/** The value a resolved path yields for one row (relationship fields follow the lookup). */
export function readPath(session, type, row, resolved) {
  if (resolved.via === null) return valueOf(type, row, resolved.field.name);
  const related = relatedRow(session, type, row, resolved);
  if (related === null) return null;
  if (resolved.typeField) return related.targetType;
  const name = resolved.targetFields[related.targetType];
  return name === undefined ? null : valueOf(related.targetType, related.target, name);
}

/** Render a row as `{ attributes, ...paths }` with relationship paths nested as Salesforce does. */
export function renderPaths(session, type, row, version, resolvedPaths) {
  const out = { attributes: attributesOf(version, type, row.Id) };
  for (const resolved of resolvedPaths) {
    if (resolved.via === null) {
      out[resolved.field.name] = valueOf(type, row, resolved.field.name);
      continue;
    }
    const key = resolved.via.relationshipName;
    const related = relatedRow(session, type, row, resolved);
    if (related === null) {
      if (!(key in out)) out[key] = null;
      continue;
    }
    if (out[key] === null || out[key] === undefined) out[key] = { attributes: attributesOf(version, related.targetType, related.target.Id) };
    if (resolved.typeField) out[key].Type = related.targetType;
    else {
      const name = resolved.targetFields[related.targetType];
      if (name !== undefined) out[key][name] = valueOf(related.targetType, related.target, name);
    }
  }
  return out;
}

/** The five most recently modified visible records of a type, as `{ attributes, Id, Name }`. */
export function recentItems(session, type, version) {
  const nameField = nameFieldOf(type);
  return visibleRows(session, type)
    .slice()
    .sort((left, right) => (left.LastModifiedDate < right.LastModifiedDate ? 1 : left.LastModifiedDate > right.LastModifiedDate ? -1 : left.Id < right.Id ? -1 : 1))
    .slice(0, 5)
    .map((row) => ({ attributes: attributesOf(version, type, row.Id), Id: row.Id, [nameField]: valueOf(type, row, nameField) }));
}
