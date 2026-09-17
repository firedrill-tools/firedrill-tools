// Page view: cover/icon/title, the property panel of database rows, page comments and the block editor.
// Every edit is a Tool operation (pages.update, blocks.update, blocks.children.append, blocks.delete,
// comments.create, pages.update-markdown, pages.move); the page is re-read after each write.
import { emptyState, openSidePanel, skeleton } from "./chrome.js";
import { renderInlineDatabase, openSchemaEditor } from "./database.js";
import { newBlockInput, openBlockMenu, openEmojiPicker, openPropertyEditor } from "./editors.js";
import { icon, propertyIcon } from "./icons.js";
import { checkbox, emojiOf, objectIcon, person, plain, propertyValue, richText, textToRich, userName } from "./rich.js";
import { canComment, canWrite, loadIndex, lookup, navigate, pageTitle, state } from "./state.js";
import { $, action, avatar, call, closePopovers, confirmDialog, describe, el, iconButton, key, notSimulated, openPopover, popoverOpen, relativeTime, shortDate, snackbar, textButton, ToolError, unsimulatedButton } from "./ui.js";
import { coverSeed, openCoverPicker, workspaceCovers } from "./cover-picker.js";
import { registerFormatTarget } from "./format-bar.js";

const TEXT_TYPES = ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout", "code"];
const PLACEHOLDER = { paragraph: "Write something, or press '/' for commands…", heading_1: "Heading 1", heading_2: "Heading 2", heading_3: "Heading 3", bulleted_list_item: "List", numbered_list_item: "List", to_do: "To-do", toggle: "Toggle", quote: "Quote", callout: "Callout", code: "Code" };

/**
 * Render a page into `host`. Returns a controller with `refresh()` and `page`.
 * `options.peek`: rendered inside the side peek (no top-level actions), `options.onChanged`: called after writes.
 */
export function renderPageView(host, pageId, options = {}) {
  const view = {
    id: pageId,
    page: undefined,
    schema: undefined, // data source properties for database rows
    blocks: [],
    blocksCursor: null,
    blocksMore: false,
    children: new Map(), // block id → { blocks, more, cursor }
    expanded: new Set(),
    comments: [],
    commentsError: undefined,
    focusAfter: undefined,
    error: undefined,
    loading: true,
  };
  host.replaceChildren(el("div", { class: "page-shell" }, skeleton(8)));
  view.refresh = () => load(host, view, options);
  void view.refresh();
  return view;
}

async function load(host, view, options) {
  try {
    view.page = await call("pages.retrieve", { page_id: view.id });
    view.error = undefined;
    if (view.page.parent?.type === "data_source_id") view.schema = (await call("data-sources.retrieve", { data_source_id: view.page.parent.data_source_id })).properties;
    else view.schema = undefined;
    const children = await call("blocks.children.list", { block_id: view.id, page_size: 30 });
    view.blocks = children.results;
    view.blocksCursor = children.next_cursor;
    view.blocksMore = children.has_more;
    view.children = new Map();
    view.comments = [];
    view.commentsError = undefined;
    if (canComment("read")) {
      try {
        view.comments = await allComments(view.id);
      } catch (error) {
        view.commentsError = describe(error);
      }
    }
  } catch (error) {
    view.error = error;
  }
  view.loading = false;
  render(host, view, options);
  options.onLoaded?.(view);
}

const COMMENT_REQUESTS = 20;

/** Every comment of a block, paged by cursor; `comments.truncated` is set when the request cap trips. */
async function allComments(blockId) {
  const comments = [];
  let cursor;
  for (let request = 0; ; request += 1) {
    if (request === COMMENT_REQUESTS) {
      comments.truncated = true;
      break;
    }
    const page = await call("comments.list", { block_id: blockId, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    comments.push(...page.results);
    if (!page.has_more) break;
    cursor = page.next_cursor;
  }
  return comments;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function render(host, view, options) {
  host.replaceChildren();
  if (view.error) {
    host.append(errorState(view.error));
    return;
  }
  const page = view.page;
  const shell = el("div", { class: `page-shell ${page.cover ? "has-cover" : ""} ${page.icon ? "has-icon" : ""}`.trim() });
  if (page.cover) shell.append(coverBanner(page, view, options));
  const content = el("div", { class: "page-content" });
  if (page.in_trash) content.append(trashBanner(view, host, options));
  content.append(pageHeader(view, host, options));
  if (view.schema) content.append(propertyPanel(view, host, options));
  content.append(commentsStrip(view, host, options));
  content.append(blockList(view, host, options));
  shell.append(content);
  host.append(shell);
  if (view.focusAfter) {
    const target = host.querySelector(`[data-block-id="${view.focusAfter}"] .block-text`);
    view.focusAfter = undefined;
    if (target) {
      target.focus();
      placeCaretAtEnd(target);
    }
  }
}

function errorState(error) {
  if (error instanceof ToolError && (error.denied || error.is("OBJECT_NOT_FOUND") || error.is("RESTRICTED_RESOURCE"))) {
    const denied = error.denied || error.is("RESTRICTED_RESOURCE");
    return el("div", { class: "page-shell" }, [
      el("div", { class: "page-content" }, emptyState(denied ? "You don't have access to this page" : "This content doesn't exist or you don't have access.", denied ? error.message : "Make sure the page is shared with the integration, or open another page from the sidebar.", [textButton("Go to Home", { onClick: () => navigate({ name: "home" }) })])),
    ]);
  }
  if (error instanceof ToolError && error.is("RATE_LIMITED")) {
    return el("div", { class: "page-shell" }, [el("div", { class: "page-content" }, emptyState("You're being rate limited", "Notion asked us to slow down (429). Try again in a few seconds.", [textButton("Retry", { class: "primary", onClick: () => window.dispatchEvent(new HashChangeEvent("hashchange")) })]))]);
  }
  return el("div", { class: "page-shell" }, [el("div", { class: "page-content" }, emptyState("Something went wrong", describe(error), [textButton("Retry", { class: "primary", onClick: () => window.dispatchEvent(new HashChangeEvent("hashchange")) })]))]);
}

function coverBanner(page, view, options) {
  // External cover images cannot be fetched inside the test environment; the product's gradient covers are drawn instead.
  const banner = el("div", { class: "page-cover", attrs: { role: "img", "aria-label": "Page cover" } });
  banner.dataset.seed = String(coverSeed(page.cover?.external?.url ?? page.id));
  banner.append(el("span", { class: "cover-note", text: page.cover?.external?.url ?? "" }));
  if (view && canWrite() && !page.in_trash) {
    const change = textButton("Change cover", {});
    change.addEventListener("click", () => openCoverPicker(change, page.cover?.external?.url, (url) => writeCover(view, options, url)));
    const reposition = textButton("Reposition", {});
    reposition.addEventListener("click", () => notSimulated(reposition, "Reposition", "Cover position is an app-only setting that the public API does not expose.", { align: "end" }));
    banner.append(el("div", { class: "page-cover-actions" }, [change, reposition]));
  }
  return banner;
}

function writeCover(view, options, url) {
  return action(async () => {
    await call("pages.update", { page_id: view.id, cover: url === null ? null : { type: "external", external: { url } } }, key());
    await afterWrite(view, options);
  });
}

function trashBanner(view, host, options) {
  const restore = textButton("Restore page", { class: "on-red", onClick: () => action(async () => {
    await call("pages.update", { page_id: view.id, in_trash: false }, key());
    snackbar("Page restored");
    await afterWrite(view, options);
  }) });
  return el("div", { class: "trash-banner" }, [el("span", { text: "This page is in Trash." }), restore, el("span", { class: "trash-note", text: "Permanent deletion is not part of the public API." })]);
}

async function afterWrite(view, options) {
  await loadIndex();
  await view.refresh();
  options.onChanged?.(view);
}

// ---------------------------------------------------------------------------------------------
// Header: icon, title, hover controls
// ---------------------------------------------------------------------------------------------

function pageHeader(view, host, options) {
  const page = view.page;
  const writable = canWrite() && !page.in_trash;
  const header = el("div", { class: "page-header" });
  const emoji = emojiOf(page.icon);
  const iconButtonEl = el("button", { class: `page-icon ${emoji === undefined ? "empty" : ""}`.trim(), attrs: { type: "button", "aria-label": emoji === undefined ? "Add icon" : "Change icon", "aria-expanded": "false" } });
  if (emoji !== undefined) iconButtonEl.append(el("span", { class: "page-emoji", text: emoji }));
  else if (page.icon?.type === "external") iconButtonEl.append(icon("page", "page-icon-glyph"));
  iconButtonEl.disabled = !writable;
  iconButtonEl.addEventListener("click", () => openEmojiPicker(iconButtonEl, emoji, (picked) => action(async () => {
    await call("pages.update", { page_id: view.id, icon: picked === null ? null : { type: "emoji", emoji: picked } }, key());
    await afterWrite(view, options);
  })));
  if (emoji !== undefined || page.icon?.type === "external") header.append(iconButtonEl);

  const controls = el("div", { class: "page-controls" });
  if (writable && emoji === undefined) controls.append(textButton("Add icon", { class: "ghost", icon: "star", onClick: () => openEmojiPicker(controls.firstChild, undefined, (picked) => action(async () => {
    if (picked === null) return;
    await call("pages.update", { page_id: view.id, icon: { type: "emoji", emoji: picked } }, key());
    await afterWrite(view, options);
  })) }));
  if (writable && !page.cover) controls.append(textButton("Add cover", { class: "ghost", icon: "image", onClick: (event) => {
    const used = workspaceCovers();
    if (used.length > 0) void writeCover(view, options, used[0].url);
    else openCoverPicker(event.currentTarget, undefined, (url) => writeCover(view, options, url), { startWith: "link" });
  } }));
  if (canComment("read_insert") && !page.in_trash) controls.append(textButton("Add comment", { class: "ghost", icon: "comment", onClick: () => host.querySelector(".comment-composer input")?.focus() }));
  header.append(controls);

  const title = el("h1", { class: `page-title ${pageTitle(page) === "Untitled" && plain(titleProperty(page)?.title) === "" ? "empty" : ""}`.trim(), attrs: { "aria-label": "Page title", "data-placeholder": "Untitled" } });
  const text = plain(titleProperty(page)?.title);
  title.textContent = text;
  if (writable) {
    title.setAttribute("contenteditable", "plaintext-only");
    title.setAttribute("spellcheck", "false");
    const commit = () => {
      const next = title.textContent.replace(/\n/g, " ").trim();
      if (next === text) return;
      const name = titlePropertyName(view);
      void action(async () => {
        await call("pages.update", { page_id: view.id, properties: { [name]: { title: textToRich(next) } } }, key());
        await afterWrite(view, options);
      });
    };
    title.addEventListener("blur", commit);
    title.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        title.blur();
        const first = host.querySelector(".block .block-text");
        first?.focus();
      }
      if (event.key === "Escape") {
        title.textContent = text;
        title.blur();
      }
    });
    title.addEventListener("input", () => title.classList.toggle("empty", title.textContent.length === 0));
  }
  header.append(title);
  return header;
}

/** Schema order with the computed (created / last edited) properties last, as a workspace member would arrange them. */
export function orderedDefinitions(definitions) {
  const computed = ["created_time", "created_by", "last_edited_time", "last_edited_by"];
  return [...definitions.filter((definition) => !computed.includes(definition.type)), ...definitions.filter((definition) => computed.includes(definition.type))];
}

function titleProperty(page) {
  return Object.values(page.properties ?? {}).find((entry) => entry.type === "title");
}
function titlePropertyName(view) {
  const entry = Object.entries(view.page.properties ?? {}).find(([, value]) => value.type === "title");
  return entry ? entry[0] : "title";
}

// ---------------------------------------------------------------------------------------------
// Property panel (database rows)
// ---------------------------------------------------------------------------------------------

function propertyPanel(view, host, options) {
  const page = view.page;
  const panel = el("div", { class: "property-panel", attrs: { role: "table", "aria-label": "Properties" } });
  const maps = lookup();
  const writable = canWrite() && !page.in_trash;
  const definitions = Object.values(view.schema);
  const ordered = orderedDefinitions(definitions).filter((definition) => definition.type !== "title");
  for (const definition of ordered) {
    const property = page.properties[definition.name];
    if (!property) continue;
    const row = el("div", { class: "property-row", attrs: { role: "row" } });
    const name = el("div", { class: "property-name", attrs: { role: "rowheader" } }, [icon(propertyIcon(definition.type), "property-icon"), el("span", { text: definition.name })]);
    const computed = ["created_time", "created_by", "last_edited_time", "last_edited_by"].includes(definition.type);
    const value = el("button", { class: `property-value ${property[definition.type] === null || (Array.isArray(property[definition.type]) && property[definition.type].length === 0) || property[definition.type] === "" ? "empty" : ""}`.trim(), attrs: { type: "button", "aria-label": `${definition.name} value`, "aria-expanded": "false", role: "cell" } });
    value.append(propertyValue(property, maps));
    value.dataset.placeholder = "Empty";
    if (definition.type === "checkbox") {
      value.replaceChildren(checkbox(property.checkbox === true, { label: definition.name, onToggle: writable ? (next) => writeProperty(view, options, definition.name, { checkbox: next }) : undefined }));
    } else if (computed || !writable) {
      value.disabled = true;
      value.classList.add("readonly");
    } else {
      value.addEventListener("click", () => openPropertyEditor(value, definition, property, (next) => writeProperty(view, options, definition.name, next), { onNotice: (text) => snackbar(text) }));
    }
    row.append(name, value);
    panel.append(row);
  }
  if (canWrite("read_update") && !page.in_trash) {
    const add = textButton("Add a property", { class: "ghost add-property", icon: "plus", onClick: () => openSchemaEditor(add, page.parent.data_source_id, view.schema, () => afterWrite(view, options)) });
    panel.append(add);
  }
  return panel;
}

function writeProperty(view, options, name, valueObject) {
  return action(async () => {
    await call("pages.update", { page_id: view.id, properties: { [name]: valueObject } }, key());
    await afterWrite(view, options);
  });
}

// ---------------------------------------------------------------------------------------------
// Comments under the title
// ---------------------------------------------------------------------------------------------

function commentsStrip(view, host, options) {
  const strip = el("div", { class: "comments-strip" });
  if (!canComment("read")) return strip;
  if (view.commentsError) {
    strip.append(el("div", { class: "comments-error", text: view.commentsError }));
    return strip;
  }
  const discussions = groupDiscussions(view.comments);
  if (view.comments.truncated) strip.append(el("div", { class: "list-notice", text: `Showing the first ${view.comments.length} comments on this page.` }));
  for (const discussion of discussions) strip.append(discussionBlock(discussion, view, options));
  if (canComment("read_insert") && !view.page.in_trash) strip.append(commentComposer("Add a comment…", (text) => action(async () => {
    await call("comments.create", { parent: { page_id: view.id }, rich_text: textToRich(text) }, key());
    await view.refresh();
    options.onChanged?.(view);
  })));
  return strip;
}

export function groupDiscussions(comments) {
  const map = new Map();
  for (const comment of comments) {
    if (!map.has(comment.discussion_id)) map.set(comment.discussion_id, { id: comment.discussion_id, parent: comment.parent, comments: [] });
    map.get(comment.discussion_id).comments.push(comment);
  }
  return [...map.values()];
}

export function discussionBlock(discussion, view, options, { showParent = false } = {}) {
  const box = el("div", { class: "discussion" });
  if (showParent && discussion.parent?.type === "block_id") box.append(el("div", { class: "discussion-context", text: "On a block of this page" }));
  for (const comment of discussion.comments) {
    const author = comment.display_name?.resolved_name ?? userName(comment.created_by, state.users);
    const row = el("div", { class: "comment" }, [
      avatar({ id: comment.created_by?.id, name: author }, "small"),
      el("div", { class: "comment-body" }, [
        el("div", { class: "comment-meta" }, [el("span", { class: "comment-author", text: author }), comment.display_name?.type === "integration" ? el("span", { class: "comment-bot", text: "Integration" }) : null, el("span", { class: "comment-time", text: relativeTime(comment.created_time, state.nowMs) })]),
        el("div", { class: "comment-text" }, richText(comment.rich_text)),
      ]),
    ]);
    box.append(row);
  }
  if (canComment("read_insert") && !view?.page?.in_trash) box.append(commentComposer("Reply…", (text) => action(async () => {
    await call("comments.create", { discussion_id: discussion.id, rich_text: textToRich(text) }, key());
    await view.refresh();
    options?.onChanged?.(view);
  }), { compact: true }));
  return box;
}

export function commentComposer(placeholder, onSubmit, { compact = false } = {}) {
  const form = el("form", { class: `comment-composer ${compact ? "compact" : ""}`.trim() });
  const input = el("input", { attrs: { type: "text", placeholder, "aria-label": placeholder, autocomplete: "off" } });
  const send = el("button", { class: "send-btn", attrs: { type: "submit", "aria-label": "Send comment" } }, icon("send"));
  send.disabled = true;
  input.addEventListener("input", () => { send.disabled = input.value.trim().length === 0; });
  form.append(state.context ? avatar(state.context.user, "small") : el("span"), input, send);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text.length === 0) return;
    void Promise.resolve(onSubmit(text)).then(() => { if (form.isConnected) { input.value = ""; send.disabled = true; } });
  });
  return form;
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

function blockList(view, host, options) {
  const list = el("div", { class: "blocks", attrs: { role: "region", "aria-label": "Page content" } });
  const writable = canWrite() && !view.page.in_trash;
  if (view.blocks.length === 0) {
    if (writable) {
      const empty = el("div", { class: "blocks-empty" });
      const start = el("button", { class: "blocks-empty-btn", attrs: { type: "button" } }, [el("span", { text: "Write something, or press " }), el("kbd", { text: "/" }), el("span", { text: " for commands…" })]);
      start.addEventListener("click", () => appendBlock(view, options, view.id, newBlockInput("paragraph"), undefined));
      empty.append(start);
      list.append(empty);
    } else list.append(el("div", { class: "blocks-empty", text: "This page is empty." }));
    return list;
  }
  renderBlocks(list, view.blocks, { view, host, options, parentId: view.id, writable, depth: 0 });
  if (view.blocksMore) {
    const more = textButton("Load more blocks", { class: "load-more", onClick: () => action(async () => {
      const next = await call("blocks.children.list", { block_id: view.id, page_size: 30, start_cursor: view.blocksCursor });
      view.blocks.push(...next.results);
      view.blocksCursor = next.next_cursor;
      view.blocksMore = next.has_more;
      render(host, view, options);
    }, { exclusive: false }) });
    list.append(more);
  }
  if (writable) {
    const tail = el("div", { class: "blocks-tail", attrs: { role: "button", tabindex: "0", "aria-label": "Add a block at the end" } });
    const add = () => appendBlock(view, options, view.id, newBlockInput("paragraph"), view.blocks[view.blocks.length - 1]?.id ? undefined : undefined);
    tail.addEventListener("click", add);
    tail.addEventListener("keydown", (event) => { if (event.key === "Enter") add(); });
    list.append(tail);
  }
  return list;
}

function renderBlocks(list, blocks, context) {
  let number = 0;
  blocks.forEach((block, index) => {
    if (block.type === "numbered_list_item") number = blocks[index - 1]?.type === "numbered_list_item" ? number + 1 : 1;
    list.append(renderBlock(block, { ...context, number }));
  });
}

function renderBlock(block, context) {
  const { view, options, writable, depth } = context;
  const type = block.type;
  const wrapper = el("div", { class: `block block-${type} ${block.in_trash ? "trashed" : ""}`.trim(), attrs: { "data-block-id": block.id, "data-depth": String(depth) } });
  if (writable && type !== "child_page" && type !== "child_database") wrapper.append(gutter(block, context));
  const body = el("div", { class: "block-body" });
  const content = block[type] ?? {};
  switch (type) {
    case "child_page": {
      const node = state.pages.get(block.id);
      const link = el("a", { class: "child-page", attrs: { href: `#/page/${block.id}` } }, [objectIcon(node?.iconObject, "page", "child-icon"), el("span", { class: "child-title", text: content.title || node?.title || "Untitled" })]);
      body.append(link);
      break;
    }
    case "child_database": {
      const node = state.databases.get(block.id);
      if (node?.isInline) {
        body.append(el("div", { class: "inline-database" }, renderInlineDatabase(block.id, { onChanged: () => options.onChanged?.(view) })));
      } else {
        body.append(el("a", { class: "child-page child-database", attrs: { href: `#/database/${block.id}/table` } }, [objectIcon(node?.iconObject, "database", "child-icon"), el("span", { class: "child-title", text: content.title || node?.title || "Untitled" })]));
      }
      break;
    }
    case "divider":
      body.append(el("hr", { class: "divider" }));
      break;
    case "bookmark": {
      const card = el("a", { class: "bookmark", attrs: { href: content.url, target: "_blank", rel: "noopener noreferrer" } }, [
        el("div", { class: "bookmark-main" }, [el("div", { class: "bookmark-title", text: plain(content.caption) || content.url }), el("div", { class: "bookmark-url", text: content.url })]),
        el("div", { class: "bookmark-side" }, icon("link")),
      ]);
      body.append(card);
      break;
    }
    case "image": {
      // Remote images never load inside the test environment: the product's "image" frame with the URL as caption.
      body.append(el("div", { class: "image-block" }, [el("div", { class: "image-frame" }, [icon("page", "image-glyph"), el("span", { text: "External image" })]), el("div", { class: "image-caption", text: plain(content.caption) || content.external?.url || "" })]));
      break;
    }
    default:
      body.append(textBlock(block, content, context));
  }
  wrapper.append(body);
  // Nested children: toggles collapse, everything else shows its children inline.
  if (block.has_children && type !== "child_page" && type !== "child_database") {
    const expanded = type === "toggle" ? view.expanded.has(block.id) : true;
    if (expanded) {
      const childHost = el("div", { class: "block-children" });
      const loaded = view.children.get(block.id);
      if (loaded) {
        renderBlocks(childHost, loaded.blocks, { ...context, parentId: block.id, depth: depth + 1 });
        if (loaded.more) childHost.append(textButton("Load more", { class: "load-more", onClick: () => loadChildren(block.id, context, loaded.cursor) }));
      } else {
        childHost.append(el("div", { class: "block-loading", text: "Loading…" }));
        void loadChildren(block.id, context);
      }
      wrapper.append(childHost);
    }
  }
  return wrapper;
}

async function loadChildren(blockId, context, cursor) {
  const { view, host, options } = context;
  try {
    const page = await call("blocks.children.list", { block_id: blockId, page_size: 50, ...(cursor ? { start_cursor: cursor } : {}) });
    const existing = cursor ? view.children.get(blockId)?.blocks ?? [] : [];
    view.children.set(blockId, { blocks: [...existing, ...page.results], more: page.has_more, cursor: page.next_cursor });
  } catch (error) {
    view.children.set(blockId, { blocks: [], more: false, cursor: null, error: describe(error) });
    snackbar(describe(error), { error: true });
  }
  render(host, view, options);
}

function textBlock(block, content, context) {
  const { view, options, writable, number } = context;
  const type = block.type;
  const row = el("div", { class: "block-row" });
  if (type === "bulleted_list_item") row.append(el("span", { class: "marker bullet", text: "•", attrs: { "aria-hidden": "true" } }));
  if (type === "numbered_list_item") row.append(el("span", { class: "marker number", text: `${number}.`, attrs: { "aria-hidden": "true" } }));
  if (type === "to_do") row.append(checkbox(content.checked === true, { label: "To-do", onToggle: writable ? (next) => action(async () => {
    await call("blocks.update", { block_id: block.id, to_do: { checked: next } }, key());
    await refreshBlocks(view, context);
  }) : undefined }));
  if (type === "toggle") {
    const open = view.expanded.has(block.id);
    const chevron = el("button", { class: `toggle-chevron ${open ? "open" : ""}`.trim(), attrs: { type: "button", "aria-label": open ? "Collapse" : "Expand", "aria-expanded": String(open) } }, icon("chevron_right"));
    chevron.addEventListener("click", () => {
      if (open) view.expanded.delete(block.id);
      else view.expanded.add(block.id);
      render(context.host, view, options);
    });
    row.append(chevron);
  }
  if (type === "callout") row.append(el("span", { class: "callout-icon", text: emojiOf(content.icon) ?? "💡", attrs: { "aria-hidden": "true" } }));
  if (type === "code") row.append(el("span", { class: "code-language", text: content.language ?? "plain text" }));
  const text = el("div", { class: `block-text ${type === "to_do" && content.checked ? "checked" : ""}`.trim(), attrs: { "data-placeholder": PLACEHOLDER[type] ?? "" } });
  if (content.color && content.color !== "default") text.dataset.color = content.color;
  if (writable) editableText(text, block, content, context);
  else text.append(richText(content.rich_text));
  if (plain(content.rich_text).length === 0) text.classList.add("empty");
  row.append(text);
  return row;
}

/** Plain-text editing of a text block: edits replace the block's rich text with one plain run. */
function editableText(text, block, content, context) {
  const { view, options } = context;
  const original = plain(content.rich_text);
  text.append(richText(content.rich_text));
  text.setAttribute("contenteditable", "plaintext-only");
  text.setAttribute("spellcheck", "false");
  text.setAttribute("role", "textbox");
  text.setAttribute("aria-label", `${block.type.replace(/_/g, " ")} block`);
  registerFormatTarget(text, { openComments: () => openBlockComments(block, context) });
  let menu;
  const currentText = () => text.textContent.replace(/ /g, " ");
  const commit = async () => {
    const next = currentText().replace(/\n$/, "");
    if (next === original) return false;
    await call("blocks.update", { block_id: block.id, [block.type]: { rich_text: textToRich(next) } }, key());
    return true;
  };
  text.addEventListener("focus", () => text.classList.remove("empty"));
  text.addEventListener("input", () => {
    const value = currentText();
    if (value.startsWith("/")) {
      const needle = value.slice(1);
      if (!menu || !menu.isConnected) {
        menu = openBlockMenu(text, (type) => insertFromSlash(block, type, context), { filter: needle });
        text.focus();
      } else menu.filter(needle);
    } else if (menu?.isConnected) {
      closePopovers();
      menu = undefined;
    }
  });
  text.addEventListener("blur", () => {
    if (currentText().length === 0) text.classList.add("empty");
    void action(async () => {
      if (await commit()) await refreshBlocks(view, context);
    }, { exclusive: false });
  });
  text.addEventListener("keydown", (event) => {
    if (menu?.isConnected && popoverOpen()) {
      if (event.key === "Enter") {
        event.preventDefault();
        menu.querySelector(".menu-item:not(:disabled)")?.click();
        return;
      }
      if (event.key === "Escape") return; // the popover handler closes it
    }
    if (event.key === "Enter" && !event.shiftKey && block.type !== "code") {
      event.preventDefault();
      const nextType = ["bulleted_list_item", "numbered_list_item", "to_do"].includes(block.type) && currentText().length > 0 ? block.type : "paragraph";
      void action(async () => {
        await commit();
        await appendBlockNow(view, options, context.parentId, newBlockInput(nextType), block.id, { silent: true });
      });
    } else if (event.key === "Backspace" && currentText().length === 0) {
      event.preventDefault();
      const previous = text.closest(".block")?.previousElementSibling;
      const previousId = previous?.getAttribute("data-block-id");
      void action(async () => {
        await call("blocks.delete", { block_id: block.id }, key());
        if (previousId) view.focusAfter = previousId;
        await refreshBlocks(view, context);
      });
    } else if (event.key === "Escape") {
      text.blur();
    }
  });
}

async function insertFromSlash(block, type, context) {
  const { view, options } = context;
  const host = context.host;
  const textNode = host.querySelector(`[data-block-id="${block.id}"] .block-text`);
  const typed = (textNode?.textContent ?? "").replace(/^\/\S*/, "").trim();
  if (type === "page") {
    await action(async () => {
      const created = await call("pages.create", { parent: { page_id: view.id }, properties: { title: textToRich(typed || "Untitled") } }, key());
      if (typed.length === 0 && textNode) await call("blocks.delete", { block_id: block.id }, key()).catch(() => undefined);
      await loadIndex();
      navigate({ name: "page", id: created.id });
    });
    return;
  }
  await action(async () => {
    const appended = await call("blocks.children.append", { block_id: context.parentId, children: [newBlockInput(type, typed)], after: block.id }, key());
    const emptyOriginal = (textNode?.textContent ?? "").replace(/^\/\S*/, "").trim().length === 0;
    if (emptyOriginal) await call("blocks.delete", { block_id: block.id }, key());
    view.focusAfter = appended.results[0]?.id;
    await refreshBlocks(view, context);
  });
}

/** Append one block (inside an already running action). */
async function appendBlockNow(view, options, parentId, input, afterId, { silent = false } = {}) {
  const appended = await call("blocks.children.append", { block_id: parentId, children: [input], ...(afterId ? { after: afterId } : {}) }, key());
  view.focusAfter = appended.results[0]?.id;
  await view.refresh();
  if (!silent) options.onChanged?.(view);
}

function appendBlock(view, options, parentId, input, afterId, flags) {
  return action(() => appendBlockNow(view, options, parentId, input, afterId, flags));
}

async function refreshBlocks(view, context) {
  await view.refresh();
  context.options.onChanged?.(view);
}

function gutter(block, context) {
  const { view, options } = context;
  const box = el("div", { class: "gutter", attrs: { "aria-hidden": "false" } });
  const add = iconButton("plus", "Add a block below", { class: "gutter-btn", tooltip: false });
  add.addEventListener("click", () => openBlockMenu(add, (type) => {
    if (type === "page") {
      void action(async () => {
        const created = await call("pages.create", { parent: { page_id: view.id }, properties: { title: textToRich("Untitled") } }, key());
        await loadIndex();
        navigate({ name: "page", id: created.id });
      });
      return;
    }
    void appendBlock(view, options, context.parentId, newBlockInput(type), block.id);
  }));
  const handle = iconButton("drag", "Block options", { class: "gutter-btn handle", tooltip: false });
  handle.addEventListener("click", () => openPopover(handle, [
    { header: block.type.replace(/_/g, " ") },
    { label: "Comment", icon: "comment", onSelect: () => openBlockComments(block, context) },
    { label: "Add block below", icon: "plus", onSelect: () => openBlockMenu(handle, (type) => appendBlock(view, options, context.parentId, newBlockInput(type), block.id)) },
    "divider",
    { label: "Delete", icon: "trash", danger: true, shortcut: "Del", onSelect: () => action(async () => {
      if (!(await confirmDialog("Delete this block?", "The block and anything nested inside it move to the trash.", "Delete"))) return;
      await call("blocks.delete", { block_id: block.id }, key());
      await refreshBlocks(view, context);
    }) },
  ], { width: 240 }));
  box.append(add, handle);
  return box;
}

function openBlockComments(block, context) {
  const { view, options } = context;
  const body = el("div", { class: "panel-comments" }, el("div", { class: "panel-loading", text: "Loading comments…" }));
  openSidePanel("Comments", body);
  void (async () => {
    try {
      const comments = await allComments(block.id);
      body.replaceChildren();
      body.append(el("div", { class: "panel-context" }, [icon("block_text", "panel-context-icon"), el("span", { text: plain(block[block.type]?.rich_text) || block.type })]));
      const discussions = groupDiscussions(comments);
      if (discussions.length === 0) body.append(el("div", { class: "panel-empty", text: "No comments on this block yet." }));
      for (const discussion of discussions) body.append(discussionBlock(discussion, view, options));
      if (canComment("read_insert") && !view.page.in_trash) {
        body.append(el("p", { class: "panel-note", text: "New block-level discussions cannot be started through the public API; reply in an existing one or comment on the page." }));
      }
    } catch (error) {
      body.replaceChildren(el("div", { class: "panel-empty", text: describe(error) }));
    }
  })();
}

// ---------------------------------------------------------------------------------------------
// Page-level actions (top bar): comments panel, more menu, move, markdown
// ---------------------------------------------------------------------------------------------

export function openCommentsPanel(view, options) {
  const body = el("div", { class: "panel-comments" });
  const fill = () => {
    body.replaceChildren();
    if (!canComment("read")) {
      body.append(el("div", { class: "panel-empty", text: "This integration can't read comments." }));
      return;
    }
    const discussions = groupDiscussions(view.comments);
    body.append(el("div", { class: "panel-tabs" }, [el("button", { class: "panel-tab active", text: "Open", attrs: { type: "button" } }), el("button", { class: "panel-tab", text: "Resolved", attrs: { type: "button", disabled: "" } })]));
    if (discussions.length === 0) body.append(el("div", { class: "panel-empty" }, [icon("comment", "panel-empty-icon"), el("p", { text: "No open comments yet" }), el("p", { class: "panel-note", text: "Comments on this page will appear here." })]));
    for (const discussion of discussions) body.append(discussionBlock(discussion, view, { onChanged: () => { options?.onChanged?.(view); fill(); } }));
  };
  fill();
  openSidePanel("Comments", body);
}

export function openMarkdownPanel(view, options) {
  const body = el("div", { class: "panel-markdown" }, el("div", { class: "panel-loading", text: "Rendering markdown…" }));
  openSidePanel("Markdown", body);
  void action(async () => {
    const rendered = await call("pages.retrieve-markdown", { page_id: view.id });
    body.replaceChildren();
    const area = el("textarea", { class: "markdown-area", attrs: { "aria-label": "Page markdown", spellcheck: "false", rows: "24" } });
    area.value = rendered.markdown;
    if (rendered.unknown_block_ids.length > 0) body.append(el("p", { class: "panel-note", text: `${rendered.unknown_block_ids.length} block(s) have no markdown form and are kept as <unknown/> tags.` }));
    body.append(area);
    if (canWrite() && !view.page.in_trash) {
      const apply = textButton("Replace page content", { class: "primary", onClick: () => action(async () => {
        if (!(await confirmDialog("Replace the page content?", "Blocks that are not in the markdown are moved to the trash; child pages and databases stay in place.", "Replace", { danger: false }))) return;
        await call("pages.update-markdown", { page_id: view.id, type: "replace_content", content: area.value, allow_deleting_content: true }, key());
        snackbar("Page content replaced from markdown");
        await view.refresh();
        options?.onChanged?.(view);
      }) });
      body.append(el("div", { class: "panel-actions" }, [apply]));
    } else body.append(el("p", { class: "panel-note", text: "Read-only: this integration cannot update content." }));
  }, { exclusive: false, onError: (error) => body.replaceChildren(el("div", { class: "panel-empty", text: describe(error) })) });
}

export function openMoveDialog(anchor, view, options) {
  const box = el("div", { class: "editor-options" });
  const search = el("input", { class: "editor-search", attrs: { type: "text", placeholder: "Move page to…", "aria-label": "Move page to" } });
  const list = el("div", { class: "picker-list", attrs: { role: "listbox" } });
  const excluded = new Set([view.id]);
  const isDescendant = (node) => {
    let current = node;
    for (let depth = 0; depth < 32 && current; depth += 1) {
      if (current.parent?.type === "page_id") {
        if (current.parent.page_id === view.id) return true;
        current = state.pages.get(current.parent.page_id);
      } else return false;
    }
    return false;
  };
  const render = () => {
    list.replaceChildren();
    const needle = search.value.trim().toLowerCase();
    const targets = [
      ...[...state.pages.values()].filter((page) => page.parent?.type !== "data_source_id" && !excluded.has(page.id) && !isDescendant(page)).map((page) => ({ label: page.title, emoji: page.icon, kind: "page", id: page.id })),
      ...[...state.databases.values()].map((database) => ({ label: database.title, emoji: database.icon, kind: "database", id: database.dataSourceId })),
    ].filter((target) => target.label.toLowerCase().includes(needle));
    if (targets.length === 0) list.append(el("div", { class: "picker-empty", text: "No pages found" }));
    for (const target of targets.slice(0, 40)) {
      const row = el("button", { class: "picker-item", attrs: { type: "button", role: "option" } }, [target.emoji ? el("span", { class: "picker-emoji", text: target.emoji }) : icon(target.kind === "database" ? "database" : "page", "picker-icon"), el("span", { class: "picker-label", text: target.label })]);
      row.addEventListener("click", () => action(async () => {
        closePopovers();
        const parent = target.kind === "database" ? { type: "data_source_id", data_source_id: target.id } : { type: "page_id", page_id: target.id };
        await call("pages.move", { page_id: view.id, parent }, key());
        snackbar(`Moved to ${target.label}`);
        await loadIndex();
        await view.refresh();
        options?.onChanged?.(view);
      }));
      list.append(row);
    }
  };
  search.addEventListener("input", render);
  box.append(search, list);
  render();
  return openPopover(anchor, box, { width: 320, align: "end" });
}

export function openPageMenu(anchor, view, options) {
  const page = view.page;
  const editor = state.users.get(page.last_edited_by?.id);
  const items = [
    { label: "Copy link", icon: "link", onSelect: () => navigator.clipboard?.writeText(page.url).then(() => snackbar("Link copied (synthetic notion.so URL)"), () => snackbar(page.url)) },
    { label: "Markdown", icon: "markdown", description: "View or replace the content as markdown", onSelect: () => openMarkdownPanel(view, options) },
  ];
  if (canWrite() && !page.in_trash) {
    items.push({ label: "Move to", icon: "move", shortcut: "⌘⇧P", onSelect: () => openMoveDialog(anchor, view, options) });
    items.push("divider", { label: "Move to Trash", icon: "trash", danger: true, onSelect: () => action(async () => {
      if (!(await confirmDialog("Move this page to Trash?", `"${pageTitle(page)}" and everything inside it move to the trash. You can restore it from Trash.`, "Move to Trash"))) return;
      await call("pages.update", { page_id: view.id, in_trash: true }, key());
      snackbar("Moved to Trash", { actionLabel: "Undo", onAction: async () => { await call("pages.update", { page_id: view.id, in_trash: false }, key()); await loadIndex(); await view.refresh(); options?.onChanged?.(view); } });
      await loadIndex();
      await view.refresh();
      options?.onChanged?.(view);
    }) });
  }
  const footer = el("div", { class: "menu-footer" }, [
    el("div", { text: `Last edited by ${editor?.name ?? userName(page.last_edited_by, state.users)}` }),
    el("div", { text: relativeTime(page.last_edited_time, state.nowMs) }),
  ]);
  const box = el("div");
  box.append(...[el("div", { class: "menu-header", text: "Page" })]);
  const menu = openPopover(anchor, items, { align: "end", width: 265 });
  menu.append(footer);
  return menu;
}

export function pageTopbarActions(view, options) {
  const page = view.page;
  const comments = iconButton("comment", "Comments", { onClick: () => openCommentsPanel(view, options) });
  const more = iconButton("more", "More", { onClick: () => openPageMenu(more, view, options) });
  const share = textButton("Share", { class: "share", onClick: () => openSharePopover(share, view) });
  const edited = el("span", { class: "topbar-edited", text: page ? `Edited ${relativeTime(page.last_edited_time, state.nowMs)}` : "" });
  const updates = unsimulatedButton("clock", "View all updates", "Page history and the updates feed are not part of the API subset this Tool serves. The page's last edit time is shown in the top bar.", { align: "end" });
  const favorite = unsimulatedButton("star", "Add to Favorites", "Favorites are a per-user app preference that the API does not expose, so this Tool does not store them.", { align: "end" });
  return [edited, share, comments, updates, favorite, more];
}

function openSharePopover(anchor, view) {
  const box = el("div", { class: "share-popover" });
  const integration = state.context?.integration;
  box.append(el("div", { class: "share-row head" }, [el("span", { text: "Share" }), el("span", { class: "share-badge", text: "Synthetic workspace" })]));
  box.append(el("input", { class: "editor-search", attrs: { type: "text", placeholder: "Sharing settings are not part of the public API", disabled: "" } }));
  box.append(el("div", { class: "share-row" }, [person({ id: integration?.id, name: integration?.name ?? "Integration" }, state.users), el("span", { class: "share-role", text: integration?.access?.type === "workspace" ? "Full workspace access" : "Shared pages only" })]));
  for (const user of [...state.users.values()].filter((user) => user.type === "person").slice(0, 6)) box.append(el("div", { class: "share-row" }, [person(user, state.users), el("span", { class: "share-role", text: user.is_guest ? "Guest" : "Can edit" })]));
  box.append(el("p", { class: "panel-note", text: `Visible to this integration: ${integration?.access?.type === "workspace" ? "every page of the workspace" : "the shared roots and their descendants"}. Page permissions cannot be changed through the API subset.` }));
  return openPopover(anchor, box, { width: 360, align: "end" });
}

export function placeCaretAtEnd(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

export { shortDate, $ };
