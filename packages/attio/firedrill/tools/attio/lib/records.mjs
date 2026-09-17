// People, companies and deals: query, get, create, assert (upsert), update, delete and search.
import { caller, requireScopes } from "./access.mjs";
import { compileFilter, compileSorts, foldSearch, words } from "./filter.mjs";
import {
  PAGE_BYTES,
  clip,
  compare,
  encodedSize,
  fail,
  integerParam,
  isPlainObject,
  isUuid,
  nextId,
  notFound,
  now,
  rows,
  validation,
  valueNotFound,
} from "./common.mjs";
import { OBJECT_SLUGS, coerceWrite, entryKey, expandValues, loadDefs, mergeValues, resolveDef } from "./values.mjs";

const READ_SCOPES = ["object_configuration:read", "record_permission:read"];
// Values stored per attribute, including relationship inverses: keeps a record read well under 1 MiB.
const MAX_STORED_VALUES = 1_000;
const WRITE_SCOPES = ["object_configuration:read", "record_permission:read-write"];

export function begin(context, scopes) {
  const who = caller(context);
  requireScopes(context, who, ...scopes);
  return { who, ws: who.workspace, actor: who.actor, now: now(context) };
}

/** An object row by slug or object_id, or null. */
export function findObject(context, key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 128) return null;
  for (const slug of OBJECT_SLUGS) {
    const object = context.state.get("objects", slug);
    if (object !== null && (slug === key || object.object_id === key)) return object;
  }
  return null;
}

export function requireObject(context, key) {
  const object = findObject(context, key);
  if (object === null) return notFound(context, `Object with slug/ID "${clip(String(key))}" not found.`);
  return object;
}

/** Per-operation cache of attribute definitions by object slug. */
export function defsCache(context) {
  const cache = new Map();
  return (slug) => {
    if (!cache.has(slug)) cache.set(slug, loadDefs(context, "objects", slug));
    return cache.get(slug);
  };
}

export function recordOut(env, object, defs, row) {
  return {
    id: { workspace_id: env.ws.workspace_id, object_id: object.object_id, record_id: row.record_id },
    created_at: row.created_at,
    web_url: `https://app.attio.com/${env.ws.workspace_slug}/${object.singular_noun.toLowerCase()}/${row.record_id}/overview`,
    values: expandValues({ workspaceId: env.ws.workspace_id, parentField: "object_id", parentId: object.object_id, recordId: row.record_id }, defs, row, row.values),
  };
}

export function recordView(row) {
  return { id: row.record_id, created_at: row.created_at, created_by_actor: row.created_by_actor, values: row.values };
}

function loadRecord(context, object, recordId) {
  if (!isUuid(recordId)) return null;
  return context.state.get(object.api_slug, recordId);
}

function requireRecord(context, object, recordId) {
  const row = loadRecord(context, object, recordId);
  if (row === null) return notFound(context, `Record with ID "${clip(String(recordId))}" not found.`);
  return row;
}

function pageSizeCheck(context, value) {
  if (encodedSize(value) > PAGE_BYTES) return fail(context, "FAILED_PRECONDITION", "Response too large; lower limit");
  return value;
}

// ------------------------------------------------------------------------------------------------------------
// Writes: merge, uniqueness, required attributes, relationship inverses, events

function refEntry(env, targetObject, targetId) {
  return { active_from: env.now, active_until: null, created_by_actor: env.actor, target_object: targetObject, target_record_id: targetId };
}

function touch(touched, object, recordId, attributeId) {
  const key = `${object.api_slug}/${recordId}`;
  if (!touched.has(key)) touched.set(key, { object, recordId, attributes: [] });
  const entry = touched.get(key);
  if (!entry.attributes.includes(attributeId)) entry.attributes.push(attributeId);
}

function removeRef(context, env, defsFor, targetSlug, targetId, inverseSlug, fromId, touched) {
  const row = context.state.get(targetSlug, targetId);
  if (row === null) return;
  const current = Object.hasOwn(row.values, inverseSlug) ? row.values[inverseSlug] : [];
  const next = current.filter((entry) => entry.target_record_id !== fromId);
  if (next.length === current.length) return;
  const values = { ...row.values };
  if (next.length === 0) delete values[inverseSlug];
  else values[inverseSlug] = next;
  context.state.put(targetSlug, targetId, { ...row, values });
  if (touched !== null) touch(touched, context.state.get("objects", targetSlug), targetId, defsFor(targetSlug).bySlug.get(inverseSlug).attribute_id);
}

function addRef(context, env, defsFor, targetSlug, targetId, inverseDef, fromSlug, fromId, fromDef, touched) {
  const row = context.state.get(targetSlug, targetId);
  if (row === null) return;
  const current = Object.hasOwn(row.values, inverseDef.api_slug) ? row.values[inverseDef.api_slug] : [];
  if (current.some((entry) => entry.target_record_id === fromId)) return;
  if (inverseDef.is_multiselect && current.length >= MAX_STORED_VALUES) {
    return validation(context, `Attribute with slug "${inverseDef.api_slug}" cannot hold more than ${MAX_STORED_VALUES} values.`);
  }
  if (!inverseDef.is_multiselect) {
    for (const entry of current) removeRef(context, env, defsFor, fromSlug, entry.target_record_id, fromDef.api_slug, targetId, touched);
  }
  const fresh = context.state.get(targetSlug, targetId);
  const entries = inverseDef.is_multiselect ? [...(Object.hasOwn(fresh.values, inverseDef.api_slug) ? fresh.values[inverseDef.api_slug] : []), refEntry(env, fromSlug, fromId)] : [refEntry(env, fromSlug, fromId)];
  context.state.put(targetSlug, targetId, { ...fresh, values: { ...fresh.values, [inverseDef.api_slug]: entries } });
  touch(touched, context.state.get("objects", targetSlug), targetId, inverseDef.attribute_id);
}

function uniqueValueText(entry) {
  return entry.email_address ?? entry.domain ?? entry.value ?? entryKey(entry);
}

/**
 * Persist a record after merging `updates`. Returns `{ row, changed }`. Fails before any write on required,
 * uniqueness and validation problems (a declared failure rolls back every write anyway).
 */
function saveRecord(context, env, defsFor, object, existing, updates, modeFor, touched) {
  const defs = defsFor(object.api_slug);
  const recordId = existing === null ? nextId(context, "00000004") : existing.record_id;
  const stored = existing === null ? {} : existing.values;
  const { values, changed } = mergeValues(defs, stored, updates, modeFor);
  for (const slug of changed) {
    if (Object.hasOwn(values, slug) && values[slug].length > MAX_STORED_VALUES) {
      return validation(context, `Attribute with slug "${slug}" cannot hold more than ${MAX_STORED_VALUES} values.`);
    }
  }
  if (existing === null) {
    for (const def of defs.list) {
      if (def.is_required && !def.is_archived && def.is_writable && !(Object.hasOwn(values, def.api_slug) && values[def.api_slug].length > 0)) {
        return validation(context, `Required attribute with slug "${def.api_slug}" is missing a value.`);
      }
    }
  } else {
    for (const slug of changed) {
      const def = defs.bySlug.get(slug);
      if (def.is_required && !(Object.hasOwn(values, slug) && values[slug].length > 0)) {
        return validation(context, `Required attribute with slug "${slug}" cannot be cleared.`);
      }
    }
  }
  const uniqueChanged = changed.map((slug) => defs.bySlug.get(slug)).filter((def) => def.is_unique);
  if (uniqueChanged.length > 0) {
    const others = rows(context, object.api_slug, { bounded: true });
    for (const def of uniqueChanged) {
      const before = new Set((Object.hasOwn(stored, def.api_slug) ? stored[def.api_slug] : []).map(entryKey));
      const added = (Object.hasOwn(values, def.api_slug) ? values[def.api_slug] : []).filter((entry) => !before.has(entryKey(entry)));
      for (const entry of added) {
        const key = entryKey(entry);
        const clash = others.some((other) => other.record_id !== recordId && Object.hasOwn(other.values, def.api_slug) && other.values[def.api_slug].some((candidate) => entryKey(candidate) === key));
        if (clash) {
          return fail(context, "UNIQUENESS_CONFLICT", `The value "${clip(String(uniqueValueText(entry)))}" provided for attribute with slug "${def.api_slug}" is not unique.`);
        }
      }
    }
  }
  const row = existing === null
    ? { record_id: recordId, created_at: env.now, created_by_actor: env.actor, values }
    : { ...existing, values };
  context.state.put(object.api_slug, recordId, row);
  if (existing !== null) for (const slug of changed) touch(touched, object, recordId, defs.bySlug.get(slug).attribute_id);
  for (const slug of changed) {
    const def = defs.bySlug.get(slug);
    if (def.relationship === null || def.type !== "record-reference") continue;
    const inverseSlug = def.relationship.object;
    const inverseDefs = defsFor(inverseSlug);
    const inverseDef = inverseDefs.bySlug.get(def.relationship.attribute);
    if (inverseDef === undefined) continue;
    const beforeIds = (Object.hasOwn(stored, slug) ? stored[slug] : []).map((entry) => entry.target_record_id);
    const afterIds = (Object.hasOwn(values, slug) ? values[slug] : []).map((entry) => entry.target_record_id);
    for (const id of beforeIds) if (!afterIds.includes(id)) removeRef(context, env, defsFor, inverseSlug, id, inverseDef.api_slug, recordId, touched);
    for (const id of afterIds) if (!beforeIds.includes(id)) addRef(context, env, defsFor, inverseSlug, id, inverseDef, object.api_slug, recordId, def, touched);
  }
  return { row: context.state.get(object.api_slug, recordId), changed };
}

function emitUpdates(context, env, touched) {
  for (const { object, recordId, attributes } of touched.values()) {
    for (const attributeId of attributes) {
      context.events.emit("record.updated", {
        id: { workspace_id: env.ws.workspace_id, object_id: object.object_id, record_id: recordId },
        attribute_id: attributeId,
        actor: env.actor,
      });
    }
  }
}

function emitCreated(context, env, object, recordId) {
  context.events.emit("record.created", { id: { workspace_id: env.ws.workspace_id, object_id: object.object_id, record_id: recordId }, actor: env.actor });
}

function valuesPayload(context, data, field = "values") {
  if (!isPlainObject(data)) return validation(context, `Expected "data" to be an object with "${field}".`);
  if (!isPlainObject(data[field])) return validation(context, `Expected "data.${field}" to be an object of attribute values.`);
  return data[field];
}

function modeOf(context, mode) {
  if (mode !== "append" && mode !== "overwrite") return validation(context, `Invalid update mode "${clip(String(mode))}".`);
  return mode;
}

// ------------------------------------------------------------------------------------------------------------
// Operations

export function recordsQuery(input, context) {
  const env = begin(context, READ_SCOPES);
  const object = requireObject(context, input.object);
  if (input.filter_view_id !== undefined && input.filter_view_id !== null) {
    return validation(context, "Querying by filter_view_id is not supported; pass a filter object instead.");
  }
  const limit = integerParam(context, input.limit, "limit", { min: 1, max: 500, fallback: 500 });
  const offset = integerParam(context, input.offset, "offset", { min: 0, max: 1_000_000_000, fallback: 0 });
  const defs = defsCache(context)(object.api_slug);
  const predicate = compileFilter(context, input.filter, { defs, systemFields: true });
  const comparator = compileSorts(context, input.sorts, defs, true);
  const matched = rows(context, object.api_slug, { bounded: true })
    .map((row) => ({ row, view: recordView(row) }))
    .filter((item) => predicate(item.view))
    .sort((a, b) => comparator(a.view, b.view));
  return pageSizeCheck(context, { data: matched.slice(offset, offset + limit).map((item) => recordOut(env, object, defs, item.row)) });
}

export function recordsGet(input, context) {
  const env = begin(context, READ_SCOPES);
  const object = requireObject(context, input.object);
  const row = requireRecord(context, object, input.record_id);
  return { data: recordOut(env, object, defsCache(context)(object.api_slug), row) };
}

export function recordsCreate(input, context) {
  const env = begin(context, WRITE_SCOPES);
  const object = requireObject(context, input.object);
  const defsFor = defsCache(context);
  const updates = coerceWrite(context, env, defsFor(object.api_slug), valuesPayload(context, input.data));
  const touched = new Map();
  const { row } = saveRecord(context, env, defsFor, object, null, updates, () => "append", touched);
  emitCreated(context, env, object, row.record_id);
  emitUpdates(context, env, touched);
  return { data: recordOut(env, object, defsFor(object.api_slug), row) };
}

export function recordsAssert(input, context) {
  const env = begin(context, WRITE_SCOPES);
  const object = requireObject(context, input.object);
  const defsFor = defsCache(context);
  const defs = defsFor(object.api_slug);
  const matching = input.matching_attribute;
  if (typeof matching !== "string" || matching.length === 0) return validation(context, "The matching_attribute query parameter is required.");
  const def = matching === "__proto__" || matching === "constructor" || matching === "prototype" ? undefined : resolveDef(defs, matching);
  if (def === undefined || def.is_archived) return validation(context, `Cannot find attribute with slug/ID "${clip(matching)}".`);
  if (!def.is_unique) return validation(context, `The attribute with slug "${def.api_slug}" is not unique, so it cannot be used as a matching_attribute.`);
  const updates = coerceWrite(context, env, defs, valuesPayload(context, input.data));
  const incoming = updates.get(def.api_slug);
  if (incoming === undefined || incoming.length === 0) {
    return validation(context, `The matching_attribute "${def.api_slug}" must be given a value in data.values.`);
  }
  const keys = new Set(incoming.map(entryKey));
  const matches = rows(context, object.api_slug, { bounded: true }).filter(
    (row) => Object.hasOwn(row.values, def.api_slug) && row.values[def.api_slug].some((entry) => keys.has(entryKey(entry))),
  );
  if (matches.length > 1) {
    return fail(context, "MULTIPLE_MATCH_RESULTS", `Multiple records match the value provided for matching_attribute "${def.api_slug}", so the record to update is ambiguous.`);
  }
  const touched = new Map();
  if (matches.length === 0) {
    const { row } = saveRecord(context, env, defsFor, object, null, updates, () => "append", touched);
    emitCreated(context, env, object, row.record_id);
    emitUpdates(context, env, touched);
    return { data: recordOut(env, object, defs, row) };
  }
  const { row } = saveRecord(context, env, defsFor, object, matches[0], updates, (slug) => (slug === def.api_slug ? "append" : "overwrite"), touched);
  emitUpdates(context, env, touched);
  return { data: recordOut(env, object, defs, row) };
}

export function recordsUpdate(input, context) {
  const env = begin(context, WRITE_SCOPES);
  const object = requireObject(context, input.object);
  const mode = modeOf(context, input.mode);
  const existing = requireRecord(context, object, input.record_id);
  const defsFor = defsCache(context);
  const raw = valuesPayload(context, input.data);
  if (Object.keys(raw).length === 0) {
    return validation(context, "You passed an empty payload. Please ensure you are updating at least one property in your request.");
  }
  const updates = coerceWrite(context, env, defsFor(object.api_slug), raw);
  const touched = new Map();
  const { row } = saveRecord(context, env, defsFor, object, existing, updates, () => mode, touched);
  emitUpdates(context, env, touched);
  return { data: recordOut(env, object, defsFor(object.api_slug), row) };
}

export function recordsDelete(input, context) {
  begin(context, WRITE_SCOPES);
  const object = requireObject(context, input.object);
  const row = requireRecord(context, object, input.record_id);
  const id = row.record_id;
  context.state.delete(object.api_slug, id);
  for (const slug of OBJECT_SLUGS) {
    for (const other of rows(context, slug, { bounded: true })) {
      let changed = false;
      const values = {};
      for (const [key, entries] of Object.entries(other.values)) {
        const kept = entries.filter((entry) => entry.target_record_id !== id);
        if (kept.length !== entries.length) changed = true;
        if (kept.length > 0) values[key] = kept;
      }
      if (changed) context.state.put(slug, other.record_id, { ...other, values });
    }
  }
  for (const entry of rows(context, "entries", { bounded: true })) {
    if (entry.parent_record_id === id) context.state.delete("entries", `${entry.list_id}/${entry.entry_id}`);
  }
  for (const note of rows(context, "notes", { bounded: true })) {
    if (note.parent_record_id === id) context.state.delete("notes", note.note_id);
  }
  for (const task of rows(context, "tasks", { bounded: true })) {
    const kept = task.linked_records.filter((link) => link.target_record_id !== id);
    if (kept.length !== task.linked_records.length) context.state.put("tasks", task.task_id, { ...task, linked_records: kept });
  }
  return {};
}

function firstName(values) {
  const entries = Object.hasOwn(values, "name") ? values.name : [];
  if (entries.length === 0) return "";
  return entries[0].full_name ?? (typeof entries[0].value === "string" ? entries[0].value : "");
}

function listOf(values, slug, field) {
  return (Object.hasOwn(values, slug) ? values[slug] : []).map((entry) => entry[field]).filter((value) => typeof value === "string");
}

export function recordsSearch(input, context) {
  const env = begin(context, READ_SCOPES);
  const { query } = input;
  if (typeof query !== "string" || query.length > 256) return validation(context, `"query" must be a string of at most 256 characters.`);
  if (query.includes("�")) return validation(context, `"query" contains an invalid character (U+FFFD).`);
  if (!Array.isArray(input.objects) || input.objects.length === 0 || input.objects.length > 3) {
    return validation(context, `"objects" must be an array of 1 to 3 object slugs or IDs.`);
  }
  const objects = [];
  for (const key of input.objects) {
    const object = requireObject(context, key);
    if (!objects.includes(object)) objects.push(object);
  }
  const requestAs = input.request_as;
  if (!isPlainObject(requestAs) || (requestAs.type !== "workspace" && requestAs.type !== "workspace-member")) {
    return validation(context, `"request_as" must be { "type": "workspace" } or { "type": "workspace-member", ... }.`);
  }
  if (requestAs.type === "workspace-member") {
    const id = requestAs.workspace_member_id;
    const email = requestAs.email_address;
    if (typeof id !== "string" && typeof email !== "string") {
      return validation(context, `"request_as" of type workspace-member needs workspace_member_id or email_address.`);
    }
    const member = typeof id === "string" ? (isUuid(id) ? context.state.get("workspace-members", id) : null) : findMemberByEmail(context, email);
    if (member === null) return valueNotFound(context, `Workspace member "${clip(String(id ?? email))}" not found.`);
  }
  const limit = integerParam(context, input.limit, "limit", { min: 1, max: 25, fallback: 25 });
  const tokens = words(query);
  const hits = [];
  for (const object of objects) {
    for (const row of rows(context, object.api_slug, { bounded: true })) {
      const name = firstName(row.values);
      const emails = listOf(row.values, "email_addresses", "email_address");
      const phones = listOf(row.values, "phone_numbers", "phone_number");
      const domains = listOf(row.values, "domains", "domain");
      const recordWords = [...words(name), ...emails.flatMap(words), ...domains.flatMap(words), ...phones.map((phone) => foldSearch(phone).replace("+", ""))];
      let score = 0;
      let matched = true;
      for (const token of tokens) {
        if (!recordWords.some((word) => word.startsWith(token))) {
          matched = false;
          break;
        }
        if (recordWords.includes(token)) score += 1;
      }
      if (!matched) continue;
      const item = {
        id: { workspace_id: env.ws.workspace_id, object_id: object.object_id, record_id: row.record_id },
        object_slug: object.api_slug,
        record_text: name,
        record_image: null,
      };
      if (object.api_slug === "people") {
        item.email_addresses = emails;
        item.phone_numbers = phones;
      } else if (object.api_slug === "companies") {
        item.domains = domains;
      }
      hits.push({ item, score, created_at: row.created_at });
    }
  }
  hits.sort((a, b) => b.score - a.score || compare(a.created_at, b.created_at) || compare(a.item.id.record_id, b.item.id.record_id));
  return { data: hits.slice(0, limit).map((hit) => hit.item) };
}

function findMemberByEmail(context, email) {
  const needle = email.trim().toLowerCase();
  if (needle.length === 0 || needle.length > 320) return null;
  return rows(context, "workspace-members").find((row) => row.email_address.toLowerCase() === needle) ?? null;
}
