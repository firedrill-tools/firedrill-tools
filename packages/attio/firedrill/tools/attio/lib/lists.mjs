// Objects, attribute definitions, lists and list entries.
import { requireListWrite, listLevel, visibleList } from "./access.mjs";
import { compileFilter, compileSorts } from "./filter.mjs";
import { PAGE_BYTES, clip, compare, encodedSize, fail, integerParam, isPlainObject, isUuid, nextId, notFound, rows, validation } from "./common.mjs";
import { begin, recordView, requireObject } from "./records.mjs";
import { OBJECT_SLUGS, coerceWrite, expandValues, loadDefs, mergeValues } from "./values.mjs";

const ENTRY_READ = ["list_entry:read", "list_configuration:read"];
const ENTRY_WRITE = ["list_entry:read-write", "list_configuration:read"];

export function objectsList(_input, context) {
  const env = begin(context, ["object_configuration:read"]);
  // The three standard objects are read by slug: no scan, so the scan bound never applies here.
  const data = OBJECT_SLUGS.map((slug) => context.state.get("objects", slug))
    .filter((object) => object !== null)
    .sort((a, b) => compare(a.created_at, b.created_at) || compare(a.object_id, b.object_id))
    .map((object) => ({
      id: { workspace_id: env.ws.workspace_id, object_id: object.object_id },
      api_slug: object.api_slug,
      singular_noun: object.singular_noun,
      plural_noun: object.plural_noun,
      created_at: object.created_at,
    }));
  return { data };
}

function attributeOut(env, parentField, parentId, def) {
  return {
    id: { workspace_id: env.ws.workspace_id, [parentField]: parentId, attribute_id: def.attribute_id },
    title: def.title,
    description: def.description,
    api_slug: def.api_slug,
    type: def.type,
    is_system_attribute: def.is_system_attribute,
    is_writable: def.is_writable,
    is_required: def.is_required,
    is_unique: def.is_unique,
    is_multiselect: def.is_multiselect,
    is_default_value_enabled: def.is_default_value_enabled,
    is_archived: def.is_archived,
    default_value: def.default_value,
    relationship: def.relationship,
    created_at: def.created_at,
    config: def.config,
  };
}

export function attributesList(input, context) {
  let env;
  let defs;
  let parentField;
  let parentId;
  if (input.target === "lists") {
    env = begin(context, ["list_configuration:read"]);
    const list = visibleList(context, env.who, input.identifier);
    defs = loadDefs(context, "lists", list.api_slug);
    parentField = "list_id";
    parentId = list.list_id;
  } else if (input.target === "objects") {
    env = begin(context, ["object_configuration:read"]);
    const object = requireObject(context, input.identifier);
    defs = loadDefs(context, "objects", object.api_slug);
    parentField = "object_id";
    parentId = object.object_id;
  } else {
    return validation(context, `"target" must be "objects" or "lists".`);
  }
  const limit = integerParam(context, input.limit, "limit", { min: 1, max: 500, fallback: 500 });
  const offset = integerParam(context, input.offset, "offset", { min: 0, max: 1_000_000_000, fallback: 0 });
  const showArchived = input.show_archived ?? false;
  if (typeof showArchived !== "boolean") return validation(context, `"show_archived" must be true or false.`);
  const data = defs.list
    .filter((def) => showArchived || !def.is_archived)
    .slice(offset, offset + limit)
    .map((def) => attributeOut(env, parentField, parentId, def));
  return { data };
}

function listOut(env, list) {
  return {
    id: { workspace_id: env.ws.workspace_id, list_id: list.list_id },
    api_slug: list.api_slug,
    name: list.name,
    parent_object: list.parent_object,
    workspace_access: list.workspace_access,
    workspace_member_access: list.workspace_member_access,
    created_by_actor: list.created_by_actor,
    created_at: list.created_at,
  };
}

export function listsList(_input, context) {
  const env = begin(context, ["list_configuration:read"]);
  const data = rows(context, "lists", { bounded: true })
    .filter((list) => listLevel(env.who, list) !== null)
    .sort((a, b) => compare(a.created_at, b.created_at) || compare(a.list_id, b.list_id))
    .map((list) => listOut(env, list));
  return { data };
}

function entryOut(env, list, defs, row) {
  return {
    id: { workspace_id: env.ws.workspace_id, list_id: list.list_id, entry_id: row.entry_id },
    parent_record_id: row.parent_record_id,
    parent_object: row.parent_object,
    created_at: row.created_at,
    entry_values: expandValues({ workspaceId: env.ws.workspace_id, parentField: "list_id", parentId: list.list_id }, defs, row, row.entry_values),
  };
}

function parentObjectOf(context, list) {
  const object = context.state.get("objects", list.parent_object[0]);
  if (object === null) return notFound(context, `Object with slug/ID "${clip(String(list.parent_object[0]))}" not found.`);
  return object;
}

export function entriesQuery(input, context) {
  const env = begin(context, ENTRY_READ);
  const list = visibleList(context, env.who, input.list);
  const defs = loadDefs(context, "lists", list.api_slug);
  const parentObject = parentObjectOf(context, list);
  const parentDefs = loadDefs(context, "objects", parentObject.api_slug);
  const limit = integerParam(context, input.limit, "limit", { min: 1, max: 500, fallback: 500 });
  const offset = integerParam(context, input.offset, "offset", { min: 0, max: 1_000_000_000, fallback: 0 });
  const predicate = compileFilter(context, input.filter, {
    defs,
    systemFields: false,
    listSlug: list.api_slug,
    path: (key) => (key === parentObject.api_slug || key === parentObject.object_id ? parentDefs : undefined),
  });
  const comparator = compileSorts(context, input.sorts, defs, false);
  const parents = new Map();
  const parentView = (id) => {
    if (!parents.has(id)) {
      const record = context.state.get(parentObject.api_slug, id);
      parents.set(id, record === null ? null : recordView(record));
    }
    return parents.get(id);
  };
  const matched = rows(context, "entries", { prefix: `${list.list_id}/`, bounded: true })
    .map((row) => ({
      row,
      view: { id: row.entry_id, created_at: row.created_at, created_by_actor: row.created_by_actor, values: row.entry_values, parent: () => parentView(row.parent_record_id) },
    }))
    .filter((item) => predicate(item.view))
    .sort((a, b) => comparator(a.view, b.view));
  const result = { data: matched.slice(offset, offset + limit).map((item) => entryOut(env, list, defs, item.row)) };
  if (encodedSize(result) > PAGE_BYTES) return fail(context, "FAILED_PRECONDITION", "Response too large; lower limit");
  return result;
}

function requireEntry(context, list, entryId) {
  const row = isUuid(entryId) ? context.state.get("entries", `${list.list_id}/${entryId}`) : null;
  if (row === null) return notFound(context, `Entry with ID "${clip(String(entryId))}" not found.`);
  return row;
}

export function entriesCreate(input, context) {
  const env = begin(context, ENTRY_WRITE);
  const list = visibleList(context, env.who, input.list);
  requireListWrite(context, env.who, list);
  const data = input.data;
  if (!isPlainObject(data)) return validation(context, `Expected "data" to be an object with parent_record_id, parent_object and entry_values.`);
  const parentObject = parentObjectOf(context, list);
  if (data.parent_object !== parentObject.api_slug && data.parent_object !== parentObject.object_id) {
    return validation(context, `Parent object "${clip(String(data.parent_object))}" does not match the list's parent object "${parentObject.api_slug}".`);
  }
  const parent = isUuid(data.parent_record_id) ? context.state.get(parentObject.api_slug, data.parent_record_id) : null;
  if (parent === null) return notFound(context, `Record with ID "${clip(String(data.parent_record_id))}" not found.`);
  const rawValues = data.entry_values ?? {};
  if (!isPlainObject(rawValues)) return validation(context, `Expected "data.entry_values" to be an object of attribute values.`);
  const defs = loadDefs(context, "lists", list.api_slug);
  const updates = coerceWrite(context, env, defs, rawValues);
  const { values } = mergeValues(defs, {}, updates, () => "append");
  const entryId = nextId(context, "00000006");
  const row = {
    entry_id: entryId,
    list_id: list.list_id,
    parent_object: parentObject.api_slug,
    parent_record_id: parent.record_id,
    created_at: env.now,
    created_by_actor: env.actor,
    entry_values: values,
  };
  context.state.put("entries", `${list.list_id}/${entryId}`, row);
  context.events.emit("list-entry.created", {
    id: { workspace_id: env.ws.workspace_id, list_id: list.list_id, entry_id: entryId },
    parent_object_id: parentObject.object_id,
    parent_record_id: parent.record_id,
    actor: env.actor,
  });
  return { data: entryOut(env, list, defs, row) };
}

export function entriesGet(input, context) {
  const env = begin(context, ENTRY_READ);
  const list = visibleList(context, env.who, input.list);
  const row = requireEntry(context, list, input.entry_id);
  return { data: entryOut(env, list, loadDefs(context, "lists", list.api_slug), row) };
}

export function entriesUpdate(input, context) {
  const env = begin(context, ENTRY_WRITE);
  const list = visibleList(context, env.who, input.list);
  requireListWrite(context, env.who, list);
  const existing = requireEntry(context, list, input.entry_id);
  if (input.mode !== "append" && input.mode !== "overwrite") return validation(context, `Invalid update mode "${clip(String(input.mode))}".`);
  const data = input.data;
  if (!isPlainObject(data) || !isPlainObject(data.entry_values)) return validation(context, `Expected "data.entry_values" to be an object of attribute values.`);
  if (Object.keys(data.entry_values).length === 0) {
    return validation(context, "You passed an empty payload. Please ensure you are updating at least one property in your request.");
  }
  const defs = loadDefs(context, "lists", list.api_slug);
  const updates = coerceWrite(context, env, defs, data.entry_values);
  const { values } = mergeValues(defs, existing.entry_values, updates, () => input.mode);
  for (const [slug, entries] of Object.entries(values)) {
    if (entries.length > 1_000) return validation(context, `Attribute with slug "${slug}" cannot hold more than 1000 values.`);
  }
  const row = { ...existing, entry_values: values };
  context.state.put("entries", `${list.list_id}/${existing.entry_id}`, row);
  return { data: entryOut(env, list, defs, row) };
}

export function entriesDelete(input, context) {
  const env = begin(context, ENTRY_WRITE);
  const list = visibleList(context, env.who, input.list);
  requireListWrite(context, env.who, list);
  const existing = requireEntry(context, list, input.entry_id);
  context.state.delete("entries", `${list.list_id}/${existing.entry_id}`);
  return {};
}
