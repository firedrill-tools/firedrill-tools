// Notion object rendering (page, database, data source, block, comment, list envelopes). Pure functions
// over state rows; reads through context only to expand users and child titles.
import { compactId } from "./ids.mjs";
import { renderPageProperties, renderSchema, renderUser, userReference } from "./properties.mjs";
import { plainText } from "./rich-text.mjs";
import { slug } from "./state.mjs";

export { renderUser };

export function objectUrl(titlePlain, id) {
  const part = slug(titlePlain);
  return `https://www.notion.so/${part.length > 0 ? `${part}-` : ""}${compactId(id)}`;
}

function stamps(row) {
  return {
    created_time: row.created_time,
    last_edited_time: row.last_edited_time,
    created_by: { object: "user", id: row.created_by.id },
    last_edited_by: { object: "user", id: row.last_edited_by.id },
  };
}

export function renderPage(context, identity, page, filterIds) {
  return {
    object: "page",
    id: page.id,
    ...stamps(page),
    cover: page.cover,
    icon: page.icon,
    parent: page.parent,
    archived: page.in_trash,
    in_trash: page.in_trash,
    properties: renderPageProperties(context, identity, page, filterIds),
    url: objectUrl(page.title_plain, page.id),
    public_url: null,
  };
}

export function renderDatabase(context, database) {
  const sources = database.data_source_ids.map((id) => {
    const source = context.state.get("data-sources", id);
    return { id, name: source === null ? "" : source.name };
  });
  return {
    object: "database",
    id: database.id,
    ...stamps(database),
    title: database.title,
    description: database.description,
    icon: database.icon,
    cover: database.cover,
    parent: database.parent,
    is_inline: database.is_inline,
    is_locked: false,
    archived: database.in_trash,
    in_trash: database.in_trash,
    url: objectUrl(database.title_plain, database.id),
    public_url: null,
    data_sources: sources,
  };
}

export function renderDataSource(context, source) {
  const database = context.state.get("databases", source.parent.database_id);
  return {
    object: "data_source",
    id: source.id,
    name: source.name,
    ...stamps(source),
    title: source.title,
    description: source.description,
    icon: database === null ? null : database.icon,
    properties: renderSchema(source.properties),
    parent: source.parent,
    database_parent: database === null ? { type: "workspace", workspace: true } : database.parent,
    is_inline: database === null ? false : database.is_inline,
    archived: source.in_trash,
    in_trash: source.in_trash,
    url: objectUrl(plainText(source.title), source.id),
    public_url: null,
  };
}

function blockContent(context, block) {
  if (block.type === "child_page") {
    const page = context.state.get("pages", block.id);
    return { title: page === null ? block.content.title ?? "" : page.title_plain };
  }
  if (block.type === "child_database") {
    const database = context.state.get("databases", block.id);
    return { title: database === null ? block.content.title ?? "" : database.title_plain };
  }
  return block.content;
}

export function renderBlock(context, block) {
  return {
    object: "block",
    id: block.id,
    parent: block.parent,
    ...stamps(block),
    has_children: block.has_children,
    archived: block.in_trash,
    in_trash: block.in_trash,
    type: block.type,
    [block.type]: blockContent(context, block),
  };
}

export function renderComment(context, identity, comment) {
  return {
    object: "comment",
    id: comment.id,
    parent: comment.parent,
    discussion_id: comment.discussion_id,
    created_time: comment.created_time,
    last_edited_time: comment.last_edited_time,
    created_by: userReference(context, identity, comment.created_by.id),
    rich_text: comment.rich_text,
    attachments: [],
    display_name: comment.display_name,
  };
}

/** Notion's paginated list envelope (`type` names the element kind; `request_status` on query/search). */
export function listResponse(type, results, pagination, extra = {}) {
  return {
    object: "list",
    results,
    next_cursor: pagination.next_cursor,
    has_more: pagination.has_more,
    type,
    [type]: {},
    ...extra,
  };
}
