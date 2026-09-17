// Gmail Tool browser app. Every control calls the Tool's own operations through /_firedrill/client.js;
// nothing on this page is authoritative — records are re-read after each write and whenever the world revision moves.
import { hydrateIcons, icon } from "./icons.js";
import {
  $,
  $$,
  ToolError,
  action,
  avatar,
  call,
  closeMenus,
  confirmDialog,
  decodeBase64Url,
  describe,
  el,
  formatBytes,
  fullDate,
  hideSnackbar,
  htmlToText,
  iconButton,
  isPending,
  key,
  listDate,
  longDate,
  notSimulated,
  onBusy,
  openMenu,
  readPreference,
  snackbar,
  splitAddresses,
  watchWorld,
  writePreference,
} from "./ui.js";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const FOLDERS = {
  inbox: { hash: "inbox", title: "Inbox", query: "in:inbox" },
  starred: { hash: "starred", title: "Starred", query: "is:starred" },
  sent: { hash: "sent", title: "Sent", query: "in:sent" },
  drafts: { hash: "drafts", title: "Drafts", drafts: true },
  important: { hash: "imp", title: "Important", query: "is:important" },
  all: { hash: "all", title: "All Mail", query: "" },
  spam: { hash: "spam", title: "Spam", query: "in:spam", includeTrash: true },
  trash: { hash: "trash", title: "Trash", query: "in:trash", includeTrash: true },
  // Inbox category tabs and the More › Categories entries filter on the mailbox's own CATEGORY_* system labels.
  promotions: { hash: "category/promotions", title: "Promotions", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], tab: "promotions" },
  social: { hash: "category/social", title: "Social", labelIds: ["INBOX", "CATEGORY_SOCIAL"], tab: "social" },
  updates: { hash: "category/updates", title: "Updates", labelIds: ["INBOX", "CATEGORY_UPDATES"], tab: "updates" },
  forums: { hash: "category/forums", title: "Forums", labelIds: ["CATEGORY_FORUMS"] },
};
/** Categories that have an inbox tab; Primary is the inbox minus conversations filed under one of them. */
const TAB_CATEGORIES = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES"];
const PRIMARY_PAGE_LIMIT = 60;
// labels.list pages the app follows (100 labels each): covers the largest label bound a mailbox can declare (10,000).
const LABEL_PAGE_LIMIT = 120;
const FOLDER_BY_HASH = Object.fromEntries(Object.values(FOLDERS).map((folder) => [folder.hash, folder]));
const EMPTY_TEXT = {
  inbox: ["No new mail!", "Your inbox is empty."],
  starred: ["No starred messages.", "Stars let you give messages a special status to make them easier to find."],
  sent: ["No sent messages!", "Messages you send appear here."],
  drafts: ["You don't have any saved drafts.", "Saving a draft lets you keep a message you aren't ready to send yet."],
  important: ["No important messages.", "Messages marked important appear here."],
  all: ["No mail.", "This mailbox has no messages outside Spam and Trash."],
  spam: ["Hooray, no spam here!", ""],
  trash: ["No conversations in Trash.", "Trashed conversations can be moved back to the Inbox."],
  search: ["No messages matched your search.", "Try different keywords or search operators."],
  primary: ["Your Primary tab is empty.", "Personal messages and messages that don't appear in other tabs will be shown here."],
  promotions: ["Your Promotions tab is empty.", "Deals, offers, and other marketing emails will be shown here."],
  social: ["Your Social tab is empty.", "Messages from social networks and media-sharing sites will be shown here."],
  updates: ["Your Updates tab is empty.", "Notifications such as confirmations, receipts, bills and statements will be shown here."],
  forums: ["No conversations in Forums.", "Messages from online groups and mailing lists appear here."],
  label: ["There are no messages with this label.", ""],
};
// Label background palette (the set the mail API accepts); text colour is picked by luminance.
const PALETTE = [
  "#000000", "#434343", "#666666", "#999999", "#cccccc", "#efefef", "#f3f3f3", "#ffffff",
  "#fb4c2f", "#ffad47", "#fad165", "#16a766", "#43d692", "#4a86e8", "#a479e2", "#f691b3",
  "#f6c5be", "#ffe6c7", "#fef1d1", "#b9e4d0", "#c6f3de", "#c9daf8", "#e4d7f5", "#fcdee8",
  "#efa093", "#ffd6a2", "#fce8b3", "#89d3b2", "#a0eac9", "#a4c2f4", "#d0bcf1", "#fbc8d9",
  "#e66550", "#ffbc6b", "#fcda83", "#44b984", "#68dfa9", "#6d9eeb", "#b694e8", "#f7a7c0",
  "#cc3a21", "#eaa041", "#f2c960", "#149e60", "#3dc789", "#3c78d8", "#8e63ce", "#e07798",
  "#ac2b16", "#cf8933", "#d5ae49", "#0b804b", "#2a9c68", "#285bac", "#653e9b", "#b65775",
  "#822111", "#a46a21", "#aa8831", "#076239", "#1a764d", "#1c4587", "#41236d", "#83334c",
];

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

const state = {
  folder: FOLDERS.inbox,
  labelId: undefined,
  search: "",
  tokens: [undefined],
  offsets: [0],
  page: 0,
  pageSize: Number(readPreference("pageSize", "50")),
  rows: [],
  drafts: [],
  total: 0,
  nextToken: undefined,
  selected: new Set(),
  thread: undefined,
  expanded: new Set(),
  labels: [],
  counts: {},
  profile: undefined,
  nowMs: undefined,
  denied: false,
  navigation: 0,
  route: "",
};

const compose = {
  open: false,
  draftId: undefined,
  threadId: undefined,
  replyToMessageId: undefined,
  dirty: false,
  saving: false,
  sending: false,
  saveTimer: undefined,
  saveIntent: undefined,
  sendIntent: undefined,
  lastSaved: undefined,
};

const mode = () => (state.search ? "search" : state.labelId ? "label" : state.folder.drafts ? "drafts" : state.folder === FOLDERS.inbox ? "primary" : state.folder.tab ?? (state.folder === FOLDERS.forums ? "forums" : state.folder.hash));
const tabbed = () => !state.search && !state.labelId && (state.folder === FOLDERS.inbox || Boolean(state.folder.tab));

/** Phone-width layout: the header search collapses to an icon and expands into Gmail's mobile search bar. */
const compact = () => window.matchMedia("(max-width: 768px)").matches;
function setSearchBar(open, focus = false) {
  $(".gm-header").classList.toggle("searching", open);
  if (open && focus) $("#search").focus();
}
/** The world's virtual now (ms), taken from the last `profile.get`; the app never consults the browser clock. */
const nowMs = () => state.nowMs;

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

const userLabel = (id) => state.labels.find((label) => label.labelId === id);
const labelByName = (name) => state.labels.find((label) => label.name.toLowerCase() === String(name).toLowerCase());

function luminance(hex) {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!value) return 1;
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value[1].slice(offset, offset + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const textColorFor = (background) => (luminance(background) < 0.55 ? "#ffffff" : "#000000");

function labelChip(label) {
  const chip = el("span", { class: "gm-label-chip", text: label.name.split("/").pop(), title: label.name });
  if (label.color) {
    chip.style.background = label.color.backgroundColor;
    chip.style.color = label.color.textColor;
    if (luminance(label.color.backgroundColor) > 0.85) chip.classList.add("light");
  } else chip.classList.add("light");
  return chip;
}

function systemChip(text) {
  return el("span", { class: "gm-label-chip light", text });
}

function threadLabelIds(thread) {
  const ids = [];
  for (const message of thread.messages) for (const id of message.labelIds) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** Every label of the mailbox: follows nextPageToken until the list ends, so navigation and pickers are never partial. */
async function loadLabels() {
  const all = [];
  let pageToken;
  for (let page = 0; page < LABEL_PAGE_LIMIT; page += 1) {
    const result = await call("labels.list", { type: "all", pageSize: 100, ...(pageToken ? { pageToken } : {}) });
    all.push(...result.labels);
    pageToken = result.nextPageToken;
    if (!pageToken) break;
  }
  if (pageToken) throw new Error(`This mailbox holds more than ${LABEL_PAGE_LIMIT * 100} labels; the app does not show a partial label list.`);
  state.labels = all.filter((label) => label.type === "user").sort((a, b) => a.name.localeCompare(b.name));
  state.counts = Object.fromEntries(all.map((label) => [label.labelId, label]));
  renderNav();
}

function renderCount(element, value) {
  element.textContent = value > 0 ? String(value) : "";
}

function renderNav() {
  renderCount($("[data-count='INBOX']"), state.counts.INBOX?.threadsUnread ?? 0);
  renderCount($("[data-count='DRAFT']"), state.counts.DRAFT?.threadsTotal ?? 0);
  renderCount($("[data-count='SPAM']"), state.counts.SPAM?.threadsUnread ?? 0);
  const list = $("#labels");
  list.replaceChildren();
  const visible = state.labels.filter((label) => label.labelListVisibility !== "labelHide" || label.threadsUnread > 0);
  if (state.labels.length === 0) list.append(el("li", { class: "gm-nav-empty", text: "No labels yet. Use + to create one." }));
  for (const label of visible) {
    const item = el("li");
    const link = el("a", { attrs: { href: `#label/${encodeURIComponent(label.name)}`, title: label.name } });
    const glyph = icon("label_filled", "gm-label-icon");
    if (label.color) glyph.style.color = label.color.backgroundColor;
    else glyph.style.color = "";
    const parts = label.name.split("/");
    const parentShown = parts.length > 1 && visible.some((candidate) => candidate.name === parts.slice(0, -1).join("/"));
    if (parentShown) link.classList.add("nested");
    link.append(glyph, el("span", { class: "label", text: parentShown ? parts.at(-1) : label.name }));
    const count = el("span", { class: "count" });
    renderCount(count, label.threadsUnread);
    link.append(count);
    if (state.labelId === label.labelId && !state.search) link.setAttribute("aria-current", "page");
    const menuButton = iconButton("more_vert", `Options for label ${label.name}`, { class: "gm-label-menu", tooltip: false });
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.addEventListener("click", (event) => {
      event.preventDefault();
      openLabelOptions(menuButton, label);
    });
    item.append(link, menuButton);
    list.append(item);
  }
  markCurrentFolder();
}

function markCurrentFolder() {
  for (const link of $$("#folders a")) {
    const target = link.dataset.folder ? FOLDERS[link.dataset.folder] : FOLDERS[link.dataset.category];
    const current = !state.search && !state.labelId && (target === state.folder || (link.dataset.folder === "inbox" && Boolean(state.folder.tab)));
    if (current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const inMore = !state.search && !state.labelId && ["important", "all", "spam", "trash", "forums"].includes(Object.keys(FOLDERS).find((name) => FOLDERS[name] === state.folder));
  if (!state.search && !state.labelId && state.folder === FOLDERS.forums) $("#categories-toggle").setAttribute("aria-expanded", "true");
  if (inMore) setMore(true);
  const tabs = $("#category-tabs");
  tabs.hidden = !tabbed();
  for (const tab of $$(".gm-tab", tabs)) tab.setAttribute("aria-selected", String(tabbed() && tab.dataset.tab === (state.folder.tab ?? "primary")));
}

function setCategories(open) {
  const toggle = $("#categories-toggle");
  toggle.setAttribute("aria-expanded", String(open));
  const moreOpen = $("#more-toggle").getAttribute("aria-expanded") === "true";
  for (const item of $$("#folders .gm-nav-cat")) item.hidden = !(open && moreOpen);
}

function setMore(open) {
  const categoriesOpen = $("#categories-toggle").getAttribute("aria-expanded") === "true";
  for (const item of $$("#folders .gm-nav-more")) item.hidden = !open || (item.classList.contains("gm-nav-cat") && !categoriesOpen);
  const toggle = $("#more-toggle");
  toggle.setAttribute("aria-expanded", String(open));
  toggle.querySelector(".label").textContent = open ? "Less" : "More";
  toggle.querySelector(".icon").replaceWith(icon(open ? "expand_less" : "expand_more"));
}

function openLabelOptions(anchor, label) {
  openMenu(anchor, [
    { label: "Label color", icon: "label", onSelect: () => openPalette(anchor, label) },
    { label: "Edit", icon: "edit", onSelect: () => openLabelDialog({ label }) },
    { label: "Add sublabel", icon: "add", onSelect: () => openLabelDialog({ parent: label }) },
    "divider",
    {
      label: "Remove label",
      icon: "delete",
      onSelect: () =>
        action(async () => {
          const count = label.threadsTotal;
          const ok = await confirmDialog(
            `Remove the label "${label.name}"?`,
            count > 0 ? `The label is removed from ${count} conversation${count === 1 ? "" : "s"}. The messages themselves are kept.` : "This label is not used by any conversation.",
            "Remove",
            { danger: true },
          );
          if (!ok) return;
          const result = await call("labels.delete", { labelId: label.labelId }, key());
          if (state.labelId === label.labelId) navigate("#inbox");
          snackbar(`Label "${label.name}" removed (${result.messagesUpdated} message${result.messagesUpdated === 1 ? "" : "s"} updated).`);
          await refreshAll();
        }),
    },
  ]);
}

function openPalette(anchor, label) {
  const panel = el("div");
  panel.append(el("div", { class: "gm-menu-header", text: "Label color" }));
  const grid = el("div", { class: "gm-palette", attrs: { role: "group", "aria-label": "Label color" } });
  for (const color of PALETTE) {
    const swatch = el("button", { class: `gm-swatch${label.color?.backgroundColor === color ? " current" : ""}`, attrs: { type: "button", "aria-label": `Color ${color}` } });
    swatch.style.background = color;
    swatch.addEventListener("click", () =>
      action(async () => {
        closeMenus();
        await call("labels.update", { labelId: label.labelId, color: { backgroundColor: color, textColor: textColorFor(color) } }, key());
        await refreshAll();
      }),
    );
    grid.append(swatch);
  }
  panel.append(grid);
  if (label.color) {
    panel.append(el("div", { class: "gm-menu-divider" }));
    const remove = el("button", { class: "gm-menu-item", text: "Remove color", attrs: { type: "button", role: "menuitem" } });
    remove.addEventListener("click", () =>
      action(async () => {
        closeMenus();
        await call("labels.update", { labelId: label.labelId, color: { backgroundColor: "", textColor: "" } }, key());
        await refreshAll();
      }),
    );
    panel.append(remove);
  }
  openMenu(anchor, panel, { className: "gm-menu-palette" });
}

// Label dialog (create / edit / sublabel)
let labelDialogState = {};
function openLabelDialog({ label, parent } = {}) {
  labelDialogState = { label, parent };
  const dialog = $("#label-dialog");
  $("#label-dialog-title").textContent = label ? "Edit label" : "New label";
  $("#label-submit").textContent = label ? "Save" : "Create";
  $("#label-error").hidden = true;
  const select = $("#label-parent");
  select.replaceChildren(new Option("Please select a parent…", ""));
  for (const candidate of state.labels) if (!label || (candidate.labelId !== label.labelId && !candidate.name.startsWith(`${label.name}/`))) select.append(new Option(candidate.name, candidate.name));
  const parts = label ? label.name.split("/") : [];
  const parentName = parent?.name ?? (parts.length > 1 ? parts.slice(0, -1).join("/") : "");
  $("#label-name").value = label ? parts.at(-1) : "";
  $("#label-nest").checked = Boolean(parentName);
  select.disabled = !parentName;
  select.value = parentName;
  dialog.showModal();
  $("#label-name").focus();
}

async function submitLabelDialog() {
  const { label } = labelDialogState;
  const leaf = $("#label-name").value.trim();
  const error = $("#label-error");
  if (!leaf) {
    error.textContent = "Please enter a label name.";
    error.hidden = false;
    return;
  }
  const parentName = $("#label-nest").checked ? $("#label-parent").value : "";
  if ($("#label-nest").checked && !parentName) {
    error.textContent = "Please select a parent label.";
    error.hidden = false;
    return;
  }
  const displayName = parentName ? `${parentName}/${leaf}` : leaf;
  try {
    if (label) await call("labels.update", { labelId: label.labelId, displayName }, key());
    else await call("labels.create", { displayName }, key());
  } catch (caught) {
    error.textContent = caught instanceof ToolError && caught.is("ALREADY_EXISTS") ? "A label with this name already exists." : describe(caught);
    error.hidden = false;
    return;
  }
  $("#label-dialog").close();
  snackbar(label ? `Label renamed to "${displayName}".` : `Label "${displayName}" created.`);
  await refreshAll();
}

// ---------------------------------------------------------------------------------------------
// Routing (#inbox, #inbox/<threadId>, #label/<name>, #search/<query>, …)
// ---------------------------------------------------------------------------------------------

function currentListHash() {
  if (state.search) return `#search/${encodeURIComponent(state.search)}`;
  if (state.labelId) return `#label/${encodeURIComponent(userLabel(state.labelId)?.name ?? state.labelId)}`;
  return `#${state.folder.hash}`;
}

function navigate(hash) {
  if (location.hash === hash) void applyRoute();
  else location.hash = hash;
}

function parseHash() {
  const parts = location.hash.replace(/^#/, "").split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const [head = "inbox", second = "", third = ""] = parts;
  if (head === "label") return { kind: "label", labelName: second, threadId: third };
  if (head === "search") return { kind: "search", query: second, threadId: third };
  if (head === "category") {
    const key = `category/${second}`;
    return { kind: "folder", folder: Object.hasOwn(FOLDER_BY_HASH, key) ? FOLDER_BY_HASH[key] : FOLDERS.inbox, threadId: third };
  }
  return { kind: "folder", folder: Object.hasOwn(FOLDER_BY_HASH, head) ? FOLDER_BY_HASH[head] : FOLDERS.inbox, threadId: second };
}

async function applyRoute() {
  const route = parseHash();
  const previous = state.route;
  if (route.kind === "label") {
    const label = labelByName(route.labelName);
    state.labelId = label?.labelId ?? undefined;
    state.search = "";
    state.folder = FOLDERS.all;
    if (!label) {
      state.folder = FOLDERS.inbox;
      snackbar(`The label "${route.labelName}" does not exist.`, { error: true });
    }
  } else if (route.kind === "search") {
    state.search = route.query;
    state.labelId = undefined;
    state.folder = FOLDERS.all;
  } else {
    state.folder = route.folder;
    state.labelId = undefined;
    state.search = "";
  }
  $("#search").value = state.search;
  $("#search-clear").hidden = !state.search;
  setSearchBar(compact() && Boolean(state.search));
  const listHash = currentListHash();
  state.route = listHash;
  markCurrentFolder();
  renderNav();
  const listChanged = previous !== listHash;
  if (listChanged) {
    state.tokens = [undefined];
    state.page = 0;
    state.selected.clear();
  }
  if (route.threadId) {
    if (listChanged) void refreshList();
    await openThread(route.threadId);
  } else {
    state.thread = undefined;
    showView("list");
    if (listChanged || !state.rows.length) await refreshList();
    else renderRows();
  }
}

function showView(name) {
  $("#list-view").hidden = name !== "list";
  $("#thread-view").hidden = name !== "thread";
  // Phone layout: Gmail's floating Compose button sits over the conversation list only (CSS shows it below 769 px).
  $("#compose-fab").hidden = name !== "list";
  closeMenus();
}

function updateTitle() {
  const unread = state.counts.INBOX?.threadsUnread ?? 0;
  const where = state.search ? `Search results` : state.labelId ? (userLabel(state.labelId)?.name ?? "Label") : state.folder.title;
  const email = state.profile?.emailAddress ?? "";
  document.title = `${where}${where === "Inbox" && unread > 0 ? ` (${unread})` : ""}${email ? ` - ${email}` : ""} - Gmail (synthetic)`;
}

// ---------------------------------------------------------------------------------------------
// Conversation list
// ---------------------------------------------------------------------------------------------

function listQuery() {
  if (state.search) return { query: state.search, includeTrash: false };
  if (state.labelId) return { query: `label:${state.labelId}`, includeTrash: false };
  return { query: state.folder.query, includeTrash: Boolean(state.folder.includeTrash), labelIds: state.folder.labelIds };
}

/**
 * Read every page of one thread query. Used where Gmail's view spans the whole result (the Primary tab, "Mark all as
 * read"). Stops with an error instead of acting on a partial list when the result is larger than the page budget.
 */
async function loadAllThreads(args) {
  const threads = [];
  let pageToken;
  for (let page = 0; page < PRIMARY_PAGE_LIMIT; page += 1) {
    const result = await listThreads({ ...args, pageSize: 100, ...(pageToken ? { pageToken } : {}) });
    threads.push(...result.threads);
    pageToken = result.nextPageToken;
    if (!pageToken) return threads;
  }
  throw new Error(`This view holds more than ${PRIMARY_PAGE_LIMIT * 100} conversations; the app does not act on a partial list. Use search or the Promotions, Social and Updates tabs to narrow it.`);
}

/** The Tool's declared refusal for a response over its byte budget. */
const isTooLarge = (error) => error instanceof ToolError && error.is("FAILED_PRECONDITION") && error.message.startsWith("Response too large");

/**
 * One threads.list page. Normally one call returns every row with its message summaries, exactly as before. When one
 * conversation is too wide for a list entry (the Tool refuses that page with FAILED_PRECONDITION), the same page is
 * read again with withoutMessages (page tokens are shared by both shapes) and each row's summaries are read on their own,
 * so every other conversation still shows and the pager keeps working.
 */
async function listThreads(args) {
  try {
    const page = await call("threads.list", args);
    // A page cut short by the byte budget (the next conversation did not fit beside the others) is read the slow way
    // too, so the page holds pageSize rows like every other page instead of stopping at the wide conversation.
    if (!page.nextPageToken || page.threads.length >= args.pageSize) return page;
  } catch (error) {
    if (!isTooLarge(error)) throw error;
  }
  const page = await call("threads.list", { ...args, withoutMessages: true });
  const threads = [];
  for (const entry of page.threads) threads.push(await threadRowOf(entry));
  return { ...page, threads };
}

function addressOf(from) {
  const open = from.lastIndexOf("<");
  if (open < 0 || !from.endsWith(">")) return { address: from.trim() };
  const name = from.slice(0, open).trim().replace(/^"|"$/g, "");
  return { address: from.slice(open + 1, -1).trim(), ...(name ? { name } : {}) };
}

/**
 * Summaries for one listed conversation. A conversation whose summaries cannot fit one response even alone is shown
 * from its REST minimal rendering (every message id, label and size, so row actions still cover the whole
 * conversation) plus the latest message's From and Subject headers, and is marked too large to open in this app.
 */
async function threadRowOf(entry) {
  try {
    const thread = await call("threads.get", { threadId: entry.id, messageFormat: "MINIMAL" });
    return { id: thread.id, snippet: entry.snippet, historyId: thread.historyId, messages: thread.messages };
  } catch (error) {
    if (!isTooLarge(error)) throw error;
  }
  const slim = await call("threads.get", { threadId: entry.id, restFormat: "minimal" });
  const last = slim.messages.at(-1);
  const head = await call("messages.get", { id: last.id, format: "metadata", metadataHeaders: ["From", "Subject"] });
  const header = (name) => (head.payload?.headers ?? []).find((item) => item.name.toLowerCase() === name)?.value ?? "";
  const from = addressOf(header("from"));
  const messages = slim.messages.map((message) => ({ ...message, toRecipients: [], ccRecipients: [], attachmentCount: 0 }));
  Object.assign(messages[messages.length - 1], { sender: from.address, ...(from.name ? { senderName: from.name } : {}), subject: header("subject") });
  return { id: slim.id, snippet: entry.snippet, historyId: slim.historyId, messages, tooLarge: true };
}

const isTabCategorised = (thread) => thread.messages.some((message) => message.labelIds.some((id) => TAB_CATEGORIES.includes(id)));

function skeleton(count = 8) {
  const box = el("div");
  for (let index = 0; index < count; index += 1) box.append(el("div", { class: "gm-skeleton", attrs: { "aria-hidden": "true" } }));
  return box;
}

function stateBox(title, text, { iconName, button, error = false } = {}) {
  const box = el("div", { class: `gm-state${error ? " error" : ""}` });
  if (iconName) box.append(icon(iconName));
  box.append(el("h3", { text: title }));
  if (text) box.append(el("p", { text }));
  if (button) box.append(button);
  return box;
}

async function refreshList() {
  const generation = ++state.navigation;
  const rows = $("#rows");
  if (!state.rows.length) rows.replaceChildren(skeleton());
  $("#search-chips").hidden = !state.search;
  updateChips();
  try {
    const token = state.tokens[state.page];
    if (mode() === "drafts") {
      const result = await call("drafts.list", { pageSize: state.pageSize, ...(token ? { pageToken: token } : {}) });
      if (generation !== state.navigation) return;
      state.drafts = result.drafts;
      state.rows = [];
      state.total = result.resultSizeEstimate;
      state.nextToken = result.nextPageToken;
    } else if (mode() === "primary") {
      // Primary = Inbox minus Promotions/Social/Updates. The engine has no category: operator, so the whole Inbox is read
      // (bounded, never truncated) and paged locally.
      const all = (await loadAllThreads({ query: "in:inbox" })).filter((thread) => !isTabCategorised(thread));
      if (generation !== state.navigation) return;
      const start = state.page * state.pageSize;
      state.rows = all.slice(start, start + state.pageSize);
      state.drafts = [];
      state.total = all.length;
      state.nextToken = start + state.pageSize < all.length ? "local" : undefined;
    } else {
      const { query, includeTrash, labelIds } = listQuery();
      const result = await listThreads({ ...(query ? { query } : {}), ...(labelIds ? { labelIds } : {}), pageSize: state.pageSize, includeTrash, ...(token ? { pageToken: token } : {}) });
      if (generation !== state.navigation) return;
      state.rows = result.threads;
      state.drafts = [];
      state.total = result.resultSizeEstimate;
      state.nextToken = result.nextPageToken;
    }
    state.denied = false;
    for (const id of [...state.selected]) if (!state.rows.some((thread) => thread.id === id) && !state.drafts.some((draft) => draft.id === id)) state.selected.delete(id);
    renderRows();
  } catch (error) {
    if (generation !== state.navigation) return;
    state.rows = [];
    state.drafts = [];
    if (error instanceof ToolError && error.is("INVALID_PAGE_TOKEN") && state.page > 0) {
      state.tokens = [undefined];
      state.page = 0;
      return refreshList();
    }
    renderListError(error);
  }
  updateTitle();
}

function renderListError(error) {
  const retry = el("button", { class: "gm-text-btn", text: "Retry", attrs: { type: "button" } });
  retry.addEventListener("click", () => action(refreshList));
  let box;
  if (error instanceof ToolError && error.denied) {
    state.denied = true;
    box = stateBox("You don't have permission to view this mailbox", "The selected actor has no grant for reading conversations. Add the Gmail Tool grants to the actor in the world file and restart serve.", { iconName: "lock" });
  } else if (error instanceof ToolError && error.is("INVALID_ARGUMENT") && state.search) {
    box = stateBox("Your search could not be run", error.message, { iconName: "search" });
  } else box = stateBox("Oops… the mailbox could not be loaded", describe(error), { iconName: "error", button: retry, error: true });
  $("#rows").replaceChildren(box);
  renderPager(0);
  updateToolbar();
}

function participants(thread) {
  const me = state.profile?.emailAddress;
  const names = [];
  const drafts = thread.messages.some((message) => message.labelIds.includes("DRAFT"));
  if (thread.tooLarge) {
    // Only the latest message's From header is read for a conversation too large to list with summaries.
    const last = thread.messages.at(-1);
    const name = last.sender === me ? "me" : (last.senderName?.split(" ")[0] ?? (last.sender || "(unknown sender)").split("@")[0]);
    return { text: name, drafts, unreadNames: last.labelIds.includes("UNREAD") ? new Set([name]) : new Set() };
  }
  const sentOnly = thread.messages.every((message) => message.sender === me);
  if (sentOnly && (state.folder === FOLDERS.sent || state.folder === FOLDERS.all) && !state.search && !state.labelId) {
    const recipients = [...new Set(thread.messages.flatMap((message) => message.toRecipients))].map((address) => address.split("@")[0]);
    return { text: `To: ${recipients.join(", ") || "(no recipients)"}`, drafts, unreadNames: new Set() };
  }
  const unreadNames = new Set();
  for (const message of thread.messages) {
    if (message.labelIds.includes("DRAFT")) continue;
    const name = message.sender === me ? "me" : (message.senderName?.split(" ")[0] ?? message.sender.split("@")[0]);
    if (!names.includes(name)) names.push(name);
    if (message.labelIds.includes("UNREAD")) unreadNames.add(name);
  }
  const shown = names.length > 3 ? [names[0], "..", ...names.slice(-2)] : names;
  return { text: shown.join(", "), drafts, unreadNames };
}

function checkboxIcon(checked) {
  return icon(checked === "mixed" ? "check_box_indeterminate" : checked ? "check_box" : "check_box_blank");
}

function rowCheckbox(id, label, face) {
  const button = el("button", { class: "icon-btn gm-check", attrs: { type: "button", role: "checkbox", "aria-checked": String(state.selected.has(id)), "aria-label": `Select ${label}` } });
  button.append(checkboxIcon(state.selected.has(id)));
  // Phone widths show the sender's letter avatar in place of the checkbox, as the Gmail mobile client does; tapping it selects.
  if (face) button.append(avatar(face.name, face.address, "gm-row-avatar"));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSelected(id);
  });
  return button;
}

function toggleSelected(id, force) {
  const next = force ?? !state.selected.has(id);
  if (next) state.selected.add(id);
  else state.selected.delete(id);
  const row = $(`[data-id="${CSS.escape(id)}"]`, $("#rows"));
  if (row) {
    row.classList.toggle("selected", next);
    const check = row.querySelector(".gm-check");
    check.setAttribute("aria-checked", String(next));
    check.querySelector(".icon").replaceWith(checkboxIcon(next));
  }
  updateToolbar();
}

function renderRows() {
  const container = $("#rows");
  container.replaceChildren();
  const current = mode();
  if (current === "drafts") renderDraftRows(container);
  else renderThreadRows(container, current);
  const count = current === "drafts" ? state.drafts.length : state.rows.length;
  renderFolderBanner(current, count);
  renderPager(count);
  updateToolbar();
  updateTitle();
}

/** Gmail's notice above a non-empty Spam or Trash list. Permanent deletion and the 30-day purge are not modeled. */
const FOLDER_BANNERS = {
  spam: ["Messages that have been in Spam more than 30 days will be automatically deleted.", "Delete all spam messages now", "Delete all spam messages"],
  trash: ["Messages that have been in Trash more than 30 days will be automatically deleted.", "Empty Trash now", "Empty Trash"],
};
function renderFolderBanner(current, count) {
  const banner = $("#folder-banner");
  const entry = FOLDER_BANNERS[current];
  banner.hidden = !entry || count === 0;
  if (banner.hidden) return;
  const [text, actionLabel, name] = entry;
  $("#folder-banner-text").textContent = text;
  const button = $("#folder-banner-action");
  button.textContent = actionLabel;
  button.dataset.notSimulated = name;
  button.dataset.nsDetail = "Permanent deletion is not simulated: this Tool has no delete operation for messages and does not purge after 30 days. Delete forever is not available; Not spam and Move to Inbox still work. Nothing was changed.";
}

function renderThreadRows(container, current) {
  if (state.rows.length === 0) {
    const [title, text] = EMPTY_TEXT[current] ?? EMPTY_TEXT.all;
    const iconName = { search: "search", spam: "report", trash: "delete", promotions: "local_offer", social: "group", updates: "info", forums: "forum" }[current] ?? "inbox";
    container.append(stateBox(title, text, { iconName }));
    return;
  }
  const inbox = tabbed();
  for (const thread of state.rows) {
    const last = thread.messages.at(-1);
    const labels = threadLabelIds(thread);
    const unread = labels.includes("UNREAD");
    const row = el("div", { class: `gm-row${unread ? " unread" : ""}${state.selected.has(thread.id) ? " selected" : ""}`, attrs: { role: "listitem", tabindex: "0", "data-id": thread.id, "aria-label": `${last.subject || "(no subject)"}, ${unread ? "unread" : "read"}` } });
    const me = state.profile?.emailAddress;
    const lead = [...thread.messages].reverse().find((message) => !message.labelIds.includes("DRAFT") && message.sender !== me) ?? last;
    row.append(rowCheckbox(thread.id, last.subject || "conversation", { name: lead.sender === me ? state.profile?.displayName || "me" : lead.senderName || lead.sender, address: lead.sender }));

    const starred = labels.includes("STARRED");
    const star = iconButton(starred ? "star" : "star_border", starred ? "Starred" : "Not starred", { class: `gm-star${starred ? " on" : ""}` });
    star.addEventListener("click", (event) => {
      event.stopPropagation();
      void action(() => setThreadLabel(thread.id, "STARRED", !starred));
    });
    row.append(star);

    const important = labels.includes("IMPORTANT");
    const marker = iconButton(important ? "important" : "important_outline", important ? "Important — click to mark as not important" : "Click to mark as important", { class: `gm-important${important ? " on" : ""}` });
    marker.addEventListener("click", (event) => {
      event.stopPropagation();
      void action(() => setThreadLabel(thread.id, "IMPORTANT", !important));
    });
    row.append(marker);

    const who = participants(thread);
    const sender = el("div", { class: "gm-row-sender" });
    sender.append(el("span", { text: who.text }));
    if (who.drafts) sender.append(el("span", { class: "gm-draft-marker", text: who.text ? ", Draft" : "Draft" }));
    if (thread.tooLarge) sender.append(el("span", { class: "gm-too-large-marker", text: "Too large", attrs: { title: "This conversation is too large to open in this app (its messages pass the Tool's 900 KB response budget). Row actions still apply to every message." } }));
    if (thread.messages.filter((message) => !message.labelIds.includes("DRAFT")).length > 1) sender.append(el("span", { class: "gm-row-count", text: String(thread.messages.filter((message) => !message.labelIds.includes("DRAFT")).length) }));
    row.append(sender);

    const main = el("div", { class: "gm-row-main" });
    if (!inbox && labels.includes("INBOX")) main.append(systemChip("Inbox"));
    for (const id of labels) {
      const label = userLabel(id);
      if (label && id !== state.labelId) main.append(labelChip(label));
    }
    main.append(el("span", { class: "gm-row-subject", text: last.subject || "(no subject)" }));
    if (last.snippet) main.append(el("span", { class: "gm-row-snippet", text: last.snippet }));
    row.append(main);

    const end = el("div", { class: "gm-row-end" });
    if (thread.messages.some((message) => message.attachmentCount > 0)) end.append(el("span", { class: "gm-row-attach", title: "Has attachment" }, icon("attach_file")));
    end.append(el("span", { class: "gm-row-date", text: listDate(last.internalDate, nowMs()), title: longDate(last.internalDate) }));
    end.append(rowActions(thread, labels));
    row.append(end);

    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      openThreadRoute(thread.id);
    });
    row.addEventListener("keydown", (event) => onRowKey(event, thread, labels));
    container.append(row);
  }
}

function rowActions(thread, labels) {
  const actions = el("div", { class: "gm-row-actions" });
  const stop = (handler) => (event) => {
    event.stopPropagation();
    void action(handler);
  };
  if (labels.includes("TRASH")) {
    actions.append(iconButton("move_to_inbox", "Move to Inbox", { onClick: stop(() => restoreThreads([thread])) }));
  } else if (labels.includes("SPAM")) {
    actions.append(iconButton("move_to_inbox", "Not spam", { onClick: stop(() => notSpam([thread])) }));
    actions.append(iconButton("delete", "Delete", { onClick: stop(() => trashThreads([thread])) }));
  } else {
    if (labels.includes("INBOX")) actions.append(iconButton("archive", "Archive", { onClick: stop(() => archiveThreads([thread])) }));
    actions.append(iconButton("delete", "Delete", { onClick: stop(() => trashThreads([thread])) }));
    const unread = labels.includes("UNREAD");
    actions.append(iconButton(unread ? "mail_open" : "mail", unread ? "Mark as read" : "Mark as unread", { onClick: stop(() => markThreads([thread], !unread)) }));
    const snooze = iconButton("snooze", "Snooze");
    snooze.dataset.notSimulated = "Snooze";
    snooze.dataset.nsDetail = "Snoozing is not part of this Tool's mail model. Nothing was changed.";
    actions.append(snooze);
  }
  return actions;
}

function renderDraftRows(container) {
  if (state.drafts.length === 0) {
    const [title, text] = EMPTY_TEXT.drafts;
    container.append(stateBox(title, text, { iconName: "draft" }));
    return;
  }
  for (const draft of state.drafts) {
    const row = el("div", { class: `gm-row${state.selected.has(draft.id) ? " selected" : ""}`, attrs: { role: "listitem", tabindex: "0", "data-id": draft.id, "aria-label": `Draft: ${draft.subject || "(no subject)"}` } });
    row.append(rowCheckbox(draft.id, draft.subject || "draft"));
    row.append(el("span"), el("span"));
    const sender = el("div", { class: "gm-row-sender" });
    sender.append(el("span", { class: "gm-draft-marker", text: "Draft" }));
    if (draft.toRecipients.length > 0) sender.append(el("span", { class: "gm-row-count", text: `To: ${draft.toRecipients.map((address) => address.split("@")[0]).join(", ")}` }));
    row.append(sender);
    const main = el("div", { class: "gm-row-main" });
    main.append(el("span", { class: "gm-row-subject", text: draft.subject || "(no subject)" }));
    if (draft.plaintextBody) main.append(el("span", { class: "gm-row-snippet", text: draft.plaintextBody.replace(/\s+/g, " ").slice(0, 160) }));
    row.append(main);
    const end = el("div", { class: "gm-row-end" });
    end.append(el("span", { class: "gm-row-date", text: listDate(draft.internalDate, nowMs()), title: longDate(draft.internalDate) }));
    const actions = el("div", { class: "gm-row-actions" });
    actions.append(
      iconButton("delete", "Discard draft", {
        onClick: (event) => {
          event.stopPropagation();
          void action(() => discardDrafts([draft]));
        },
      }),
    );
    end.append(actions);
    row.append(end);
    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      void action(() => openCompose({ draft }));
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "o") {
        event.preventDefault();
        void action(() => openCompose({ draft }));
      } else if (event.key === "x") {
        event.preventDefault();
        toggleSelected(draft.id);
      } else if (event.key === "#") {
        event.preventDefault();
        void action(() => discardDrafts([draft]));
      } else moveCursor(event);
    });
    container.append(row);
  }
}

function renderPager(count) {
  const text = $("#pager-text");
  // Pages can hold fewer rows than the page size (the server also caps a page by response bytes), so the range starts
  // after the rows actually shown on earlier pages.
  const offset = state.offsets[state.page] ?? state.page * state.pageSize;
  if (count === 0) text.textContent = state.total > 0 && state.page > 0 ? `${offset + 1}–${offset} of ${state.total}` : "";
  else {
    const start = offset + 1;
    text.textContent = `${start}–${start + count - 1} of ${Math.max(state.total, start + count - 1)}`;
  }
  $("#page-newer").disabled = state.page === 0;
  $("#page-older").disabled = !state.nextToken;
}

function moveCursor(event) {
  if (!["ArrowDown", "ArrowUp", "j", "k"].includes(event.key)) return;
  const rows = $$("#rows .gm-row");
  if (rows.length === 0) return;
  const index = rows.indexOf(event.target.closest(".gm-row"));
  const next = event.key === "ArrowDown" || event.key === "j" ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1);
  rows[next].focus();
  event.preventDefault();
}

function onRowKey(event, thread, labels) {
  if (event.target !== event.currentTarget) return;
  switch (event.key) {
    case "Enter":
    case "o":
      event.preventDefault();
      openThreadRoute(thread.id);
      break;
    case "x":
      event.preventDefault();
      toggleSelected(thread.id);
      break;
    case "s":
      event.preventDefault();
      void action(() => setThreadLabel(thread.id, "STARRED", !labels.includes("STARRED")));
      break;
    case "e":
      event.preventDefault();
      if (labels.includes("INBOX")) void action(() => archiveThreads([thread]));
      break;
    case "#":
      event.preventDefault();
      void action(() => (labels.includes("TRASH") ? undefined : trashThreads([thread])));
      break;
    default:
      moveCursor(event);
  }
}

// Toolbar in list view --------------------------------------------------------------------

function selectedThreads() {
  return state.rows.filter((thread) => state.selected.has(thread.id));
}

function updateToolbar() {
  const current = mode();
  const selectedCount = state.selected.size;
  const pageCount = current === "drafts" ? state.drafts.length : state.rows.length;
  const all = $("#select-all");
  const checked = selectedCount === 0 ? "false" : selectedCount === pageCount ? "true" : "mixed";
  all.setAttribute("aria-checked", checked);
  all.querySelector(".icon").replaceWith(checkboxIcon(checked === "mixed" ? "mixed" : checked === "true"));
  all.disabled = pageCount === 0;
  $("#toolbar-idle").hidden = selectedCount > 0;
  $("#toolbar-selection").hidden = selectedCount === 0;
  const banner = $("#selection-banner");
  banner.hidden = !(selectedCount > 0 && selectedCount === pageCount && pageCount > 1);
  banner.textContent = `All ${pageCount} conversations on this page are selected.`;
  const threads = selectedThreads();
  const labels = threads.flatMap(threadLabelIds);
  const trash = current === "trash";
  const spam = current === "spam";
  const drafts = current === "drafts";
  $("#bulk-inbox").hidden = !trash;
  $("#bulk-archive").hidden = trash || spam || drafts;
  $("#bulk-spam").hidden = trash || spam || drafts;
  $("#bulk-not-spam").hidden = !spam;
  $("#bulk-delete").hidden = trash;
  $("#bulk-delete").setAttribute("aria-label", drafts ? "Discard drafts" : "Delete");
  $("#bulk-delete").title = drafts ? "Discard drafts" : "Delete";
  const anyUnread = labels.includes("UNREAD");
  $("#bulk-read").hidden = drafts || !anyUnread;
  $("#bulk-unread").hidden = drafts || anyUnread;
  $("#bulk-label").hidden = drafts;
  $("#bulk-move").hidden = drafts;
  $("#bulk-more").hidden = drafts;
  $("#bulk-snooze").hidden = drafts || trash;
  $("#bulk-tasks").hidden = drafts;
  $("#select-menu").disabled = pageCount === 0;
  $$("#toolbar-selection .gm-toolbar-divider").forEach((divider) => (divider.hidden = drafts));
}

function updateChips() {
  const tokens = state.search.split(/\s+/);
  for (const chip of $$("#search-chips .gm-chip[data-chip]")) chip.setAttribute("aria-pressed", String(tokens.includes(chip.dataset.chip)));
  const time = tokens.find((token) => /^older_than:/.test(token));
  const timeChip = $("#chip-time");
  timeChip.setAttribute("aria-pressed", String(Boolean(time)));
  timeChip.firstChild.textContent = time ? { "older_than:7d": "Older than a week", "older_than:1m": "Older than a month", "older_than:6m": "Older than 6 months", "older_than:1y": "Older than a year" }[time] ?? time : "Any time";
}

function toggleSearchTerm(term, { exclusivePrefix } = {}) {
  let tokens = state.search.split(/\s+/).filter(Boolean);
  const present = tokens.includes(term);
  if (exclusivePrefix) tokens = tokens.filter((token) => !token.startsWith(exclusivePrefix));
  if (!present && term) tokens.push(term);
  else if (present && !exclusivePrefix) tokens = tokens.filter((token) => token !== term);
  const query = tokens.join(" ").trim();
  navigate(query ? `#search/${encodeURIComponent(query)}` : "#inbox");
}

// ---------------------------------------------------------------------------------------------
// Mutations shared by rows, bulk toolbar and conversation view
// ---------------------------------------------------------------------------------------------

const messageIdsOf = (threads) => threads.flatMap((thread) => thread.messages.map((message) => message.id));
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Run one Tool call per item and keep going when the Tool refuses one, so a bulk action never stops half-way with the
 * earlier conversations changed and the later ones silently skipped. Only Tool outcomes are collected; a transport
 * failure still aborts. Returns the items that went through and the refusals, in order.
 */
async function eachItem(items, task) {
  const done = [];
  const failed = [];
  for (const item of items) {
    try {
      await task(item);
      done.push(item);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      failed.push({ item, error });
    }
  }
  return { done, failed };
}

/**
 * Report a bulk outcome the way Gmail's snackbar would if it were honest about partial results: the full count when
 * everything went through, otherwise "k of n … ; m skipped: <reason>" with the Tool's own reason (one per distinct
 * refusal, clipped), and Undo only for the conversations that actually changed.
 */
function reportBulk({ done, failed }, did, { noun = "conversation", skipped = [], actionLabel, onAction } = {}) {
  const total = done.length + failed.length + skipped.length;
  const undo = done.length > 0 && onAction ? { actionLabel, onAction } : {};
  if (failed.length === 0 && skipped.length === 0) {
    snackbar(`${plural(done.length, noun)} ${did}.`, undo);
    return;
  }
  const reasons = [...new Set(failed.map(({ error }) => clipText(describe(error))))];
  if (skipped.length > 0) reasons.unshift(`${plural(skipped.length, noun)} already in Trash`);
  const detail = reasons.length <= 2 ? reasons.join("; ") : `${reasons.slice(0, 2).join("; ")}; and ${reasons.length - 2} more`;
  snackbar(`${done.length} of ${plural(total, noun)} ${did}; ${failed.length + skipped.length} skipped: ${detail}`, { ...undo, error: true, timeout: 12000 });
}

const clipText = (text) => (text.length > 160 ? `${text.slice(0, 160)}…` : text);

async function batchModify(ids, addLabelIds, removeLabelIds) {
  for (let index = 0; index < ids.length; index += 100) {
    await call("messages.batch-modify", { ids: ids.slice(index, index + 100), ...(addLabelIds?.length ? { addLabelIds } : {}), ...(removeLabelIds?.length ? { removeLabelIds } : {}) }, key());
  }
}

async function setThreadLabel(threadId, labelId, on) {
  await call(on ? "threads.label" : "threads.unlabel", { threadId, labelIds: [labelId] }, key());
  await refreshAll();
}

async function afterListMutation() {
  state.selected.clear();
  if (state.thread) {
    state.thread = undefined;
    navigate(currentListHash());
  }
  await refreshAll();
}

async function archiveThreads(threads) {
  const ids = messageIdsOf(threads);
  await batchModify(ids, [], ["INBOX"]);
  snackbar(`${plural(threads.length, "conversation")} archived.`, { actionLabel: "Undo", onAction: () => batchModify(ids, ["INBOX"], []).then(refreshAll) });
  await afterListMutation();
}

async function trashThreads(threads) {
  // threads.trash refuses a conversation whose every message is already in Trash (possible from search results or
  // a label view); skip those client-side and report them instead of letting one refusal stop the loop.
  const inTrash = (thread) => thread.messages.every((message) => message.labelIds.includes("TRASH"));
  const skipped = threads.filter(inTrash);
  const outcome = await eachItem(threads.filter((thread) => !inTrash(thread)), (thread) => call("threads.trash", { id: thread.id }, key()));
  const ids = messageIdsOf(outcome.done);
  reportBulk(outcome, "moved to Trash", {
    skipped,
    actionLabel: "Undo",
    onAction: async () => {
      reportBulk(await eachItem(ids, (id) => call("messages.untrash", { id }, key())), "restored", { noun: "message" });
      await refreshAll();
    },
  });
  await afterListMutation();
}

async function restoreThreads(threads) {
  const ids = messageIdsOf(threads);
  await batchModify(ids, ["INBOX"], ["TRASH"]);
  snackbar(`${plural(threads.length, "conversation")} moved to Inbox.`, { actionLabel: "Undo", onAction: () => batchModify(ids, ["TRASH"], ["INBOX"]).then(refreshAll) });
  await afterListMutation();
}

async function spamThreads(threads) {
  const ids = messageIdsOf(threads);
  await batchModify(ids, ["SPAM"], ["INBOX"]);
  snackbar(`${plural(threads.length, "conversation")} reported as spam.`, { actionLabel: "Undo", onAction: () => batchModify(ids, ["INBOX"], ["SPAM"]).then(refreshAll) });
  await afterListMutation();
}

async function notSpam(threads) {
  const ids = messageIdsOf(threads);
  await batchModify(ids, ["INBOX"], ["SPAM"]);
  snackbar(`${plural(threads.length, "conversation")} moved to Inbox.`, { actionLabel: "Undo", onAction: () => batchModify(ids, ["SPAM"], ["INBOX"]).then(refreshAll) });
  await afterListMutation();
}

async function markThreads(threads, read) {
  const ids = messageIdsOf(threads);
  await batchModify(ids, read ? [] : ["UNREAD"], read ? ["UNREAD"] : []);
  snackbar(`${plural(threads.length, "conversation")} marked as ${read ? "read" : "unread"}.`, { actionLabel: "Undo", onAction: () => batchModify(ids, read ? ["UNREAD"] : [], read ? [] : ["UNREAD"]).then(refreshAll) });
  state.selected.clear();
  await refreshAll();
}

async function discardDrafts(drafts) {
  const outcome = await eachItem(drafts, (draft) => call("drafts.delete", { id: draft.id }, key()));
  if (outcome.done.some((draft) => draft.id === compose.draftId)) closeCompose();
  reportBulk(outcome, "discarded", {
    noun: "draft",
    actionLabel: "Undo",
    onAction: async () => {
      reportBulk(await eachItem(outcome.done, (draft) => call("drafts.create", draftFields(draft), key())), "restored", { noun: "draft" });
      await refreshAll();
    },
  });
  state.selected.clear();
  await refreshAll();
}

function draftFields(draft) {
  const fields = { subject: draft.subject, body: draft.plaintextBody };
  if (draft.toRecipients.length) fields.to = draft.toRecipients;
  if (draft.ccRecipients.length) fields.cc = draft.ccRecipients;
  if (draft.bccRecipients.length) fields.bcc = draft.bccRecipients;
  return fields;
}

function openLabelMenu(anchor, threads) {
  if (threads.length === 0) return;
  const panel = el("div");
  panel.append(el("div", { class: "gm-menu-header", text: "Label as:" }));
  const search = el("input", { class: "gm-menu-search", attrs: { type: "text", placeholder: "Search labels", "aria-label": "Search labels" } });
  panel.append(search);
  const list = el("div");
  const render = () => {
    list.replaceChildren();
    const needle = search.value.trim().toLowerCase();
    const labels = state.labels.filter((label) => label.name.toLowerCase().includes(needle));
    if (labels.length === 0) list.append(el("div", { class: "gm-menu-header", text: needle ? "No labels match" : "No labels yet" }));
    for (const label of labels) {
      const checked = threads.every((thread) => threadLabelIds(thread).includes(label.labelId));
      const item = el("button", { class: "gm-menu-item", attrs: { type: "button", role: "menuitemcheckbox", "aria-checked": String(checked) } });
      item.append(icon(checked ? "check_box" : "check_box_blank", "menu-check"), el("span", { class: "gm-menu-label", text: label.name }));
      if (label.color) {
        const swatch = el("span", { class: "gm-menu-swatch" });
        swatch.style.background = label.color.backgroundColor;
        item.append(swatch);
      }
      item.addEventListener("click", () =>
        action(async () => {
          closeMenus();
          const outcome = await eachItem(threads, (thread) => call(checked ? "threads.unlabel" : "threads.label", { threadId: thread.id, labelIds: [label.labelId] }, key()));
          reportBulk(outcome, checked ? `no longer labeled "${label.name}"` : `labeled "${label.name}"`);
          state.selected.clear();
          await refreshAll();
        }),
      );
      list.append(item);
    }
  };
  search.addEventListener("input", render);
  render();
  panel.append(list, el("div", { class: "gm-menu-divider" }));
  const create = el("button", { class: "gm-menu-item", attrs: { type: "button", role: "menuitem" } });
  create.append(el("span", { class: "menu-icon" }), el("span", { class: "gm-menu-label", text: "Create new" }));
  create.addEventListener("click", () => {
    closeMenus();
    openLabelDialog();
  });
  panel.append(create);
  openMenu(anchor, panel, { className: "gm-menu-labels" });
}

/** "Move to": file conversations under a label (leaving the Inbox), into a category tab, or to Spam / Trash. */
function openMoveMenu(anchor, threads) {
  if (threads.length === 0) return;
  const panel = el("div");
  panel.append(el("div", { class: "gm-menu-header", text: "Move to:" }));
  const search = el("input", { class: "gm-menu-search", attrs: { type: "text", placeholder: "Search", "aria-label": "Search labels to move to" } });
  panel.append(search);
  const list = el("div");
  const categories = [
    ["Social", "CATEGORY_SOCIAL"],
    ["Updates", "CATEGORY_UPDATES"],
    ["Forums", "CATEGORY_FORUMS"],
    ["Promotions", "CATEGORY_PROMOTIONS"],
  ];
  const item = (label, onSelect) => {
    const button = el("button", { class: "gm-menu-item", attrs: { type: "button", role: "menuitem" } });
    button.append(el("span", { class: "gm-menu-label", text: label }));
    button.addEventListener("click", () => {
      closeMenus();
      void action(onSelect);
    });
    return button;
  };
  const ids = messageIdsOf(threads);
  const render = () => {
    list.replaceChildren();
    const needle = search.value.trim().toLowerCase();
    const match = (name) => name.toLowerCase().includes(needle);
    for (const [name, id] of categories.filter(([name]) => match(name))) {
      list.append(
        item(name, async () => {
          await batchModify(ids, [id, "INBOX"], categories.map(([, other]) => other).filter((other) => other !== id));
          snackbar(`${plural(threads.length, "conversation")} moved to "${name}".`);
          await afterListMutation();
        }),
      );
    }
    const labels = state.labels.filter((label) => match(label.name));
    if (labels.length) list.append(el("div", { class: "gm-menu-divider" }));
    for (const label of labels) {
      list.append(
        item(label.name, async () => {
          const remove = ["INBOX", ...(state.labelId && state.labelId !== label.labelId ? [state.labelId] : [])];
          await batchModify(ids, [label.labelId], remove);
          snackbar(`${plural(threads.length, "conversation")} moved to "${label.name}".`, { actionLabel: "Undo", onAction: () => batchModify(ids, remove, [label.labelId]).then(refreshAll) });
          await afterListMutation();
        }),
      );
    }
    list.append(el("div", { class: "gm-menu-divider" }));
    if (match("Spam")) list.append(item("Spam", () => spamThreads(threads)));
    if (match("Trash")) list.append(item("Trash", () => trashThreads(threads)));
  };
  search.addEventListener("input", render);
  render();
  panel.append(list, el("div", { class: "gm-menu-divider" }));
  const create = el("button", { class: "gm-menu-item", attrs: { type: "button", role: "menuitem" } });
  create.append(el("span", { class: "gm-menu-label", text: "Create new" }));
  create.addEventListener("click", () => {
    closeMenus();
    openLabelDialog();
  });
  panel.append(create);
  openMenu(anchor, panel, { className: "gm-menu-labels" });
}

/** Toolbar "More" for selected conversations or the open conversation. */
function openMoreMenu(anchor, threads) {
  if (threads.length === 0) return;
  const labels = threads.flatMap(threadLabelIds);
  const ids = messageIdsOf(threads);
  const anyUnread = labels.includes("UNREAD");
  const allImportant = threads.every((thread) => threadLabelIds(thread).includes("IMPORTANT"));
  const allStarred = threads.every((thread) => threadLabelIds(thread).includes("STARRED"));
  const modify = (add, remove, text) =>
    action(async () => {
      await batchModify(ids, add, remove);
      snackbar(text);
      state.selected.clear();
      await refreshAll();
    });
  const count = plural(threads.length, "conversation");
  openMenu(anchor, [
    anyUnread ? { label: "Mark as read", icon: "mail_open", onSelect: () => action(() => markThreads(threads, true)) } : { label: "Mark as unread", icon: "mail", onSelect: () => action(() => markThreads(threads, false)) },
    allImportant ? { label: "Mark as not important", icon: "important_outline", onSelect: () => modify([], ["IMPORTANT"], `${count} marked as not important.`) } : { label: "Mark as important", icon: "important", onSelect: () => modify(["IMPORTANT"], [], `${count} marked as important.`) },
    allStarred ? { label: "Remove star", icon: "star_border", onSelect: () => modify([], ["STARRED"], `Star removed from ${count}.`) } : { label: "Add star", icon: "star", onSelect: () => modify(["STARRED"], [], `${count} starred.`) },
    "divider",
    { label: "Filter messages like these", icon: "filter_list", notSimulated: "Filters are account settings that this Tool does not model." },
    { label: "Mute", icon: "volume_off", notSimulated: "Muting conversations is not part of this Tool's mail model." },
  ]);
}

/** The caret beside the select-all checkbox: All / None / Read / Unread / Starred / Unstarred on this page. */
function openSelectMenu(anchor) {
  const rows = mode() === "drafts" ? state.drafts.map((draft) => ({ id: draft.id, labels: [] })) : state.rows.map((thread) => ({ id: thread.id, labels: threadLabelIds(thread) }));
  const pick = (predicate) => () => {
    for (const row of rows) toggleSelected(row.id, predicate(row));
  };
  const items = [
    { label: "All", onSelect: pick(() => true) },
    { label: "None", onSelect: pick(() => false) },
  ];
  if (mode() !== "drafts")
    items.push(
      { label: "Read", onSelect: pick((row) => !row.labels.includes("UNREAD")) },
      { label: "Unread", onSelect: pick((row) => row.labels.includes("UNREAD")) },
      { label: "Starred", onSelect: pick((row) => row.labels.includes("STARRED")) },
      { label: "Unstarred", onSelect: pick((row) => !row.labels.includes("STARRED")) },
    );
  openMenu(anchor, items);
}

/** Toolbar "More email options" with nothing selected. */
function openListMoreMenu(anchor) {
  const drafts = mode() === "drafts";
  openMenu(anchor, [
    {
      label: "Mark all as read",
      icon: "done_all",
      disabled: drafts || state.denied,
      onSelect: () =>
        action(async () => {
          const { query, includeTrash, labelIds } = listQuery();
          let threads = await loadAllThreads({ ...(query ? { query } : {}), ...(labelIds ? { labelIds } : {}), includeTrash });
          if (mode() === "primary") threads = threads.filter((thread) => !isTabCategorised(thread));
          const unread = threads.filter((thread) => threadLabelIds(thread).includes("UNREAD"));
          if (unread.length === 0) return snackbar("There are no unread conversations here.");
          const ok = await confirmDialog("Confirm bulk action", `This will mark ${plural(unread.length, "conversation")} in this view as read.`, "OK");
          if (!ok) return undefined;
          await batchModify(messageIdsOf(unread), [], ["UNREAD"]);
          snackbar(`${plural(unread.length, "conversation")} marked as read.`);
          return refreshAll();
        }),
    },
    { label: "Select messages to see more actions", disabled: true },
  ]);
}

// ---------------------------------------------------------------------------------------------
// Conversation view
// ---------------------------------------------------------------------------------------------

function openThreadRoute(threadId) {
  navigate(`${currentListHash()}/${threadId}`);
}

async function openThread(threadId, { markRead = true } = {}) {
  const generation = ++state.navigation;
  showView("thread");
  const firstOpen = state.thread?.id !== threadId;
  if (firstOpen) {
    $("#messages").replaceChildren(skeleton(3));
    $("#thread-subject").textContent = "";
    $("#thread-chips").replaceChildren();
    state.expanded.clear();
  }
  let thread;
  try {
    thread = await call("threads.get", { threadId, messageFormat: "FULL_CONTENT" });
    if (markRead && threadLabelIds(thread).includes("UNREAD")) {
      await call("threads.unlabel", { threadId, labelIds: ["UNREAD"] }, key());
      const unreadIds = thread.messages.filter((message) => message.labelIds.includes("UNREAD")).map((message) => message.id);
      for (const id of unreadIds) state.expanded.add(id);
      thread = await call("threads.get", { threadId, messageFormat: "FULL_CONTENT" });
      void loadLabels();
    }
  } catch (error) {
    if (generation !== state.navigation) return;
    if (error instanceof ToolError && error.is("NOT_FOUND")) {
      snackbar("This conversation is no longer in the mailbox — the world may have been reset.", { error: true });
      navigate(currentListHash());
      return;
    }
    if (isTooLarge(error)) {
      $("#messages").replaceChildren(stateBox("This conversation is too large to open here", "Its messages together pass the 900 KB response budget of this synthetic mailbox, so the Tool refuses to return the whole conversation. It stays in your lists, where archive, labels, read state and Trash still apply to every message.", { iconName: "info" }));
      return;
    }
    $("#messages").replaceChildren(stateBox(error instanceof ToolError && error.denied ? "You don't have permission to read this conversation" : "Oops… the conversation could not be loaded", describe(error), { iconName: error instanceof ToolError && error.denied ? "lock" : "error", error: true }));
    return;
  }
  if (generation !== state.navigation) return;
  if (firstOpen) {
    const last = thread.messages.at(-1);
    if (last) state.expanded.add(last.id);
  }
  state.thread = thread;
  renderThread();
}

function renderThread() {
  const thread = state.thread;
  const labels = threadLabelIds(thread);
  const last = thread.messages.at(-1);
  $("#thread-subject").textContent = last?.subject || "(no subject)";
  const chips = $("#thread-chips");
  chips.replaceChildren();
  const removable = (chip, name, labelId) => {
    chip.classList.add("gm-chip-remove");
    const remove = el("button", { class: "gm-chip-x", title: `Remove label ${name}`, attrs: { type: "button", "aria-label": `Remove label ${name} from this conversation` } }, icon("close"));
    remove.addEventListener("click", () =>
      action(async () => {
        if (labelId === "INBOX") return archiveThreads([thread]);
        await call("threads.unlabel", { threadId: thread.id, labelIds: [labelId] }, key());
        snackbar(`Label "${name}" removed from the conversation.`);
        return refreshAll();
      }),
    );
    chip.append(remove);
    return chip;
  };
  if (labels.includes("INBOX")) chips.append(removable(systemChip("Inbox"), "Inbox", "INBOX"));
  for (const id of labels) {
    const label = userLabel(id);
    if (label) chips.append(removable(labelChip(label), label.name, label.labelId));
  }

  const trash = labels.includes("TRASH") && !labels.includes("INBOX");
  const spam = labels.includes("SPAM");
  $("#thread-inbox").hidden = !trash;
  $("#thread-archive").hidden = trash || spam || !labels.includes("INBOX");
  $("#thread-spam").hidden = trash || spam;
  $("#thread-not-spam").hidden = !spam;
  $("#thread-delete").hidden = trash;

  const container = $("#messages");
  container.replaceChildren();
  for (const message of thread.messages) container.append(messageCard(message, thread));
  const others = last ? [...new Set([...last.toRecipients, ...last.ccRecipients, last.sender])].filter((address) => address !== state.profile?.emailAddress) : [];
  $("#thread-reply-all").hidden = others.length < 2;
  $("#thread-actions").hidden = thread.messages.length === 0;

  const index = state.rows.findIndex((row) => row.id === thread.id);
  $("#thread-position").textContent = index >= 0 ? `${state.page * state.pageSize + index + 1} of ${Math.max(state.total, state.rows.length)}` : "";
  $("#thread-newer").disabled = index <= 0;
  $("#thread-older").disabled = index < 0 || index >= state.rows.length - 1;
  updateTitle();
}

function messageCard(message, thread) {
  const me = state.profile?.emailAddress;
  const expanded = state.expanded.has(message.id);
  const card = el("article", { class: `gm-message${expanded ? "" : " collapsed"}`, attrs: { "data-id": message.id } });
  const head = el("div", { class: "gm-message-head" });
  const isMe = message.sender === me;
  const name = isMe ? (state.profile?.displayName ?? "me") : (message.senderName ?? message.sender);
  head.append(avatar(name, message.sender));
  const who = el("div", { class: "gm-message-who" });
  if (expanded) {
    const sender = el("div", { class: "gm-message-sender" });
    sender.append(el("span", { class: "name", text: name }));
    if (message.labelIds.includes("DRAFT")) sender.append(el("span", { class: "gm-draft-marker", text: "Draft" }));
    sender.append(el("span", { class: "address", text: `<${message.sender}>` }));
    who.append(sender);
    const toLine = el("button", { class: "gm-message-to", attrs: { type: "button", "aria-expanded": "false" } });
    const recipients = message.toRecipients.map((address) => (address === me ? "me" : address.split("@")[0]));
    toLine.append(el("span", { text: recipients.length ? `to ${recipients.join(", ")}` : "to (no recipients)" }), icon("arrow_drop_down"));
    who.append(toLine);
    const details = el("dl", { class: "gm-message-details" });
    details.hidden = true;
    const detailRow = (term, value) => details.append(el("dt", { text: term }), el("dd", { text: value }));
    detailRow("from:", `${name} <${message.sender}>`);
    detailRow("to:", message.toRecipients.join(", ") || "—");
    if (message.ccRecipients.length) detailRow("cc:", message.ccRecipients.join(", "));
    if (message.bccRecipients.length) detailRow("bcc:", message.bccRecipients.join(", "));
    detailRow("date:", longDate(message.internalDate));
    detailRow("subject:", message.subject || "(no subject)");
    if (message.messageIdHeader) detailRow("message-id:", message.messageIdHeader);
    toLine.addEventListener("click", (event) => {
      event.stopPropagation();
      details.hidden = !details.hidden;
      toLine.setAttribute("aria-expanded", String(!details.hidden));
    });
    card.detailsElement = details;
  } else {
    who.append(el("div", { class: "gm-message-sender" }, el("span", { class: "name", text: name })));
    who.append(el("div", { class: "gm-message-snippet", text: message.snippet || "(empty message)" }));
  }
  head.append(who);

  const meta = el("div", { class: "gm-message-meta" });
  meta.append(el("span", { text: expanded ? fullDate(message.internalDate, nowMs()) : listDate(message.internalDate, nowMs()), title: longDate(message.internalDate) }));
  if (expanded) {
    const starred = message.labelIds.includes("STARRED");
    const star = iconButton(starred ? "star" : "star_border", starred ? "Starred" : "Not starred", { class: `gm-star${starred ? " on" : ""}` });
    star.addEventListener("click", (event) => {
      event.stopPropagation();
      void action(async () => {
        await call(starred ? "messages.unlabel" : "messages.label", { messageId: message.id, labelIds: ["STARRED"] }, key());
        await refreshAll();
      });
    });
    const reply = iconButton("reply", "Reply", {
      onClick: (event) => {
        event.stopPropagation();
        void action(() => openCompose({ replyTo: message, thread }));
      },
    });
    const more = iconButton("more_vert", "More");
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      openMessageMenu(more, message, thread);
    });
    const react = iconButton("add_reaction", "Add emoji reaction");
    react.dataset.notSimulated = "Emoji reactions";
    react.dataset.nsDetail = "Emoji reactions are not part of this Tool's mail model. Nothing was sent.";
    meta.append(star, react, reply, more);
  }
  head.append(meta);
  head.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    if (state.expanded.has(message.id)) state.expanded.delete(message.id);
    else state.expanded.add(message.id);
    renderThread();
  });
  card.append(head);
  if (!expanded) return card;
  if (card.detailsElement) card.append(card.detailsElement);

  const { text, quoted, note } = splitBody(message);
  card.append(el("div", { class: "gm-message-body", text: text || "(empty message)" }));
  if (note) card.append(el("p", { class: "gm-body-note", text: note }));
  if (quoted) {
    const toggle = el("button", { class: "gm-quote-toggle", text: "···", attrs: { type: "button", "aria-label": "Show trimmed content", "aria-expanded": "false" } });
    const quote = el("blockquote", { class: "gm-quote", text: quoted });
    quote.hidden = true;
    toggle.addEventListener("click", () => {
      quote.hidden = !quote.hidden;
      toggle.setAttribute("aria-expanded", String(!quote.hidden));
    });
    card.append(toggle, quote);
  }
  if (message.attachments?.length) {
    const box = el("div", { class: "gm-attachments" });
    box.append(el("div", { class: "gm-attachments-head" }, [icon("attach_file"), el("span", { text: `${plural(message.attachments.length, "Attachment")} · ${message.attachments.map((attachment) => attachment.filename).join(", ")}` })]));
    for (const attachment of message.attachments) {
      const chip = el("button", { class: "gm-attachment", attrs: { type: "button", title: `Preview ${attachment.filename}` } });
      chip.append(el("div", { class: "gm-attachment-preview" }, icon("description")));
      chip.append(el("div", { class: "gm-attachment-info" }, [icon("description"), el("span", { class: "gm-attachment-name", text: attachment.filename }), el("span", { class: "gm-attachment-size", text: formatBytes(attachment.size) })]));
      chip.addEventListener("click", () => action(() => previewAttachment(message, attachment)));
      box.append(chip);
    }
    card.append(box);
  }
  return card;
}

/** Split quoted replies ("On … wrote:" + "> " lines) from the fresh text, the way the conversation view trims quotes. */
function splitBody(message) {
  let source = message.plaintextBody ?? "";
  let note;
  if (!source && message.htmlBody) {
    source = htmlToText(message.htmlBody);
    note = "This message was sent as HTML; it is shown here as plain text.";
  }
  const lines = source.split("\n");
  let cut = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^On .+wrote:\s*$/.test(lines[index]) || /^-{5,} (Forwarded|Original) message -{5,}$/i.test(lines[index]) || (lines[index].startsWith(">") && lines.slice(index).every((line) => line.startsWith(">") || line.trim() === ""))) {
      cut = index;
      break;
    }
  }
  if (cut <= 0) return { text: source.trim(), note };
  return { text: lines.slice(0, cut).join("\n").trim(), quoted: lines.slice(cut).join("\n").trim(), note };
}

function openMessageMenu(anchor, message, thread) {
  const unread = message.labelIds.includes("UNREAD");
  const trashed = message.labelIds.includes("TRASH");
  openMenu(
    anchor,
    [
      { label: "Reply", icon: "reply", onSelect: () => action(() => openCompose({ replyTo: message, thread })) },
      { label: "Reply all", icon: "reply_all", onSelect: () => action(() => openCompose({ replyTo: message, thread, replyAll: true })) },
      { label: "Forward", icon: "forward_arrow", onSelect: () => action(() => openCompose({ forward: message, thread })) },
      "divider",
      { label: "Filter messages like this", icon: "filter_list", notSimulated: "Filters are account settings that this Tool does not model." },
      { label: "Print", icon: "print", notSimulated: "Gmail's print view is not simulated by this Tool." },
      "divider",
      {
        label: unread ? "Mark as read" : "Mark as unread",
        icon: unread ? "mail_open" : "mail",
        onSelect: () =>
          action(async () => {
            await call("messages.modify", unread ? { id: message.id, removeLabelIds: ["UNREAD"] } : { id: message.id, addLabelIds: ["UNREAD"] }, key());
            if (!unread) {
              navigate(currentListHash());
              snackbar("Message marked as unread.");
            }
            await refreshAll();
          }),
      },
      {
        label: trashed ? "Restore this message" : "Delete this message",
        icon: trashed ? "restore" : "delete",
        onSelect: () =>
          action(async () => {
            await call(trashed ? "messages.untrash" : "messages.trash", { id: message.id }, key());
            snackbar(trashed ? "Message moved to Inbox." : "Message moved to Trash.", {
              actionLabel: "Undo",
              onAction: async () => {
                await call(trashed ? "messages.trash" : "messages.untrash", { id: message.id }, key());
                await refreshAll();
              },
            });
            await refreshAll();
          }),
      },
    ],
    { align: "end" },
  );
}

async function previewAttachment(message, attachment) {
  const result = await call("attachments.get", { messageId: message.id, id: attachment.id });
  $("#preview-title").textContent = attachment.filename;
  $("#preview-meta").textContent = `${attachment.mimeType} · ${formatBytes(result.size)}`;
  $("#preview-body").textContent = result.size === 0 ? "(zero-byte attachment)" : attachment.mimeType.startsWith("text/") || /json|xml|csv/.test(attachment.mimeType) ? decodeBase64Url(result.data) : "(binary attachment — preview shows text content only)";
  $("#preview-dialog").showModal();
}

async function refreshAll() {
  await loadLabels();
  if (state.thread && !$("#thread-view").hidden) {
    await openThread(state.thread.id, { markRead: false });
    void refreshList();
  } else await refreshList();
}

function threadNavigate(delta) {
  const index = state.rows.findIndex((row) => row.id === state.thread?.id);
  const next = state.rows[index + delta];
  if (next) openThreadRoute(next.id);
}

// ---------------------------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------------------------

function composeFields() {
  return {
    to: splitAddresses($("#to").value),
    cc: splitAddresses($("#cc").value),
    bcc: splitAddresses($("#bcc").value),
    subject: $("#subject").value,
    body: $("#body-text").value,
  };
}

function composeArguments({ forCreate = false } = {}) {
  const fields = composeFields();
  const args = { subject: fields.subject, body: fields.body };
  if (fields.to.length) args.to = fields.to;
  if (fields.cc.length) args.cc = fields.cc;
  if (fields.bcc.length) args.bcc = fields.bcc;
  if (forCreate && compose.replyToMessageId) args.replyToMessageId = compose.replyToMessageId;
  else if (forCreate && compose.threadId) args.threadId = compose.threadId;
  return args;
}

const composeHasContent = () => {
  const fields = composeFields();
  return fields.to.length > 0 || fields.cc.length > 0 || fields.bcc.length > 0 || fields.subject.trim() !== "" || fields.body.trim() !== "";
};

function setComposeStatus(text, error = false) {
  const status = $("#compose-status");
  status.textContent = text;
  status.dataset.error = String(error);
}

function setComposeTitle() {
  const subject = $("#subject").value.trim();
  $("#compose-title").textContent = subject || "New Message";
}

function quoteHeader(message) {
  const name = message.senderName ? `${message.senderName} <${message.sender}>` : message.sender;
  return `On ${longDate(message.internalDate)}, ${name} wrote:`;
}

async function openCompose({ draft, replyTo, forward, thread, replyAll = false } = {}) {
  if (compose.open && compose.dirty && composeHasContent()) {
    await saveDraft({ silent: true }).catch(() => undefined);
  }
  clearTimeout(compose.saveTimer);
  compose.open = true;
  compose.dirty = false;
  compose.saving = false;
  compose.sending = false;
  compose.saveIntent = undefined;
  compose.sendIntent = undefined;
  compose.draftId = draft?.id;
  compose.threadId = draft?.threadId ?? replyTo?.threadId ?? forward?.threadId;
  compose.replyToMessageId = replyTo?.id;
  const me = state.profile?.emailAddress;
  let to = "";
  let cc = "";
  let subject = "";
  let body = "";
  if (draft) {
    to = draft.toRecipients.join(", ");
    cc = draft.ccRecipients.join(", ");
    $("#bcc").value = draft.bccRecipients.join(", ");
    subject = draft.subject;
    body = draft.plaintextBody;
  } else if (replyTo) {
    const target = replyTo.sender === me ? replyTo.toRecipients : [replyTo.sender];
    to = target.join(", ");
    if (replyAll) cc = [...new Set([...replyTo.toRecipients, ...replyTo.ccRecipients])].filter((address) => address !== me && !target.includes(address)).join(", ");
    subject = /^re:/i.test(replyTo.subject) ? replyTo.subject : `Re: ${replyTo.subject}`;
    const original = (replyTo.plaintextBody ?? (replyTo.htmlBody ? htmlToText(replyTo.htmlBody) : "")).split("\n").map((line) => `> ${line}`).join("\n");
    body = `\n\n${quoteHeader(replyTo)}\n${original}`;
  } else if (forward) {
    subject = /^fwd?:/i.test(forward.subject) ? forward.subject : `Fwd: ${forward.subject}`;
    const original = forward.plaintextBody ?? (forward.htmlBody ? htmlToText(forward.htmlBody) : "");
    body = `\n\n---------- Forwarded message ---------\nFrom: ${forward.senderName ? `${forward.senderName} <${forward.sender}>` : forward.sender}\nDate: ${longDate(forward.internalDate)}\nSubject: ${forward.subject}\nTo: ${forward.toRecipients.join(", ")}\n\n${original}`;
  }
  if (!draft) $("#bcc").value = "";
  $("#to").value = to;
  $("#cc").value = cc;
  $("#subject").value = subject;
  $("#body-text").value = body;
  $("#cc-field").hidden = !cc;
  $("#bcc-field").hidden = !$("#bcc").value;
  $("#show-cc").hidden = Boolean(cc);
  $("#show-bcc").hidden = Boolean($("#bcc").value);
  compose.lastSaved = draft ? JSON.stringify(composeArguments()) : undefined;
  setComposeStatus(draft ? "Saved" : "");
  setComposeTitle();
  lockCompose(false);
  // On phones the navigation is a drawer: Gmail closes it when Compose takes over the screen.
  if (compact()) {
    $("#nav").classList.add("collapsed");
    $("#menu-toggle").setAttribute("aria-expanded", "false");
  }
  const window_ = $("#compose-window");
  window_.classList.remove("minimized");
  window_.hidden = false;
  if (draft || replyTo) {
    const area = $("#body-text");
    area.focus();
    area.setSelectionRange(0, 0);
  } else if (forward) $("#to").focus();
  else $("#to").focus();
  void thread;
}

function closeCompose() {
  clearTimeout(compose.saveTimer);
  compose.open = false;
  compose.dirty = false;
  compose.draftId = undefined;
  compose.threadId = undefined;
  compose.replyToMessageId = undefined;
  compose.saveIntent = undefined;
  compose.sendIntent = undefined;
  compose.lastSaved = undefined;
  const window_ = $("#compose-window");
  window_.hidden = true;
  window_.classList.remove("minimized", "fullscreen");
  $("#compose-expand").querySelector(".icon").replaceWith(icon("open_in_full"));
  for (const field of ["#to", "#cc", "#bcc", "#subject", "#body-text"]) $(field).value = "";
  setComposeStatus("");
}

function lockCompose(locked) {
  for (const field of $$("#compose-form input, #compose-form textarea")) field.readOnly = locked;
  $("#send").disabled = locked;
}

function scheduleAutosave() {
  clearTimeout(compose.saveTimer);
  compose.saveTimer = setTimeout(() => {
    if (!compose.open || compose.sending || compose.saving) return;
    if (!composeHasContent()) return;
    if (JSON.stringify(composeArguments()) === compose.lastSaved) return;
    void action(() => saveDraft({ silent: true }), { exclusive: false, onError: () => undefined });
  }, 2000);
}

async function saveDraft({ silent = false } = {}) {
  if (compose.saving) return undefined;
  if (!compose.saveIntent) compose.saveIntent = { args: composeArguments({ forCreate: !compose.draftId }), key: key(), draftId: compose.draftId };
  compose.saving = true;
  setComposeStatus("Saving…");
  try {
    const intent = compose.saveIntent;
    const draft = intent.draftId ? await call("drafts.update", { id: intent.draftId, ...intent.args }, intent.key) : await call("drafts.create", intent.args, intent.key);
    compose.draftId = draft.id;
    compose.threadId = draft.threadId;
    compose.saveIntent = undefined;
    compose.dirty = JSON.stringify(composeArguments()) !== JSON.stringify(intent.args);
    compose.lastSaved = JSON.stringify(intent.args);
    setComposeStatus("Saved");
    if (compose.dirty) scheduleAutosave();
    void loadLabels();
    if (mode() === "drafts") void refreshList();
    return draft;
  } catch (error) {
    if (error instanceof ToolError) compose.saveIntent = undefined;
    setComposeStatus(error instanceof ToolError ? `Not saved: ${describe(error)}` : "Save result uncertain — retrying with the same key.", true);
    if (!silent) throw error;
    return undefined;
  } finally {
    compose.saving = false;
  }
}

async function sendMessage() {
  if (compose.sending) return;
  clearTimeout(compose.saveTimer);
  const fields = composeFields();
  if (fields.to.length + fields.cc.length + fields.bcc.length === 0) {
    setComposeStatus("Please specify at least one recipient.", true);
    $("#to").focus();
    return;
  }
  compose.sending = true;
  lockCompose(true);
  setComposeStatus("Sending…");
  try {
    if (!compose.sendIntent) {
      if (compose.draftId && JSON.stringify(composeArguments()) !== compose.lastSaved) {
        compose.saveIntent = undefined;
        await saveDraft();
      }
      compose.sendIntent = compose.draftId ? { operation: "drafts.send", args: { id: compose.draftId }, key: key() } : { operation: "messages.send", args: composeArguments({ forCreate: true }), key: key() };
    }
    const intent = compose.sendIntent;
    const result = await call(intent.operation, intent.args, intent.key);
    compose.sendIntent = undefined;
    closeCompose();
    snackbar("Message sent.", { actionLabel: "View message", onAction: () => navigate(`#sent/${result.threadId}`) });
    await refreshAll();
  } catch (error) {
    if (error instanceof ToolError) compose.sendIntent = undefined;
    setComposeStatus(error instanceof ToolError ? `Not sent: ${describe(error)}` : "Send result uncertain — Send again retries with the same key.", true);
  } finally {
    compose.sending = false;
    if (compose.open) lockCompose(false);
  }
}

// ---------------------------------------------------------------------------------------------
// Header popovers (account, help, search options) and quick settings
// ---------------------------------------------------------------------------------------------

function openPopover(anchor, content) {
  const panel = el("div");
  panel.append(content);
  openMenu(anchor, panel, { align: "end", className: "gm-popover" });
}

function accountPopover(anchor) {
  const box = el("div", { class: "gm-popover-account" });
  const profile = state.profile;
  const name = profile?.displayName || profile?.emailAddress || "Unknown account";
  const close = iconButton("close", "Close", { class: "gm-account-close", onClick: () => closeMenus() });
  box.append(close, el("div", { class: "gm-account-email", text: profile?.emailAddress ?? "No mailbox: the actor has no grants." }));
  box.append(avatar(name, profile?.emailAddress ?? ""), el("h2", { text: profile?.displayName ? `Hi, ${profile.displayName.split(" ")[0]}!` : "Hi!" }));
  const manage = el("button", { class: "gm-outline-btn", text: "Manage your Google Account", attrs: { type: "button" } });
  manage.dataset.notSimulated = "Manage your Google Account";
  manage.dataset.nsDetail = "Google Account settings are not simulated. The mailbox identity comes from the Firedrill actor.";
  box.append(manage);
  const actions = el("div", { class: "gm-account-actions" });
  const add = el("button", { attrs: { type: "button" } }, [icon("person_add"), el("span", { text: "Add account" })]);
  add.dataset.notSimulated = "Add account";
  add.dataset.nsDetail = "Accounts are Firedrill actors. Choose another actor with firedrill serve --actor <id>.";
  const out = el("button", { attrs: { type: "button" } }, [icon("logout"), el("span", { text: "Sign out" })]);
  out.dataset.notSimulated = "Sign out";
  out.dataset.nsDetail = "There is no sign-in in a local world; stop serve to end the session.";
  actions.append(add, out);
  box.append(actions);
  if (profile) box.append(el("div", { class: "meta", text: `${plural(profile.messagesTotal, "message")} · ${plural(profile.threadsTotal, "conversation")} · synthetic account (actor "${state.actorId ?? "?"}")` }));
  const legal = el("div", { class: "gm-account-legal" });
  for (const [label, detail] of [["Privacy Policy", "Google's privacy policy is not part of this synthetic mailbox."], ["Terms of Service", "Google's terms are not part of this synthetic mailbox."]]) {
    const button = el("button", { text: label, attrs: { type: "button" } });
    button.dataset.notSimulated = label;
    button.dataset.nsDetail = detail;
    legal.append(button);
  }
  box.append(legal);
  openPopover(anchor, box);
}

function aboutPopover(anchor) {
  const box = el("div");
  box.append(el("h2", { text: "About this mailbox" }));
  box.append(el("p", { text: "This is a synthetic Gmail mailbox served by a Firedrill Tool. Every button here calls the same operations your agent calls, and both see the same records. Nothing is delivered outside the local world; sending only stores a Sent copy and delivers to other synthetic mailboxes." }));
  box.append(el("p", { text: "Search supports from:, to:, cc:, subject:, label:, in:, is:unread|read|starred|important, has:attachment, newer_than:, older_than:, after:, before:, filename:, quoted phrases, -negation, OR and ( ) groups. Unsupported operators are refused instead of ignored." }));
  box.append(el("p", { text: "Controls that say \u201cNot simulated by this Tool\u201d exist in Gmail but are outside this Tool's model; they change nothing." }));
  box.append(el("p", { text: "Gmail and the Gmail logo are trademarks of Google LLC, used only to identify the simulated service. No affiliation or endorsement." }));
  openPopover(anchor, box);
}

function helpMenu(anchor) {
  openMenu(
    anchor,
    [
      { label: "Help", icon: "help_center", onSelect: () => aboutPopover(anchor) },
      { label: "Training", icon: "school", notSimulated: "Gmail training content is not part of this Tool." },
      { label: "Updates", icon: "new_releases", notSimulated: "Gmail product updates are not part of this Tool." },
      "divider",
      { label: "Send feedback to Google", icon: "feedback", notSimulated: "Feedback is never sent anywhere from a local Firedrill world." },
    ],
    { align: "end" },
  );
}

function searchOptionsPopover(anchor) {
  const form = el("form", { class: "gm-advanced", attrs: { novalidate: "" } });
  form.append(el("h2", { text: "Search options" }));
  const field = (label, name, placeholder) => {
    const row = el("label", { class: "gm-advanced-row" });
    row.append(el("span", { text: label }), el("input", { attrs: { type: "text", name, placeholder: placeholder ?? "", autocomplete: "off" } }));
    return row;
  };
  form.append(field("From", "from"), field("To", "to"), field("Subject", "subject"), field("Has the words", "words"), field("Doesn't have", "not"));
  const attachment = el("label", { class: "gm-checkbox" });
  attachment.append(el("input", { attrs: { type: "checkbox", name: "attachment" } }), el("span", { text: "Has attachment" }));
  form.append(attachment);
  const actions = el("div", { class: "gm-dialog-actions" });
  const submit = el("button", { class: "gm-filled-btn", text: "Search", attrs: { type: "submit" } });
  actions.append(submit);
  form.append(actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const quote = (value) => (/\s/.test(value) ? `"${value}"` : value);
    const parts = [];
    for (const [name, operator] of [["from", "from:"], ["to", "to:"], ["subject", "subject:"]]) {
      const value = String(data.get(name) ?? "").trim();
      if (value) parts.push(`${operator}${quote(value)}`);
    }
    const words = String(data.get("words") ?? "").trim();
    if (words) parts.push(words);
    const not = String(data.get("not") ?? "").trim();
    if (not) parts.push(...not.split(/\s+/).map((word) => `-${word}`));
    if (data.get("attachment")) parts.push("has:attachment");
    closeMenus();
    if (parts.length) navigate(`#search/${encodeURIComponent(parts.join(" "))}`);
  });
  const menu = openMenu(anchor, form, { align: "start", className: "gm-popover gm-popover-search" });
  menu.style.width = `${Math.min(720, anchor.closest(".gm-search").getBoundingClientRect().width)}px`;
  const rect = anchor.closest(".gm-search").getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  form.querySelector("input").focus();
}

function setSidePanel(open) {
  $(".gm-body").classList.toggle("side-hidden", !open);
  $("#side-show").hidden = open;
  writePreference("sidePanel", open ? "open" : "hidden");
  if (open) $("#side-hide").focus();
  else $("#side-show").focus();
}

function applyDensity(value) {
  document.body.classList.remove("density-default", "density-comfortable", "density-compact");
  document.body.classList.add(`density-${value}`);
  for (const radio of $$("input[name='density']")) radio.checked = radio.value === value;
  writePreference("density", value);
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

function wire() {
  window.addEventListener("hashchange", () => void applyRoute());

  // Phone drawer: tapping the dimmed content outside it closes it, as in Gmail's mobile web layout.
  document.addEventListener("click", (event) => {
    const nav = $("#nav");
    if (!compact() || nav.classList.contains("collapsed")) return;
    if (event.target.closest?.("#nav, #menu-toggle, .gm-popover, dialog")) return;
    nav.classList.add("collapsed");
    $("#menu-toggle").setAttribute("aria-expanded", "false");
  });
  $("#menu-toggle").addEventListener("click", () => {
    const nav = $("#nav");
    nav.classList.toggle("collapsed");
    $("#menu-toggle").setAttribute("aria-expanded", String(!nav.classList.contains("collapsed")));
  });
  $("#more-toggle").addEventListener("click", () => setMore($("#more-toggle").getAttribute("aria-expanded") !== "true"));
  $("#compose").addEventListener("click", () => action(() => openCompose()));
  $("#compose-fab").addEventListener("click", () => action(() => openCompose()));
  $("#label-create").addEventListener("click", () => openLabelDialog());

  // Search
  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (compact() && !$(".gm-header").classList.contains("searching")) {
      setSearchBar(true, true);
      return;
    }
    const query = $("#search").value.trim();
    navigate(query ? `#search/${encodeURIComponent(query)}` : "#inbox");
  });
  $("#search-back").addEventListener("click", () => {
    if (state.search) navigate("#inbox");
    else {
      $("#search").value = "";
      $("#search-clear").hidden = true;
      setSearchBar(false);
    }
  });
  $("#search").addEventListener("input", () => ($("#search-clear").hidden = !$("#search").value));
  $("#search-clear").addEventListener("click", () => {
    $("#search").value = "";
    navigate("#inbox");
  });
  $("#search-options").addEventListener("click", () => searchOptionsPopover($("#search-options")));
  for (const chip of $$("#search-chips .gm-chip[data-chip]")) chip.addEventListener("click", () => toggleSearchTerm(chip.dataset.chip));
  $("#chip-time").addEventListener("click", () =>
    openMenu(
      $("#chip-time"),
      [
        ["Any time", ""],
        ["Older than a week", "older_than:7d"],
        ["Older than a month", "older_than:1m"],
        ["Older than 6 months", "older_than:6m"],
        ["Older than a year", "older_than:1y"],
      ].map(([label, term]) => ({ label, onSelect: () => toggleSearchTerm(term, { exclusivePrefix: "older_than:" }) })),
    ),
  );

  // Header
  $("#account").addEventListener("click", () => accountPopover($("#account")));
  $("#help").addEventListener("click", () => helpMenu($("#help")));
  $("#side-hide").addEventListener("click", () => setSidePanel(false));
  $("#side-show").addEventListener("click", () => setSidePanel(true));
  $("#categories-toggle").addEventListener("click", () => setCategories($("#categories-toggle").getAttribute("aria-expanded") !== "true"));
  $("#nav-create-label").addEventListener("click", () => openLabelDialog());
  $("#select-menu").addEventListener("click", () => openSelectMenu($("#select-menu")));
  $("#list-more").addEventListener("click", () => openListMoreMenu($("#list-more")));
  $("#bulk-move").addEventListener("click", () => openMoveMenu($("#bulk-move"), selectedThreads()));
  $("#bulk-more").addEventListener("click", () => openMoreMenu($("#bulk-more"), selectedThreads()));
  $("#thread-move").addEventListener("click", () => openMoveMenu($("#thread-move"), [state.thread]));
  $("#thread-more").addEventListener("click", () => openMoreMenu($("#thread-more"), [state.thread]));
  $("#format-toggle").addEventListener("click", () => {
    const hidden = $("#compose-window").classList.toggle("no-format");
    $("#format-toggle").setAttribute("aria-pressed", String(!hidden));
  });
  // Gmail controls outside this Tool's model: one delegated handler opens the explanation, nothing is written.
  document.addEventListener(
    "click",
    (event) => {
      const control = event.target.closest?.("[data-not-simulated]");
      if (!control) return;
      event.preventDefault();
      event.stopPropagation();
      notSimulated(control, control.dataset.notSimulated, control.dataset.nsDetail);
    },
    true,
  );
  $("#settings").addEventListener("click", () => {
    const panel = $("#quick-settings");
    panel.hidden = !panel.hidden;
    $("#settings").setAttribute("aria-expanded", String(!panel.hidden));
  });
  $("#quick-settings-close").addEventListener("click", () => {
    $("#quick-settings").hidden = true;
    $("#settings").setAttribute("aria-expanded", "false");
  });
  for (const radio of $$("input[name='density']")) radio.addEventListener("change", () => applyDensity(radio.value));
  $("#page-size").addEventListener("change", () => {
    state.pageSize = Number($("#page-size").value);
    writePreference("pageSize", String(state.pageSize));
    state.tokens = [undefined];
    state.page = 0;
    void action(refreshList);
  });

  // List toolbar
  $("#refresh").addEventListener("click", () => action(refreshAll));
  $("#select-all").addEventListener("click", () => {
    const ids = mode() === "drafts" ? state.drafts.map((draft) => draft.id) : state.rows.map((thread) => thread.id);
    const all = ids.length > 0 && ids.every((id) => state.selected.has(id));
    for (const id of ids) toggleSelected(id, !all);
  });
  $("#page-older").addEventListener("click", () =>
    action(async () => {
      if (!state.nextToken) return;
      state.tokens[state.page + 1] = state.nextToken;
      state.offsets[state.page + 1] = (state.offsets[state.page] ?? state.page * state.pageSize) + (mode() === "drafts" ? state.drafts.length : state.rows.length);
      state.page += 1;
      state.selected.clear();
      await refreshList();
    }),
  );
  $("#page-newer").addEventListener("click", () =>
    action(async () => {
      if (state.page === 0) return;
      state.page -= 1;
      state.selected.clear();
      await refreshList();
    }),
  );
  $("#bulk-archive").addEventListener("click", () => action(() => archiveThreads(selectedThreads())));
  $("#bulk-spam").addEventListener("click", () => action(() => spamThreads(selectedThreads())));
  $("#bulk-not-spam").addEventListener("click", () => action(() => notSpam(selectedThreads())));
  $("#bulk-inbox").addEventListener("click", () => action(() => restoreThreads(selectedThreads())));
  $("#bulk-delete").addEventListener("click", () =>
    action(async () => {
      if (mode() === "drafts") return discardDrafts(state.drafts.filter((draft) => state.selected.has(draft.id)));
      return trashThreads(selectedThreads());
    }),
  );
  $("#bulk-read").addEventListener("click", () => action(() => markThreads(selectedThreads(), true)));
  $("#bulk-unread").addEventListener("click", () => action(() => markThreads(selectedThreads(), false)));
  $("#bulk-label").addEventListener("click", () => openLabelMenu($("#bulk-label"), selectedThreads()));

  // Conversation view
  $("#back").addEventListener("click", () => navigate(currentListHash()));
  $("#thread-newer").addEventListener("click", () => threadNavigate(-1));
  $("#thread-older").addEventListener("click", () => threadNavigate(1));
  $("#thread-archive").addEventListener("click", () => action(() => archiveThreads([state.thread])));
  $("#thread-spam").addEventListener("click", () => action(() => spamThreads([state.thread])));
  $("#thread-not-spam").addEventListener("click", () => action(() => notSpam([state.thread])));
  $("#thread-inbox").addEventListener("click", () => action(() => restoreThreads([state.thread])));
  $("#thread-delete").addEventListener("click", () => action(() => trashThreads([state.thread])));
  $("#thread-unread").addEventListener("click", () =>
    action(async () => {
      await call("threads.label", { threadId: state.thread.id, labelIds: ["UNREAD"] }, key());
      snackbar("Conversation marked as unread.");
      navigate(currentListHash());
      await refreshAll();
    }),
  );
  $("#thread-label").addEventListener("click", () => openLabelMenu($("#thread-label"), [state.thread]));
  $("#thread-reply").addEventListener("click", () => action(() => openCompose({ replyTo: state.thread.messages.at(-1), thread: state.thread })));
  $("#thread-reply-all").addEventListener("click", () => action(() => openCompose({ replyTo: state.thread.messages.at(-1), thread: state.thread, replyAll: true })));
  $("#thread-forward").addEventListener("click", () => action(() => openCompose({ forward: state.thread.messages.at(-1), thread: state.thread })));
  $("#preview-close").addEventListener("click", () => $("#preview-dialog").close());

  // Compose
  $("#compose-form").addEventListener("input", () => {
    compose.dirty = true;
    if (!compose.saving) setComposeStatus("");
    setComposeTitle();
    scheduleAutosave();
  });
  $("#compose-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void action(sendMessage, { onError: () => undefined });
  });
  $("#show-cc").addEventListener("click", () => {
    $("#cc-field").hidden = false;
    $("#show-cc").hidden = true;
    $("#cc").focus();
  });
  $("#show-bcc").addEventListener("click", () => {
    $("#bcc-field").hidden = false;
    $("#show-bcc").hidden = true;
    $("#bcc").focus();
  });
  $("#compose-minimize").addEventListener("click", () => {
    const window_ = $("#compose-window");
    window_.classList.toggle("minimized");
    window_.classList.remove("fullscreen");
  });
  $("#compose-head").addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    const window_ = $("#compose-window");
    if (window_.classList.contains("minimized")) window_.classList.remove("minimized");
  });
  $("#compose-expand").addEventListener("click", () => {
    const window_ = $("#compose-window");
    window_.classList.remove("minimized");
    const full = window_.classList.toggle("fullscreen");
    $("#compose-expand").querySelector(".icon").replaceWith(icon(full ? "close_fullscreen" : "open_in_full"));
    $("#compose-expand").setAttribute("aria-label", full ? "Exit full screen" : "Full screen");
  });
  $("#compose-close").addEventListener("click", () =>
    action(async () => {
      clearTimeout(compose.saveTimer);
      if (composeHasContent() && (compose.dirty || !compose.draftId) && JSON.stringify(composeArguments()) !== compose.lastSaved) {
        const saved = await saveDraft({ silent: true });
        if (!saved) {
          const leave = await confirmDialog("Discard unsaved changes?", "The draft could not be saved. Closing now loses what you typed.", "Discard", { danger: true });
          if (!leave) return;
        }
      }
      closeCompose();
      await refreshAll();
    }),
  );
  $("#discard").addEventListener("click", () =>
    action(async () => {
      clearTimeout(compose.saveTimer);
      const draftId = compose.draftId;
      const snapshot = composeArguments();
      const hadContent = composeHasContent();
      if (draftId) await call("drafts.delete", { id: draftId }, key());
      closeCompose();
      if (draftId || hadContent) {
        snackbar("Draft discarded.", {
          actionLabel: "Undo",
          onAction: async () => {
            const draft = await call("drafts.create", snapshot, key());
            await openCompose({ draft: { ...draft, plaintextBody: draft.plaintextBody ?? snapshot.body ?? "" } });
            await refreshAll();
          },
        });
      }
      await refreshAll();
    }),
  );

  // Label dialog
  $("#label-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void action(submitLabelDialog);
  });
  $("#label-cancel").addEventListener("click", () => $("#label-dialog").close());
  $("#label-nest").addEventListener("change", () => ($("#label-parent").disabled = !$("#label-nest").checked));

  // Global keyboard shortcuts
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const typing = event.target.matches("input, textarea, select, [contenteditable]");
    if (event.key === "Escape") {
      if (typing && event.target.closest("#search")) {
        event.target.blur();
        if (compact() && !state.search) setSearchBar(false);
        return;
      }
      if (compose.open && event.target.closest("#compose-window")) {
        $("#compose-minimize").click();
        return;
      }
      if (!$("#quick-settings").hidden) $("#quick-settings-close").click();
      return;
    }
    if (typing || document.querySelector("dialog[open]") || document.querySelector(".gm-menu")) return;
    const inThread = !$("#thread-view").hidden && state.thread;
    switch (event.key) {
      case "c":
        event.preventDefault();
        void action(() => openCompose());
        break;
      case "/":
        event.preventDefault();
        if (compact()) setSearchBar(true);
        $("#search").focus();
        break;
      case "u":
        if (inThread) navigate(currentListHash());
        break;
      case "j":
      case "k":
        if (inThread) threadNavigate(event.key === "j" ? 1 : -1);
        else {
          const rows = $$("#rows .gm-row");
          if (rows.length && !rows.includes(document.activeElement)) rows[0].focus();
        }
        break;
      case "e":
        if (inThread && threadLabelIds(state.thread).includes("INBOX")) void action(() => archiveThreads([state.thread]));
        break;
      case "#":
        if (inThread && !threadLabelIds(state.thread).includes("TRASH")) void action(() => trashThreads([state.thread]));
        break;
      case "r":
        if (inThread) void action(() => openCompose({ replyTo: state.thread.messages.at(-1), thread: state.thread }));
        break;
      case "f":
        if (inThread) void action(() => openCompose({ forward: state.thread.messages.at(-1), thread: state.thread }));
        break;
      case "s":
        if (inThread) void action(() => setThreadLabel(state.thread.id, "STARRED", !threadLabelIds(state.thread).includes("STARRED")));
        break;
      case "?":
        $("#settings").click();
        break;
      default:
    }
  });

  let loadingTimer;
  onBusy((busy) => {
    clearTimeout(loadingTimer);
    if (busy) loadingTimer = setTimeout(() => ($("#loading").hidden = !isPending()), 250);
    else $("#loading").hidden = true;
  });
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

hydrateIcons();
wire();
applyDensity(readPreference("density", "default"));
if (readPreference("sidePanel", "open") === "hidden") {
  $(".gm-body").classList.add("side-hidden");
  $("#side-show").hidden = false;
}
$("#page-size").value = String(state.pageSize);
if (window.matchMedia("(max-width: 768px)").matches) {
  $("#nav").classList.add("collapsed");
  $("#menu-toggle").setAttribute("aria-expanded", "false");
}

const GMAIL_FREE_QUOTA_BYTES = 15 * 1024 ** 3;
/**
 * Footer as in Gmail: storage used on the left, last account activity on the right. Storage is the sum of every
 * message's sizeEstimate (Spam and Trash included, read through threads.list); activity is this app's latest mailbox
 * read in world time, so it reads "0 minutes ago" while the page is open. Neither figure is invented.
 */
async function renderFooter() {
  if (!state.profile) {
    $("#footer-storage").hidden = true;
    $("#footer-activity").hidden = true;
    return;
  }
  try {
    const threads = await loadAllThreads({ includeTrash: true });
    const bytes = threads.reduce((sum, thread) => sum + thread.messages.reduce((inner, message) => inner + (Number(message.sizeEstimate) || 0), 0), 0);
    const gb = bytes / 1024 ** 3;
    const shown = gb < 0.01 ? "0" : gb.toFixed(2).replace(/\.?0+$/, "");
    const text = $("#storage-text");
    text.textContent = `${shown} GB of 15 GB used`;
    text.title = `${plural(state.profile.messagesTotal, "message")}, ${bytes.toLocaleString("en-US")} bytes (sum of sizeEstimate)`;
    text.setAttribute("aria-label", `Storage: ${shown} GB of 15 GB used`);
    $("#storage-fill").style.width = `${Math.min(100, (bytes / GMAIL_FREE_QUOTA_BYTES) * 100)}%`;
    $("#footer-storage").hidden = false;
  } catch {
    $("#footer-storage").hidden = true;
  }
  const minutes = Math.max(0, Math.floor(((state.nowMs ?? 0) - (state.profileReadMs ?? state.nowMs ?? 0)) / 60000));
  $("#activity-text").textContent = `Last account activity: ${minutes === 1 ? "1 minute" : `${minutes} minutes`} ago`;
  $("#footer-activity").hidden = false;
}

watchWorld(
  async (first) => {
    try {
      state.profile = await call("profile.get", {});
      state.nowMs = Date.parse(state.profile.serverTime);
      state.profileReadMs = state.nowMs;
      state.denied = false;
      const initial = (state.profile.displayName ?? state.profile.emailAddress).trim().charAt(0).toUpperCase();
      const avatarElement = $("#account-avatar");
      avatarElement.textContent = initial;
      avatarElement.style.background = avatar(state.profile.displayName, state.profile.emailAddress).style.background;
      $("#account").setAttribute("aria-label", `Account: ${state.profile.emailAddress}`);
      $("#account").title = state.profile.emailAddress;
    } catch (error) {
      state.profile = undefined;
      state.nowMs = undefined;
      if (error instanceof ToolError && error.denied) {
        state.denied = true;
        $("#rows").replaceChildren(stateBox("You don't have permission to view this mailbox", "The selected actor has no grants for the Gmail Tool. Add grants in the world file and restart serve.", { iconName: "lock" }));
        $("#footer-storage").hidden = true;
        $("#footer-activity").hidden = true;
        return;
      }
      snackbar(describe(error), { error: true });
    }
    try {
      await loadLabels();
    } catch (error) {
      if (!(error instanceof ToolError && error.denied)) snackbar(describe(error), { error: true });
    }
    if (first) await applyRoute();
    else await refreshAll();
    await renderFooter();
  },
  () => !compose.saving && !compose.sending,
  (context) => {
    state.actorId = context.actorId;
  },
);
