// Who is calling: the integration (capabilities + visibility scope) and the attributed user. Resolved from
// the actor attributes `integrationId` / `userId` with the documented fallback (first integrations row).
import { normalizeId } from "./ids.mjs";
import { fail, notFound, restricted, shown, validationError } from "./state.mjs";

const INVALID_TOKEN = "The bearer token is not valid.";
const CONTENT_LEVELS = Object.freeze({ none: 0, read: 1, read_update: 2, read_update_insert: 3 });
const COMMENT_LEVELS = Object.freeze({ none: 0, read: 1, read_insert: 2 });

export function requireIdentity(context) {
  const attributes = context.actor.attributes ?? {};
  let integration = null;
  if (attributes.integrationId !== undefined) {
    const id = normalizeId(attributes.integrationId);
    integration = id === undefined ? null : context.state.get("integrations", id);
    if (integration === null) return fail(context, "UNAUTHORIZED", INVALID_TOKEN);
  } else {
    const first = context.state.scan("integrations", { limit: 1 });
    if (first.length === 0) return fail(context, "UNAUTHORIZED", INVALID_TOKEN);
    integration = first[0].value;
  }
  const bot = context.state.get("users", integration.bot_user_id);
  if (bot === null) return fail(context, "UNAUTHORIZED", INVALID_TOKEN);
  let user = bot;
  if (attributes.userId !== undefined) {
    const id = normalizeId(attributes.userId);
    const person = id === undefined ? null : context.state.get("users", id);
    if (person === null || person.type !== "person") return fail(context, "UNAUTHORIZED", INVALID_TOKEN);
    user = person;
  }
  return { integration, bot, user, capabilities: integration.capabilities, access: integration.access };
}

export function requireContent(context, identity, level) {
  if (CONTENT_LEVELS[identity.capabilities.content] >= CONTENT_LEVELS[level]) return;
  const verb = level === "read" ? "read" : level === "read_update" ? "update" : "insert";
  return restricted(context, `This integration does not have ${verb} content capabilities.`);
}

export function requireComments(context, identity, level) {
  if (COMMENT_LEVELS[identity.capabilities.comments] >= COMMENT_LEVELS[level]) return;
  const verb = level === "read" ? "read" : "insert";
  return restricted(context, `This integration does not have ${verb} comment capabilities.`);
}

export function requireUserInformation(context, identity) {
  if (identity.capabilities.user_information !== "none") return;
  return restricted(context, "This integration does not have user information capabilities.");
}

/** Ids from the object itself up to the workspace root (page → data source → database → page → …). */
export function ancestry(context, row) {
  const ids = [row.id];
  let parent = row.parent;
  for (let depth = 0; depth < 64 && parent !== undefined && parent !== null && parent.type !== "workspace"; depth += 1) {
    if (parent.type === "page_id") {
      const page = context.state.get("pages", parent.page_id);
      if (page === null) break;
      ids.push(page.id);
      parent = page.parent;
    } else if (parent.type === "block_id") {
      const block = context.state.get("blocks", parent.block_id);
      if (block === null) break;
      ids.push(block.id);
      parent = block.parent;
    } else if (parent.type === "data_source_id") {
      const source = context.state.get("data-sources", parent.data_source_id);
      if (source === null) break;
      ids.push(source.id);
      parent = source.parent;
    } else if (parent.type === "database_id") {
      const database = context.state.get("databases", parent.database_id);
      if (database === null) break;
      ids.push(database.id);
      parent = database.parent;
    } else {
      break;
    }
  }
  return ids;
}

export function isVisible(context, identity, row) {
  if (identity.access.type === "workspace") return true;
  const roots = identity.access.root_ids;
  return ancestry(context, row).some((id) => roots.includes(id));
}

/**
 * Validate an id parameter's shape the way Notion does (`path.page_id should be a valid uuid`). `name` may carry the
 * section the value came from (`body.parent.page_id`, `query.block_id`); a bare name is a path parameter, so the
 * message never claims a body or query value sat in the path.
 */
export function requireUuid(context, value, name) {
  const id = normalizeId(value);
  if (id === undefined) {
    const field = /^(path|body|query)\./.test(name) ? name : `path.${name}`;
    const section = field.slice(0, field.indexOf("."));
    return validationError(context, `${section} failed validation: ${field} should be a valid uuid, instead was \`${shown(value)}\`.`);
  }
  return id;
}

function load(context, identity, namespace, kind, value, name) {
  const id = requireUuid(context, value, name);
  const row = context.state.get(namespace, id);
  if (row === null || !isVisible(context, identity, row)) return notFound(context, kind, id);
  return row;
}

export const requirePage = (context, identity, value, name = "page_id") => load(context, identity, "pages", "page", value, name);
export const requireDatabase = (context, identity, value, name = "database_id") => load(context, identity, "databases", "database", value, name);
export const requireDataSource = (context, identity, value, name = "data_source_id") =>
  load(context, identity, "data-sources", "data-source", value, name);
export const requireBlockRow = (context, identity, value, name = "block_id") => load(context, identity, "blocks", "block", value, name);

/** A person or bot user visible to every integration (users are never scoped, only e-mails are). */
export function requireUser(context, value) {
  const id = requireUuid(context, value, "user_id");
  const row = context.state.get("users", id);
  if (row === null) return notFound(context, "user", id);
  return row;
}
