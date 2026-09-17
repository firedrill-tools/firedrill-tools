// Synthetic Notion workspace. Every operation computes from context.state: ids come from the
// `meta/counters` row, timestamps from the virtual clock, visibility and capabilities from the calling
// integration. Nothing here contacts Notion; no notification, e-mail or webhook is ever sent.
import {
  APPENDABLE_BLOCK_TYPES,
  CONTAINER_TYPES,
  blockTree,
  childrenOf,
  createBlocks,
  descendantIds,
  indexBlocks,
  nextPosition,
  placeInOrder,
  removeBlockRow,
  addBlockRow,
  normalizeBlockInputs,
  normalizeContent,
  pageOfBlock,
  blockLevel,
  requestDepth,
  MAX_TREE_LEVELS,
  parentKey,
  setBlockTrashed,
  setDataSourceTrashed,
  setPageTrashed,
  touchPage,
} from "./lib/blocks.mjs";
import {
  ancestry,
  isVisible,
  requireBlockRow,
  requireComments,
  requireContent,
  requireDataSource,
  requireDatabase,
  requireIdentity,
  requirePage,
  requireUser,
  requireUserInformation,
  requireUuid,
} from "./lib/identity.mjs";
import { nextId } from "./lib/ids.mjs";
import { parseMarkdown, renderMarkdown } from "./lib/markdown.mjs";
import {
  COMPUTED_TYPES,
  definitionsOf,
  emptyValue,
  findDefinition,
  findPropertyById,
  normalizePropertyValues,
  normalizeSchema,
  applySchemaPatch,
  propertyItems,
  renderSchema,
  renderSchemaPageShape,
  validateFilterProperties,
} from "./lib/properties.mjs";
import { compileFilter, compileSorts } from "./lib/query.mjs";
import { listResponse, renderBlock, renderComment, renderDataSource, renderDatabase, renderPage, renderUser } from "./lib/render.mjs";
import { normalizeRichText, plainText } from "./lib/rich-text.mjs";
import { jsonBytes, SCHEMA_BUDGET_BYTES, SCHEMA_PAGE_BUDGET_BYTES, utf8Length } from "./lib/size.mjs";
import { allRows, isMangled, isoNow, limits, mangledError, notFound, pageSize, paginate, shown, sized, validationError, withinBudget } from "./lib/state.mjs";
import { defined, encodeOutcome, intOrRaw, jsonBody, list, operationInput, str } from "./lib/wire.mjs";

const TRASHED_EDIT = "Can't edit block that is archived. You must unarchive the block before editing.";
const MARKDOWN_TYPES = ["replace_content", "update_content", "insert_content"];

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Mutable copies of every block row, indexed by id and by parent for the duration of one operation. */
function blockRows(context) {
  return indexBlocks(allRows(context, "blocks").map((row) => ({ ...row })));
}

/** Most `content_updates` entries one update_content request may carry. */
const MAX_CONTENT_UPDATES = 100;

/** Offsets of `needle` in `text` (non-overlapping, left to right), stopping once `limit` are found. */
function occurrencesOf(text, needle, limit) {
  const found = [];
  let from = 0;
  while (found.length < limit) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    found.push(at);
    from = at + needle.length;
  }
  return found;
}

/** Literal replacement at known offsets (no `$&`-style patterns, one join). */
function replaceAt(text, offsets, needleLength, replacement) {
  const parts = [];
  let last = 0;
  for (const at of offsets) {
    parts.push(text.slice(last, at), replacement);
    last = at + needleLength;
  }
  parts.push(text.slice(last));
  return parts.join("");
}

function author(identity) {
  return { object: "user", id: identity.user.id };
}

function parentInfo(context, parent) {
  if (parent.type === "workspace") {
    const workspace = context.state.get("workspace", "workspace");
    return { parent_type: "workspace", parent_id: workspace === null ? "workspace" : workspace.id };
  }
  return { parent_type: parent.type, parent_id: parentKey(parent) };
}

function icon(context, value, path) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (isObject(value) && value.type === "emoji" && typeof value.emoji === "string" && value.emoji.length > 0) return { type: "emoji", emoji: value.emoji };
  if (isObject(value) && (value.type === "external" || value.external !== undefined) && isObject(value.external) && typeof value.external.url === "string") {
    return { type: "external", external: { url: value.external.url } };
  }
  return validationError(context, `body failed validation: body.${path} should be an emoji ({ type: "emoji", emoji }) or an external image ({ type: "external", external: { url } }), or null.`);
}

function cover(context, value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (isObject(value) && (value.type === "external" || value.external !== undefined) && isObject(value.external) && typeof value.external.url === "string") {
    return { type: "external", external: { url: value.external.url } };
  }
  return validationError(context, 'body failed validation: body.cover should be an external image ({ type: "external", external: { url } }) or null.');
}

/** Resolve the `parent` object of a create/move request into a target page or data source row. */
function resolveParent(context, identity, parent, { allowDatabase }) {
  if (!isObject(parent)) return validationError(context, "body failed validation: body.parent should be an object.");
  if (parent.type === "workspace" || parent.workspace === true) {
    return validationError(context, "body failed validation: body.parent.type should be \"page_id\" or \"data_source_id\" (integrations cannot create pages at the workspace root).");
  }
  if (parent.page_id !== undefined) {
    const page = requirePage(context, identity, parent.page_id, "body.parent.page_id");
    if (page.in_trash) return validationError(context, "Can't create or move content under a page that is in the trash.");
    return { kind: "page", row: page };
  }
  if (parent.data_source_id !== undefined) {
    const source = requireDataSource(context, identity, parent.data_source_id, "body.parent.data_source_id");
    if (source.in_trash) return validationError(context, "Can't create or move content in a data source that is in the trash.");
    return { kind: "data_source", row: source };
  }
  if (allowDatabase && parent.database_id !== undefined) {
    const database = requireDatabase(context, identity, parent.database_id, "body.parent.database_id");
    if (database.in_trash) return validationError(context, "Can't create content in a database that is in the trash.");
    const source = context.state.get("data-sources", database.data_source_ids[0]);
    if (source === null) return notFound(context, "database", database.id);
    return { kind: "data_source", row: source };
  }
  return validationError(context, `body failed validation: body.parent should contain page_id${allowDatabase ? ", data_source_id or database_id" : " or data_source_id"}.`);
}

function titlePlainOf(values, definitions) {
  const title = Object.values(definitions).find((definition) => definition.type === "title");
  const stored = title === undefined ? undefined : values[title.name];
  return stored === undefined ? "" : plainText(stored.value);
}

/** Stored values for a plain (non-database) page: only `title` exists. */
function plainPageValues(context, raw) {
  const definitions = { title: { id: "title", name: "title", type: "title", config: {} } };
  return normalizePropertyValues(context, definitions, raw, { create: true }).values;
}

function persistSchema(context, source, properties, now, identity) {
  checkSchema(context, properties);
  const updated = { ...source, properties, last_edited_time: now, last_edited_by: author(identity) };
  context.state.put("data-sources", source.id, updated);
  return updated;
}

/**
 * A schema is bounded twice: by its own rendering, and by the most it adds to the rendering of each page of its data
 * source. Pages are size-checked when written, so without the second bound a later schema change (say many
 * created_by properties, which render an expanded user in every page) could push stored pages and whole query or
 * search pages past the response limit for good.
 */
function checkSchema(context, properties) {
  const shape = renderSchemaPageShape(properties, widestUser(context));
  const pageBytes = jsonBytes(shape);
  if (pageBytes > SCHEMA_PAGE_BUDGET_BYTES) {
    return validationError(
      context,
      `body failed validation: the data source schema would add ${pageBytes} bytes to the rendering of each of its pages; the limit is ${SCHEMA_PAGE_BUDGET_BYTES} bytes.`,
    );
  }
  withinBudget(context, renderSchema(properties), "the data source schema", SCHEMA_BUDGET_BYTES);
}

/** The largest expanded user object any integration could be shown (with emails). */
function widestUser(context) {
  const reader = { capabilities: { user_information: "with_emails" } };
  let widest = { object: "user", id: "00000000-0000-0000-0000-000000000000" };
  let widestBytes = jsonBytes(widest);
  for (const row of allRows(context, "users")) {
    const rendered = renderUser(context, reader, row);
    const bytes = jsonBytes(rendered);
    if (bytes > widestBytes) {
      widest = rendered;
      widestBytes = bytes;
    }
  }
  return widest;
}

/** Re-key the values of every page of a data source after a schema patch. */
function applyChangesToPages(context, source, changes) {
  if (changes.length === 0) return;
  for (const page of allRows(context, "pages")) {
    if (page.parent.type !== "data_source_id" || page.parent.data_source_id !== source.id) continue;
    const values = { ...page.properties };
    let changed = false;
    for (const change of changes) {
      if (change.kind === "remove") delete values[change.name];
      else if (change.kind === "rename") {
        if (values[change.from] !== undefined) {
          values[change.to] = values[change.from];
          delete values[change.from];
        }
      } else if (change.kind === "retype") {
        values[change.name] = { id: change.definition.id, type: change.definition.type, value: emptyValue(change.definition.type) };
      } else if (change.kind === "add") {
        if (!COMPUTED_TYPES.includes(change.definition.type)) values[change.name] = { id: change.definition.id, type: change.definition.type, value: emptyValue(change.definition.type) };
      } else if (change.kind === "reconfigure") {
        const current = values[change.name];
        const options = change.definition.config.options;
        if (current !== undefined && options !== undefined) {
          if (current.type === "multi_select") values[change.name] = { ...current, value: current.value.filter((item) => options.some((option) => option.id === item.id)) };
          else if (current.value !== null && !options.some((option) => option.id === current.value.id)) values[change.name] = { ...current, value: null };
        }
      }
    }
    // Computed-type adds and option-preserving reconfigures leave a page as it was: do not rewrite it.
    const keys = Object.keys(values);
    changed = keys.length !== Object.keys(page.properties).length || keys.some((key) => values[key] !== page.properties[key]);
    if (changed) context.state.put("pages", page.id, { ...page, properties: values });
  }
}

function contentUpdated(context, identity, pageId, blockIds) {
  context.events.emit("page.content_updated", { entity_id: pageId, updated_blocks: blockIds, author_id: identity.user.id });
}

/** Set the order of a page's live top-level blocks to `orderedIds` (others keep their relative order after). */
function arrangeChildren(context, rows, parentId, orderedIds) {
  const siblings = childrenOf(rows, parentId);
  const byId = new Map(siblings.map((block) => [block.id, block]));
  const wanted = new Set(orderedIds);
  const ordered = [];
  for (const id of wanted) if (byId.has(id)) ordered.push(byId.get(id));
  placeInOrder(context, [...ordered, ...siblings.filter((block) => !wanted.has(block.id))]);
}

function pageMarkdown(context, rows, page) {
  const rendered = renderMarkdown(context, blockTree(rows, page.id));
  const result = { object: "page_markdown", id: page.id, markdown: rendered.markdown, truncated: false, unknown_block_ids: rendered.unknown_block_ids };
  return sized(context, result, "the page markdown");
}

/** Validate parsed markdown entries: `keep` references must be live top-level children of the page. */
function splitParsed(context, rows, pageId, parsed, { allowKeep }) {
  const live = childrenOf(rows, pageId);
  const liveIds = new Set(live.map((block) => block.id));
  for (const entry of parsed) {
    if (entry.keep === undefined) continue;
    if (!allowKeep) return validationError(context, "body failed validation: inserted markdown cannot reference existing blocks (notion:// links to child pages or <unknown/> tags).");
    if (!liveIds.has(entry.keep)) return validationError(context, `body failed validation: the markdown references block ${entry.keep}, which is not a child of this page.`);
  }
  return live;
}

const operations = {
  // ---------------------------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------------------------
  "users.me": (input, context) => {
    const identity = requireIdentity(context);
    return renderUser(context, identity, identity.bot);
  },
  "users.list": (input, context) => {
    const identity = requireIdentity(context);
    requireUserInformation(context, identity);
    const users = allRows(context, "users");
    const pagination = paginate(context, users, input, undefined, (user) => renderUser(context, identity, user));
    return listResponse("user", pagination.results, pagination);
  },
  "users.get": (input, context) => {
    const identity = requireIdentity(context);
    // GET /v1/users/me reaches this operation: the framework cannot declare a literal path next to /v1/users/{user_id}.
    if (input.user_id === "me") return renderUser(context, identity, identity.bot);
    requireUserInformation(context, identity);
    return renderUser(context, identity, requireUser(context, input.user_id));
  },

  // ---------------------------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------------------------
  search: (input, context) => {
    const identity = requireIdentity(context);
    let objectFilter;
    if (input.filter !== undefined) {
      if (!isObject(input.filter) || input.filter.property !== "object" || !["page", "data_source"].includes(input.filter.value)) {
        return validationError(context, 'body failed validation: body.filter should be { property: "object", value: "page" | "data_source" }.');
      }
      objectFilter = input.filter.value;
    }
    let direction = "descending";
    if (input.sort !== undefined) {
      if (!isObject(input.sort) || input.sort.timestamp !== "last_edited_time" || !["ascending", "descending"].includes(input.sort.direction)) {
        return validationError(context, 'body failed validation: body.sort should be { timestamp: "last_edited_time", direction: "ascending" | "descending" }.');
      }
      direction = input.sort.direction;
    }
    if (input.query !== undefined && typeof input.query !== "string") return validationError(context, "body failed validation: body.query should be a string.");
    // A search term carrying U+FFFD reached the server mangled (lenient percent-decoding, or a literal %EF%BF%BD).
    // Running it would silently match nothing, so fail with Notion's validation_error instead.
    if (isMangled(input.query)) return mangledError(context, "body.query");
    const tokens = (input.query ?? "").toLowerCase().split(/\s+/).filter((token) => token.length > 0);
    const matches = (title) => tokens.every((token) => title.toLowerCase().includes(token));
    const candidates = [];
    if (identity.capabilities.content !== "none") {
      if (objectFilter !== "data_source") {
        for (const page of allRows(context, "pages")) {
          if (!page.in_trash && matches(page.title_plain) && isVisible(context, identity, page)) candidates.push({ kind: "page", row: page });
        }
      }
      if (objectFilter !== "page") {
        for (const source of allRows(context, "data-sources")) {
          const database = context.state.get("databases", source.parent.database_id);
          if (source.in_trash || database === null || database.in_trash || !matches(plainText(source.title))) continue;
          if (isVisible(context, identity, source)) candidates.push({ kind: "data_source", row: source });
        }
      }
    }
    const sign = direction === "ascending" ? 1 : -1;
    candidates.sort((left, right) => {
      const byTime = Date.parse(left.row.last_edited_time) - Date.parse(right.row.last_edited_time);
      if (byTime !== 0) return byTime * sign;
      return left.row.id < right.row.id ? -1 : 1;
    });
    const render = (candidate) => (candidate.kind === "page" ? renderPage(context, identity, candidate.row) : renderDataSource(context, candidate.row));
    const pagination = paginate(context, candidates, input, (candidate) => candidate.row.id, render, "body.page_size");
    return listResponse("page_or_data_source", pagination.results, pagination, { request_status: { type: "complete" } });
  },

  // ---------------------------------------------------------------------------------------------
  // Pages
  // ---------------------------------------------------------------------------------------------
  "pages.create": (input, context) => {
    const identity = requireIdentity(context);
    requireContent(context, identity, "read_update_insert");
    const target = resolveParent(context, identity, input.parent, { allowDatabase: true });
    const now = isoNow(context);
    let values;
    let schema;
    if (target.kind === "page") {
      if (isObject(input.properties)) {
        for (const key of Object.keys(input.properties)) if (key !== "title") return validationError(context, `${key} is not a property that exists.`);
      }
      values = plainPageValues(context, input.properties ?? {});
    } else {
      const normalized = normalizePropertyValues(context, target.row.properties, input.properties ?? {}, { create: true });
      values = normalized.values;
      schema = normalized.changed ? normalized.properties : undefined;
    }
    const pageIcon = icon(context, input.icon, "icon") ?? null;
    const pageCover = cover(context, input.cover) ?? null;
    let children = [];
    if (input.children !== undefined) {
      children = normalizeBlockInputs(context, input.children, "children");
      const max = limits(context).max_children_per_append;
      if (children.length > max) return validationError(context, `body failed validation: body.children.length should be ≤ ${max}, instead was ${children.length}.`);
    }
    // Every check passed: write.
    const rows = blockRows(context);
    const id = nextId(context, "pages");
    const parent = target.kind === "page" ? { type: "page_id", page_id: target.row.id } : { type: "data_source_id", data_source_id: target.row.id, database_id: target.row.parent.database_id };
    const definitions = target.kind === "page" ? { title: { id: "title", name: "title", type: "title", config: {} } } : (schema ?? target.row.properties);
    const page = {
      id,
      parent,
      properties: values,
      icon: pageIcon,
      cover: pageCover,
      in_trash: false,
      created_time: now,
      last_edited_time: now,
      created_by: author(identity),
      last_edited_by: author(identity),
      title_plain: titlePlainOf(values, definitions),
    };
    context.state.put("pages", id, page);
    if (schema !== undefined) persistSchema(context, target.row, schema, now, identity);
    if (target.kind === "page") {
      const block = {
        id,
        parent: { type: "page_id", page_id: target.row.id },
        type: "child_page",
        content: { title: page.title_plain },
        position: nextPosition(rows, target.row.id),
        has_children: false,
        in_trash: false,
        created_time: now,
        last_edited_time: now,
        created_by: author(identity),
        last_edited_by: author(identity),
      };
      context.state.put("blocks", id, block);
      addBlockRow(rows, { ...block });
      touchPage(context, target.row.id, now, identity.user.id);
    } else {
      const source = context.state.get("data-sources", target.row.id);
      if (source !== null) context.state.put("data-sources", source.id, { ...source, last_edited_time: now, last_edited_by: author(identity) });
    }
    const created = children.length === 0 ? [] : createBlocks(context, { type: "page_id", page_id: id }, children, { now, authorId: identity.user.id, rows });
    context.events.emit("page.created", {
      entity_id: id,
      ...parentInfo(context, parent),
      database_id: parent.type === "data_source_id" ? parent.database_id : null,
      author_id: identity.user.id,
    });
    if (created.length > 0) contentUpdated(context, identity, id, created.map((block) => block.id));
    return withinBudget(context, renderPage(context, identity, context.state.get("pages", id)), "the page");
  },
  "pages.retrieve": (input, context) => {
    const identity = requireIdentity(context);
    const page = requirePage(context, identity, input.page_id);
    const filter = validateFilterProperties(context, definitionsOf(context, page), input.filter_properties, "query.filter_properties");
    return sized(context, renderPage(context, identity, page, filter), "the page");
  },
  "pages.update": (input, context) => {
    const identity = requireIdentity(context);
    requireContent(context, identity, "read_update");
    let page = requirePage(context, identity, input.page_id);
    const trash = input.in_trash ?? input.archived;
    const editing = input.properties !== undefined || input.icon !== undefined || input.cover !== undefined;
    if (page.in_trash && trash !== false && editing) return validationError(context, TRASHED_EDIT);
    const now = isoNow(context);
    const definitions = definitionsOf(context, page);
    let values = page.properties;
    let schema;
    const updatedIds = [];
    if (input.properties !== undefined) {
      if (page.parent.type !== "data_source_id") {
        if (!isObject(input.properties)) return validationError(context, "body failed validation: body.properties should be an object.");
        for (const key of Object.keys(input.properties)) if (key !== "title") return validationError(context, `${key} is not a property that exists.`);
      }
      const normalized = normalizePropertyValues(context, definitions, input.properties, { create: false });
      values = { ...page.properties, ...normalized.values };
      updatedIds.push(...Object.values(normalized.values).map((value) => value.id));
      if (normalized.changed) schema = normalized.properties;
    }
    const nextIcon = icon(context, input.icon, "icon");
    const nextCover = cover(context, input.cover);
    if (nextIcon !== undefined) updatedIds.push("icon");
    if (nextCover !== undefined) updatedIds.push("cover");
    // Writes.
    const rows = blockRows(context);
    if (trash === true && !page.in_trash) {
      setPageTrashed(context, rows, page.id, true, now, identity.user.id);
      context.events.emit("page.deleted", { entity_id: page.id, ...parentInfo(context, page.parent), author_id: identity.user.id });
    } else if (trash === false && page.in_trash) {
      setPageTrashed(context, rows, page.id, false, now, identity.user.id);
      context.events.emit("page.undeleted", { entity_id: page.id, ...parentInfo(context, page.parent), author_id: identity.user.id });
    }
    page = context.state.get("pages", page.id);
    if (editing) {
      if (schema !== undefined) {
        const source = context.state.get("data-sources", page.parent.data_source_id);
        persistSchema(context, source, schema, now, identity);
      }
      const updated = {
        ...page,
        properties: values,
        icon: nextIcon === undefined ? page.icon : nextIcon,
        cover: nextCover === undefined ? page.cover : nextCover,
        last_edited_time: now,
        last_edited_by: author(identity),
        title_plain: titlePlainOf(values, schema ?? definitions),
      };
      context.state.put("pages", page.id, updated);
      if (updated.title_plain !== page.title_plain) {
        const block = context.state.get("blocks", page.id);
        if (block !== null && block.type === "child_page") context.state.put("blocks", page.id, { ...block, content: { title: updated.title_plain }, last_edited_time: now, last_edited_by: author(identity) });
      }
      if (page.parent.type === "page_id") touchPage(context, page.parent.page_id, now, identity.user.id);
      context.events.emit("page.properties_updated", { entity_id: page.id, ...parentInfo(context, page.parent), updated_properties: updatedIds, author_id: identity.user.id });
    }
    return withinBudget(context, renderPage(context, identity, context.state.get("pages", page.id)), "the page");
  },
  "pages.retrieve-property": (input, context) => {
    const identity = requireIdentity(context);
    const page = requirePage(context, identity, input.page_id);
    if (typeof input.property_id !== "string" || input.property_id.trim().length === 0) return validationError(context, "path failed validation: path.property_id should be a non-empty string.");
    pageSize(context, input);
    const definition = findPropertyById(definitionsOf(context, page), input.property_id);
    if (definition === undefined) return validationError(context, `Could not find property with name or id: ${input.property_id}`);
    const items = propertyItems(context, identity, page, definition);
    if (!items.list) {
      if (input.start_cursor !== undefined || input.page_size !== undefined) {
        return validationError(context, `body failed validation: ${definition.type} properties are single property items and cannot be paginated.`);
      }
      return sized(context, items.item, "the property item");
    }
    const indexed = items.items.map((item, index) => ({ cursor: String(index), item }));
    const pagination = paginate(context, indexed, input, (entry) => entry.cursor, (entry) => entry.item);
    return {
      object: "list",
      results: pagination.results,
      next_cursor: pagination.next_cursor,
      has_more: pagination.has_more,
      type: "property_item",
      property_item: { id: definition.id, type: definition.type, next_url: null, [definition.type]: {} },
    };
  },
  "pages.move": (input, context) => {
    const identity = requireIdentity(context);
    requireContent(context, identity, "read_update");
    const page = requirePage(context, identity, input.page_id);
    if (page.in_trash) return validationError(context, TRASHED_EDIT);
    const target = resolveParent(context, identity, input.parent, { allowDatabase: false });
    if (target.kind === "page" && ancestry(context, target.row).includes(page.id)) {
      return validationError(context, "body failed validation: body.parent.page_id should not be the page itself or one of its descendants.");
    }
    const now = isoNow(context);
    const rows = blockRows(context);
    const previous = page.parent;
    const oldDefinitions = definitionsOf(context, page);
    const titleValue = page.properties[Object.values(oldDefinitions).find((definition) => definition.type === "title")?.name ?? "title"];
    const richTitle = titleValue === undefined ? [] : titleValue.value;
    // Detach from the old parent page (the child_page block id equals the page id).
    if (previous.type === "page_id" && context.state.get("blocks", page.id) !== null) {
      context.state.delete("blocks", page.id);
      removeBlockRow(rows, page.id);
      placeInOrder(context, childrenOf(rows, previous.page_id));
      touchPage(context, previous.page_id, now, identity.user.id);
    }
    let parent;
    let values;
    if (target.kind === "page") {
      parent = { type: "page_id", page_id: target.row.id };
      values = { title: { id: "title", type: "title", value: richTitle } };
      context.state.put("blocks", page.id, {
        id: page.id,
        parent,
        type: "child_page",
        content: { title: page.title_plain },
        position: nextPosition(rows, target.row.id),
        has_children: childrenOf(rows, page.id).length > 0,
        in_trash: false,
        created_time: page.created_time,
        last_edited_time: now,
        created_by: page.created_by,
        last_edited_by: author(identity),
      });
      touchPage(context, target.row.id, now, identity.user.id);
    } else {
      parent = { type: "data_source_id", data_source_id: target.row.id, database_id: target.row.parent.database_id };
      const titleDefinition = Object.values(target.row.properties).find((definition) => definition.type === "title");
      values = normalizePropertyValues(context, target.row.properties, { [titleDefinition.name]: { title: richTitle } }, { create: true }).values;
    }
    context.state.put("pages", page.id, { ...page, parent, properties: values, last_edited_time: now, last_edited_by: author(identity) });
    context.events.emit("page.properties_updated", { entity_id: page.id, ...parentInfo(context, parent), updated_properties: [], author_id: identity.user.id });
    return withinBudget(context, renderPage(context, identity, context.state.get("pages", page.id)), "the page");
  },
  "pages.retrieve-markdown": (input, context) => {
    const identity = requireIdentity(context);
    const page = requirePage(context, identity, input.page_id);
    return pageMarkdown(context, blockRows(context), page);
  },
  "pages.update-markdown": (input, context) => {
    const identity = requireIdentity(context);
    requireContent(context, identity, "read_update");
    const page = requirePage(context, identity, input.page_id);
    if (page.in_trash) return validationError(context, TRASHED_EDIT);
    if (input.allow_async === true) return validationError(context, "body failed validation: body.allow_async is not supported; updates are applied synchronously.");
    if (!MARKDOWN_TYPES.includes(input.type)) return validationError(context, `body failed validation: body.type should be one of ${MARKDOWN_TYPES.join(", ")}, instead was \`${shown(input.type)}\`.`);
    const maxBytes = limits(context).max_markdown_bytes;
    const now = isoNow(context);
    const rows = blockRows(context);
    const allowDeleting = input.allow_deleting_content === true;
    const pageRef = { type: "page_id", page_id: page.id };
    // `ordered` lists the page's top-level blocks in their new order: an existing block id (string) or `{ inputs }`
    // for a block still to create. Every new block is created by ONE createBlocks call once all checks have passed,
    // so a document of n blocks costs one sort of the page's live children, never one per entry.
    const pendingOf = (entry) => (entry.keep !== undefined ? entry.keep : { inputs: normalizeBlockInputs(context, [entry], "content") });
    const createPending = (ordered, touched) => {
      const inputs = [];
      for (const item of ordered) if (typeof item !== "string") inputs.push(...item.inputs);
      const created = inputs.length === 0 ? [] : createBlocks(context, pageRef, inputs, { now, authorId: identity.user.id, rows });
      let next = 0;
      return ordered.map((item) => {
        if (typeof item === "string") return item;
        const id = created[next].id;
        next += 1;
        touched.add(id);
        return id;
      });
    };
    let touched;
    if (input.type === "replace_content") {
      const parsed = parseMarkdown(context, input.new_str, maxBytes);
      const live = splitParsed(context, rows, page.id, parsed, { allowKeep: true });
      const kept = new Set(parsed.filter((entry) => entry.keep !== undefined).map((entry) => entry.keep));
      const removed = live.filter((block) => !kept.has(block.id));
      if (removed.some((block) => block.type === "child_page" || block.type === "child_database")) {
        return validationError(context, "body failed validation: child pages and databases cannot be removed through markdown; keep their notion:// links or trash them with the pages API.");
      }
      if (removed.length > 0 && !allowDeleting) return validationError(context, "This update would delete existing content. Set allow_deleting_content to true to confirm.");
      const pending = parsed.map(pendingOf);
      for (const block of removed) setBlockTrashed(context, rows, block, true, now, identity.user.id);
      touched = new Set();
      arrangeChildren(context, rows, page.id, createPending(pending, touched));
      for (const block of removed) touched.add(block.id);
    } else if (input.type === "insert_content") {
      const parsed = parseMarkdown(context, input.content, maxBytes);
      splitParsed(context, rows, page.id, parsed, { allowKeep: false });
      const position = input.position === undefined ? "end" : isObject(input.position) ? input.position.type : undefined;
      if (position !== "start" && position !== "end") return validationError(context, 'body failed validation: body.position.type should be "start" or "end".');
      const before = childrenOf(rows, page.id).map((block) => block.id);
      touched = new Set();
      const created = createPending(parsed.map(pendingOf), touched);
      arrangeChildren(context, rows, page.id, position === "start" ? [...created, ...before] : [...before, ...created]);
    } else {
      if (!Array.isArray(input.content_updates) || input.content_updates.length === 0) return validationError(context, "body failed validation: body.content_updates should be a non-empty array.");
      if (input.content_updates.length > MAX_CONTENT_UPDATES) {
        return validationError(context, `body failed validation: body.content_updates.length should be ≤ ${MAX_CONTENT_UPDATES}, instead was ${input.content_updates.length}.`);
      }
      const current = pageMarkdown(context, rows, page).markdown;
      let markdown = current;
      let markdownBytes = utf8Length(current);
      for (let index = 0; index < input.content_updates.length; index += 1) {
        const update = input.content_updates[index];
        if (!isObject(update) || typeof update.old_str !== "string" || update.old_str.length === 0 || typeof update.new_str !== "string") {
          return validationError(context, `body failed validation: body.content_updates[${index}] should have a non-empty old_str and a new_str.`);
        }
        const replaceAll = update.replace_all_matches === true;
        // A unique match only needs to know whether a second one exists.
        const found = occurrencesOf(markdown, update.old_str, replaceAll ? Number.POSITIVE_INFINITY : 2);
        if (found.length === 0) return validationError(context, `body failed validation: body.content_updates[${index}].old_str was not found in the page content.`);
        if (found.length > 1 && !replaceAll) {
          return validationError(context, `body failed validation: body.content_updates[${index}].old_str matched more than one place; make it unique or set replace_all_matches to true.`);
        }
        // The size of the result is known before it is built: a step may never grow the markdown past the limit.
        const resulting = markdownBytes + found.length * (utf8Length(update.new_str) - utf8Length(update.old_str));
        if (resulting > Math.max(maxBytes, markdownBytes)) {
          return validationError(context, `body failed validation: the resulting markdown exceeds ${maxBytes} bytes (at body.content_updates[${index}]).`);
        }
        markdown = replaceAt(markdown, found, update.old_str.length, update.new_str);
        markdownBytes = resulting;
      }
      if (markdownBytes > maxBytes) return validationError(context, `body failed validation: the resulting markdown exceeds ${maxBytes} bytes.`);
      const live = childrenOf(rows, page.id);
      const oldEntries = parseMarkdown(context, current, maxBytes, { stored: true });
      const newEntries = parseMarkdown(context, markdown, maxBytes, { stored: true });
      splitParsed(context, rows, page.id, newEntries, { allowKeep: true });
      const aligned = oldEntries.length === live.length;
      const keyOf = (entry) => JSON.stringify(entry);
      // Longest common subsequence over serialised entries keeps unchanged blocks (ids and children).
      const oldKeys = aligned ? oldEntries.map(keyOf) : [];
      const newKeys = newEntries.map(keyOf);
      const table = Array.from({ length: oldKeys.length + 1 }, () => new Array(newKeys.length + 1).fill(0));
      for (let i = oldKeys.length - 1; i >= 0; i -= 1) {
        for (let j = newKeys.length - 1; j >= 0; j -= 1) {
          table[i][j] = oldKeys[i] === newKeys[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
      }
      const ordered = [];
      const removed = [];
      const updatedInPlace = new Set();
      let pendingOld = [];
      let pendingNew = [];
      const flush = () => {
        // Pair leftover old/new entries of the same type in order: in-place updates; extras insert or delete.
        const pairs = Math.min(pendingOld.length, pendingNew.length);
        for (let k = 0; k < pairs; k += 1) {
          const oldBlock = pendingOld[k];
          const entry = pendingNew[k];
          if (entry.keep === undefined && oldBlock.type === entry.type && oldBlock.type !== "child_page" && oldBlock.type !== "child_database") {
            const content = normalizeContent(context, entry.type, entry[entry.type], "content");
            const stored = context.state.get("blocks", oldBlock.id);
            const children = childrenOf(rows, oldBlock.id);
            const updated = { ...stored, content, last_edited_time: now, last_edited_by: author(identity) };
            context.state.put("blocks", oldBlock.id, updated);
            Object.assign(oldBlock, updated);
            for (const child of children) setBlockTrashed(context, rows, child, true, now, identity.user.id, { updateParent: false });
            if (entry.children !== undefined) {
              createBlocks(context, { type: "block_id", block_id: oldBlock.id }, normalizeBlockInputs(context, entry.children, "content", 1), { now, authorId: identity.user.id, rows });
            } else if (updated.has_children) {
              context.state.put("blocks", oldBlock.id, { ...updated, has_children: false });
              oldBlock.has_children = false;
            }
            ordered.push(oldBlock.id);
            updatedInPlace.add(oldBlock.id);
          } else {
            removed.push(oldBlock);
            ordered.push(pendingOf(entry));
          }
        }
        for (let k = pairs; k < pendingOld.length; k += 1) removed.push(pendingOld[k]);
        for (let k = pairs; k < pendingNew.length; k += 1) ordered.push(pendingOf(pendingNew[k]));
        pendingOld = [];
        pendingNew = [];
      };
      let i = 0;
      let j = 0;
      while (i < oldKeys.length || j < newKeys.length) {
        if (i < oldKeys.length && j < newKeys.length && oldKeys[i] === newKeys[j]) {
          flush();
          ordered.push(live[i].id);
          i += 1;
          j += 1;
        } else if (j < newKeys.length && (i >= oldKeys.length || table[i][j + 1] >= table[i + 1][j])) {
          pendingNew.push(newEntries[j]);
          j += 1;
        } else {
          pendingOld.push(live[i]);
          i += 1;
        }
      }
      flush();
      if (!aligned) removed.push(...live);
      const orderedIds = new Set(ordered.filter((item) => typeof item === "string"));
      const actuallyRemoved = removed.filter((block) => !orderedIds.has(block.id));
      if (actuallyRemoved.some((block) => block.type === "child_page" || block.type === "child_database")) {
        return validationError(context, "body failed validation: child pages and databases cannot be removed through markdown; keep their notion:// links or trash them with the pages API.");
      }
      if (actuallyRemoved.length > 0 && !allowDeleting) return validationError(context, "This update would delete existing content. Set allow_deleting_content to true to confirm.");
      for (const block of actuallyRemoved) setBlockTrashed(context, rows, block, true, now, identity.user.id);
      const created = new Set();
      const finalIds = createPending(ordered, created);
      // Event order as before: updated or created blocks in page order, then the removed ones.
      touched = new Set(finalIds.filter((id) => created.has(id) || updatedInPlace.has(id)));
      for (const block of actuallyRemoved) touched.add(block.id);
      arrangeChildren(context, rows, page.id, finalIds);
    }
    touchPage(context, page.id, now, identity.user.id);
    contentUpdated(context, identity, page.id, [...touched]);
    // The operation's block index already reflects every write above; rendering from it avoids a second full scan.
    return pageMarkdown(context, rows, context.state.get("pages", page.id));
  },

  // ---------------------------------------------------------------------------------------------
  // Databases and data sources
  // ---------------------------------------------------------------------------------------------
  "databases.create": (input, context) => {
    const identity = requireIdentity(context);
    requireContent(context, identity, "read_update_insert");
    if (!isObject(input.parent) || input.parent.page_id === undefined) return validationError(context, "body failed validation: body.parent.page_id should be defined (databases are created under a page).");
    const parentPage = requirePage(context, identity, input.parent.page_id, "body.parent.page_id");
    if (parentPage.in_trash) return validationError(context, "Can't create or move content under a page that is in the trash.");
    const rawProperties = isObject(input.initial_data_source) ? input.initial_data_source.properties : input.properties;
    if (rawProperties === undefined) return validationError(context, "body failed validation: body.initial_data_source.properties should be defined.");
    const title = normalizeRichText(context, input.title ?? [], "title");
    const description = normalizeRichText(context, input.description ?? [], "description");
    const databaseIcon = icon(context, input.icon, "icon") ?? null;
    const databaseCover = cover(context, input.cover) ?? null;
    if (input.is_inline !== undefined && typeof input.is_inline !== "boolean") return validationError(context, "body failed validation: body.is_inline should be a boolean.");
    const properties = normalizeSchema(context, rawProperties, isObject(input.initial_data_source) ? "initial_data_source.properties" : "properties");
    checkSchema(context, properties);
    const now = isoNow(context);
    const rows = blockRows(context);
    const databaseId = nextId(context, "databases");
    const sourceId = nextId(context, "data-sources");
    const stamp = { created_time: now, last_edited_time: now, created_by: author(identity), last_edited_by: author(identity) };
    const titlePlain = plainText(title);
    context.state.put("databases", databaseId, {
      id: databaseId,
      parent: { type: "page_id", page_id: parentPage.id },
      title,
      description,
      icon: databaseIcon,
      cover: databaseCover,
      is_inline: input.is_inline === true,
      in_trash: false,
      data_source_ids: [sourceId],
      ...stamp,
      title_plain: titlePlain,
    });
    context.state.put("data-sources", sourceId, {
      id: sourceId,
      parent: { type: "database_id", database_id: databaseId },
      name: titlePlain,
      title,
      description,
      properties,
      in_trash: false,
      ...stamp,
    });
    context.state.put("blocks", databaseId, {
      id: databaseId,
      parent: { type: "page_id", page_id: parentPage.id },
      type: "child_database",
      content: { title: titlePlain },
      position: nextPosition(rows, parentPage.id),
      has_children: false,
      in_trash: false,
      ...stamp,
    });
    touchPage(context, parentPage.id, now, identity.user.id);
    withinBudget(context, renderDataSource(context, context.state.get("data-sources", sourceId)), "the data source");
    return withinBudget(context, renderDatabase(context, context.state.get("databases", databaseId)), "the database");
  },
  "databases.retrieve": (input, context) => {
    const identity = requireIdentity(context);
    return sized(context, renderDatabase(context, requireDatabase(context, identity, input.database_id)), "the database");
  },
  "data-sources.retrieve": (input, context) => {
    const identity = requireIdentity(context);
    return sized(context, renderDataSource(context, requireDataSource(context, identity, input.data_source_id)), "the data source");
  },
  "data-sources.query": (input, context) => {
    const identity = requireIdentity(context);
    let source;
    if (input.data_source_id !== undefined) source = requireDataSource(context, identity, input.data_source_id);
    else if (input.database_id !== undefined) {
      const database = requireDatabase(context, identity, input.database_id);
      source = context.state.get("data-sources", database.data_source_ids[0]);
      if (source === null) return notFound(context, "database", database.id);
    } else return validationError(context, "path failed validation: path.data_source_id should be defined.");
    // Notion documents `filter_properties` as a query-string parameter of this route (the codec also maps a JSON-body
    // copy onto the same argument), so its messages are labelled `query.filter_properties`, as on pages.retrieve.
    const filterIds = validateFilterProperties(context, source.properties, input.filter_properties, "query.filter_properties");
    const predicate = input.filter === undefined ? () => true : compileFilter(context, source.properties, input.filter);
    const comparator = compileSorts(context, source.properties, input.sorts);
    const trashed = input.in_trash ?? input.archived;
    if (trashed !== undefined && typeof trashed !== "boolean") return validationError(context, "body failed validation: body.in_trash should be a boolean.");
    const nowMs = Math.floor(context.clock.nowUs() / 1000);
    const pages = allRows(context, "pages").filter(
      (page) => page.parent.type === "data_source_id" && page.parent.data_source_id === source.id && page.in_trash === (trashed === true) && predicate(page, nowMs),
    );
    const sorted = pages.map((page, index) => ({ page, index })).sort((left, right) => comparator(left.page, right.page) || left.index - right.index).map((entry) => entry.page);
    const pagination = paginate(context, sorted, input, undefined, (page) => renderPage(context, identity, page, filterIds), "body.page_size");
    return listResponse("page_or_data_source", pagination.results, pagination, { request_status: { type: "complete" } });
  },
  "data-sources.update": (input, context) => {
    const identity = requireIdentity(context);
    requireContent(context, identity, "read_update");
    const source = requireDataSource(context, identity, input.data_source_id);
    const trash = input.in_trash ?? input.archived;
    const editing = input.title !== undefined || input.description !== undefined || input.properties !== undefined;
    if (source.in_trash && trash !== false && editing) return validationError(context, TRASHED_EDIT);
    const title = input.title === undefined ? undefined : normalizeRichText(context, input.title, "title");
    const description = input.description === undefined ? undefined : normalizeRichText(context, input.description, "description");
    const patch = input.properties === undefined ? undefined : applySchemaPatch(context, source.properties, input.properties);
    if (patch !== undefined) checkSchema(context, patch.properties);
    const now = isoNow(context);
    const rows = blockRows(context);
    if (trash === true && !source.in_trash) setDataSourceTrashed(context, rows, source.id, true, now, identity.user.id);
    else if (trash === false && source.in_trash) setDataSourceTrashed(context, rows, source.id, false, now, identity.user.id);
    const current = context.state.get("data-sources", source.id);
    const updated = {
      ...current,
      title: title ?? current.title,
      description: description ?? current.description,
      properties: patch === undefined ? current.properties : patch.properties,
      name: title === undefined ? current.name : plainText(title),
      last_edited_time: now,
      last_edited_by: author(identity),
    };
    context.state.put("data-sources", source.id, updated);
    withinBudget(context, renderDataSource(context, updated), "the data source");
    if (patch !== undefined) applyChangesToPages(context, updated, patch.changes);
    const database = context.state.get("databases", source.parent.database_id);
    if (database !== null) {
      const databaseTitle = title !== undefined && database.data_source_ids[0] === source.id ? { title, title_plain: plainText(title) } : {};
      context.state.put("databases", database.id, { ...database, ...databaseTitle, last_edited_time: now, last_edited_by: author(identity) });
    }
    return renderDataSource(context, context.state.get("data-sources", source.id));
  },

  // ---------------------------------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------------------------------
  "blocks.retrieve": (input, context) => {
    const identity = requireIdentity(context);
    return sized(context, renderBlock(context, requireBlockRow(context, identity, input.block_id)), "the block");
  },
  "blocks.children.list": (input, context) => {
    const identity = requireIdentity(context);
    const id = requireUuid(context, input.block_id, "block_id");
    const container = context.state.get("blocks", id) ?? context.state.get("pages", id);
    if (container === null || !isVisible(context, identity, container)) return notFound(context, "block", id);
    const rows = blockRows(context);
    const pagination = paginate(context, childrenOf(rows, id), input, undefined, (block) => renderBlock(context, block));
    return listResponse("block", pagination.results, pagination);
  },
  "blocks.children.append": (input, context) => {
    const identity = requireIdentity(context);
    requireContent(context, identity, "read_update_insert");
    const id = requireUuid(context, input.block_id, "block_id");
    const block = context.state.get("blocks", id);
    const page = block === null ? context.state.get("pages", id) : null;
    const container = block ?? page;
    if (container === null || !isVisible(context, identity, container)) return notFound(context, "block", id);
    if (container.in_trash) return validationError(context, TRASHED_EDIT);
    if (block !== null && block.type !== "child_page" && !CONTAINER_TYPES.includes(block.type) && block.type !== "toggle") {
      return validationError(context, `body failed validation: blocks of type ${block.type} do not support children.`);
    }
    const children = normalizeBlockInputs(context, input.children, "children");
    if (block !== null && block.type !== "child_page") {
      // Stored trees stay within MAX_TREE_LEVELS so every later walk over them is bounded.
      const levels = blockLevel(context, block) + 1 + requestDepth(children);
      if (levels > MAX_TREE_LEVELS) {
        return validationError(context, `body failed validation: body.children would nest blocks ${levels} levels below the page; the limit is ${MAX_TREE_LEVELS}.`);
      }
    }
    const max = limits(context).max_children_per_append;
    if (children.length === 0) return validationError(context, "body failed validation: body.children should be a non-empty array.");
    if (children.length > max) return validationError(context, `body failed validation: body.children.length should be ≤ ${max}, instead was ${children.length}.`);
    let afterId;
    if (input.after !== undefined) afterId = requireUuid(context, input.after, "body.after");
    const now = isoNow(context);
    const rows = blockRows(context);
    const parent = block !== null && block.type !== "child_page" ? { type: "block_id", block_id: id } : { type: "page_id", page_id: id };
    const created = createBlocks(context, parent, children, { afterId, now, authorId: identity.user.id, rows });
    const pageId = parent.type === "page_id" ? id : pageOfBlock(context, block);
    if (pageId !== undefined) touchPage(context, pageId, now, identity.user.id);
    contentUpdated(context, identity, pageId ?? id, created.map((row) => row.id));
    return sized(context, listResponse("block", created.map((row) => renderBlock(context, context.state.get("blocks", row.id))), { next_cursor: null, has_more: false }), "the appended blocks");
  },
  "blocks.update": (input, context) => {
    const identity = requireIdentity(context);
    requireContent(context, identity, "read_update");
    const block = requireBlockRow(context, identity, input.block_id);
    if (block.type === "child_page" || block.type === "child_database") return validationError(context, `body failed validation: ${block.type} blocks are updated through the pages and data sources APIs.`);
    const wrapper = isObject(input.type) ? input.type : input;
    const givenType = APPENDABLE_BLOCK_TYPES.find((type) => wrapper[type] !== undefined);
    if (givenType !== undefined && givenType !== block.type) return validationError(context, `body failed validation: body.${givenType} does not match the block type ${block.type}; a block's type cannot be changed.`);
    const archived = input.archived ?? input.in_trash;
    if (block.in_trash && archived !== false && givenType !== undefined) return validationError(context, TRASHED_EDIT);
    let content = block.content;
    if (givenType !== undefined) {
      const body = wrapper[givenType];
      if (!isObject(body)) return validationError(context, `body failed validation: body.${givenType} should be an object.`);
      const merged = { ...block.content };
      if (body.rich_text !== undefined) merged.rich_text = body.rich_text;
      for (const key of ["checked", "color", "language", "icon", "url", "caption", "is_toggleable", "external"]) if (body[key] !== undefined) merged[key] = body[key];
      content = normalizeContent(context, block.type, merged, "");
      if (block.type === "callout" && body.icon === undefined) content.icon = block.content.icon;
    }
    const now = isoNow(context);
    const rows = blockRows(context);
    let current = block;
    if (archived === true && !block.in_trash) current = setBlockTrashed(context, rows, block, true, now, identity.user.id);
    else if (archived === false && block.in_trash) current = setBlockTrashed(context, rows, block, false, now, identity.user.id);
    const updated = { ...current, content, last_edited_time: now, last_edited_by: author(identity) };
    context.state.put("blocks", block.id, updated);
    const pageId = pageOfBlock(context, updated);
    if (pageId !== undefined) touchPage(context, pageId, now, identity.user.id);
    contentUpdated(context, identity, pageId ?? block.id, [block.id]);
    return renderBlock(context, updated);
  },
  "blocks.delete": (input, context) => {
    const identity = requireIdentity(context);
    requireContent(context, identity, "read_update");
    const block = requireBlockRow(context, identity, input.block_id);
    if (block.type === "child_page" || block.type === "child_database") {
      return validationError(context, `body failed validation: ${block.type} blocks cannot be deleted here; move the page or database to the trash with in_trash: true instead.`);
    }
    const now = isoNow(context);
    const rows = blockRows(context);
    const updated = block.in_trash ? block : setBlockTrashed(context, rows, block, true, now, identity.user.id);
    const pageId = pageOfBlock(context, updated);
    if (pageId !== undefined) touchPage(context, pageId, now, identity.user.id);
    contentUpdated(context, identity, pageId ?? block.id, [block.id, ...descendantIds(rows, block.id)]);
    return renderBlock(context, updated);
  },

  // ---------------------------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------------------------
  "comments.create": (input, context) => {
    const identity = requireIdentity(context);
    requireComments(context, identity, "read_insert");
    const hasParent = input.parent !== undefined;
    const hasDiscussion = input.discussion_id !== undefined;
    if (hasParent === hasDiscussion) return validationError(context, "body failed validation: exactly one of body.parent or body.discussion_id should be defined.");
    const richText = normalizeRichText(context, input.rich_text, "rich_text");
    if (richText.length === 0 || plainText(richText).length === 0) return validationError(context, "body failed validation: body.rich_text should be a non-empty array of rich text objects.");
    let parent;
    let discussionId;
    if (hasParent) {
      if (!isObject(input.parent) || input.parent.page_id === undefined) return validationError(context, "body failed validation: body.parent.page_id should be defined.");
      const page = requirePage(context, identity, input.parent.page_id, "body.parent.page_id");
      if (page.in_trash) return validationError(context, TRASHED_EDIT);
      parent = { type: "page_id", page_id: page.id };
    } else {
      discussionId = requireUuid(context, input.discussion_id, "body.discussion_id");
      const first = allRows(context, "comments").find((comment) => comment.discussion_id === discussionId);
      if (first === undefined) return notFound(context, "discussion", discussionId);
      const container = first.parent.type === "page_id" ? context.state.get("pages", first.parent.page_id) : context.state.get("blocks", first.parent.block_id);
      if (container === null || !isVisible(context, identity, container)) return notFound(context, "discussion", discussionId);
      if (container.in_trash) return validationError(context, TRASHED_EDIT);
      parent = first.parent;
    }
    const now = isoNow(context);
    const id = nextId(context, "comments");
    const comment = {
      id,
      parent,
      discussion_id: discussionId ?? nextId(context, "discussions"),
      rich_text: richText,
      created_time: now,
      last_edited_time: now,
      created_by: author(identity),
      display_name: identity.user.type === "bot" ? { type: "integration", resolved_name: identity.integration.name } : { type: "user", resolved_name: identity.user.name },
    };
    context.state.put("comments", id, comment);
    const pageId = parent.type === "page_id" ? parent.page_id : pageOfBlock(context, context.state.get("blocks", parent.block_id));
    if (pageId !== undefined) touchPage(context, pageId, now, identity.user.id);
    context.events.emit("comment.created", {
      entity_id: id,
      discussion_id: comment.discussion_id,
      parent_type: parent.type,
      parent_id: parentKey(parent),
      page_id: pageId ?? parentKey(parent),
      author_id: identity.user.id,
    });
    return withinBudget(context, renderComment(context, identity, comment), "the comment");
  },
  "comments.list": (input, context) => {
    const identity = requireIdentity(context);
    requireComments(context, identity, "read");
    if (input.block_id === undefined) return validationError(context, "query failed validation: query.block_id should be defined, instead was `undefined`.");
    const id = requireUuid(context, input.block_id, "query.block_id");
    const container = context.state.get("blocks", id) ?? context.state.get("pages", id);
    if (container === null || !isVisible(context, identity, container)) return notFound(context, "block", id);
    const comments = allRows(context, "comments")
      .filter((comment) => parentKey(comment.parent) === id)
      .sort((left, right) => Date.parse(left.created_time) - Date.parse(right.created_time) || (left.id < right.id ? -1 : 1));
    const pagination = paginate(context, comments, input, undefined, (comment) => renderComment(context, identity, comment));
    return listResponse("comment", pagination.results, pagination);
  },

  // ---------------------------------------------------------------------------------------------
  // Workspace context (canonical only; lets a UI render "today" from virtual time)
  // ---------------------------------------------------------------------------------------------
  "workspace.context": (input, context) => {
    const identity = requireIdentity(context);
    const workspace = context.state.get("workspace", "workspace") ?? { id: "workspace", name: "Workspace", icon: null, domain: "workspace" };
    return {
      workspace: { id: workspace.id, name: workspace.name, icon: workspace.icon, domain: workspace.domain },
      user: { id: identity.user.id, name: identity.user.name, type: identity.user.type, avatar_url: identity.user.avatar_url },
      integration: { id: identity.integration.id, name: identity.integration.name, capabilities: identity.capabilities, access: identity.access },
      now: isoNow(context),
      limits: limits(context),
    };
  },
  "workspace.trash": (input, context) => {
    // Trash roots: trashed pages and databases whose own parent is live (a restored root brings its subtree back).
    const identity = requireIdentity(context);
    const candidates = [];
    if (identity.capabilities.content !== "none") {
      const parentTrashed = (parent) => {
        if (parent.type === "page_id") return context.state.get("pages", parent.page_id)?.in_trash === true;
        if (parent.type === "data_source_id") return context.state.get("data-sources", parent.data_source_id)?.in_trash === true;
        if (parent.type === "database_id") return context.state.get("databases", parent.database_id)?.in_trash === true;
        if (parent.type === "block_id") return context.state.get("blocks", parent.block_id)?.in_trash === true;
        return false;
      };
      for (const page of allRows(context, "pages")) {
        if (page.in_trash && !parentTrashed(page.parent) && isVisible(context, identity, page)) candidates.push({ kind: "page", row: page });
      }
      for (const database of allRows(context, "databases")) {
        if (database.in_trash && !parentTrashed(database.parent) && isVisible(context, identity, database)) candidates.push({ kind: "database", row: database });
      }
    }
    candidates.sort((left, right) => {
      const byTime = Date.parse(right.row.last_edited_time) - Date.parse(left.row.last_edited_time);
      if (byTime !== 0) return byTime;
      return left.row.id < right.row.id ? -1 : 1;
    });
    const render = (candidate) => (candidate.kind === "page" ? renderPage(context, identity, candidate.row) : renderDatabase(context, candidate.row));
    const pagination = paginate(context, candidates, input, (candidate) => candidate.row.id, render, "body.page_size");
    return listResponse("page_or_database", pagination.results, pagination);
  },
};

// ---------------------------------------------------------------------------------------------
// Provider-shaped HTTP routes (pure codecs)
// ---------------------------------------------------------------------------------------------

const cursorQuery = (request) => defined({ start_cursor: str(request.query, "start_cursor"), page_size: intOrRaw(request.query, "page_size") });
const read = (decode) => ({ decode: (request) => ({ arguments: decode(request) }), encode: encodeOutcome });
const write = (decode) => ({ decode: (request) => operationInput(request, decode(request)), encode: encodeOutcome });

const http = {
  "list-users": read((request) => cursorQuery(request)),
  "get-user": read((request) => ({ user_id: request.path.user_id })),
  search: read((request) => jsonBody(request)),
  "create-page": write((request) => jsonBody(request)),
  "retrieve-page": read((request) => defined({ page_id: request.path.page_id, filter_properties: list(request.query, "filter_properties") })),
  "update-page": write((request) => ({ ...jsonBody(request), page_id: request.path.page_id })),
  "retrieve-page-property": read((request) => ({ page_id: request.path.page_id, property_id: request.path.property_id, ...cursorQuery(request) })),
  "move-page": write((request) => ({ ...jsonBody(request), page_id: request.path.page_id })),
  "retrieve-page-markdown": read((request) => ({ page_id: request.path.page_id })),
  "update-page-markdown": write((request) => ({ ...jsonBody(request), page_id: request.path.page_id })),
  "create-database": write((request) => jsonBody(request)),
  "retrieve-database": read((request) => ({ database_id: request.path.database_id })),
  "query-database-legacy": read((request) => defined({ ...jsonBody(request), database_id: request.path.database_id, filter_properties: list(request.query, "filter_properties") ?? jsonBody(request).filter_properties })),
  "retrieve-data-source": read((request) => ({ data_source_id: request.path.data_source_id })),
  "query-data-source": read((request) => defined({ ...jsonBody(request), data_source_id: request.path.data_source_id, filter_properties: list(request.query, "filter_properties") ?? jsonBody(request).filter_properties })),
  "update-data-source": write((request) => ({ ...jsonBody(request), data_source_id: request.path.data_source_id })),
  "retrieve-block": read((request) => ({ block_id: request.path.block_id })),
  "list-block-children": read((request) => ({ block_id: request.path.block_id, ...cursorQuery(request) })),
  "append-block-children": write((request) => ({ ...jsonBody(request), block_id: request.path.block_id })),
  "update-block": write((request) => ({ ...jsonBody(request), block_id: request.path.block_id })),
  "delete-block": write((request) => ({ block_id: request.path.block_id })),
  "create-comment": write((request) => jsonBody(request)),
  "list-comments": read((request) => defined({ block_id: str(request.query, "block_id"), ...cursorQuery(request) })),
};

export default { operations, http };
