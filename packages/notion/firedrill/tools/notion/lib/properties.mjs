// Data-source schemas and page property values: validation from request bodies, the stored form
// (definition `{id, name, type, config}`, value `{id, type, value}`) and Notion-shaped rendering.
import { nextShortId, normalizeId } from "./ids.mjs";
import { isDateString, normalizeRichText } from "./rich-text.mjs";
import { isMangled, mangledError, shown, validationError } from "./state.mjs";

export const PROPERTY_TYPES = Object.freeze([
  "title", "rich_text", "number", "select", "multi_select", "status", "date", "checkbox", "url", "email",
  "phone_number", "people", "relation", "created_time", "created_by", "last_edited_time", "last_edited_by",
]);
export const COMPUTED_TYPES = Object.freeze(["created_time", "created_by", "last_edited_time", "last_edited_by"]);
export const TEXT_TYPES = Object.freeze(["title", "rich_text", "url", "email", "phone_number"]);
export const LIST_ITEM_TYPES = Object.freeze(["title", "rich_text", "relation", "people"]);
export const OPTION_COLORS = Object.freeze(["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]);
const NUMBER_FORMATS = Object.freeze(["number", "number_with_commas", "percent", "dollar", "euro", "pound", "yen", "ruble", "rupee", "won", "yuan"]);
const DEFAULT_STATUS = Object.freeze([
  { name: "Not started", color: "default", group: "To-do" },
  { name: "In progress", color: "blue", group: "In progress" },
  { name: "Done", color: "green", group: "Complete" },
]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function emptyValue(type) {
  switch (type) {
    case "title":
    case "rich_text":
    case "multi_select":
    case "people":
    case "relation":
      return [];
    case "checkbox":
      return false;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Users (people values and created_by expansions share this rendering)
// ---------------------------------------------------------------------------------------------

export function renderUser(context, identity, row, partial = false) {
  if (partial || row === null) return { object: "user", id: row === null ? undefined : row.id };
  const user = { object: "user", id: row.id, name: row.name, avatar_url: row.avatar_url, type: row.type };
  if (row.type === "person") {
    user.person = identity.capabilities.user_information === "with_emails" && row.person !== null ? { email: row.person.email } : {};
  } else {
    user.bot = row.bot === null ? {} : row.bot;
  }
  return user;
}

/** Expanded user object, or the partial `{ object, id }` when the integration lacks user information. */
export function userReference(context, identity, id) {
  const row = context.state.get("users", id);
  if (row === null || identity.capabilities.user_information === "none") return { object: "user", id };
  return renderUser(context, identity, row);
}

// ---------------------------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------------------------

function detectType(value, allowed) {
  if (!isObject(value)) return undefined;
  if (typeof value.type === "string") return value.type;
  return allowed.find((type) => value[type] !== undefined);
}

function normalizeOptions(context, raw, path, existing = []) {
  if (raw === undefined) return existing.map((option) => ({ ...option }));
  if (!Array.isArray(raw)) return validationError(context, `body failed validation: body.${path}.options should be an array.`);
  const options = [];
  for (let index = 0; index < raw.length; index += 1) {
    const option = raw[index];
    if (!isObject(option) || typeof option.name !== "string" || option.name.trim().length === 0) {
      return validationError(context, `body failed validation: body.${path}.options[${index}].name should be a non-empty string.`);
    }
    if (option.name.includes(",")) return validationError(context, `body failed validation: body.${path}.options[${index}].name should not contain commas.`);
    if (options.some((known) => known.name === option.name)) {
      return validationError(context, `body failed validation: body.${path}.options should not contain duplicate names (${option.name}).`);
    }
    const color = option.color ?? "default";
    if (!OPTION_COLORS.includes(color)) return validationError(context, `body failed validation: body.${path}.options[${index}].color should be a valid option color, instead was \`${shown(color)}\`.`);
    const known = existing.find((candidate) => candidate.name === option.name || (typeof option.id === "string" && candidate.id === option.id));
    options.push({ id: known === undefined ? nextShortId(context) : known.id, name: option.name, color, description: null });
  }
  return options;
}

function statusConfig(context, raw, path, existing) {
  const seed = raw.options === undefined && existing === undefined ? DEFAULT_STATUS : undefined;
  const options = seed === undefined ? normalizeOptions(context, raw.options, path, existing?.options ?? []) : seed.map((option) => ({ id: nextShortId(context), name: option.name, color: option.color, description: null }));
  const groupNames = ["To-do", "In progress", "Complete"];
  const groups = groupNames.map((name, index) => ({
    id: existing?.groups?.[index]?.id ?? nextShortId(context),
    name,
    color: ["gray", "blue", "green"][index],
    option_ids: [],
  }));
  options.forEach((option, index) => {
    const seeded = seed === undefined ? undefined : seed[index].group;
    const previous = existing?.groups?.find((group) => group.option_ids.includes(option.id))?.name;
    const groupName = seeded ?? previous ?? (index === options.length - 1 && options.length > 1 ? "Complete" : "To-do");
    groups[groupNames.indexOf(groupName)].option_ids.push(option.id);
  });
  return { options, groups };
}

/** Validate one property definition from a request (`{ rich_text: {} }`, `{ select: { options } }`, …). */
function normalizeDefinition(context, name, raw, path, existing) {
  const type = detectType(raw, PROPERTY_TYPES);
  if (type === undefined || !PROPERTY_TYPES.includes(type)) {
    return validationError(context, `body failed validation: body.${path} should be an object with one supported property type (${PROPERTY_TYPES.join(", ")}).`);
  }
  const config = isObject(raw[type]) ? raw[type] : {};
  const id = existing?.id ?? (type === "title" ? "title" : nextShortId(context));
  switch (type) {
    case "number": {
      const format = config.format ?? "number";
      if (!NUMBER_FORMATS.includes(format)) return validationError(context, `body failed validation: body.${path}.number.format should be a valid number format, instead was \`${shown(format)}\`.`);
      return { id, name, type, config: { format } };
    }
    case "select":
    case "multi_select":
      return { id, name, type, config: { options: normalizeOptions(context, config.options, `${path}.${type}`, existing?.type === type ? existing.config.options : []) } };
    case "status":
      return { id, name, type, config: statusConfig(context, config, `${path}.status`, existing?.type === "status" ? existing.config : undefined) };
    case "relation": {
      const sourceId = normalizeId(config.data_source_id);
      const source = sourceId === undefined ? null : context.state.get("data-sources", sourceId);
      if (source === null) return validationError(context, `body failed validation: body.${path}.relation.data_source_id should be the id of an existing data source.`);
      return { id, name, type, config: { data_source_id: source.id, database_id: source.parent.database_id, type: "single_property", single_property: {} } };
    }
    default:
      return { id, name, type, config: {} };
  }
}

/**
 * `__proto__` cannot be an own key of the plain objects that hold schemas and page values (assigning it replaces the
 * object's prototype and the property silently disappears), so it is rejected with a validation error instead.
 */
function reservedName(context, path) {
  return validationError(context, `body failed validation: body.${path} uses the reserved property name __proto__.`);
}

/** The complete schema of a new data source; exactly one `title` property is required. */
export function normalizeSchema(context, raw, path) {
  if (!isObject(raw)) return validationError(context, `body failed validation: body.${path} should be an object.`);
  const properties = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name.trim().length === 0) return validationError(context, `body failed validation: body.${path} property names should be non-empty.`);
    if (name === "__proto__") return reservedName(context, `${path}.${name}`);
    properties[name] = normalizeDefinition(context, name, value, `${path}.${name}`);
  }
  const titles = Object.values(properties).filter((definition) => definition.type === "title");
  if (titles.length !== 1) return validationError(context, `body failed validation: body.${path} should contain exactly one property of type title, instead had ${titles.length}.`);
  return properties;
}

/** decodeURIComponent that never throws (undefined for malformed percent-encoding). */
function safeDecode(value) {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a `property_id` path parameter. Notion property ids are URL-encoded strings (e.g. `%3AUPp` for `:UPp`), and
 * clients either put that id in the path verbatim (the server's single path decode yields `:UPp`) or percent-encode it
 * again (`%253AUPp`, decoded once to `%3AUPp`). The framework has already decoded the segment once, so a property
 * matches when its name or id equals the value, or its id decodes to the value, or the value decodes (once, guarded)
 * to its name or id. Malformed percent-encoding never throws; it simply matches nothing.
 */
export function findPropertyById(properties, value) {
  const definitions = Object.values(properties);
  const candidates = [];
  for (const candidate of [value, upperEscapes(value), safeDecode(value), safeDecode(upperEscapes(value))]) {
    if (typeof candidate === "string" && !candidates.includes(candidate)) candidates.push(candidate);
  }
  for (const candidate of candidates) {
    const direct = findDefinition(properties, candidate);
    if (direct !== undefined) return direct;
  }
  return definitions.find((definition) => {
    if (typeof definition.id !== "string") return false;
    const decodedId = safeDecode(definition.id);
    const encodedId = upperEscapes(definition.id);
    return candidates.some((candidate) => candidate === decodedId || upperEscapes(candidate) === encodedId);
  });
}

/** Percent escapes with upper-case hexadecimal, so `%3a` and `%3A` name the same property id. */
function upperEscapes(value) {
  return typeof value === "string" ? value.replace(/%([0-9a-fA-F]{2})/g, (_, hex) => `%${hex.toUpperCase()}`) : value;
}

export function findDefinition(properties, nameOrId) {
  if (Object.hasOwn(properties, nameOrId)) return properties[nameOrId];
  return Object.values(properties).find((definition) => definition.id === nameOrId);
}

/**
 * Apply a `data-sources.update` properties patch: `null` removes, `{ name }` renames, a definition adds or
 * retypes. Returns the new schema and the list of changes to apply to the source's pages.
 */
export function applySchemaPatch(context, properties, patch) {
  if (!isObject(patch)) return validationError(context, "body failed validation: body.properties should be an object.");
  const next = { ...properties };
  const changes = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (key === "__proto__") return reservedName(context, `properties.${key}`);
    const current = findDefinition(next, key);
    if (raw === null) {
      if (current === undefined) return validationError(context, `${key} is not a property that exists.`);
      if (current.type === "title") return validationError(context, "The title property cannot be removed.");
      delete next[current.name];
      changes.push({ kind: "remove", name: current.name });
      continue;
    }
    if (!isObject(raw)) return validationError(context, `body failed validation: body.properties.${key} should be an object or null.`);
    const renamed = typeof raw.name === "string" ? raw.name : undefined;
    if (renamed === "__proto__") return reservedName(context, `properties.${key}.name`);
    const type = detectType(raw, PROPERTY_TYPES);
    if (current !== undefined && renamed !== undefined && type === undefined) {
      if (renamed.trim().length === 0) return validationError(context, `body failed validation: body.properties.${key}.name should be non-empty.`);
      if (renamed !== current.name && findDefinition(next, renamed) !== undefined) return validationError(context, `A property named ${renamed} already exists.`);
      delete next[current.name];
      next[renamed] = { ...current, name: renamed };
      changes.push({ kind: "rename", from: current.name, to: renamed });
      continue;
    }
    if (type === undefined) return validationError(context, `body failed validation: body.properties.${key} should be a property definition, a rename ({ name }) or null.`);
    if (current === undefined) {
      if (type === "title") return validationError(context, "A data source can only have one title property.");
      const definition = normalizeDefinition(context, key, raw, `properties.${key}`);
      next[key] = definition;
      changes.push({ kind: "add", name: key, definition });
      continue;
    }
    if (current.type === "title" && type !== "title") return validationError(context, "The title property cannot change its type.");
    if (type === "title" && current.type !== "title") return validationError(context, "A data source can only have one title property.");
    const definition = normalizeDefinition(context, renamed ?? current.name, raw, `properties.${key}`, current);
    delete next[current.name];
    next[definition.name] = definition;
    if (renamed !== undefined && renamed !== current.name) changes.push({ kind: "rename", from: current.name, to: renamed });
    if (current.type !== type) changes.push({ kind: "retype", name: definition.name, definition });
    else changes.push({ kind: "reconfigure", name: definition.name, definition });
  }
  return { properties: next, changes };
}

export function renderSchema(properties) {
  const rendered = {};
  for (const [name, definition] of Object.entries(properties)) {
    rendered[name] = { id: definition.id, name, type: definition.type, description: null, [definition.type]: definition.config };
  }
  return rendered;
}

/**
 * The `properties` of a page of this schema rendered at its largest before any value is set: empty values, the
 * fixed-width timestamp for created_time / last_edited_time and `widestUser` for created_by / last_edited_by.
 */
export function renderSchemaPageShape(properties, widestUser) {
  const rendered = {};
  for (const [name, definition] of Object.entries(properties)) {
    const type = definition.type;
    let value = emptyValue(type);
    if (type === "created_time" || type === "last_edited_time") value = "0000-00-00T00:00:00.000Z";
    else if (type === "created_by" || type === "last_edited_by") value = widestUser;
    const entry = { id: definition.id, type, [type]: value };
    if (type === "relation") entry.has_more = false;
    rendered[name] = entry;
  }
  return rendered;
}

// ---------------------------------------------------------------------------------------------
// Page property values
// ---------------------------------------------------------------------------------------------

function optionByRef(options, ref) {
  if (!isObject(ref)) return undefined;
  if (typeof ref.id === "string") return options.find((option) => option.id === ref.id);
  if (typeof ref.name === "string") return options.find((option) => option.name === ref.name);
  return undefined;
}

/** Validate one page property value; may add select options (returns `{ value, definition }`). */
function normalizeValue(context, definition, raw, name) {
  const type = definition.type;
  if (COMPUTED_TYPES.includes(type)) return validationError(context, `Cannot update property "${name}" of type ${type}: it is computed by the workspace.`);
  // Notion accepts the bare rich text array for title / rich_text values (`properties: { title: [...] }`).
  if (Array.isArray(raw) && (type === "title" || type === "rich_text")) raw = { [type]: raw };
  if (!isObject(raw)) return validationError(context, `${name} is expected to be ${type}.`);
  const given = detectType(raw, PROPERTY_TYPES);
  const value = given === undefined ? undefined : raw[given];
  if (given !== type && !(type === "title" && given === "rich_text")) return validationError(context, `${name} is expected to be ${type}.`);
  const expected = (condition, message) => (condition ? undefined : validationError(context, `body failed validation: body.properties.${name}.${type} ${message}`));
  switch (type) {
    case "title":
    case "rich_text":
      return { value: normalizeRichText(context, value, `properties.${name}.${type}`), definition };
    case "number":
      expected(value === null || (typeof value === "number" && Number.isFinite(value)), "should be a number or null.");
      return { value, definition };
    case "checkbox":
      expected(typeof value === "boolean", "should be a boolean.");
      return { value, definition };
    case "url":
    case "email":
    case "phone_number":
      expected(value === null || typeof value === "string", "should be a string or null.");
      return { value: value === "" ? null : value, definition };
    case "date": {
      if (value === null) return { value: null, definition };
      expected(isObject(value) && isDateString(value.start), "should be an object with a valid ISO 8601 `start`, or null.");
      expected(value.end === undefined || value.end === null || isDateString(value.end), "should have a valid ISO 8601 `end` or null.");
      return { value: { start: value.start, end: value.end ?? null, time_zone: typeof value.time_zone === "string" ? value.time_zone : null }, definition };
    }
    case "select": {
      if (value === null) return { value: null, definition };
      expected(isObject(value) && (typeof value.name === "string" || typeof value.id === "string"), "should be an object with `name` or `id`, or null.");
      const known = optionByRef(definition.config.options, value);
      if (known !== undefined) return { value: { id: known.id, name: known.name, color: known.color }, definition };
      if (typeof value.name !== "string" || value.name.trim().length === 0) return validationError(context, `Select option with id ${shown(value.id)} does not exist on property ${name}.`);
      if (value.name.includes(",")) return validationError(context, `body failed validation: body.properties.${name}.select.name should not contain commas.`);
      const option = { id: nextShortId(context), name: value.name, color: OPTION_COLORS.includes(value.color) ? value.color : "default", description: null };
      const updated = { ...definition, config: { options: [...definition.config.options, option] } };
      return { value: { id: option.id, name: option.name, color: option.color }, definition: updated };
    }
    case "multi_select": {
      expected(Array.isArray(value), "should be an array.");
      let updated = definition;
      const values = [];
      for (const item of value) {
        expected(isObject(item) && (typeof item.name === "string" || typeof item.id === "string"), "items should be objects with `name` or `id`.");
        const known = optionByRef(updated.config.options, item);
        if (known !== undefined) {
          if (!values.some((existing) => existing.id === known.id)) values.push({ id: known.id, name: known.name, color: known.color });
          continue;
        }
        if (typeof item.name !== "string" || item.name.trim().length === 0) return validationError(context, `Multi-select option with id ${shown(item.id)} does not exist on property ${name}.`);
        if (item.name.includes(",")) return validationError(context, `body failed validation: body.properties.${name}.multi_select names should not contain commas.`);
        const option = { id: nextShortId(context), name: item.name, color: OPTION_COLORS.includes(item.color) ? item.color : "default", description: null };
        updated = { ...updated, config: { options: [...updated.config.options, option] } };
        values.push({ id: option.id, name: option.name, color: option.color });
      }
      return { value: values, definition: updated };
    }
    case "status": {
      if (value === null) return { value: null, definition };
      expected(isObject(value) && (typeof value.name === "string" || typeof value.id === "string"), "should be an object with `name` or `id`, or null.");
      const known = optionByRef(definition.config.options, value);
      if (known === undefined) return validationError(context, `Status option ${JSON.stringify(value.name ?? value.id)} does not exist on property ${name}. Status options cannot be created through the API.`);
      return { value: { id: known.id, name: known.name, color: known.color }, definition };
    }
    case "people": {
      expected(Array.isArray(value), "should be an array of user references.");
      const users = [];
      for (const item of value) {
        const id = isObject(item) ? normalizeId(item.id) : undefined;
        const user = id === undefined ? null : context.state.get("users", id);
        if (user === null) return validationError(context, `body failed validation: body.properties.${name}.people should reference existing users, instead had \`${JSON.stringify(item)}\`.`);
        if (!users.some((existing) => existing.id === user.id)) users.push({ object: "user", id: user.id });
      }
      return { value: users, definition };
    }
    case "relation": {
      expected(Array.isArray(value), "should be an array of page references.");
      const pages = [];
      for (const item of value) {
        const id = isObject(item) ? normalizeId(item.id) : undefined;
        const page = id === undefined ? null : context.state.get("pages", id);
        const valid = page !== null && page.parent.type === "data_source_id" && page.parent.data_source_id === definition.config.data_source_id;
        if (!valid) return validationError(context, `body failed validation: body.properties.${name}.relation should reference pages of the related data source, instead had \`${JSON.stringify(item)}\`.`);
        if (!pages.some((existing) => existing.id === page.id)) pages.push({ id: page.id });
      }
      return { value: pages, definition };
    }
    default:
      return validationError(context, `${name} is expected to be ${type}.`);
  }
}

/**
 * Validate the `properties` of a create/update against a schema. Returns the values to store (only the
 * given ones on update, every property on create) and the possibly extended schema.
 */
export function normalizePropertyValues(context, properties, raw, { create }) {
  if (raw === undefined) return { values: {}, properties, changed: false };
  if (!isObject(raw)) return validationError(context, "body failed validation: body.properties should be an object.");
  let schema = properties;
  let changed = false;
  const values = {};
  for (const [key, value] of Object.entries(raw)) {
    const definition = findDefinition(schema, key);
    if (definition === undefined) return validationError(context, `${key} is not a property that exists.`);
    if (value === null) {
      if (definition.type === "title") return validationError(context, "body failed validation: body.properties.title should be an array of rich text objects, instead was null.");
      values[definition.name] = { id: definition.id, type: definition.type, value: emptyValue(definition.type) };
      continue;
    }
    const result = normalizeValue(context, definition, value, definition.name);
    if (result.definition !== definition) {
      schema = { ...schema, [definition.name]: result.definition };
      changed = true;
    }
    values[definition.name] = { id: definition.id, type: definition.type, value: result.value };
  }
  if (create) {
    for (const definition of Object.values(schema)) {
      if (COMPUTED_TYPES.includes(definition.type) || values[definition.name] !== undefined) continue;
      values[definition.name] = { id: definition.id, type: definition.type, value: emptyValue(definition.type) };
    }
  }
  return { values, properties: schema, changed };
}

/** The value a page holds for a definition, computed for the read-only timestamp/user types. */
export function propertyValue(page, definition) {
  switch (definition.type) {
    case "created_time":
      return page.created_time;
    case "last_edited_time":
      return page.last_edited_time;
    case "created_by":
      return page.created_by;
    case "last_edited_by":
      return page.last_edited_by;
    default: {
      const stored = page.properties[definition.name];
      return stored === undefined ? emptyValue(definition.type) : stored.value;
    }
  }
}

function renderValue(context, identity, type, value) {
  switch (type) {
    case "people":
      return value.map((user) => userReference(context, identity, user.id));
    case "created_by":
    case "last_edited_by":
      return userReference(context, identity, value.id);
    default:
      return value;
  }
}

/** Schema definitions of a page: the data source's for database pages, the implicit `title` otherwise. */
export function definitionsOf(context, page) {
  if (page.parent.type === "data_source_id") {
    const source = context.state.get("data-sources", page.parent.data_source_id);
    if (source !== null) return source.properties;
  }
  return { title: { id: "title", name: "title", type: "title", config: {} } };
}

export function renderPageProperties(context, identity, page, filterIds) {
  const definitions = definitionsOf(context, page);
  const rendered = {};
  for (const definition of Object.values(definitions)) {
    if (filterIds !== undefined && !filterIds.includes(definition.id)) continue;
    const value = propertyValue(page, definition);
    const entry = { id: definition.id, type: definition.type, [definition.type]: renderValue(context, identity, definition.type, value) };
    if (definition.type === "relation") entry.has_more = false;
    rendered[definition.name] = entry;
  }
  return rendered;
}

/**
 * Resolve `filter_properties` (ids or names) to property ids. `field` is the label the call site uses in messages
 * (`query.filter_properties` on both routes, where Notion documents the parameter), the same convention as `pageSize`
 * and the uuid checks. The declared input schema already refuses a non-array, so the array check is defensive.
 */
export function validateFilterProperties(context, definitions, filterProperties, field = "query.filter_properties") {
  if (filterProperties === undefined) return undefined;
  const section = field.split(".")[0];
  if (!Array.isArray(filterProperties)) return validationError(context, `${section} failed validation: ${field} should be an array of property ids.`);
  const ids = [];
  for (const id of filterProperties) {
    if (isMangled(id)) return mangledError(context, field);
    const definition = findDefinition(definitions, String(id));
    if (definition === undefined) return validationError(context, `Could not find property with name or id: ${shown(id)}`);
    ids.push(definition.id);
  }
  return ids;
}

/** `pages.retrieve-property`: paginated item lists for title/rich_text/relation/people, one object otherwise. */
export function propertyItems(context, identity, page, definition) {
  const value = propertyValue(page, definition);
  const type = definition.type;
  if (!LIST_ITEM_TYPES.includes(type)) {
    return { list: false, item: { object: "property_item", id: definition.id, type, [type]: renderValue(context, identity, type, value) } };
  }
  const items = value.map((element) => ({
    object: "property_item",
    id: definition.id,
    type,
    [type]: type === "people" ? userReference(context, identity, element.id) : element,
  }));
  return { list: true, items };
}
