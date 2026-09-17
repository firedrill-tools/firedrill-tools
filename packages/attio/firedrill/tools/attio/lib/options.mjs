// Select options and statuses of one attribute (read-only schema reads used by record pickers and list boards).
import { visibleList } from "./access.mjs";
import { clip, fail, validation } from "./common.mjs";
import { begin, requireObject } from "./records.mjs";
import { loadDefs, resolveDef } from "./values.mjs";

function resolveAttribute(input, context, expectedType) {
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
  const def = resolveDef(defs, input.attribute);
  if (def === undefined) return fail(context, "NOT_FOUND", `Attribute with slug/ID "${clip(String(input.attribute))}" not found.`);
  if (def.type !== expectedType) {
    return validation(context, `Attribute with slug "${def.api_slug}" is of type "${def.type}", not "${expectedType}".`);
  }
  const showArchived = input.show_archived ?? false;
  if (typeof showArchived !== "boolean") return validation(context, `"show_archived" must be true or false.`);
  const id = (extra) => ({ workspace_id: env.ws.workspace_id, [parentField]: parentId, attribute_id: def.attribute_id, ...extra });
  return { def, showArchived, id };
}

export function selectOptionsList(input, context) {
  const { def, showArchived, id } = resolveAttribute(input, context, "select");
  const data = def.options
    .filter((option) => showArchived || !option.is_archived)
    .map((option) => ({ id: id({ option_id: option.option_id }), title: option.title, is_archived: option.is_archived }));
  return { data };
}

export function statusesList(input, context) {
  const { def, showArchived, id } = resolveAttribute(input, context, "status");
  const data = def.statuses
    .filter((status) => showArchived || !status.is_archived)
    .map((status) => ({
      id: id({ status_id: status.status_id }),
      title: status.title,
      is_archived: status.is_archived,
      celebration_enabled: status.celebration_enabled,
      target_time_in_status: status.target_time_in_status,
    }));
  return { data };
}
