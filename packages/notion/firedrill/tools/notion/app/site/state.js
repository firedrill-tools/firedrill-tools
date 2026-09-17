// App-wide state and the caches every screen shares (workspace context, users, the page/database index used by
// the sidebar, breadcrumbs and relation chips). Caches are refilled from the Tool on every world revision change.
import { call, ToolError } from "./ui.js";
import { emojiOf, plain } from "./rich.js";

export const state = {
  context: undefined, // workspace.context value (workspace, user, integration, now, limits)
  nowMs: undefined,
  users: new Map(), // id → user object (persons and bots) when the integration may list users
  usersDenied: false,
  usersTruncated: false,
  indexTruncated: false,
  pages: new Map(), // id → { id, title, icon, parent, kind: "page", lastEdited, inTrash }
  databases: new Map(), // database id → { id, title, icon, parent, kind: "database", dataSourceId, isInline, schema }
  dataSources: new Map(), // data source id → data source object
  indexError: undefined,
  route: { name: "home" },
  favorites: new Set(),
  tick: 0,
};

export const canWrite = (level = "read_update") => {
  const content = state.context?.integration?.capabilities?.content ?? "none";
  const rank = { none: 0, read: 1, read_update: 2, read_update_insert: 3 };
  return rank[content] >= rank[level];
};
export const canComment = (level = "read") => {
  const comments = state.context?.integration?.capabilities?.comments ?? "none";
  const rank = { none: 0, read: 1, read_insert: 2 };
  return rank[comments] >= rank[level];
};

export function pageTitle(page) {
  const property = Object.values(page.properties ?? {}).find((entry) => entry.type === "title");
  const title = property ? plain(property.title) : "";
  return title.length > 0 ? title : "Untitled";
}

export function titleOfRich(items) {
  const title = plain(items);
  return title.length > 0 ? title : "Untitled";
}

/** Read the workspace context (virtual time, identity). */
export async function loadContext() {
  state.context = await call("workspace.context", {});
  state.nowMs = Date.parse(state.context.now);
}

const USER_PAGES = 20;
const INDEX_PAGES = 200;

/** All users when the integration has the user-information capability; otherwise the caller's own identity only. */
export async function loadUsers() {
  const users = new Map();
  try {
    let cursor;
    let more = true;
    // Pages end early by bytes as well as by count, so the guard counts requests, and tripping it is surfaced.
    for (let guard = 0; guard < USER_PAGES && more; guard += 1) {
      const page = await call("users.list", cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 });
      for (const user of page.results) users.set(user.id, user);
      more = page.has_more === true;
      cursor = page.next_cursor;
    }
    state.usersTruncated = more;
    state.usersDenied = false;
  } catch (error) {
    if (!(error instanceof ToolError) || !(error.is("RESTRICTED_RESOURCE") || error.denied)) throw error;
    state.usersDenied = true;
  }
  if (state.context?.user) users.set(state.context.user.id, { ...state.context.user, object: "user" });
  state.users = users;
}

/** Every page and data source visible to the integration (search without a query, paginated). */
export async function loadIndex() {
  const pages = new Map();
  const databases = new Map();
  const dataSources = new Map();
  let truncated = false;
  const collect = async (value, sink) => {
    let cursor;
    for (let guard = 0; ; guard += 1) {
      if (guard === INDEX_PAGES) {
        truncated = true;
        break;
      }
      const page = await call("search", { filter: { property: "object", value }, sort: { timestamp: "last_edited_time", direction: "descending" }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      for (const item of page.results) sink(item);
      if (!page.has_more) break;
      cursor = page.next_cursor;
    }
  };
  try {
    await collect("page", (page) => pages.set(page.id, { id: page.id, kind: "page", title: pageTitle(page), icon: emojiOf(page.icon), iconObject: page.icon, parent: page.parent, lastEdited: page.last_edited_time, created: page.created_time, inTrash: page.in_trash, raw: page }));
    await collect("data_source", (source) => {
      dataSources.set(source.id, source);
      const databaseId = source.parent?.database_id ?? source.id;
      databases.set(databaseId, { id: databaseId, kind: "database", title: titleOfRich(source.title), icon: emojiOf(source.icon), iconObject: source.icon, parent: source.database_parent ?? { type: "workspace", workspace: true }, dataSourceId: source.id, isInline: source.is_inline === true, lastEdited: source.last_edited_time, schema: source.properties });
    });
    state.indexError = undefined;
    state.indexTruncated = truncated;
  } catch (error) {
    state.indexError = error;
  }
  state.pages = pages;
  state.databases = databases;
  state.dataSources = dataSources;
  state.tick += 1;
}

/** Lookup maps for property rendering (people names, relation titles). */
export function lookup() {
  const pageLookup = new Map();
  for (const page of state.pages.values()) pageLookup.set(page.id, { title: page.title, icon: page.icon });
  return { users: state.users, pages: pageLookup };
}

/** Parent chain (nearest first) of a page or database node from the index, for breadcrumbs. */
export function ancestors(node) {
  const chain = [];
  let parent = node?.parent;
  for (let depth = 0; depth < 32 && parent; depth += 1) {
    let next;
    if (parent.type === "page_id") next = state.pages.get(parent.page_id);
    else if (parent.type === "data_source_id") {
      const source = state.dataSources.get(parent.data_source_id);
      next = source ? state.databases.get(source.parent?.database_id ?? parent.database_id) : state.databases.get(parent.database_id);
    } else if (parent.type === "database_id") next = state.databases.get(parent.database_id);
    if (!next) break;
    chain.push(next);
    parent = next.parent;
  }
  return chain;
}

// ---------------------------------------------------------------------------------------------
// Routing (hash based, so the app works from any served path)
// ---------------------------------------------------------------------------------------------

export function parseRoute(hash) {
  const raw = (hash || "#/home").replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "page" && parts[1]) return { name: "page", id: parts[1], peek: params.get("peek") ?? undefined };
  if (parts[0] === "database" && parts[1]) return { name: "database", id: parts[1], view: parts[2] ?? "table", peek: params.get("peek") ?? undefined };
  return { name: "home" };
}

export function routeHash(route) {
  let hash;
  if (route.name === "page") hash = `#/page/${route.id}`;
  else if (route.name === "database") hash = `#/database/${route.id}/${route.view ?? "table"}`;
  else hash = "#/home";
  if (route.peek) hash += `?peek=${encodeURIComponent(route.peek)}`;
  return hash;
}

export function navigate(route) {
  const hash = routeHash(route);
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = hash;
}

/** Route to open any index node (page → page view, database → its table). */
export function routeFor(node) {
  return node.kind === "database" ? { name: "database", id: node.id, view: "table" } : { name: "page", id: node.id };
}
