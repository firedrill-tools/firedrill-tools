// Synthetic HubSpot CRM portal. Every operation computes from context.state: object ids come from the
// `meta/counters` row, timestamps from the virtual clock, visibility from the calling actor's owner row.
// Nothing here contacts HubSpot; no e-mail, sequence or workflow is ever triggered.
import { ALL_SCOPES, OBJECT_TYPES, objectTypeById, readScope, resolveObjectType, schemaReadScope, writeScope } from "./lib/object-types.mjs";
import { DEFAULT_PROPERTIES, DEFINED_PROPERTIES, REQUIRED_ON_CREATE, SEARCHABLE_PROPERTIES, TIMESTAMPS, coerceValue } from "./lib/properties.mjs";
import { RESPONSE_BYTE_BUDGET, PAGE_ENVELOPE_BYTES, jsonBytes } from "./lib/bytes.mjs";
import { MAX_MATCH_WORK, MAX_SEARCH_TEXT, createRecordMatcher, createWorkBudget, isMangled, normalizeFilterGroups, normalizeSorts, sortRecords } from "./lib/search.mjs";
import {
  allRows,
  associationPrefix,
  clip,
  clipJson,
  associationRowId,
  compareStrings,
  fail,
  findRow,
  isObjectId,
  isRowKey,
  isoNow,
  nextObjectId,
  notFound,
  padId,
  prefixRows,
  validationError,
} from "./lib/state.mjs";
import { bool, defined, hubspotError, int, isRateLimited, jsonArrayBody, jsonBody, list, operationInput, responseHeaders, str } from "./lib/wire.mjs";

const ACCOUNT = Object.freeze({
  portalId: 24871365,
  accountType: "STANDARD",
  timeZone: "Europe/Stockholm",
  companyCurrency: "EUR",
  additionalCurrencies: [],
  utcOffset: "+02:00",
  utcOffsetMilliseconds: 7_200_000,
  uiDomain: "app.hubspot.com",
  dataHostingLocation: "eu1",
});

const OBJECT_NAMESPACES = OBJECT_TYPES.map((type) => type.name);
const UNAUTHORIZED_MESSAGE =
  "Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview";
const MISSING_SCOPES_MESSAGE =
  "This app hasn't been granted all required scopes to make this call. Read more about required scopes here: https://developers.hubspot.com/scopes.";
const MAX_BATCH = 100;
const MAX_LIST_LIMIT = 100;
const MAX_ASSOCIATION_LIMIT = 500;
const MAX_OWNER_LIMIT = 500;
const MAX_SEARCH_LIMIT = 200;
const MAX_SEARCH_OFFSET = 10_000;

// ---------------------------------------------------------------------------------------------
// Identity, scopes and visibility
// ---------------------------------------------------------------------------------------------

function unauthorized(context) {
  return fail(context, "UNAUTHORIZED", UNAUTHORIZED_MESSAGE);
}

/**
 * The caller. With an `email` attribute: the non-archived owner with that e-mail (none → UNAUTHORIZED).
 * Without one (e.g. an actor created by `firedrill tool add`): the portal's default user, i.e. the first
 * non-archived owner in row-id order (41001 in the starter data); a portal without owners → UNAUTHORIZED.
 */
function requireUser(context) {
  const attributes = context.actor.attributes ?? {};
  const email = typeof attributes.email === "string" ? attributes.email.trim().toLowerCase() : "";
  const owner =
    email.length === 0
      ? findRow(context, "owners", (row) => row.archived !== true)
      : findRow(context, "owners", (row) => typeof row.email === "string" && row.email.toLowerCase() === email && row.archived !== true);
  if (owner === null) return unauthorized(context);
  const scopes = Array.isArray(attributes.scopes) ? attributes.scopes.filter((scope) => typeof scope === "string") : null;
  const recordAccess = attributes.recordAccess === "owned" ? "owned" : "all";
  return { owner, scopes, recordAccess };
}

function requireScopes(context, user, ...scopes) {
  if (user.scopes === null) return;
  const missing = scopes.filter((scope) => !user.scopes.includes(scope));
  if (missing.length === 0) return;
  return fail(context, "MISSING_SCOPES", MISSING_SCOPES_MESSAGE, {
    errors: [{ message: "One or more of the following scopes are required.", context: { requiredGranularScopes: missing } }],
  });
}

function requireType(context, value) {
  const type = resolveObjectType(value);
  if (type === undefined) return notFound(context, `Unable to infer object type from: ${clip(typeof value === "string" ? value : JSON.stringify(value ?? null))}`);
  return type;
}

/** "Owned records only": a record is visible when unassigned or owned by the caller. */
function isVisible(user, record) {
  if (user.recordAccess !== "owned") return true;
  const owner = record.properties.hubspot_owner_id;
  return owner === null || owner === undefined || owner === "" || owner === user.owner.id;
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

/** HubSpot-defined definitions plus the custom `properties` rows of the type (custom rows cannot shadow). */
function definitionsFor(context, type) {
  const map = new Map(DEFINED_PROPERTIES[type.name]);
  for (const row of prefixRows(context, "properties", `${type.name}/`)) if (!map.has(row.name)) map.set(row.name, row);
  return map;
}

/** Load a record by id; archived or hidden records count as missing unless `includeArchived`. */
function loadRecord(context, user, type, id, includeArchived = false) {
  if (!isObjectId(id)) return null;
  const record = context.state.get(type.name, padId(id));
  if (record === null) return null;
  if (record.archived && !includeArchived) return null;
  if (!isVisible(user, record)) return null;
  return record;
}

/**
 * Per-request lookups of unique properties (`idProperty` resolution and contact e-mail uniqueness). Each index is
 * built with one bounded scan the first time a property is used and kept current as the request writes records, so
 * a batch of N entries costs one scan instead of N (lower-cased value → records in row-id order).
 */
function uniqueLookups(context, type) {
  const indexes = new Map();
  const keyOf = (record, name) => {
    const value = Object.hasOwn(record.properties, name) ? record.properties[name] : undefined;
    return typeof value === "string" ? value.toLowerCase() : undefined;
  };
  const insert = (index, name, record) => {
    const key = keyOf(record, name);
    if (key === undefined) return;
    const list = index.get(key);
    if (list === undefined) return void index.set(key, [record]);
    const at = list.findIndex((other) => Number(other.id) > Number(record.id));
    if (at === -1) list.push(record);
    else list.splice(at, 0, record);
  };
  const remove = (index, name, record) => {
    const key = keyOf(record, name);
    const list = key === undefined ? undefined : index.get(key);
    const at = list === undefined ? -1 : list.findIndex((other) => other.id === record.id);
    if (at !== -1) list.splice(at, 1);
  };
  return {
    candidates(name, value) {
      let index = indexes.get(name);
      if (index === undefined) {
        index = new Map();
        for (const record of allRows(context, type.name)) insert(index, name, record);
        indexes.set(name, index);
      }
      return index.get(String(value).toLowerCase()) ?? [];
    },
    replace(before, after) {
      for (const [name, index] of indexes) {
        if (before !== null) remove(index, name, before);
        if (after !== null) insert(index, name, after);
      }
    },
  };
}

function findByUniqueProperty(context, user, type, definitions, propertyName, value, includeArchived, lookups) {
  const definition = definitions.get(propertyName);
  if (definition === undefined || definition.hasUniqueValue !== true) {
    return validationError(context, `Invalid idProperty: ${clip(propertyName)}`, [{ message: `Property "${clip(propertyName)}" is not a unique identifier of ${type.name}`, context: { propertyName: [clip(propertyName)] } }]);
  }
  const candidates = (lookups ?? uniqueLookups(context, type)).candidates(propertyName, value);
  return candidates.find((record) => (includeArchived || !record.archived) && isVisible(user, record)) ?? null;
}

function resolveRecord(context, user, type, definitions, id, idProperty, includeArchived = false, lookups = undefined) {
  if (idProperty !== undefined && idProperty !== "id" && idProperty !== "hs_object_id") {
    return findByUniqueProperty(context, user, type, definitions, idProperty, id, includeArchived, lookups);
  }
  return loadRecord(context, user, type, String(id), includeArchived);
}

function requireRecord(context, user, type, definitions, id, idProperty, includeArchived = false, lookups = undefined) {
  const record = resolveRecord(context, user, type, definitions, id, idProperty, includeArchived, lookups);
  return record === null ? notFound(context) : record;
}

function saveRecord(context, type, record) {
  context.state.put(type.name, padId(record.id), record);
}

/** The property names of a read: requested (unknown names silently dropped) or the default set, plus the always-present system properties. */
function readNames(type, requested, definitions) {
  const base = Array.isArray(requested) && requested.length > 0 ? requested : DEFAULT_PROPERTIES[type.name];
  const names = new Set(["hs_object_id", TIMESTAMPS[type.name].created, TIMESTAMPS[type.name].modified]);
  for (const name of base) if (typeof name === "string" && definitions.has(name)) names.add(name);
  return [...names].sort(compareStrings);
}

/** Every stored non-null property plus the default set (the shape of create/update responses). */
function writeNames(type, record, definitions) {
  const names = new Set(DEFAULT_PROPERTIES[type.name]);
  for (const [name, value] of Object.entries(record.properties)) if (value !== null) names.add(name);
  return readNames(type, [...names], definitions);
}

function recordView(record, names, associations) {
  const properties = {};
  for (const name of names) properties[name] = record.properties[name] ?? null;
  const view = { id: record.id, properties, createdAt: record.createdAt, updatedAt: record.updatedAt, archived: record.archived };
  if (record.archived) view.archivedAt = record.archivedAt;
  if (associations !== undefined) view.associations = associations;
  return view;
}

function requireOwner(context, id) {
  if (!isObjectId(id)) return null;
  const owner = context.state.get("owners", padId(id));
  return owner !== null && owner.archived !== true ? owner : null;
}

function propertyError(name, code, message) {
  return { isValid: false, message, error: code, name };
}

function raisePropertyErrors(context, errors) {
  return validationError(
    context,
    `Property values were not valid: ${JSON.stringify(errors)}`,
    errors.map((error) => ({ message: error.message, code: error.error, context: { propertyName: [error.name] } })),
  );
}

/**
 * Validate and merge incoming property values (create when `existing` is null; PATCH merge otherwise).
 * Returns `{ properties, changes }` where `changes` lists every property whose stored value differs.
 */
function mergeProperties(context, user, type, definitions, incoming, existing, now, lookups = undefined) {
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming) || Object.keys(incoming).length === 0) {
    return validationError(context, "properties must be a non-empty object", [{ message: "properties must be a non-empty object", context: { propertyName: ["properties"] } }]);
  }
  const errors = [];
  const next = existing === null ? {} : { ...existing.properties };
  for (const [name, raw] of Object.entries(incoming)) {
    const definition = definitions.get(name);
    if (definition === undefined) {
      errors.push(propertyError(clip(name), "PROPERTY_DOESNT_EXIST", `Property "${clip(name)}" does not exist`));
      continue;
    }
    if (definition.modificationMetadata.readOnlyValue) {
      errors.push(propertyError(name, "READ_ONLY_VALUE", `Property "${name}" is read only`));
      continue;
    }
    const coerced = coerceValue(definition, raw);
    if (coerced.error !== undefined) {
      errors.push(propertyError(name, coerced.code, coerced.error));
      continue;
    }
    if (name === "hubspot_owner_id" && coerced.value !== null && requireOwner(context, coerced.value) === null) {
      errors.push(propertyError(name, "INVALID_OWNER_ID", `Owner ${clip(coerced.value)} is not valid`));
      continue;
    }
    // On create a null value sets nothing (there is nothing to clear); on PATCH it clears the property.
    if (coerced.value === null && existing === null) continue;
    next[name] = coerced.value;
  }
  if (existing === null) {
    for (const name of REQUIRED_ON_CREATE[type.name]) {
      if (errors.some((error) => error.name === name)) continue;
      if (next[name] === undefined || next[name] === null || next[name] === "") {
        errors.push(propertyError(name, "REQUIRED_FIELD_NOT_SET", `Property "${name}" is required to create a ${type.singular}`));
      }
    }
  }
  if (type.name === "deals" && errors.length === 0) {
    const pipelineId = next.pipeline ?? "default";
    const pipeline = pipelineRow(context, pipelineId);
    if (pipeline === null || pipeline.archived) {
      errors.push(propertyError("pipeline", "INVALID_OPTION", `Pipeline ID ${clip(pipelineId)} is not valid`));
    } else {
      next.pipeline = pipelineId;
      const stage = pipeline.stages.find((candidate) => candidate.id === next.dealstage && !candidate.archived);
      if (stage === undefined) {
        errors.push(propertyError("dealstage", "INVALID_OPTION", `Pipeline stage ID ${clip(next.dealstage)} is not valid for pipeline ${clip(pipelineId)}`));
      } else {
        next.hs_deal_stage_probability = stage.metadata.probability;
        next.hs_is_closed = stage.metadata.isClosed;
        next.hs_is_closed_won = stage.metadata.isClosed === "true" && Number(stage.metadata.probability) >= 1 ? "true" : "false";
      }
    }
  }
  if (errors.length > 0) return raisePropertyErrors(context, errors);
  if (type.name === "contacts" && typeof next.email === "string" && next.email.length > 0 && (existing === null || existing.properties.email !== next.email)) {
    const duplicate = (lookups ?? uniqueLookups(context, type))
      .candidates("email", next.email)
      .find((record) => !record.archived && (existing === null || record.id !== existing.id));
    if (duplicate !== undefined) {
      return fail(context, "CONFLICT", `Contact already exists. Existing ID: ${duplicate.id}`, { context: { existingId: [duplicate.id] } });
    }
  }
  if (type.name === "contacts" && incoming.hubspot_owner_id !== undefined && (existing === null || existing.properties.hubspot_owner_id !== next.hubspot_owner_id)) {
    const assigned = next.hubspot_owner_id !== null && next.hubspot_owner_id !== undefined;
    if (assigned) next.hubspot_owner_assigneddate = now;
    else if (existing !== null) next.hubspot_owner_assigneddate = null;
  }
  const changes = [];
  if (existing !== null) {
    for (const name of Object.keys(next)) {
      const previous = existing.properties[name] ?? null;
      const current = next[name] ?? null;
      if (previous !== current) changes.push({ name, previous, current });
    }
  }
  return { properties: next, changes };
}

function emitCreated(context, type, record) {
  context.events.emit("object.created", {
    objectType: type.name,
    objectTypeId: type.typeId,
    objectId: record.id,
    ownerId: record.properties.hubspot_owner_id ?? null,
  });
}

function emitChanges(context, type, record, changes) {
  for (const change of changes) {
    context.events.emit("object.property-changed", {
      objectType: type.name,
      objectTypeId: type.typeId,
      objectId: record.id,
      propertyName: change.name,
      propertyValue: change.current,
      previousValue: change.previous,
    });
  }
}

/** Create one record (the property map has been validated). Returns the stored row. */
function createRecord(context, type, properties, now) {
  const id = nextObjectId(context, OBJECT_NAMESPACES);
  const stamps = TIMESTAMPS[type.name];
  const record = {
    id,
    properties: { ...properties, hs_object_id: id, [stamps.created]: now, [stamps.modified]: now },
    createdAt: now,
    updatedAt: now,
    archived: false,
    archivedAt: null,
  };
  saveRecord(context, type, record);
  emitCreated(context, type, record);
  return record;
}

function updateRecord(context, type, existing, merged, now) {
  const stamps = TIMESTAMPS[type.name];
  const record = { ...existing, properties: { ...merged.properties, [stamps.modified]: now }, updatedAt: now };
  saveRecord(context, type, record);
  emitChanges(context, type, record, merged.changes);
  return record;
}

/** Contact e-mails inside one batch must be unique as well (case-insensitive). */
function requireUniqueEmails(context, type, propertyMaps) {
  if (type.name !== "contacts") return;
  const seen = new Map();
  for (const properties of propertyMaps) {
    const email = typeof properties.email === "string" ? properties.email.toLowerCase() : "";
    if (email.length === 0) continue;
    if (seen.has(email)) return fail(context, "CONFLICT", `Contact already exists. Existing ID: ${seen.get(email)}`, { context: { email: [email] } });
    seen.set(email, "pending");
  }
}

// ---------------------------------------------------------------------------------------------
// Associations
// ---------------------------------------------------------------------------------------------

/** Association definitions for a type pair keyed by typeId. */
function labelDefinitions(context, fromType, toType) {
  const map = new Map();
  for (const row of prefixRows(context, "association-labels", `${fromType.typeId}/${toType.typeId}/`)) map.set(row.typeId, row);
  return map;
}

function labelView(definition) {
  return { category: definition.category, typeId: definition.typeId, label: definition.label };
}

function linkRow(context, fromType, fromId, toType, toId) {
  return context.state.get("associations", associationRowId(fromType.typeId, fromId, toType.typeId, toId));
}

function saveLink(context, row) {
  const rowId = associationRowId(row.fromObjectTypeId, row.fromObjectId, row.toObjectTypeId, row.toObjectId);
  if (row.typeIds.length === 0) context.state.delete("associations", rowId);
  else context.state.put("associations", rowId, row);
}

function emitAssociation(context, row, typeIds, removed) {
  context.events.emit("association.changed", {
    fromObjectTypeId: row.fromObjectTypeId,
    fromObjectId: row.fromObjectId,
    toObjectTypeId: row.toObjectTypeId,
    toObjectId: row.toObjectId,
    associationTypeIds: typeIds,
    removed,
  });
}

/** Add type ids to one directed row (creating it when absent); returns the ids actually added. */
function addTypes(context, fromTypeId, fromId, toTypeId, toId, typeIds, now) {
  const rowId = associationRowId(fromTypeId, fromId, toTypeId, toId);
  const existing = context.state.get("associations", rowId);
  const current = existing === null ? [] : existing.typeIds;
  const added = typeIds.filter((typeId) => !current.includes(typeId));
  if (added.length === 0) return [];
  const row = {
    fromObjectTypeId: fromTypeId,
    fromObjectId: fromId,
    toObjectTypeId: toTypeId,
    toObjectId: toId,
    typeIds: [...current, ...added].sort((left, right) => left - right),
    createdAt: existing === null ? now : existing.createdAt,
    updatedAt: now,
  };
  context.state.put("associations", rowId, row);
  emitAssociation(context, row, added, false);
  return added;
}

function removeTypes(context, row, typeIds) {
  const removed = row.typeIds.filter((typeId) => typeIds.includes(typeId));
  if (removed.length === 0) return;
  const next = { ...row, typeIds: row.typeIds.filter((typeId) => !typeIds.includes(typeId)) };
  saveLink(context, next);
  emitAssociation(context, row, removed, true);
}

/** A HubSpot-defined "Primary" label is exclusive: one primary target per record and type pair. */
function clearOtherPrimaries(context, fromType, fromId, toType, toId, definition) {
  if (definition.category !== "HUBSPOT_DEFINED" || definition.label !== "Primary") return;
  for (const row of prefixRows(context, "associations", associationPrefix(fromType.typeId, fromId, toType.typeId))) {
    if (row.toObjectId === toId || !row.typeIds.includes(definition.typeId)) continue;
    removeTypes(context, row, [definition.typeId]);
    const inverse = context.state.get("associations", associationRowId(toType.typeId, row.toObjectId, fromType.typeId, fromId));
    if (inverse !== null) removeTypes(context, inverse, [definition.inverseTypeId]);
  }
}

/** Create/extend an association in both directions with validated definitions. */
function associate(context, fromType, fromId, toType, toId, definitions, now) {
  for (const definition of definitions) clearOtherPrimaries(context, fromType, fromId, toType, toId, definition);
  addTypes(context, fromType.typeId, fromId, toType.typeId, toId, definitions.map((definition) => definition.typeId), now);
  addTypes(context, toType.typeId, toId, fromType.typeId, fromId, definitions.map((definition) => definition.inverseTypeId), now);
}

/** Validate `types: [{ associationCategory, associationTypeId }]` against the pair's definitions. */
function requireTypeSpecs(context, fromType, toType, specs) {
  if (!Array.isArray(specs) || specs.length === 0) {
    return validationError(context, "At least one association type is required", [{ message: "types must be a non-empty array", context: { propertyName: ["types"] } }]);
  }
  const definitions = labelDefinitions(context, fromType, toType);
  const resolved = [];
  for (const spec of specs) {
    const typeId = typeof spec === "object" && spec !== null ? spec.associationTypeId : undefined;
    const category = typeof spec === "object" && spec !== null ? spec.associationCategory : undefined;
    const definition = typeof typeId === "number" ? definitions.get(typeId) : undefined;
    if (definition === undefined || (category !== undefined && category !== definition.category)) {
      return validationError(
        context,
        `Association type ${clipJson(typeId ?? null)} (${clip(category ?? "unspecified")}) is not defined between ${fromType.singular} and ${toType.singular}`,
        [{ message: `Unknown association type ${clipJson(typeId ?? null)} for ${fromType.typeId} -> ${toType.typeId}`, context: { associationTypeId: [clip(typeId ?? null)] } }],
      );
    }
    if (!resolved.some((entry) => entry.typeId === definition.typeId)) resolved.push(definition);
  }
  return resolved;
}

function defaultDefinition(context, fromType, toType) {
  return [...labelDefinitions(context, fromType, toType).values()].find((definition) => definition.category === "HUBSPOT_DEFINED" && definition.label === null);
}

/** The visible links of a record towards one type (targets that are archived or hidden are omitted). */
function visibleLinks(context, user, fromType, fromId, toType) {
  const rows = prefixRows(context, "associations", associationPrefix(fromType.typeId, fromId, toType.typeId));
  return rows.filter((row) => loadRecord(context, user, toType, row.toObjectId) !== null);
}

function associationTypeName(fromType, toType, definition) {
  const base = `${fromType.singular}_to_${toType.singular}`;
  return definition?.label ? `${base}_${definition.label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}` : base;
}

function inlineAssociations(context, user, type, record, toTypeNames) {
  if (!Array.isArray(toTypeNames) || toTypeNames.length === 0) return undefined;
  const view = {};
  const seen = new Set();
  for (const name of toTypeNames) {
    const toType = resolveObjectType(name);
    if (toType === undefined || seen.has(toType.name)) continue;
    seen.add(toType.name);
    const definitions = labelDefinitions(context, type, toType);
    const results = [];
    for (const link of visibleLinks(context, user, type, record.id, toType)) {
      for (const typeId of link.typeIds) results.push({ id: link.toObjectId, type: associationTypeName(type, toType, definitions.get(typeId)) });
    }
    if (results.length > 0) view[toType.name] = { results };
  }
  return Object.keys(view).length > 0 ? view : undefined;
}

function linkView(link, definitions) {
  return {
    toObjectId: link.toObjectId,
    associationTypes: link.typeIds.map((typeId) => {
      const definition = definitions.get(typeId);
      return definition === undefined ? { category: "HUBSPOT_DEFINED", typeId, label: null } : labelView(definition);
    }),
  };
}

function labelsOf(link, definitions) {
  return link === null ? [] : link.typeIds.map((typeId) => definitions.get(typeId)?.label ?? null).filter((label) => label !== null);
}

function associationResult(fromType, fromId, toType, toId, labels) {
  return { fromObjectTypeId: fromType.typeId, fromObjectId: fromId, toObjectTypeId: toType.typeId, toObjectId: toId, labels };
}

/** Inline `associations` of a create body: the target type is implied by the association type id. */
function resolveInlineAssociations(context, user, fromType, specs) {
  if (specs === undefined) return [];
  if (!Array.isArray(specs)) return validationError(context, "associations must be an array");
  const byTypeId = new Map();
  for (const row of prefixRows(context, "association-labels", `${fromType.typeId}/`)) byTypeId.set(row.typeId, row);
  const resolved = [];
  for (const spec of specs) {
    const toId = typeof spec?.to === "object" && spec.to !== null ? String(spec.to.id ?? "") : "";
    const types = Array.isArray(spec?.types) ? spec.types : [];
    if (types.length === 0) return validationError(context, "Each inline association needs at least one type");
    for (const entry of types) {
      const definition = typeof entry?.associationTypeId === "number" ? byTypeId.get(entry.associationTypeId) : undefined;
      if (definition === undefined || (entry.associationCategory !== undefined && entry.associationCategory !== definition.category)) {
        return validationError(context, `Association type ${clipJson(entry?.associationTypeId ?? null)} is not defined for ${fromType.singular} records`, [
          { message: "Unknown association type", context: { associationTypeId: [clip(entry?.associationTypeId ?? null)] } },
        ]);
      }
      const toType = objectTypeById(definition.toObjectTypeId);
      if (loadRecord(context, user, toType, toId) === null) return notFound(context, `No ${toType.singular} with ID ${clip(toId)} exists`);
      resolved.push({ toType, toId, definition });
    }
  }
  return resolved;
}

function applyInlineAssociations(context, fromType, fromId, resolved, now) {
  for (const { toType, toId, definition } of resolved) associate(context, fromType, fromId, toType, toId, [definition], now);
}

// ---------------------------------------------------------------------------------------------
// Batch helpers
// ---------------------------------------------------------------------------------------------

function requireInputs(context, inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return validationError(context, "inputs must be a non-empty array", [{ message: "inputs must be a non-empty array", context: { propertyName: ["inputs"] } }]);
  if (inputs.length > MAX_BATCH) return validationError(context, `At most ${MAX_BATCH} inputs are allowed per batch request`, [{ message: `inputs has ${inputs.length} entries`, context: { propertyName: ["inputs"] } }]);
  return inputs;
}

function batchEnvelope(results, errors, startedAt, completedAt) {
  const body = { status: "COMPLETE", results, startedAt, completedAt };
  if (errors.length > 0) {
    body.numErrors = errors.length;
    body.errors = errors;
  }
  return body;
}

function missingObjectsError(type, ids) {
  return {
    status: "error",
    category: "OBJECT_NOT_FOUND",
    message: `Could not get some ${type.singular.toUpperCase()} objects, they may be deleted or not exist. Check that ids are valid.`,
    context: { ids },
  };
}

function missingRecordError(type, id) {
  return { status: "error", category: "OBJECT_NOT_FOUND", message: `No ${type.singular} with ID ${id} exists`, context: { objectType: [type.singular], id: [id] } };
}

function rejectHistory(context, input) {
  if (input.propertiesWithHistory !== undefined && input.propertiesWithHistory.length > 0) {
    return validationError(context, "propertiesWithHistory is not supported by this Tool", [{ message: "Property history is not simulated", context: { propertyName: ["propertiesWithHistory"] } }]);
  }
}

function requireLimit(context, value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return validationError(context, `limit must be between 1 and ${max}`, [{ message: `limit ${clipJson(value)} is out of range`, context: { propertyName: ["limit"] } }]);
  }
  return value;
}

/** `archived` query flag: boolean, or the raw malformed string the codec passed through → VALIDATION_ERROR. */
function requireArchived(context, value) {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  return validationError(context, `archived must be true or false`, [{ message: `archived ${clipJson(value)} is not a boolean`, context: { propertyName: ["archived"] } }]);
}

function requireAfter(context, value) {
  if (value === undefined) return undefined;
  if (!isObjectId(String(value))) return validationError(context, "Invalid after cursor", [{ message: `after ${clipJson(value)} is not a valid cursor`, context: { propertyName: ["after"] } }]);
  return String(value);
}

/**
 * Reject a free-text filter or query value carrying U+FFFD. The framework decodes query strings and
 * bodies leniently, so malformed percent-encoding (`%E0%A4%A`) arrives as U+FFFD; treating it as
 * search text would silently match nothing. A correctly encoded `%EF%BF%BD` is rejected the same
 * way, while `%ZZ` stays literal and searches normally.
 */
function rejectMangled(context, value, propertyName) {
  if (!isMangled(value)) return;
  const message = `${propertyName} contains an invalid character (U+FFFD); check the encoding of the request`;
  return validationError(context, message, [{ message, context: { propertyName: [propertyName] } }]);
}

/** `includeHidden` query flag: boolean, or the raw malformed string the codec passed through. */
function requireIncludeHidden(context, value) {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  return validationError(context, `includeHidden must be true or false`, [{ message: `includeHidden ${clipJson(value)} is not a boolean`, context: { propertyName: ["includeHidden"] } }]);
}

function pagingLink(path, limit, after) {
  return `${path}?limit=${String(limit)}&after=${encodeURIComponent(after)}`;
}

/** VALIDATION_ERROR for a response that would not fit the framework's 1 MiB response cap (nothing commits). */
function responseTooLarge(context, bytes, hint) {
  const message = `The response would be at least ${bytes} bytes, above this Tool's ${RESPONSE_BYTE_BUDGET}-byte response limit; ${hint}`;
  return validationError(context, message, [{ message, context: { responseBytes: [String(bytes)] } }]);
}

/** Return `value` when its encoded JSON fits the response budget; otherwise fail with VALIDATION_ERROR. */
function requireFits(context, value, hint) {
  const bytes = jsonBytes(value);
  return bytes > RESPONSE_BYTE_BUDGET ? responseTooLarge(context, bytes, hint) : value;
}

const FEWER_PROPERTIES = "request fewer properties or associations";
const FEWER_INPUTS = "send fewer inputs or request fewer properties";

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

function objectsList(input, context) {
  const user = requireUser(context);
  const type = requireType(context, input.objectType);
  requireScopes(context, user, readScope(type));
  rejectHistory(context, input);
  const limit = requireLimit(context, input.limit, 10, MAX_LIST_LIMIT);
  const after = requireAfter(context, input.after);
  const archived = requireArchived(context, input.archived);
  const definitions = definitionsFor(context, type);
  const names = readNames(type, input.properties, definitions);
  const results = [];
  let lastId;
  let bytes = PAGE_ENVELOPE_BYTES;
  let cursor = after === undefined ? undefined : padId(after);
  let more = false;
  scan: for (;;) {
    const batch = context.state.scan(type.name, { ...(cursor === undefined ? {} : { afterRowId: cursor }), limit: 500 });
    if (batch.length === 0) break;
    for (const entry of batch) {
      cursor = entry.rowId;
      const record = entry.value;
      if (record.archived !== archived || !isVisible(user, record)) continue;
      if (results.length === limit) {
        more = true;
        break scan;
      }
      // Pages fill by encoded UTF-8 size as well as count; the first record that does not fit starts the next page.
      const view = recordView(record, names, inlineAssociations(context, user, type, record, input.associations));
      const size = jsonBytes(view) + 1;
      if (bytes + size > RESPONSE_BYTE_BUDGET) {
        if (results.length === 0) return responseTooLarge(context, PAGE_ENVELOPE_BYTES + size, FEWER_PROPERTIES);
        more = true;
        break scan;
      }
      bytes += size;
      results.push(view);
      lastId = record.id;
    }
    if (batch.length < 500) break;
  }
  const body = { results };
  if (more) {
    const last = lastId;
    body.paging = { next: { after: last, link: pagingLink(`/crm/v3/objects/${type.name}`, limit, last) } };
  }
  return body;
}

function objectsGet(input, context) {
  const user = requireUser(context);
  const type = requireType(context, input.objectType);
  requireScopes(context, user, readScope(type));
  rejectHistory(context, input);
  const archived = requireArchived(context, input.archived);
  const definitions = definitionsFor(context, type);
  const record = requireRecord(context, user, type, definitions, input.objectId, input.idProperty, archived);
  return requireFits(context, recordView(record, readNames(type, input.properties, definitions), inlineAssociations(context, user, type, record, input.associations)), FEWER_PROPERTIES);
}

function objectsCreate(input, context) {
  const user = requireUser(context);
  const type = requireType(context, input.objectType);
  requireScopes(context, user, writeScope(type));
  const now = isoNow(context);
  const definitions = definitionsFor(context, type);
  const merged = mergeProperties(context, user, type, definitions, input.properties, null, now);
  const links = resolveInlineAssociations(context, user, type, input.associations);
  const record = createRecord(context, type, merged.properties, now);
  applyInlineAssociations(context, type, record.id, links, now);
  return requireFits(context, recordView(record, writeNames(type, record, definitions)), "shorten the property values");
}

function objectsUpdate(input, context) {
  const user = requireUser(context);
  const type = requireType(context, input.objectType);
  requireScopes(context, user, writeScope(type));
  const definitions = definitionsFor(context, type);
  const lookups = uniqueLookups(context, type);
  const existing = requireRecord(context, user, type, definitions, input.objectId, input.idProperty, false, lookups);
  const now = isoNow(context);
  const merged = mergeProperties(context, user, type, definitions, input.properties, existing, now, lookups);
  const record = updateRecord(context, type, existing, merged, now);
  return requireFits(context, recordView(record, writeNames(type, record, definitions)), "shorten the property values");
}

function objectsArchive(input, context) {
  const user = requireUser(context);
  const type = requireType(context, input.objectType);
  requireScopes(context, user, writeScope(type));
  const record = loadRecord(context, user, type, String(input.objectId));
  if (record === null) return notFound(context);
  const now = isoNow(context);
  saveRecord(context, type, { ...record, archived: true, archivedAt: now, updatedAt: now });
  return {};
}

function objectsBatchRead(input, context) {
  const user = requireUser(context);
  const type = requireType(context, input.objectType);
  requireScopes(context, user, readScope(type));
  rejectHistory(context, input);
  const inputs = requireInputs(context, input.inputs);
  const definitions = definitionsFor(context, type);
  const names = readNames(type, input.properties, definitions);
  const now = isoNow(context);
  const results = [];
  const missing = [];
  const lookups = uniqueLookups(context, type);
  for (const entry of inputs) {
    const id = String(entry?.id ?? "");
    const record = resolveRecord(context, user, type, definitions, id, input.idProperty, false, lookups);
    if (record === null) missing.push(id);
    else results.push(recordView(record, names));
  }
  return requireFits(context, batchEnvelope(results, missing.length > 0 ? [missingObjectsError(type, missing)] : [], now, now), FEWER_INPUTS);
}

function objectsBatchCreate(input, context) {
  const user = requireUser(context);
  const type = requireType(context, input.objectType);
  requireScopes(context, user, writeScope(type));
  const inputs = requireInputs(context, input.inputs);
  const now = isoNow(context);
  const definitions = definitionsFor(context, type);
  const lookups = uniqueLookups(context, type);
  const prepared = inputs.map((entry) => ({
    merged: mergeProperties(context, user, type, definitions, entry?.properties, null, now, lookups),
    links: resolveInlineAssociations(context, user, type, entry?.associations),
  }));
  requireUniqueEmails(
    context,
    type,
    prepared.map((entry) => entry.merged.properties),
  );
  const results = prepared.map(({ merged, links }) => {
    const record = createRecord(context, type, merged.properties, now);
    applyInlineAssociations(context, type, record.id, links, now);
    return recordView(record, writeNames(type, record, definitions));
  });
  return requireFits(context, batchEnvelope(results, [], now, now), FEWER_INPUTS);
}

function objectsBatchUpdate(input, context) {
  const user = requireUser(context);
  const type = requireType(context, input.objectType);
  requireScopes(context, user, writeScope(type));
  const inputs = requireInputs(context, input.inputs);
  const now = isoNow(context);
  const definitions = definitionsFor(context, type);
  const results = [];
  const errors = [];
  const lookups = uniqueLookups(context, type);
  for (const entry of inputs) {
    const id = String(entry?.id ?? "");
    const existing = resolveRecord(context, user, type, definitions, id, entry?.idProperty, false, lookups);
    if (existing === null) {
      errors.push(missingRecordError(type, id));
      continue;
    }
    const merged = mergeProperties(context, user, type, definitions, entry?.properties, existing, now, lookups);
    const record = updateRecord(context, type, existing, merged, now);
    lookups.replace(existing, record);
    results.push(recordView(record, writeNames(type, record, definitions)));
  }
  return requireFits(context, batchEnvelope(results, errors, now, now), FEWER_INPUTS);
}

function objectsSearch(input, context) {
  const user = requireUser(context);
  const type = requireType(context, input.objectType);
  requireScopes(context, user, readScope(type));
  const definitions = definitionsFor(context, type);
  const groups = normalizeFilterGroups(input.filterGroups, definitions);
  if (groups.error !== undefined) return validationError(context, groups.error, [{ message: groups.error, context: { propertyName: ["filterGroups"] } }]);
  const sorts = normalizeSorts(input.sorts, definitions);
  if (sorts.error !== undefined) return validationError(context, sorts.error, [{ message: sorts.error, context: { propertyName: ["sorts"] } }]);
  const limit = requireLimit(context, input.limit, 10, MAX_SEARCH_LIMIT);
  const after = input.after === undefined ? "0" : String(input.after);
  if (!/^(0|[1-9][0-9]{0,6})$/.test(after) || Number(after) >= MAX_SEARCH_OFFSET) {
    return validationError(context, `Invalid after cursor: paging beyond ${MAX_SEARCH_OFFSET} results is not supported`, [{ message: "after must be a decimal offset below 10000", context: { propertyName: ["after"] } }]);
  }
  const offset = Number(after);
  const query = typeof input.query === "string" ? input.query : "";
  rejectMangled(context, query, "query");
  if (query.length > MAX_SEARCH_TEXT) {
    return validationError(context, `query exceeds the maximum length of ${MAX_SEARCH_TEXT} characters`, [{ message: `query has ${query.length} characters`, context: { propertyName: ["query"] } }]);
  }
  const budget = createWorkBudget();
  const expensive = () => {
    const message = `This search needs more than ${MAX_MATCH_WORK} characters of matching work; narrow the filters or shorten the property values it scans`;
    return validationError(context, message, [{ message, context: { propertyName: ["filterGroups"] } }]);
  };
  const matches = createRecordMatcher(groups.groups, query, SEARCHABLE_PROPERTIES[type.name], budget);
  const matched = [];
  for (const record of allRows(context, type.name)) {
    if (record.archived || !isVisible(user, record)) continue;
    if (matches(record.properties)) matched.push(record);
    if (budget.exceeded) return expensive();
  }
  if (sorts.sort !== undefined) {
    sortRecords(matched, sorts.sort, budget);
    if (budget.exceeded) return expensive();
  }
  const total = Math.min(matched.length, MAX_SEARCH_OFFSET);
  const names = readNames(type, input.properties, definitions);
  // Pages fill by encoded UTF-8 size as well as count; `after` is the offset of the first record not returned.
  const results = [];
  let bytes = PAGE_ENVELOPE_BYTES;
  for (let index = offset; index < Math.min(offset + limit, total); index += 1) {
    const view = recordView(matched[index], names);
    const size = jsonBytes(view) + 1;
    if (bytes + size > RESPONSE_BYTE_BUDGET) {
      if (results.length === 0) return responseTooLarge(context, PAGE_ENVELOPE_BYTES + size, "request fewer properties");
      break;
    }
    bytes += size;
    results.push(view);
  }
  const body = { total, results };
  const next = offset + results.length;
  if (next < total) body.paging = { next: { after: String(next) } };
  return body;
}

function associationsList(input, context) {
  const user = requireUser(context);
  const fromType = requireType(context, input.objectType);
  const toType = requireType(context, input.toObjectType);
  requireScopes(context, user, readScope(fromType), readScope(toType));
  const limit = requireLimit(context, input.limit, MAX_ASSOCIATION_LIMIT, MAX_ASSOCIATION_LIMIT);
  const after = requireAfter(context, input.after);
  const record = loadRecord(context, user, fromType, String(input.objectId));
  if (record === null) return notFound(context);
  const definitions = labelDefinitions(context, fromType, toType);
  const links = visibleLinks(context, user, fromType, record.id, toType).filter((link) => after === undefined || Number(link.toObjectId) > Number(after));
  const page = links.slice(0, limit);
  const body = { results: page.map((link) => linkView(link, definitions)) };
  if (links.length > limit) {
    const last = page[page.length - 1].toObjectId;
    body.paging = { next: { after: last, link: pagingLink(`/crm/v4/objects/${fromType.name}/${record.id}/associations/${toType.name}`, limit, last) } };
  }
  return body;
}

function requirePair(context, user, input) {
  const fromType = requireType(context, input.fromObjectType);
  const toType = requireType(context, input.toObjectType);
  requireScopes(context, user, writeScope(fromType), readScope(toType));
  const from = loadRecord(context, user, fromType, String(input.fromObjectId));
  if (from === null) return notFound(context, `No ${fromType.singular} with ID ${clip(input.fromObjectId)} exists`);
  const to = loadRecord(context, user, toType, String(input.toObjectId));
  if (to === null) return notFound(context, `No ${toType.singular} with ID ${clip(input.toObjectId)} exists`);
  return { fromType, toType, from, to };
}

function associationsCreateDefault(input, context) {
  const user = requireUser(context);
  const { fromType, toType, from, to } = requirePair(context, user, input);
  const definition = defaultDefinition(context, fromType, toType);
  if (definition === undefined) {
    return validationError(context, `No default association type is defined between ${fromType.singular} and ${toType.singular}`, [
      { message: "Default association type missing", context: { fromObjectTypeId: [fromType.typeId], toObjectTypeId: [toType.typeId] } },
    ]);
  }
  associate(context, fromType, from.id, toType, to.id, [definition], isoNow(context));
  const spec = (typeId) => ({ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId });
  return {
    results: [
      { fromObjectTypeId: fromType.typeId, fromObjectId: from.id, toObjectTypeId: toType.typeId, toObjectId: to.id, associationSpec: spec(definition.typeId) },
      { fromObjectTypeId: toType.typeId, fromObjectId: to.id, toObjectTypeId: fromType.typeId, toObjectId: from.id, associationSpec: spec(definition.inverseTypeId) },
    ],
  };
}

function associationsCreate(input, context) {
  const user = requireUser(context);
  const { fromType, toType, from, to } = requirePair(context, user, input);
  const definitions = requireTypeSpecs(context, fromType, toType, input.types);
  associate(context, fromType, from.id, toType, to.id, definitions, isoNow(context));
  const link = linkRow(context, fromType, from.id, toType, to.id);
  return associationResult(fromType, from.id, toType, to.id, labelsOf(link, labelDefinitions(context, fromType, toType)));
}

function associationsBatchCreate(input, context) {
  const user = requireUser(context);
  const fromType = requireType(context, input.fromObjectType);
  const toType = requireType(context, input.toObjectType);
  requireScopes(context, user, writeScope(fromType), readScope(toType));
  const inputs = requireInputs(context, input.inputs);
  const now = isoNow(context);
  const prepared = inputs.map((entry) => ({
    fromId: String(entry?.from?.id ?? ""),
    toId: String(entry?.to?.id ?? ""),
    definitions: requireTypeSpecs(context, fromType, toType, entry?.types),
  }));
  const results = [];
  const errors = [];
  const allDefinitions = labelDefinitions(context, fromType, toType);
  for (const { fromId, toId, definitions } of prepared) {
    if (loadRecord(context, user, fromType, fromId) === null) {
      errors.push(missingRecordError(fromType, fromId));
      continue;
    }
    if (loadRecord(context, user, toType, toId) === null) {
      errors.push(missingRecordError(toType, toId));
      continue;
    }
    associate(context, fromType, fromId, toType, toId, definitions, now);
    results.push(associationResult(fromType, fromId, toType, toId, labelsOf(linkRow(context, fromType, fromId, toType, toId), allDefinitions)));
  }
  return batchEnvelope(results, errors, now, now);
}

function associationsArchive(input, context) {
  const user = requireUser(context);
  const { fromType, toType, from, to } = requirePair(context, user, input);
  const forward = linkRow(context, fromType, from.id, toType, to.id);
  if (forward !== null) removeTypes(context, forward, forward.typeIds);
  const backward = linkRow(context, toType, to.id, fromType, from.id);
  if (backward !== null) removeTypes(context, backward, backward.typeIds);
  return {};
}

function associationsBatchRead(input, context) {
  const user = requireUser(context);
  const fromType = requireType(context, input.fromObjectType);
  const toType = requireType(context, input.toObjectType);
  requireScopes(context, user, readScope(fromType), readScope(toType));
  const inputs = requireInputs(context, input.inputs);
  const now = isoNow(context);
  const definitions = labelDefinitions(context, fromType, toType);
  const results = [];
  const errors = [];
  for (const entry of inputs) {
    const id = String(entry?.id ?? "");
    if (loadRecord(context, user, fromType, id) === null) {
      errors.push(missingRecordError(fromType, id));
      continue;
    }
    const links = visibleLinks(context, user, fromType, id, toType);
    if (links.length > 0) results.push({ from: { id }, to: links.map((link) => linkView(link, definitions)) });
  }
  return requireFits(context, batchEnvelope(results, errors, now, now), "send fewer inputs");
}

function associationsListLabels(input, context) {
  const user = requireUser(context);
  const fromType = requireType(context, input.fromObjectType);
  const toType = requireType(context, input.toObjectType);
  requireScopes(context, user, readScope(fromType), readScope(toType));
  const results = [...labelDefinitions(context, fromType, toType).values()].sort((left, right) => left.typeId - right.typeId).map(labelView);
  return { results };
}

function ownerView(owner) {
  return {
    id: owner.id,
    email: owner.email,
    type: owner.type,
    firstName: owner.firstName,
    lastName: owner.lastName,
    userId: owner.userId,
    userIdIncludingInactive: owner.userIdIncludingInactive,
    createdAt: owner.createdAt,
    updatedAt: owner.updatedAt,
    archived: owner.archived,
    teams: owner.teams,
  };
}

function ownersList(input, context) {
  const user = requireUser(context);
  requireScopes(context, user, "crm.objects.owners.read");
  const limit = requireLimit(context, input.limit, 100, MAX_OWNER_LIMIT);
  const after = requireAfter(context, input.after);
  const archived = requireArchived(context, input.archived);
  rejectMangled(context, input.email, "email");
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : undefined;
  const matched = allRows(context, "owners").filter(
    (owner) => owner.archived === archived && (email === undefined || owner.email.toLowerCase() === email) && (after === undefined || Number(owner.id) > Number(after)),
  );
  const page = matched.slice(0, limit);
  const body = { results: page.map(ownerView) };
  if (matched.length > limit) {
    const last = page[page.length - 1].id;
    body.paging = { next: { after: last, link: pagingLink("/crm/v3/owners", limit, last) } };
  }
  return body;
}

function ownersGet(input, context) {
  const user = requireUser(context);
  requireScopes(context, user, "crm.objects.owners.read");
  const includeArchived = requireArchived(context, input.archived);
  const idProperty = input.idProperty ?? "id";
  if (idProperty !== "id" && idProperty !== "userId") {
    return validationError(context, `Invalid idProperty: ${clip(idProperty)}`, [{ message: "idProperty must be id or userId", context: { propertyName: ["idProperty"] } }]);
  }
  const id = String(input.ownerId);
  const owner =
    idProperty === "userId"
      ? allRows(context, "owners").find((row) => String(row.userIdIncludingInactive) === id) ?? null
      : isObjectId(id)
        ? context.state.get("owners", padId(id))
        : null;
  if (owner === null || owner === undefined || (owner.archived && !includeArchived)) return notFound(context, `Owner ${clip(id)} not found`);
  return ownerView(owner);
}

function requireDealType(context, value) {
  const type = requireType(context, value);
  if (type.name !== "deals") return notFound(context, `Unable to infer object type from: ${clip(value)}`);
  return type;
}

function pipelineView(row) {
  const { objectType: _objectType, ...pipeline } = row;
  return pipeline;
}

/** The deal pipeline row, or null for ids that cannot name one (empty, containing `/`, or beyond the row-id bound). */
function pipelineRow(context, pipelineId) {
  return isRowKey(pipelineId, "deals/") ? context.state.get("pipelines", `deals/${pipelineId}`) : null;
}

function requirePipeline(context, pipelineId) {
  const row = pipelineRow(context, pipelineId);
  return row === null ? notFound(context, `Pipeline ${clip(pipelineId)} not found`) : row;
}

function pipelinesList(input, context) {
  const user = requireUser(context);
  requireDealType(context, input.objectType);
  requireScopes(context, user, "crm.objects.deals.read");
  const results = prefixRows(context, "pipelines", "deals/")
    .sort((left, right) => left.displayOrder - right.displayOrder || compareStrings(left.id, right.id))
    .map(pipelineView);
  return { results };
}

function pipelinesGet(input, context) {
  const user = requireUser(context);
  requireDealType(context, input.objectType);
  requireScopes(context, user, "crm.objects.deals.read");
  return pipelineView(requirePipeline(context, input.pipelineId));
}

function pipelinesListStages(input, context) {
  const user = requireUser(context);
  requireDealType(context, input.objectType);
  requireScopes(context, user, "crm.objects.deals.read");
  const pipeline = requirePipeline(context, input.pipelineId);
  return { results: [...pipeline.stages].sort((left, right) => left.displayOrder - right.displayOrder) };
}

function propertyView(definition) {
  const { objectType: _objectType, ...property } = definition;
  return property;
}

function propertiesList(input, context) {
  const user = requireUser(context);
  const type = requireType(context, input.objectType);
  requireScopes(context, user, schemaReadScope(type));
  const archived = requireArchived(context, input.archived);
  const includeHidden = requireIncludeHidden(context, input.includeHidden);
  const results = [];
  if (!archived) for (const definition of DEFINED_PROPERTIES[type.name].values()) if (includeHidden || !definition.hidden) results.push(definition);
  for (const row of prefixRows(context, "properties", `${type.name}/`)) if (row.archived === archived && (includeHidden || !row.hidden)) results.push(row);
  results.sort((left, right) => compareStrings(left.groupName, right.groupName) || left.displayOrder - right.displayOrder || compareStrings(left.name, right.name));
  return { results: results.map(propertyView) };
}

function propertiesGet(input, context) {
  const user = requireUser(context);
  const type = requireType(context, input.objectType);
  requireScopes(context, user, schemaReadScope(type));
  const includeArchived = requireArchived(context, input.archived);
  const name = String(input.propertyName);
  const defined = DEFINED_PROPERTIES[type.name].get(name);
  if (defined !== undefined) return propertyView(defined);
  const row = isRowKey(name, `${type.name}/`) ? context.state.get("properties", `${type.name}/${name}`) : null;
  if (row === null || (row.archived && !includeArchived)) return notFound(context, `Property ${clip(name)} does not exist`);
  return propertyView(row);
}

function accountGetDetails(_input, context) {
  const user = requireUser(context);
  requireScopes(context, user, "oauth");
  return {
    ...ACCOUNT,
    user: { id: user.owner.userId, email: user.owner.email, firstName: user.owner.firstName, lastName: user.owner.lastName, ownerId: user.owner.id },
    scopes: user.scopes === null ? [...ALL_SCOPES] : [...user.scopes],
  };
}

const operations = {
  "account.get-details": accountGetDetails,
  "objects.list": objectsList,
  "objects.get": objectsGet,
  "objects.create": objectsCreate,
  "objects.update": objectsUpdate,
  "objects.archive": objectsArchive,
  "objects.batch-read": objectsBatchRead,
  "objects.batch-create": objectsBatchCreate,
  "objects.batch-update": objectsBatchUpdate,
  "objects.search": objectsSearch,
  "associations.list": associationsList,
  "associations.create-default": associationsCreateDefault,
  "associations.create": associationsCreate,
  "associations.batch-create": associationsBatchCreate,
  "associations.archive": associationsArchive,
  "associations.batch-read": associationsBatchRead,
  "associations.list-labels": associationsListLabels,
  "owners.list": ownersList,
  "owners.get": ownersGet,
  "pipelines.list": pipelinesList,
  "pipelines.get": pipelinesGet,
  "pipelines.list-stages": pipelinesListStages,
  "properties.list": propertiesList,
  "properties.get": propertiesGet,
};

// ---------------------------------------------------------------------------------------------
// HTTP codecs (pure): HubSpot paths in, HubSpot bodies/headers out
// ---------------------------------------------------------------------------------------------

/** Codec for one route: success bodies pass through (or `select`), errors use the HubSpot envelope. */
function route(decode, options = {}) {
  return {
    decode,
    encode({ invocation, outcome }) {
      const headers = responseHeaders(invocation.correlationId, isRateLimited(outcome));
      if (outcome.status !== "ok") return { headers, body: { kind: "json", value: hubspotError(outcome, invocation.correlationId) } };
      if (options.empty) return { headers, body: { kind: "empty" } };
      return { headers, body: { kind: "json", value: options.select === undefined ? outcome.value : options.select(outcome.value) } };
    },
  };
}

function readQuery(request) {
  return defined({
    properties: list(request.query, "properties"),
    propertiesWithHistory: list(request.query, "propertiesWithHistory"),
    associations: list(request.query, "associations"),
    archived: bool(request.query, "archived"),
  });
}

function stringOrUndefined(value) {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

function batchBody(request, keys) {
  const body = jsonBody(request);
  return defined(Object.fromEntries(keys.map((key) => [key, body[key]])));
}

const http = {
  "get-account-details": route(() => ({ arguments: {} }), {
    select: (value) => {
      const { user: _user, scopes: _scopes, ...details } = value;
      return details;
    },
  }),
  "list-objects": route((request) => ({
    arguments: defined({ objectType: request.path.objectType, limit: int(request.query, "limit"), after: str(request.query, "after"), ...readQuery(request) }),
  })),
  "get-object": route((request) => ({
    arguments: defined({ objectType: request.path.objectType, objectId: request.path.objectId, idProperty: str(request.query, "idProperty"), ...readQuery(request) }),
  })),
  "create-object": route((request) => operationInput(request, defined({ objectType: request.path.objectType, ...batchBody(request, ["properties", "associations"]) }))),
  "update-object": route((request) =>
    operationInput(request, defined({ objectType: request.path.objectType, objectId: request.path.objectId, idProperty: str(request.query, "idProperty"), ...batchBody(request, ["properties"]) })),
  ),
  "archive-object": route((request) => operationInput(request, { objectType: request.path.objectType, objectId: request.path.objectId }), { empty: true }),
  "batch-read-objects": route((request) => ({ arguments: defined({ objectType: request.path.objectType, ...batchBody(request, ["inputs", "properties", "propertiesWithHistory", "idProperty"]) }) })),
  "batch-create-objects": route((request) => operationInput(request, defined({ objectType: request.path.objectType, ...batchBody(request, ["inputs"]) }))),
  "batch-update-objects": route((request) => operationInput(request, defined({ objectType: request.path.objectType, ...batchBody(request, ["inputs"]) }))),
  "search-objects": route((request) => {
    const body = jsonBody(request);
    return {
      arguments: defined({
        objectType: request.path.objectType,
        filterGroups: body.filterGroups,
        query: body.query,
        sorts: body.sorts,
        properties: body.properties,
        limit: body.limit,
        after: stringOrUndefined(body.after),
      }),
    };
  }),
  "list-associations": route((request) => ({
    arguments: defined({
      objectType: request.path.objectType,
      objectId: request.path.objectId,
      toObjectType: request.path.toObjectType,
      limit: int(request.query, "limit"),
      after: str(request.query, "after"),
    }),
  })),
  "create-default-association": route(
    (request) =>
      operationInput(request, {
        fromObjectType: request.path.fromObjectType,
        fromObjectId: request.path.fromObjectId,
        toObjectType: request.path.toObjectType,
        toObjectId: request.path.toObjectId,
      }),
    { select: (value) => value.results },
  ),
  "create-association": route((request) =>
    operationInput(request, {
      fromObjectType: request.path.fromObjectType,
      fromObjectId: request.path.fromObjectId,
      toObjectType: request.path.toObjectType,
      toObjectId: request.path.toObjectId,
      types: jsonArrayBody(request),
    }),
  ),
  "archive-association": route(
    (request) =>
      operationInput(request, {
        fromObjectType: request.path.fromObjectType,
        fromObjectId: request.path.fromObjectId,
        toObjectType: request.path.toObjectType,
        toObjectId: request.path.toObjectId,
      }),
    { empty: true },
  ),
  "batch-create-associations": route((request) =>
    operationInput(request, defined({ fromObjectType: request.path.fromObjectType, toObjectType: request.path.toObjectType, ...batchBody(request, ["inputs"]) })),
  ),
  "batch-read-associations": route((request) => ({
    arguments: defined({ fromObjectType: request.path.fromObjectType, toObjectType: request.path.toObjectType, ...batchBody(request, ["inputs"]) }),
  })),
  "list-association-labels": route((request) => ({ arguments: { fromObjectType: request.path.fromObjectType, toObjectType: request.path.toObjectType } })),
  "list-owners": route((request) => ({
    arguments: defined({ email: str(request.query, "email"), limit: int(request.query, "limit"), after: str(request.query, "after"), archived: bool(request.query, "archived") }),
  })),
  "get-owner": route((request) => ({
    arguments: defined({ ownerId: request.path.ownerId, idProperty: str(request.query, "idProperty"), archived: bool(request.query, "archived") }),
  })),
  "list-pipelines": route((request) => ({ arguments: { objectType: request.path.objectType } })),
  "get-pipeline": route((request) => ({ arguments: { objectType: request.path.objectType, pipelineId: request.path.pipelineId } })),
  "list-pipeline-stages": route((request) => ({ arguments: { objectType: request.path.objectType, pipelineId: request.path.pipelineId } })),
  "list-properties": route((request) => ({
    arguments: defined({ objectType: request.path.objectType, archived: bool(request.query, "archived"), includeHidden: bool(request.query, "includeHidden") ?? true }),
  })),
  "get-property": route((request) => ({
    arguments: defined({ objectType: request.path.objectType, propertyName: request.path.propertyName, archived: bool(request.query, "archived") }),
  })),
};

export default { operations, http };
