// Notion Tool browser app: shell, sidebar tree, router, Home, Inbox, Trash, search and the workspace menus.
// Every control calls the Tool's own operations through /_firedrill/client.js; nothing here is authoritative.
import { closePeek, closeSidePanel, openPeek, setBreadcrumb, setPlainBreadcrumb, setTopbarActions, skeleton } from "./chrome.js";
import { renderDatabaseView } from "./database.js";
import { hydrateIcons, icon } from "./icons.js";
import { openCommentsPanel, pageTopbarActions, renderPageView } from "./page.js";
import { emojiOf, objectIcon, pill, plain, propertyValue, richText, textToRich, userName } from "./rich.js";
import { ancestors, canComment, canWrite, loadContext, loadIndex, loadUsers, lookup, navigate, pageTitle, parseRoute, routeFor, state } from "./state.js";
import { $, $$, action, avatar, call, closePopovers, describe, el, greeting, iconButton, isEditing, key, longDate, openPopover, readPreference, relativeTime, shortDate, notSimulated, snackbar, textButton, ToolError, unsimulatedButton, watchWorld, writePreference } from "./ui.js";

const ui = {
  controller: undefined, // current screen controller ({ refresh })
  expanded: new Set(JSON.parse(readPreference("expanded", "null") ?? "[]")),
  expandRootsOnce: readPreference("expanded", null) === null,
  treeChildren: new Map(), // page id → [{ node }] loaded from blocks.children.list
  treeTick: -1,
  booted: false,
};

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

hydrateIcons();
wireShell();
watchWorld(
  async (first) => {
    try {
      await loadContext();
      if (first) await loadUsers();
      await loadIndex();
    } catch (error) {
      showConnectionError(error);
      return;
    }
    renderSwitcher();
    await renderTree();
    if (first || !ui.controller) {
      ui.booted = true;
      route();
    } else await ui.controller.refresh?.();
  },
  () => !isEditing(),
);

function showConnectionError(error) {
  const main = $("#main");
  const denied = error instanceof ToolError && error.denied;
  main.replaceChildren(
    el("div", { class: "connect-state" }, [
      el("img", { class: "connect-logo", attrs: { src: "./assets/notion-wordmark.svg", alt: "Notion", width: "160", height: "56" } }),
      el("p", { class: "connect-title", text: denied ? "This actor can't read the workspace" : "Can't connect to the workspace" }),
      el("p", { class: "connect-text", text: denied ? "The selected actor has no grant for workspace.context. Grant the operations listed in the README to this actor and reload." : error?.message ?? "Open this Tool app from its local Firedrill app link." }),
      textButton("Retry", { class: "primary", onClick: () => location.reload() }),
    ]),
  );
  setPlainBreadcrumb("");
  setTopbarActions([]);
  $("#switcher-name").textContent = "Notion";
  $("#switcher-icon").replaceChildren(el("img", { attrs: { src: "./assets/notion.svg", alt: "", width: "18", height: "18" } }));
  $("#tree").replaceChildren(el("div", { class: "tree-empty", text: denied ? "No pages: this actor has no grants." : "No pages inside" }));
}

// ---------------------------------------------------------------------------------------------
// Shell wiring
// ---------------------------------------------------------------------------------------------

function wireShell() {
  window.addEventListener("hashchange", () => { if (ui.booted) route(); });
  $("#nav-search").addEventListener("click", () => openSearch());
  $("#nav-inbox").addEventListener("click", () => openInbox($("#nav-inbox")));
  $("#nav-trash").addEventListener("click", () => openTrash($("#nav-trash")));
  $("#nav-settings").addEventListener("click", () => openSettings($("#nav-settings")));
  $("#nav-templates").addEventListener("click", () => openTemplates($("#nav-templates")));
  $("#nav-invite").addEventListener("click", () => openMembers($("#nav-invite")));
  $("#nav-ai").addEventListener("click", () => notSimulated($("#nav-ai"), "Notion AI", "AI chat, writing and Q&A over the workspace are not part of the API subset this Tool serves.", { side: "right" }));
  $("#nav-meetings").addEventListener("click", () => notSimulated($("#nav-meetings"), "Meetings", "Meeting notes capture, transcription and calendar sync are not part of the API subset this Tool serves. Meeting-note pages in the tree are ordinary pages.", { side: "right" }));
  $("#nav-marketplace").addEventListener("click", () => notSimulated($("#nav-marketplace"), "Marketplace", "The template marketplace is not part of the API subset this Tool serves.", { side: "right" }));
  const teamspaceText = "Teamspaces, their membership and teamspace page trees are not part of the public API, so this Tool does not model them. Pages shared with the integration are listed under Private.";
  const sharedText = "The Shared section lists pages other members shared with you. Per-member sharing is not part of the public API, so this Tool does not model it.";
  for (const id of ["nav-teamspaces", "teamspaces-more", "teamspaces-add", "teamspaces-browse"]) $(`#${id}`).addEventListener("click", (event) => notSimulated(event.currentTarget, "Teamspaces", teamspaceText, { side: "right" }));
  for (const id of ["nav-shared", "shared-add", "shared-start"]) $(`#${id}`).addEventListener("click", (event) => notSimulated(event.currentTarget, "Shared", sharedText, { side: "right" }));
  $("#new-page-top").addEventListener("click", () => createPage());
  $("#new-page-section").addEventListener("click", () => createPage());
  $("#switcher").addEventListener("click", () => openSwitcherMenu());
  $("#help").addEventListener("click", () => openHelp());
  $("#sidebar-collapse").addEventListener("click", () => setSidebar(false));
  $("#sidebar-open").addEventListener("click", () => setSidebar(true));
  $("#sidebar-scrim").addEventListener("click", () => setSidebar(false));
  $("#snackbar-close").addEventListener("click", () => { $("#snackbar").hidden = true; });
  $("#search-close").addEventListener("click", () => $("#search-dialog").close());
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearch();
    } else if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
      event.preventDefault();
      setSidebar(!document.body.classList.contains("sidebar-open") && compact() ? true : document.body.classList.contains("sidebar-collapsed"));
    } else if (event.key === "Escape") {
      if (!$("#peek").hidden && !document.querySelector(".popover")) closePeek();
    }
  });
  wireSearch();
  if (readPreference("sidebar", "open") === "closed") document.body.classList.add("sidebar-collapsed");
}

const compact = () => window.matchMedia("(max-width: 768px)").matches;
function setSidebar(open) {
  if (compact()) {
    document.body.classList.toggle("sidebar-open", open);
    $("#sidebar-scrim").hidden = !open;
  } else {
    document.body.classList.toggle("sidebar-collapsed", !open);
    writePreference("sidebar", open ? "open" : "closed");
  }
}

function renderSwitcher() {
  const workspace = state.context.workspace;
  const iconHost = $("#switcher-icon");
  iconHost.replaceChildren();
  const emoji = emojiOf(workspace.icon);
  if (emoji !== undefined) iconHost.textContent = emoji;
  else iconHost.textContent = workspace.name.charAt(0).toUpperCase();
  iconHost.classList.toggle("letter", emoji === undefined);
  $("#switcher-name").textContent = workspace.name;
  document.title = `${workspace.name} · Notion (synthetic)`;
}

function openSwitcherMenu() {
  const context = state.context;
  const box = el("div", { class: "switcher-menu" });
  box.append(el("div", { class: "switcher-account" }, [el("img", { attrs: { src: "./assets/notion.svg", alt: "", width: "18", height: "18" } }), el("span", { text: context.user.type === "bot" ? `${context.user.name} (integration bot)` : context.user.name })]));
  const workspaceRow = el("div", { class: "switcher-row current" }, [
    el("span", { class: "switcher-icon", text: emojiOf(context.workspace.icon) ?? context.workspace.name.charAt(0) }),
    el("div", { class: "switcher-text" }, [el("div", { class: "switcher-title", text: context.workspace.name }), el("div", { class: "switcher-sub", text: `${state.users.size > 0 ? `${[...state.users.values()].filter((user) => user.type === "person").length} members · ` : ""}${context.workspace.domain}.notion.site` })]),
    icon("check", "menu-check"),
  ]);
  box.append(workspaceRow);
  box.append(el("div", { class: "menu-divider" }));
  box.append(el("div", { class: "switcher-integration" }, [el("div", { class: "menu-header", text: "Connected as" }), el("div", { class: "switcher-sub", text: `${context.integration.name} · content: ${context.integration.capabilities.content.replace(/_/g, " ")} · comments: ${context.integration.capabilities.comments.replace(/_/g, " ")} · users: ${context.integration.capabilities.user_information.replace(/_/g, " ")}` }), el("div", { class: "switcher-sub", text: `Virtual time ${longDate(state.nowMs)}, ${shortDate(context.now, state.nowMs)} UTC` })]));
  box.append(el("div", { class: "menu-divider" }));
  box.append(el("p", { class: "panel-note", text: "Synthetic workspace for agent testing. Nothing here reaches notion.so; workspace switching and account settings are not part of the API." }));
  openPopover($("#switcher"), box, { width: 320 });
}

function openHelp() {
  const box = el("div", { class: "help-menu" });
  box.append(el("img", { attrs: { src: "./assets/notion-wordmark.svg", alt: "Notion", width: "120", height: "42" } }));
  box.append(el("p", { class: "panel-note", text: "This is a synthetic Notion workspace served by Firedrill for testing agents. It mirrors a bounded subset of the Notion API (pages, data sources, blocks, comments, search, users). Notion and its logo are trademarks of Notion Labs, Inc., used only to identify the simulated service." }));
  box.append(el("div", { class: "help-shortcuts" }, [shortcut("⌘/Ctrl K", "Search"), shortcut("⌘/Ctrl \\", "Toggle sidebar"), shortcut("/", "Insert a block"), shortcut("Esc", "Close")]));
  openPopover($("#help"), box, { width: 320, align: "end" });
}
function shortcut(keys, label) {
  return el("div", { class: "help-shortcut" }, [el("span", { text: label }), el("kbd", { text: keys })]);
}

// ---------------------------------------------------------------------------------------------
// Sidebar tree
// ---------------------------------------------------------------------------------------------

function treeNodesAtRoot() {
  const pages = [...state.pages.values()].filter((page) => page.parent?.type !== "data_source_id" && !page.inTrash);
  const roots = pages.filter((page) => page.parent?.type === "workspace" || (page.parent?.type === "page_id" && !state.pages.has(page.parent.page_id)));
  const databases = [...state.databases.values()].filter((database) => !database.isInline && (database.parent?.type === "workspace" || (database.parent?.type === "page_id" && !state.pages.has(database.parent.page_id))));
  return [...roots, ...databases].sort((left, right) => (left.created ?? left.lastEdited ?? "").localeCompare(right.created ?? right.lastEdited ?? "") || left.title.localeCompare(right.title));
}

const TREE_CHILD_REQUESTS = 10;

async function childrenOf(pageId) {
  if (ui.treeTick !== state.tick) {
    ui.treeChildren.clear();
    ui.treeTick = state.tick;
  }
  if (ui.treeChildren.has(pageId)) return ui.treeChildren.get(pageId);
  const nodes = [];
  let cursor;
  for (let request = 0; ; request += 1) {
    if (request === TREE_CHILD_REQUESTS) {
      nodes.truncated = true;
      break;
    }
    const page = await call("blocks.children.list", { block_id: pageId, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const block of page.results) {
      if (block.type === "child_page") {
        const node = state.pages.get(block.id);
        if (node && !node.inTrash) nodes.push(node);
      } else if (block.type === "child_database") {
        const node = state.databases.get(block.id);
        if (node && !node.isInline) nodes.push(node);
      }
    }
    if (!page.has_more) break;
    cursor = page.next_cursor;
  }
  ui.treeChildren.set(pageId, nodes);
  return nodes;
}

async function renderTree() {
  const tree = $("#tree");
  tree.replaceChildren();
  if (state.indexError) {
    tree.append(el("div", { class: "tree-empty", text: describe(state.indexError) }));
    return;
  }
  const roots = treeNodesAtRoot();
  if (ui.expandRootsOnce) {
    // First visit: open the root pages so the workspace is visible, the way a workspace member's sidebar looks.
    ui.expandRootsOnce = false;
    for (const node of roots) if (node.kind === "page") ui.expanded.add(node.id);
  }
  if (roots.length === 0) {
    tree.append(el("div", { class: "tree-empty", text: "No pages inside" }));
    return;
  }
  if (state.indexTruncated) tree.append(el("div", { class: "tree-notice", text: `Showing the ${state.pages.size} most recently edited pages; search to find older ones.` }));
  // Expand the ancestors of the current page so the selection is visible, as the product does.
  const current = currentNode();
  if (current) for (const ancestor of ancestors(current)) if (ancestor.kind === "page") ui.expanded.add(ancestor.id);
  for (const node of roots) tree.append(await treeItem(node, 0));
}

function currentNode() {
  const route = state.route;
  if (route.name === "page") return state.pages.get(route.id);
  if (route.name === "database") return state.databases.get(route.id);
  return undefined;
}

async function treeItem(node, depth) {
  const item = el("div", { class: "tree-node", attrs: { role: "treeitem", "aria-expanded": node.kind === "page" ? String(ui.expanded.has(node.id)) : undefined } });
  const route = routeFor(node);
  const selected = (state.route.name === "page" && route.name === "page" && state.route.id === node.id) || (state.route.name === "database" && route.name === "database" && state.route.id === node.id);
  const row = el("a", { class: `tree-row ${selected ? "selected" : ""}`.trim(), attrs: { href: route.name === "database" ? `#/database/${node.id}/table` : `#/page/${node.id}`, "aria-current": selected ? "page" : undefined } });
  row.style.paddingLeft = `${8 + depth * 14}px`;
  const toggle = el("button", { class: "tree-toggle", attrs: { type: "button", "aria-label": ui.expanded.has(node.id) ? "Collapse" : "Expand", tabindex: "-1" } }, icon("chevron_right"));
  toggle.classList.toggle("open", ui.expanded.has(node.id));
  if (node.kind === "page") {
    toggle.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (ui.expanded.has(node.id)) ui.expanded.delete(node.id);
      else ui.expanded.add(node.id);
      writePreference("expanded", JSON.stringify([...ui.expanded]));
      await renderTree();
    });
  } else toggle.classList.add("none");
  row.append(el("span", { class: "tree-icon-slot" }, [toggle, objectIcon(node.iconObject, node.kind, "tree-icon")]));
  row.append(el("span", { class: "tree-title", text: node.title }));
  const actions = el("span", { class: "tree-actions" });
  const more = iconButton("more", "More", { class: "tiny", tooltip: false });
  more.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); openTreeMenu(more, node); });
  actions.append(more);
  if (node.kind === "page" && canWrite("read_update_insert")) {
    const add = iconButton("plus", "Add a page inside", { class: "tiny", tooltip: false });
    add.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); void createPage(node.id); });
    actions.append(add);
  }
  row.append(actions);
  row.addEventListener("keydown", async (event) => {
    if (event.key === "ArrowRight" && node.kind === "page" && !ui.expanded.has(node.id)) { ui.expanded.add(node.id); await renderTree(); focusRow(node.id); }
    if (event.key === "ArrowLeft" && ui.expanded.has(node.id)) { ui.expanded.delete(node.id); await renderTree(); focusRow(node.id); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const rows = $$("#tree .tree-row");
      const index = rows.indexOf(row);
      rows[(index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
    }
  });
  row.dataset.nodeId = node.id;
  item.append(row);
  if (node.kind === "page" && ui.expanded.has(node.id)) {
    const childHost = el("div", { class: "tree-children", attrs: { role: "group" } });
    try {
      const children = await childrenOf(node.id);
      if (children.length === 0) {
        const empty = el("div", { class: "tree-empty", text: "No pages inside" });
        empty.style.paddingLeft = `${8 + (depth + 1) * 14 + 22}px`;
        childHost.append(empty);
      }
      for (const child of children) childHost.append(await treeItem(child, depth + 1));
      if (children.truncated) {
        const notice = el("div", { class: "tree-notice", text: "More blocks than the sidebar loads; open the page to see every subpage." });
        notice.style.paddingLeft = `${8 + (depth + 1) * 14 + 22}px`;
        childHost.append(notice);
      }
    } catch (error) {
      const failed = el("div", { class: "tree-empty", text: describe(error) });
      failed.style.paddingLeft = `${8 + (depth + 1) * 14 + 22}px`;
      childHost.append(failed);
    }
    item.append(childHost);
  }
  return item;
}

function focusRow(id) {
  $(`#tree .tree-row[data-node-id="${id}"]`)?.focus();
}

function openTreeMenu(anchor, node) {
  const items = [
    { label: "Copy link", icon: "link", onSelect: () => navigator.clipboard?.writeText(node.raw?.url ?? `${location.origin}${location.pathname}#/${node.kind}/${node.id}`).then(() => snackbar("Link copied"), () => snackbar("Copy failed")) },
  ];
  if (node.kind === "page" && canWrite("read_update_insert")) items.push({ label: "Add a page inside", icon: "plus", onSelect: () => createPage(node.id) });
  if (node.kind === "page" && canWrite()) {
    items.push("divider", { label: "Move to Trash", icon: "trash", danger: true, onSelect: () => action(async () => {
      await call("pages.update", { page_id: node.id, in_trash: true }, key());
      snackbar("Moved to Trash", { actionLabel: "Undo", onAction: async () => { await call("pages.update", { page_id: node.id, in_trash: false }, key()); await refreshAll(); } });
      await refreshAll();
      if (state.route.name === "page" && state.route.id === node.id) navigate({ name: "home" });
    }) });
  }
  items.push("divider", { header: `Last edited ${relativeTime(node.lastEdited, state.nowMs)}` });
  openPopover(anchor, items, { width: 240 });
}

async function refreshAll() {
  await loadIndex();
  await renderTree();
  await ui.controller?.refresh?.();
}

async function createPage(parentId) {
  if (!canWrite("read_update_insert")) {
    snackbar("This integration can't create pages (no insert capability).", { error: true });
    return;
  }
  // Integrations cannot create at the workspace root: new pages go under the first root page, which the product
  // would show as "Private" — the app says so once instead of failing.
  const parent = parentId ?? treeNodesAtRoot().find((node) => node.kind === "page")?.id;
  if (!parent) {
    snackbar("No page is shared with this integration to create a new page under.", { error: true });
    return;
  }
  await action(async () => {
    const created = await call("pages.create", { parent: { page_id: parent }, properties: { title: [] } }, key());
    ui.expanded.add(parent);
    writePreference("expanded", JSON.stringify([...ui.expanded]));
    await loadIndex();
    if (parentId === undefined) snackbar(`New page created inside ${state.pages.get(parent)?.title ?? "the root page"} (integrations can't create at the workspace root).`);
    navigate({ name: "page", id: created.id });
  });
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

function route() {
  closePopovers();
  closeSidePanel();
  const next = parseRoute(location.hash);
  const samePage = state.route.name === next.name && state.route.id === next.id && state.route.view === next.view;
  state.route = next;
  if (compact()) setSidebar(false);
  for (const link of $$("#sidebar-main a[data-route]")) link.classList.toggle("selected", link.dataset.route === next.name);
  void renderTree();
  const main = $("#main");
  if (!samePage) main.scrollTop = 0;
  if (next.name === "page") {
    const node = state.pages.get(next.id);
    setBreadcrumb(node ?? { title: "Page", kind: "page" });
    setTopbarActions([]);
    ui.controller = renderPageView(main, next.id, {
      onLoaded: (view) => {
        if (view.page) {
          const node = state.pages.get(view.page.id) ?? { id: view.page.id, kind: "page", title: pageTitle(view.page), iconObject: view.page.icon, parent: view.page.parent };
          setBreadcrumb(node);
          setTopbarActions(pageTopbarActions(view, { onChanged: () => refreshTreeSoon() }));
        }
      },
      onChanged: () => refreshTreeSoon(),
    });
  } else if (next.name === "database") {
    const node = state.databases.get(next.id);
    setBreadcrumb(node ?? { title: "Database", kind: "database" });
    setTopbarActions([]);
    ui.controller = renderDatabaseView(main, next.id, {
      view: next.view,
      onLoaded: (view) => {
        if (view.database) {
          const node = state.databases.get(view.database.id) ?? { id: view.database.id, kind: "database", title: plain(view.database.title) || "Untitled", iconObject: view.database.icon, parent: view.database.parent };
          setBreadcrumb(node);
          setTopbarActions([el("span", { class: "topbar-edited", text: `Edited ${relativeTime(view.database.last_edited_time, state.nowMs)}` }), textButton("Share", { class: "share", onClick: (event) => notSimulated(event.currentTarget, "Share", "Sharing settings are not part of the public API.", { align: "end" }) }), unsimulatedButton("comment", "Comments", "Database-level discussions are not part of the API subset; open a row to comment on it.", { align: "end" }), unsimulatedButton("clock", "View all updates", "Page history and the updates feed are not part of the API subset this Tool serves.", { align: "end" }), unsimulatedButton("star", "Add to Favorites", "Favorites are a per-user app preference that the API does not expose.", { align: "end" }), iconButton("more", "More", { onClick: (event) => openPopover(event.currentTarget, [{ label: "Reload", icon: "refresh", onSelect: () => view.refresh() }], { align: "end", width: 200 }) })]);
        }
      },
      onChanged: () => refreshTreeSoon(),
    });
    if (next.peek) openRowPeek(next.peek);
  } else {
    ui.controller = renderHome(main);
  }
}

let treeTimer;
function refreshTreeSoon() {
  clearTimeout(treeTimer);
  treeTimer = setTimeout(() => void loadIndex().then(renderTree), 50);
}

async function openRowPeek(pageId) {
  const body = el("div", { class: "peek-page" });
  const view = renderPageView(body, pageId, { peek: true, onChanged: () => ui.controller?.refresh?.() });
  openPeek(body, { onExpand: () => { closePeek(); navigate({ name: "page", id: pageId }); } });
  const head = $("#peek .peek-head");
  const actions = el("div", { class: "peek-actions" });
  head.append(actions);
  const wait = setInterval(() => { if (view.page) { clearInterval(wait); actions.replaceChildren(...pageTopbarActions(view, {}).slice(2)); } if (!body.isConnected) clearInterval(wait); }, 150);
}

// ---------------------------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------------------------

function renderHome(main) {
  setPlainBreadcrumb("Home", "home");
  setTopbarActions([]);
  const controller = { refresh: () => fill() };
  const fill = async () => {
    const context = state.context;
    const host = el("div", { class: "home" });
    const name = context.user.type === "person" ? context.user.name.split(" ")[0] : context.user.name;
    host.append(el("h1", { class: "home-greeting", text: `${greeting(state.nowMs)}, ${name}` }));
    host.append(el("p", { class: "home-date", text: longDate(state.nowMs) }));

    // Recently visited: the product's card strip, from the index sorted by last edit (no visit history in the API).
    const recent = [...state.pages.values(), ...[...state.databases.values()].filter((database) => !database.isInline)].sort((left, right) => (right.lastEdited ?? "").localeCompare(left.lastEdited ?? "")).slice(0, 8);
    const section = el("section", { class: "home-section" }, [el("h2", { class: "home-section-title" }, [icon("clock", "home-section-icon"), el("span", { text: "Recently visited" })])]);
    const strip = el("div", { class: "recent-strip" });
    if (recent.length === 0) strip.append(el("div", { class: "home-empty", text: "No pages are shared with this integration yet." }));
    for (const node of recent) {
      const card = el("a", { class: "recent-card", attrs: { href: node.kind === "database" ? `#/database/${node.id}/table` : `#/page/${node.id}` } });
      const top = el("div", { class: "recent-top" });
      top.dataset.seed = String(node.title.length % 6);
      top.append(objectIcon(node.iconObject, node.kind, "recent-icon"));
      card.append(top, el("div", { class: "recent-title", text: node.title }), el("div", { class: "recent-meta" }, [avatar({ id: node.raw?.last_edited_by?.id ?? node.id, name: userName(node.raw?.last_edited_by, state.users) || node.title }, "tiny"), el("span", { text: relativeTime(node.lastEdited, state.nowMs) })]));
      strip.append(card);
    }
    section.append(strip);
    host.append(section);

    // Upcoming events: needs a connected calendar, which the API does not model; shown in place, not simulated.
    const events = el("section", { class: "home-section" }, [el("h2", { class: "home-section-title" }, [icon("calendar", "home-section-icon"), el("span", { text: "Upcoming events" })])]);
    const connect = textButton("Connect calendar", { class: "ghost", onClick: (event) => notSimulated(event.currentTarget, "Connect calendar", "Calendar connections and meeting events are not part of the API subset this Tool serves.") });
    events.append(el("div", { class: "home-events" }, [
      el("div", { class: "home-events-lead" }, [icon("calendar"), el("span", { text: "See your upcoming events and join meetings from Home." }), connect]),
      el("div", { class: "home-events-list", text: "No calendar is connected in this workspace." }),
    ]));
    host.append(events);

    // Learn: the product's getting-started guides, drawn as text-only cards (no vendor illustrations).
    // Guides live on the vendor's help center, which is outside this Tool; each card opens a not-simulated panel.
    const learn = el("section", { class: "home-section" }, [el("h2", { class: "home-section-title" }, [icon("learn", "home-section-icon"), el("span", { text: "Learn" })])]);
    const learnStrip = el("div", { class: "learn-strip" });
    const guides = [
      ["What is a block?", "3m read", "block_text"],
      ["Create your first page", "2m read", "page"],
      ["Create a subpage", "2m read", "page"],
      ["Customize & style your content", "9m read", "text_color"],
    ];
    guides.forEach(([title, meta, glyph], index) => {
      const card = el("button", { class: "learn-card", attrs: { type: "button", "aria-label": `${title}, ${meta}` } });
      const top = el("div", { class: "learn-top", attrs: { "aria-hidden": "true" } }, [icon(glyph, "learn-glyph")]);
      top.dataset.seed = String(index % 4);
      card.append(top, el("div", { class: "learn-title", text: title }), el("div", { class: "learn-meta" }, [icon("page", "learn-meta-icon"), el("span", { text: meta })]));
      card.addEventListener("click", () => notSimulated(card, title, "Getting-started guides open on the vendor's help center, which is not part of this Tool."));
      learnStrip.append(card);
    });
    learn.append(learnStrip);
    host.append(learn);

    // Home database view: the data source with a people + status property, filtered to the acting user.
    const taskSource = [...state.dataSources.values()].find((source) => Object.values(source.properties).some((property) => property.type === "people") && Object.values(source.properties).some((property) => property.type === "status"));
    if (taskSource) {
      const people = Object.values(taskSource.properties).find((property) => property.type === "people");
      const status = Object.values(taskSource.properties).find((property) => property.type === "status");
      const database = state.databases.get(taskSource.parent?.database_id);
      const widget = el("section", { class: "home-section" }, [el("h2", { class: "home-section-title" }, [icon("database", "home-section-icon"), el("span", { text: "Home database views" })])]);
      const card = el("div", { class: "home-widget" });
      const head = el("div", { class: "widget-head" }, [
        el("a", { class: "widget-title", attrs: { href: `#/database/${database?.id}/table` } }, [objectIcon(database?.iconObject, "database", "widget-icon"), el("span", { text: database?.title ?? plain(taskSource.title) })]),
        el("span", { class: "widget-filter", text: `${people.name} is ${context.user.name}` }),
      ]);
      card.append(head);
      const list = el("div", { class: "widget-list" }, skeleton(3));
      card.append(list);
      widget.append(card);
      host.append(widget);
      void (async () => {
        try {
          const result = await call("data-sources.query", { data_source_id: taskSource.id, filter: { property: people.name, people: { contains: context.user.id } }, sorts: [{ property: status.name, direction: "ascending" }], page_size: 10 });
          list.replaceChildren();
          if (result.results.length === 0) list.append(el("div", { class: "home-empty", text: `No pages where ${people.name} is ${context.user.name}.` }));
          const maps = lookup();
          for (const row of result.results) {
            const item = el("a", { class: "widget-row", attrs: { href: `#/database/${database?.id}/table?peek=${row.id}` } });
            item.append(objectIcon(row.icon, "page", "row-icon"), el("span", { class: "widget-row-title", text: pageTitle(row) }));
            const statusValue = row.properties[status.name];
            if (statusValue?.status) item.append(pill(statusValue.status, { status: true }));
            const due = Object.values(row.properties).find((property) => property.type === "date");
            if (due?.date) item.append(el("span", { class: "widget-row-date", text: propertyValue(due, maps).textContent }));
            list.append(item);
          }
          if (result.has_more) list.append(el("a", { class: "widget-more", text: "See all", attrs: { href: `#/database/${database?.id}/table` } }));
        } catch (error) {
          list.replaceChildren(el("div", { class: "home-empty", text: describe(error) }));
        }
      })();
    }
    main.replaceChildren(host);
  };
  void fill();
  return controller;
}

// ---------------------------------------------------------------------------------------------
// Inbox (comments across recently edited pages)
// ---------------------------------------------------------------------------------------------

const INBOX_PAGES = 25;
const INBOX_REQUESTS_PER_PAGE = 10;

function openInbox(anchor) {
  const box = el("div", { class: "inbox" });
  box.append(el("div", { class: "panel-head plain" }, [el("span", { class: "panel-title", text: "Inbox" }), el("div", { class: "panel-tabs inline" }, [el("button", { class: "panel-tab active", text: "All", attrs: { type: "button" } }), el("button", { class: "panel-tab", text: "Unread", attrs: { type: "button", disabled: "" } })])]));
  const list = el("div", { class: "inbox-list" }, skeleton(4));
  box.append(list);
  openPopover(anchor, box, { side: "right", width: 400, className: "sidebar-panel" });
  void (async () => {
    if (!canComment("read")) {
      list.replaceChildren(el("div", { class: "panel-empty", text: "This integration can't read comments, so nothing lands in the inbox." }));
      return;
    }
    try {
      // Comments come from the most recently edited pages; every comment of those pages is read (cursor paging), and
      // both caps are said out loud when they trip.
      const live = [...state.pages.values()].filter((page) => !page.inTrash).sort((left, right) => (right.lastEdited ?? "").localeCompare(left.lastEdited ?? ""));
      const pages = live.slice(0, INBOX_PAGES);
      const entries = [];
      let partial = false;
      for (const page of pages) {
        let cursor;
        for (let request = 0; ; request += 1) {
          if (request === INBOX_REQUESTS_PER_PAGE) {
            partial = true;
            break;
          }
          const comments = await call("comments.list", { block_id: page.id, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
          for (const comment of comments.results) entries.push({ page, comment });
          if (!comments.has_more) break;
          cursor = comments.next_cursor;
        }
      }
      entries.sort((left, right) => right.comment.created_time.localeCompare(left.comment.created_time));
      list.replaceChildren();
      if (live.length > pages.length) list.append(el("div", { class: "inbox-notice", text: `Showing comments from the ${pages.length} most recently edited pages.` }));
      if (partial) list.append(el("div", { class: "inbox-notice", text: "Some pages have more comments than the inbox loads; open a page to see all of its comments." }));
      if (entries.length === 0) list.append(el("div", { class: "panel-empty" }, [icon("inbox", "panel-empty-icon"), el("p", { text: "You're all caught up" }), el("p", { class: "panel-note", text: "Comments on pages shared with this integration appear here." })]));
      for (const { page, comment } of entries) {
        const author = comment.display_name?.resolved_name ?? userName(comment.created_by, state.users);
        const row = el("a", { class: "inbox-row", attrs: { href: `#/page/${page.id}` } }, [
          avatar({ id: comment.created_by?.id, name: author }, "small"),
          el("div", { class: "inbox-body" }, [
            el("div", { class: "inbox-line" }, [el("span", { class: "inbox-author", text: author }), el("span", { text: " commented in " }), el("span", { class: "inbox-page" }, [objectIcon(page.iconObject, "page", "inbox-icon"), el("span", { text: page.title })])]),
            el("div", { class: "inbox-quote" }, richText(comment.rich_text)),
            el("div", { class: "inbox-time", text: relativeTime(comment.created_time, state.nowMs) }),
          ]),
        ]);
        row.addEventListener("click", () => closePopovers());
        list.append(row);
      }
    } catch (error) {
      list.replaceChildren(el("div", { class: "panel-empty", text: describe(error) }));
    }
  })();
}

// ---------------------------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------------------------

function openTrash(anchor) {
  const box = el("div", { class: "trash" });
  const search = el("input", { class: "editor-search", attrs: { type: "text", placeholder: "Search pages in Trash", "aria-label": "Search pages in Trash" } });
  const list = el("div", { class: "trash-list" }, skeleton(3));
  box.append(search, list);
  let items = [];
  let cursor = null;
  let more = false;
  const render = () => {
    list.replaceChildren();
    const needle = search.value.trim().toLowerCase();
    const visible = items.filter((item) => item.title.toLowerCase().includes(needle));
    if (visible.length === 0) list.append(el("div", { class: "panel-empty" }, [icon("trash", "panel-empty-icon"), el("p", { text: needle ? "No results" : "No pages in Trash" })]));
    for (const item of visible) {
      const row = el("div", { class: "trash-row" });
      const open = el("a", { class: "trash-main", attrs: { href: item.kind === "database" ? `#/database/${item.id}/table` : `#/page/${item.id}` } }, [objectIcon(item.iconObject, item.kind, "trash-icon"), el("div", { class: "trash-text" }, [el("div", { class: "trash-title", text: item.title }), el("div", { class: "trash-path", text: item.path })])]);
      open.addEventListener("click", () => closePopovers());
      const restore = iconButton("restore", `Restore ${item.title}`, { class: "small", onClick: () => action(async () => {
        if (item.kind === "database") await call("data-sources.update", { data_source_id: item.dataSourceId, in_trash: false }, key());
        else await call("pages.update", { page_id: item.id, in_trash: false }, key());
        snackbar(`Restored ${item.title}`);
        await loadIndex();
        await renderTree();
        await ui.controller?.refresh?.();
        await loadItems(false);
      }) });
      restore.disabled = !canWrite();
      row.append(open, restore);
      list.append(row);
    }
    if (more) list.append(textButton("Load more", { class: "load-more", onClick: () => loadItems(true) }));
    list.append(el("p", { class: "panel-note", text: "Pages stay restorable; permanent deletion is not part of the public API." }));
  };
  const loadItems = async (append) => {
    try {
      const result = await call("workspace.trash", { page_size: 25, ...(append && cursor ? { start_cursor: cursor } : {}) });
      const mapped = result.results.map((object) => object.object === "database"
        ? { id: object.id, kind: "database", title: plain(object.title) || "Untitled", iconObject: object.icon, dataSourceId: object.data_sources?.[0]?.id, path: pathOf(object.parent) }
        : { id: object.id, kind: "page", title: pageTitle(object), iconObject: object.icon, path: pathOf(object.parent) });
      items = append ? [...items, ...mapped] : mapped;
      cursor = result.next_cursor;
      more = result.has_more;
      render();
    } catch (error) {
      list.replaceChildren(el("div", { class: "panel-empty", text: describe(error) }));
    }
  };
  search.addEventListener("input", render);
  openPopover(anchor, box, { side: "right", width: 400, className: "sidebar-panel" });
  void loadItems(false);
}

function pathOf(parent) {
  if (!parent) return "";
  if (parent.type === "workspace") return state.context.workspace.name;
  if (parent.type === "page_id") return state.pages.get(parent.page_id)?.title ?? "Page";
  if (parent.type === "data_source_id") return state.databases.get(parent.database_id)?.title ?? "Database";
  return "";
}

// ---------------------------------------------------------------------------------------------
// Settings, templates, members (informational panels — the API subset has no settings surface)
// ---------------------------------------------------------------------------------------------

function openSettings(anchor) {
  const context = state.context;
  const box = el("div", { class: "settings" });
  box.append(el("div", { class: "panel-head plain" }, [el("span", { class: "panel-title", text: "Settings" })]));
  const rows = [
    ["Workspace", context.workspace.name],
    ["Domain", `${context.workspace.domain}.notion.site`],
    ["Integration", context.integration.name],
    ["Content capability", context.integration.capabilities.content.replace(/_/g, " ")],
    ["Comment capability", context.integration.capabilities.comments.replace(/_/g, " ")],
    ["User information", context.integration.capabilities.user_information.replace(/_/g, " ")],
    ["Access", context.integration.access.type === "workspace" ? "Entire workspace" : `${context.integration.access.root_ids?.length ?? 0} shared root(s)`],
    ["Virtual time", `${longDate(state.nowMs)}, ${shortDate(context.now, state.nowMs)} UTC`],
    ["Row bound", `${context.limits.max_rows_per_namespace.toLocaleString("en-US")} rows per namespace`],
  ];
  for (const [label, value] of rows) box.append(el("div", { class: "settings-row" }, [el("span", { class: "settings-label", text: label }), el("span", { class: "settings-value", text: value })]));
  box.append(el("p", { class: "panel-note", text: "Workspace settings, billing and integrations management are not part of the public API; this panel shows the identity the app is acting with." }));
  openPopover(anchor, box, { side: "right", width: 400, className: "sidebar-panel" });
}

function openTemplates(anchor) {
  const box = el("div", { class: "settings" });
  box.append(el("div", { class: "panel-head plain" }, [el("span", { class: "panel-title", text: "Templates" })]));
  box.append(el("p", { class: "panel-note", text: "The template gallery is not part of the public API. Start from a blank page instead, or duplicate content with the Markdown panel." }));
  box.append(el("div", { class: "panel-actions" }, [textButton("New page", { class: "primary", icon: "compose", onClick: () => { closePopovers(); void createPage(); } })]));
  openPopover(anchor, box, { side: "right", width: 360, className: "sidebar-panel" });
}

function openMembers(anchor) {
  const box = el("div", { class: "settings" });
  box.append(el("div", { class: "panel-head plain" }, [el("span", { class: "panel-title", text: "Members" })]));
  if (state.usersDenied) box.append(el("p", { class: "panel-note", text: "This integration has no user-information capability, so the member list is hidden." }));
  const people = [...state.users.values()].filter((user) => user.type === "person");
  const bots = [...state.users.values()].filter((user) => user.type === "bot");
  for (const user of [...people, ...bots]) {
    box.append(el("div", { class: "member-row" }, [avatar(user, "small"), el("div", { class: "member-text" }, [el("div", { class: "member-name", text: user.name }), el("div", { class: "member-sub", text: user.type === "bot" ? "Integration bot" : user.person?.email ?? (user.is_guest ? "Guest" : "Member") })]), el("span", { class: "member-role", text: user.type === "bot" ? "Bot" : user.is_guest ? "Guest" : "Member" })]));
  }
  box.append(el("p", { class: "panel-note", text: "Inviting members is not part of the public API." }));
  openPopover(anchor, box, { side: "right", width: 380, className: "sidebar-panel" });
}

// ---------------------------------------------------------------------------------------------
// Search (⌘K)
// ---------------------------------------------------------------------------------------------

const search = { filter: "all", sort: "descending", results: [], selected: 0, more: false, cursor: null, timer: undefined, query: "" };

function wireSearch() {
  const dialog = $("#search-dialog");
  const input = $("#search-input");
  input.addEventListener("input", () => {
    clearTimeout(search.timer);
    search.timer = setTimeout(() => runSearch(false), 200);
  });
  for (const chip of $$("#search-filters .chip[data-filter]")) chip.addEventListener("click", () => {
    search.filter = chip.dataset.filter;
    for (const other of $$("#search-filters .chip[data-filter]")) other.setAttribute("aria-pressed", String(other === chip));
    void runSearch(false);
  });
  $("#search-sort").addEventListener("click", () => {
    search.sort = search.sort === "descending" ? "ascending" : "descending";
    $("#search-sort").textContent = search.sort === "descending" ? "Sort: Last edited" : "Sort: Oldest edited";
    void runSearch(false);
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (search.results.length === 0) return;
      search.selected = (search.selected + (event.key === "ArrowDown" ? 1 : search.results.length - 1)) % search.results.length;
      renderSearchResults();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = search.results[search.selected];
      if (chosen) openSearchResult(chosen);
    }
  });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
}

function openSearch() {
  const dialog = $("#search-dialog");
  if (dialog.open) return;
  $("#search-input").placeholder = `Search in ${state.context?.workspace?.name ?? "workspace"}…`;
  dialog.showModal();
  $("#search-input").focus();
  $("#search-input").select();
  void runSearch(false);
}

async function runSearch(append) {
  const host = $("#search-results");
  const query = $("#search-input").value.trim();
  if (!append) {
    search.selected = 0;
    search.query = query;
    host.replaceChildren(el("div", { class: "search-loading", text: "Searching…" }));
  }
  try {
    const request = { page_size: 10, sort: { timestamp: "last_edited_time", direction: search.sort } };
    if (query) request.query = query;
    if (search.filter !== "all") request.filter = { property: "object", value: search.filter };
    if (append && search.cursor) request.start_cursor = search.cursor;
    const result = await call("search", request);
    if (query !== $("#search-input").value.trim()) return; // stale
    search.results = append ? [...search.results, ...result.results] : result.results;
    search.cursor = result.next_cursor;
    search.more = result.has_more;
    renderSearchResults();
  } catch (error) {
    host.replaceChildren(el("div", { class: "search-empty", text: describe(error) }));
  }
}

function renderSearchResults() {
  const host = $("#search-results");
  host.replaceChildren();
  if (search.results.length === 0) {
    host.append(el("div", { class: "search-empty" }, [el("p", { class: "search-empty-title", text: "No results" }), el("p", { class: "search-empty-text", text: "Some results may be in pages not shared with this integration. Search matches titles only." })]));
    return;
  }
  host.append(el("div", { class: "search-group", text: search.query ? "Best matches" : search.sort === "descending" ? "Recently edited" : "Oldest edits" }));
  search.results.forEach((result, index) => {
    const isPage = result.object === "page";
    const node = isPage ? state.pages.get(result.id) : state.databases.get(result.parent?.database_id);
    const title = isPage ? pageTitle(result) : plain(result.title) || "Untitled";
    const crumbs = node ? ancestors(node).reverse().map((ancestor) => ancestor.title) : [];
    const row = el("button", { class: `search-row ${index === search.selected ? "selected" : ""}`.trim(), attrs: { type: "button", role: "option", "aria-selected": String(index === search.selected) } });
    row.append(objectIcon(result.icon, isPage ? "page" : "database", "search-icon"));
    const text = el("div", { class: "search-text" }, [el("div", { class: "search-title", text: title })]);
    if (crumbs.length > 0) text.append(el("div", { class: "search-path", text: crumbs.join("  /  ") }));
    row.append(text, el("span", { class: "search-date", text: shortDate(result.last_edited_time, state.nowMs) }));
    row.addEventListener("click", () => openSearchResult(result));
    row.addEventListener("mousemove", () => { if (search.selected !== index) { search.selected = index; renderSearchResults(); } });
    host.append(row);
  });
  if (search.more) host.append(textButton("Show more results", { class: "load-more", onClick: () => runSearch(true) }));
  host.querySelector(".search-row.selected")?.scrollIntoView({ block: "nearest" });
}

function openSearchResult(result) {
  $("#search-dialog").close();
  if (result.object === "page") navigate({ name: "page", id: result.id });
  else {
    const databaseId = result.parent?.database_id ?? [...state.databases.values()].find((database) => database.dataSourceId === result.id)?.id;
    if (databaseId) navigate({ name: "database", id: databaseId, view: "table" });
  }
}

export { openCommentsPanel, textToRich };
