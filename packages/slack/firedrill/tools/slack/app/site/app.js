// Slack Tool browser app. Every control calls the Tool's own operations through /_firedrill/client.js; nothing on this
// page is authoritative — records are re-read after each write and whenever the world revision moves.
import { hydrateIcons, icon } from "./icons.js";
import {
  $,
  $$,
  PICKER_EMOJI,
  QUICK_REACTIONS,
  ToolError,
  action,
  avatar,
  call,
  clockTime,
  closeMenus,
  confirmDialog,
  dayLabel,
  describe,
  el,
  emoji,
  emojiLabel,
  fullDate,
  iconButton,
  isPending,
  key,
  localParts,
  longDate,
  menuOpen,
  openMenu,
  plainText,
  readPreference,
  relative,
  renderText,
  shortDate,
  textButton,
  toast,
  tsSeconds,
  watchWorld,
  writePreference,
} from "./ui.js";

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

const PAGE = 50;
const SEARCH_PAGE = 20;
const state = {
  identity: undefined, // auth.test
  me: undefined, // users.info of the acting member
  users: new Map(),
  conversations: [], // every conversation visible to the actor (all four types, archived included)
  latest: new Map(), // conversation id → newest top-level ts (sidebar activity probes)
  lastSeen: readLastSeen(),
  channelsOpen: readPreference("channelsOpen", "true") === "true",
  dmsOpen: readPreference("dmsOpen", "true") === "true",
  appsOpen: readPreference("appsOpen", "true") === "true",
  toolbar: readPreference("toolbar", "true") === "true",
  unreadOnly: false,
  railView: "home",
  view: "messages", // messages | pins | search | browse | people
  current: undefined, // conversation id
  info: undefined, // conversations.info view of the current conversation
  messages: [],
  hasMore: false,
  nextCursor: "",
  pinned: new Set(),
  pinCount: 0,
  loading: false,
  paneError: undefined,
  thread: undefined, // { channel, ts, parent, replies, hasMore, cursor }
  panel: undefined, // "thread" | "profile"
  profile: undefined,
  search: { query: "", sort: "score", page: 1, result: undefined, error: undefined, loading: false },
  browse: { filter: "" },
  people: { filter: "" },
  editing: undefined, // ts of the own message being edited in the main composer
  highlight: undefined,
  fatal: undefined, // { title, text }
  sidebarDenied: false,
};
const nav = { stack: [], index: -1, silent: false };

const me = () => state.identity?.user_id;
const tz = () => state.me?.tz_offset ?? 0;
const userOf = (id) => state.users.get(id);
const userName = (id) => userOf(id)?.real_name || userOf(id)?.name || id;
const conversationOf = (id) => state.conversations.find((conversation) => conversation.id === id);
const resolve = { user: (id) => userOf(id)?.name, channel: (id) => conversationOf(id)?.name };
const isDm = (conversation) => conversation?.is_im === true || conversation?.is_mpim === true;

/** The newest virtual instant the page knows about — the world's "now" for relative labels (never the browser clock). */
function nowTs() {
  let newest = "0";
  for (const ts of state.latest.values()) if (tsSeconds(ts) > tsSeconds(newest)) newest = ts;
  for (const message of state.messages) if (tsSeconds(message.ts) > tsSeconds(newest)) newest = message.ts;
  for (const reply of state.thread?.replies ?? []) if (tsSeconds(reply.ts) > tsSeconds(newest)) newest = reply.ts;
  if (newest === "0") newest = String(Math.max(0, ...state.conversations.map((c) => c.created)));
  return newest;
}

/** Display name of a conversation the way the sidebar shows it. */
function conversationTitle(conversation) {
  if (conversation.is_im) {
    const partner = conversation.user && conversation.user !== me() ? conversation.user : undefined;
    return partner ? userName(partner) : userName(me());
  }
  if (conversation.is_mpim) {
    const others = mpimMembers(conversation);
    return others.length > 0 ? others.map(userName).join(", ") : conversation.name;
  }
  return conversation.name;
}
function mpimMembers(conversation) {
  const match = /^mpdm-(.+)-\d+$/.exec(conversation.name ?? "");
  if (!match) return [];
  return match[1]
    .split("--")
    .map((handle) => [...state.users.values()].find((user) => user.name === handle)?.id)
    .filter((id) => id && id !== me());
}
function conversationGlyph(conversation, size = "sm") {
  const glyph = el("span", { class: "sb-glyph" });
  if (conversation.is_im) {
    const partner = conversation.user && conversation.user !== me() ? userOf(conversation.user) : state.me;
    glyph.append(avatar(partner ?? { id: conversation.user }, size), el("span", { class: `presence ${partner?.id === me() ? "active" : ""}`.trim(), attrs: { "aria-hidden": "true" } }));
  } else if (conversation.is_mpim) {
    const count = el("span", { class: "avatar sm", text: String(mpimMembers(conversation).length || "·") });
    count.style.background = "rgba(255,255,255,0.18)";
    glyph.append(count);
  } else glyph.append(icon(conversation.is_private ? "lock" : "hash"));
  return glyph;
}

// ---------------------------------------------------------------------------------------------
// Navigation (hash routes: #C…, #C…/thread/<ts>, #search/<query>, #browse, #people)
// ---------------------------------------------------------------------------------------------

/** The stored last-seen map; a corrupted or hand-edited preference value starts empty instead of crashing the app. */
function readLastSeen() {
  try {
    const entries = JSON.parse(readPreference("lastSeen", "[]"));
    return new Map(Array.isArray(entries) ? entries.filter((entry) => Array.isArray(entry) && entry.length === 2) : []);
  } catch {
    return new Map();
  }
}

function currentHash() {
  const raw = location.hash.replace(/^#/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    // A pasted or typed link with a malformed percent escape (e.g. #%E0%A4%A) cannot be decoded; treat it as the
    // default route so in-app navigation keeps working instead of throwing on every hashchange and click.
    return "";
  }
}
function navigate(hash) {
  if (currentHash() === hash) {
    void openRoute(hash);
    return;
  }
  nav.stack = nav.stack.slice(0, nav.index + 1);
  nav.stack.push(hash);
  nav.index = nav.stack.length - 1;
  nav.silent = true;
  location.hash = hash;
}
window.addEventListener("hashchange", () => {
  const hash = currentHash();
  if (!nav.silent) {
    if (nav.stack[nav.index - 1] === hash) nav.index -= 1;
    else if (nav.stack[nav.index + 1] === hash) nav.index += 1;
    else {
      nav.stack = nav.stack.slice(0, nav.index + 1);
      nav.stack.push(hash);
      nav.index = nav.stack.length - 1;
    }
  }
  nav.silent = false;
  renderNavButtons();
  void openRoute(hash);
});
function renderNavButtons() {
  $("#nav-back").disabled = nav.index <= 0;
  $("#nav-forward").disabled = nav.index >= nav.stack.length - 1;
}
$("#nav-back").addEventListener("click", () => {
  if (nav.index > 0) {
    nav.index -= 1;
    nav.silent = true;
    location.hash = nav.stack[nav.index];
  }
});
$("#nav-forward").addEventListener("click", () => {
  if (nav.index < nav.stack.length - 1) {
    nav.index += 1;
    nav.silent = true;
    location.hash = nav.stack[nav.index];
  }
});
$("#nav-history").addEventListener("click", (event) => {
  const seen = [];
  for (let index = nav.stack.length - 1; index >= 0 && seen.length < 10; index -= 1) {
    const hash = nav.stack[index];
    const conversation = conversationOf(hash.split("/")[0]);
    if (conversation && !seen.some((entry) => entry.id === conversation.id)) seen.push(conversation);
  }
  const items = seen.map((conversation) => ({ label: isDm(conversation) ? conversationTitle(conversation) : `#${conversation.name}`, icon: isDm(conversation) ? "dm" : conversation.is_private ? "lock" : "hash", onSelect: () => navigate(conversation.id) }));
  openMenu(event.currentTarget, items.length > 0 ? items : [{ label: "No recent conversations", disabled: true }], { header: "Recent" });
});

async function openRoute(hash) {
  closeMenus();
  $("#shell").classList.remove("sidebar-open");
  const [head, ...rest] = hash.split("/");
  if (head === "search") {
    const query = rest.join("/");
    $("#search").value = query;
    $("#search-form").classList.toggle("has-value", query.length > 0);
    $("#search-clear").hidden = query.length === 0;
    await runSearch(query, { page: 1 });
    return;
  }
  // Any other route clears the top search field so a stale query never sits over a conversation.
  $("#search").value = "";
  $("#search-form").classList.remove("has-value");
  $("#search-clear").hidden = true;
  if (head === "browse") {
    showView("browse");
    await renderBrowse();
    return;
  }
  if (head === "people") {
    showView("people");
    await renderPeople();
    return;
  }
  if (head === "pins" && state.current) {
    showView("pins");
    await renderPins();
    return;
  }
  const id = head || defaultConversation()?.id;
  if (!id) {
    renderEmptyWorkspace();
    return;
  }
  const changed = id !== state.current;
  if (changed) state.editing = undefined;
  await loadConversation(id, { keepScroll: !changed });
  if (rest[0] === "thread" && rest[1]) await openThread(id, rest[1]);
  else if (state.panel === "thread" && changed) closePanel();
}

function defaultConversation() {
  const member = state.conversations.filter((conversation) => conversation.is_member && !conversation.is_archived);
  return member.find((conversation) => conversation.is_general) ?? member.find((conversation) => conversation.is_channel) ?? member[0] ?? state.conversations[0];
}

// ---------------------------------------------------------------------------------------------
// Identity, users and sidebar
// ---------------------------------------------------------------------------------------------

async function loadIdentity() {
  state.identity = await call("auth.test");
  const users = [];
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const result = await call("users.list", { limit: 200, ...(cursor ? { cursor } : {}) });
    users.push(...result.members);
    cursor = result.response_metadata.next_cursor;
    if (!cursor) break;
  }
  state.users = new Map(users.map((user) => [user.id, user]));
  state.me = state.users.get(state.identity.user_id) ?? (await call("users.info", { user: state.identity.user_id })).user;
  $("#workspace-name").textContent = state.identity.team;
  $("#workspace-initial").textContent = state.identity.team.trim().charAt(0).toUpperCase() || "W";
  document.title = `${state.identity.team} - Slack (synthetic)`;
  const meAvatar = avatar(state.me, "md");
  meAvatar.id = "me-avatar";
  $("#me-avatar").replaceWith(meAvatar);
  $("#search").placeholder = `Search ${state.identity.team}`;
}

async function loadConversations() {
  const conversations = [];
  let cursor;
  try {
    for (let page = 0; page < 20; page += 1) {
      const result = await call("conversations.list", { types: "public_channel,private_channel,mpim,im", limit: 200, ...(cursor ? { cursor } : {}) });
      conversations.push(...result.channels);
      cursor = result.response_metadata.next_cursor;
      if (!cursor) break;
    }
    state.sidebarDenied = false;
  } catch (error) {
    if (error instanceof ToolError && error.denied) {
      state.sidebarDenied = true;
      state.conversations = [];
      renderSidebar();
      return;
    }
    throw error;
  }
  state.conversations = conversations;
  // Activity probes: the newest top-level message of every joined, active conversation (limit 1 each).
  const probes = conversations.filter((conversation) => conversation.is_member && !conversation.is_archived);
  const results = await Promise.all(
    probes.map((conversation) =>
      call("conversations.history", { channel: conversation.id, limit: 1 })
        .then((result) => result.messages[0]?.ts)
        .catch(() => undefined),
    ),
  );
  const firstRun = state.latest.size === 0 && state.lastSeen.size === 0;
  probes.forEach((conversation, index) => {
    const ts = results[index];
    if (!ts) return;
    state.latest.set(conversation.id, ts);
    if (firstRun) state.lastSeen.set(conversation.id, ts);
  });
  if (firstRun) saveLastSeen();
  renderSidebar();
}

function saveLastSeen() {
  writePreference("lastSeen", JSON.stringify([...state.lastSeen.entries()]));
}
function markSeen(id) {
  const latest = state.latest.get(id);
  const newest = state.messages.length > 0 ? state.messages[state.messages.length - 1].ts : latest;
  const value = [latest, newest].filter(Boolean).sort((a, b) => tsSeconds(b) - tsSeconds(a) || (b > a ? 1 : -1))[0];
  if (value) {
    state.lastSeen.set(id, value);
    saveLastSeen();
  }
}
function isUnread(conversation) {
  const latest = state.latest.get(conversation.id);
  const seen = state.lastSeen.get(conversation.id);
  if (!latest) return false;
  if (!seen) return true;
  return tsSeconds(latest) > tsSeconds(seen) || (tsSeconds(latest) === tsSeconds(seen) && latest > seen);
}

function sidebarItem(conversation) {
  const item = el("li", { class: "sb-item" });
  const link = el("button", { class: "sb-link", attrs: { type: "button", "data-id": conversation.id, title: isDm(conversation) ? conversationTitle(conversation) : `#${conversation.name}` } });
  link.append(conversationGlyph(conversation), el("span", { class: "sb-name", text: conversationTitle(conversation) }));
  if (conversation.is_mpim) link.append(el("span", { class: "sb-meta", text: String(mpimMembers(conversation).length + 1) }));
  if (conversation.id === state.current && (state.view === "messages" || state.view === "pins")) link.setAttribute("aria-current", "page");
  if (isUnread(conversation)) link.classList.add("unread");
  link.addEventListener("click", () => navigate(conversation.id));
  item.append(link);
  return item;
}

function renderSidebar() {
  const denied = $("#sidebar-denied");
  denied.hidden = !state.sidebarDenied;
  if (state.sidebarDenied) {
    denied.replaceChildren(el("strong", { text: "Channels can't be listed" }), el("span", { text: "This actor has no grant for conversations.list (missing_scope), so the sidebar stays empty. Grant the operation in the world's actor definition to see conversations here." }));
  }
  const dmsOnly = state.railView === "dms";
  $("#section-channels").hidden = dmsOnly || state.sidebarDenied;
  $("#section-dms").hidden = state.sidebarDenied;
  const channelList = $("#channel-list");
  const dmList = $("#dm-list");
  channelList.replaceChildren();
  dmList.replaceChildren();
  const visible = (conversation) => !state.unreadOnly || isUnread(conversation) || conversation.id === state.current;
  const channels = state.conversations
    .filter((conversation) => conversation.is_channel && conversation.is_member && !conversation.is_archived && visible(conversation))
    .sort((left, right) => left.name.localeCompare(right.name));
  const dms = state.conversations
    .filter((conversation) => isDm(conversation) && conversation.is_member && visible(conversation))
    .sort((left, right) => tsSeconds(state.latest.get(right.id) ?? "0") - tsSeconds(state.latest.get(left.id) ?? "0"));
  $("#channels-toggle").setAttribute("aria-expanded", String(state.channelsOpen));
  $("#dms-toggle").setAttribute("aria-expanded", String(state.dmsOpen));
  channelList.hidden = !state.channelsOpen;
  dmList.hidden = !state.dmsOpen;
  $("#add-channels").hidden = !state.channelsOpen;
  $("#add-dm").hidden = !state.dmsOpen;
  if (state.channelsOpen) {
    for (const conversation of channels) channelList.append(sidebarItem(conversation));
    if (channels.length === 0 && state.conversations.length > 0) channelList.append(el("li", { class: "sidebar-empty", text: state.unreadOnly ? "No unread channels." : "You're not in any channels yet." }));
  } else {
    // Collapsed sections still show the selected and unread conversations, the way the client does.
    for (const conversation of channels.filter((entry) => entry.id === state.current || isUnread(entry))) channelList.append(sidebarItem(conversation));
    channelList.hidden = channelList.childElementCount === 0;
  }
  if (state.dmsOpen) {
    for (const conversation of dms) dmList.append(sidebarItem(conversation));
    if (dms.length === 0 && state.conversations.length > 0) dmList.append(el("li", { class: "sidebar-empty", text: state.unreadOnly ? "No unread direct messages." : "No direct messages yet." }));
  } else {
    for (const conversation of dms.filter((entry) => entry.id === state.current || isUnread(entry))) dmList.append(sidebarItem(conversation));
    dmList.hidden = dmList.childElementCount === 0;
  }
  const bots = [...state.users.values()].filter((user) => user.is_bot && !user.deleted).sort((left, right) => (left.real_name || left.name).localeCompare(right.real_name || right.name));
  $("#section-apps").hidden = state.sidebarDenied || dmsOnly || bots.length === 0;
  $("#apps-toggle").setAttribute("aria-expanded", String(state.appsOpen));
  const appList = $("#app-list");
  appList.replaceChildren();
  appList.hidden = !state.appsOpen;
  if (state.appsOpen) {
    for (const bot of bots) {
      const link = el("button", { class: "sb-link", title: bot.real_name || bot.name, attrs: { type: "button", "data-user": bot.id } });
      link.append(el("span", { class: "sb-glyph" }, avatar(bot, "sm")), el("span", { class: "sb-name", text: bot.real_name || bot.name }));
      link.addEventListener("click", () => openProfile(bot.id));
      appList.append(el("li", { class: "sb-item" }, link));
    }
  }
  $$(".rail-item").forEach((button) => {
    if (button.dataset.view === state.railView) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function renderSidebarSkeleton() {
  for (const list of [$("#channel-list"), $("#dm-list")]) {
    list.replaceChildren();
    for (let index = 0; index < 4; index += 1) {
      const bar = el("li", { class: "sk-side" });
      bar.style.width = `${45 + ((index * 17) % 40)}%`;
      list.append(bar);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Conversation pane
// ---------------------------------------------------------------------------------------------

function showView(view) {
  state.view = view;
  const isConversation = view === "messages" || view === "pins";
  $("#pane-tabs").hidden = !isConversation || !state.current;
  $("#pane-footer").hidden = view !== "messages";
  $$(".pane-tab").forEach((tab) => {
    if (tab.dataset.tab === view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
  if (!isConversation) {
    $("#pane-topic").hidden = true;
    $("#members-pill").hidden = true;
    $("#pane-details").hidden = true;
    $("#huddle-split").hidden = true;
    $("#pane-more").hidden = true;
    $("#pane-title-glyph").replaceChildren();
    $("#pane-title").classList.add("static");
    $(".pane-title-chevron").toggleAttribute("hidden", true);
  } else $(".pane-title-chevron").toggleAttribute("hidden", false);
  renderSidebar();
}

function paneBody() {
  const body = $("#pane-body");
  body.replaceChildren();
  return body;
}

function skeleton(rows = 6) {
  const host = el("div", { class: "skeleton", attrs: { "aria-busy": "true", "aria-label": "Loading" } });
  for (let index = 0; index < rows; index += 1) {
    const lines = el("div", { class: "sk-lines" }, [el("div", { class: "sk-line short" }), el("div", { class: `sk-line ${index % 2 ? "medium" : ""}`.trim() })]);
    host.append(el("div", { class: "sk-row" }, [el("div", { class: "sk-avatar" }), lines]));
  }
  return host;
}

function stateCard(title, text, { error = false, actions = [] } = {}) {
  const card = el("div", { class: `state-card ${error ? "error" : ""}`.trim() }, [el("h2", { class: "state-title", text }), el("p", { class: "state-text", text })]);
  card.firstChild.textContent = title;
  if (actions.length > 0) card.append(el("div", { class: "state-actions" }, actions));
  return card;
}

async function loadConversation(id, { keepScroll = false } = {}) {
  state.current = id;
  state.paneError = undefined;
  state.view = "messages";
  showView("messages");
  const known = conversationOf(id);
  renderHeader(known ?? { id, name: id, is_channel: true });
  if (!keepScroll) {
    const body = paneBody();
    body.append(el("div", { class: "message-scroll", attrs: { id: "message-scroll" } }, [el("div", { class: "message-list", attrs: { id: "messages", role: "log", "aria-live": "polite", "aria-label": "Messages" } }, skeleton())]));
  }
  try {
    const info = (await call("conversations.info", { channel: id, include_num_members: true })).channel;
    if (!info.is_im) {
      // The header pill shows the first few member avatars the way the client does (one bounded page).
      info.member_preview = await call("conversations.members", { channel: id, limit: 3 })
        .then((result) => result.members)
        .catch(() => [me()]);
    }
    state.info = info;
    if (!known) state.conversations.push(info);
    else Object.assign(known, info);
    renderHeader(info);
    if (!info.is_member) {
      state.messages = [];
      state.hasMore = false;
      state.pinned = new Set();
      renderMessages({ keepScroll });
      renderFooter();
      return;
    }
    const [history, pins] = await Promise.all([call("conversations.history", { channel: id, limit: PAGE }), call("pins.list", { channel: id }).catch(() => ({ items: [] }))]);
    if (state.current !== id) return;
    state.messages = [...history.messages].reverse();
    state.hasMore = history.has_more;
    state.nextCursor = history.response_metadata.next_cursor;
    state.pinCount = history.pin_count;
    state.pinned = new Set(pins.items.map((item) => item.message.ts));
    if (state.messages.length > 0) state.latest.set(id, state.messages[state.messages.length - 1].ts);
    markSeen(id);
    renderSidebar();
    renderMessages({ keepScroll });
    renderFooter();
  } catch (error) {
    if (state.current !== id) return;
    state.paneError = error;
    renderPaneError(error, id);
  }
}

function renderHeader(conversation) {
  const glyph = $("#pane-title-glyph");
  glyph.replaceChildren();
  glyph.classList.remove("with-avatar");
  const title = $("#pane-title-text");
  const topic = $("#pane-topic");
  if (conversation.is_im) {
    const partner = conversation.user && conversation.user !== me() ? userOf(conversation.user) : state.me;
    glyph.classList.add("with-avatar");
    glyph.append(avatar(partner ?? { id: conversation.user }, "md"), el("span", { class: `presence ${partner?.id === me() ? "active" : ""}`.trim(), attrs: { "aria-hidden": "true" } }));
    title.textContent = conversationTitle(conversation);
    topic.hidden = true;
  } else if (conversation.is_mpim) {
    title.textContent = conversationTitle(conversation);
    topic.hidden = true;
  } else {
    glyph.append(icon(conversation.is_private ? "lock" : "hash"));
    title.textContent = conversation.name;
    const value = conversation.topic?.value ?? "";
    topic.hidden = false;
    topic.textContent = value || (conversation.is_member && !conversation.is_archived ? "Add a topic" : "");
    topic.hidden = topic.textContent.length === 0;
    topic.classList.toggle("placeholder", value.length === 0);
    topic.title = value || "Add a topic";
  }
  const pill = $("#members-pill");
  const count = conversation.num_members;
  pill.hidden = count === undefined || conversation.is_im === true;
  if (count !== undefined) {
    $("#members-count").textContent = String(count);
    pill.setAttribute("aria-label", `View ${count} member${count === 1 ? "" : "s"}`);
    const stack = $("#members-stack");
    stack.replaceChildren();
    const ids = conversation.is_mpim ? [me(), ...mpimMembers(conversation)] : [...(conversation.member_preview ?? [me()])];
    for (const id of ids.filter(Boolean).slice(0, 3)) stack.append(avatar(userOf(id) ?? { id }, "sm"));
  }
  $("#pane-details").hidden = true;
  $("#huddle-split").hidden = false;
  $("#pane-more").hidden = false;
  $("#pins-count").textContent = "";
  $("#pane-title").classList.remove("static");
}

function renderPaneError(error, id) {
  const body = paneBody();
  const retry = textButton("Try again", { onClick: () => action(() => loadConversation(id)) });
  if (error instanceof ToolError && error.is("CHANNEL_NOT_FOUND")) {
    body.append(stateCard("This conversation isn't available", "It doesn't exist or isn't visible to you. It may have been removed when the world was reset.", { actions: [textButton("Back to your channels", { class: "primary", onClick: () => navigate(defaultConversation()?.id ?? "") })] }));
  } else if (error instanceof ToolError && error.is("SERVICE_UNAVAILABLE")) {
    body.append(stateCard("History is temporarily unavailable", "The workspace answered 503 service_unavailable for this channel's history. Nothing was changed.", { error: true, actions: [retry] }));
  } else if (error instanceof ToolError && error.denied) {
    body.append(stateCard("You don't have permission to view this", "This actor has no grant for conversations.history or conversations.info (missing_scope).", { error: true }));
  } else {
    body.append(stateCard("Something went wrong", describe(error), { error: true, actions: [retry] }));
  }
  $("#pane-footer").hidden = true;
  $("#pane-tabs").hidden = true;
}

/** Group top-level messages into day sections and render them oldest-first with the composer anchored below. */
function renderMessages({ keepScroll = false } = {}) {
  const info = state.info;
  let scroll = $("#message-scroll");
  const previousBottom = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight : 0;
  const previousTop = scroll?.scrollTop ?? 0;
  if (!scroll) {
    const body = paneBody();
    scroll = el("div", { class: "message-scroll", attrs: { id: "message-scroll" } });
    body.append(scroll);
  }
  const list = el("div", { class: "message-list", attrs: { id: "messages", role: "log", "aria-live": "polite", "aria-label": "Messages" } });
  scroll.replaceChildren(list);
  $("#pins-count").textContent = state.pinCount > 0 ? String(state.pinCount) : "";
  if (!info.is_member) {
    list.append(previewCard(info));
    return;
  }
  if (state.hasMore) {
    list.append(textButton("Load older messages", { class: "load-more", onClick: () => action(loadOlder) }));
  } else list.append(channelIntro(info));
  const now = nowTs();
  let previous;
  let previousDay;
  for (const message of state.messages) {
    const day = localParts(message.ts, tz()).dayIndex;
    if (day !== previousDay) {
      list.append(dayDivider(dayLabel(message.ts, now, tz())));
      previous = undefined;
      previousDay = day;
    }
    const continued = previous !== undefined && previous.user === message.user && !message.subtype && !previous.subtype && tsSeconds(message.ts) - tsSeconds(previous.ts) < 300;
    list.append(messageRow(message, { continued, channel: info.id }));
    previous = message;
  }
  if (keepScroll) scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight - previousBottom);
  else scroll.scrollTop = scroll.scrollHeight;
  if (state.highlight) {
    const target = list.querySelector(`[data-ts="${state.highlight}"]`);
    if (target) {
      target.classList.add("highlight");
      target.scrollIntoView({ block: "center" });
      setTimeout(() => target.classList.remove("highlight"), 4000);
    }
    state.highlight = undefined;
  } else if (keepScroll && previousTop === 0 && !state.hasMore) scroll.scrollTop = scroll.scrollHeight;
}

function dayDivider(label) {
  const pill = el("button", { class: "day-pill", attrs: { type: "button", "aria-label": `${label} — jump to date`, title: label } }, [el("span", { text: label }), icon("chevron_down")]);
  pill.addEventListener("click", (event) => openMenu(event.currentTarget, [{ label: "Jump to the most recent message", onSelect: () => ($("#message-scroll").scrollTop = $("#message-scroll").scrollHeight) }, { label: "Load older messages", disabled: !state.hasMore, onSelect: () => action(loadOlder) }], { align: "start" }));
  return el("div", { class: "day-divider", attrs: { role: "separator" } }, pill);
}

function channelIntro(info) {
  const host = el("div", { class: "channel-intro" });
  if (info.is_im) {
    const partner = info.user && info.user !== me() ? userOf(info.user) : state.me;
    host.append(avatar(partner ?? { id: info.user }, "xl"));
    host.append(el("h2", { class: "intro-title", text: partner?.id === me() ? "This is your space" : partner?.real_name ?? info.user }));
    host.append(el("p", { class: "intro-text", text: partner?.id === me() ? "Draft messages, list your to-dos, or keep links and files handy. You can also talk to yourself here, but please bear in mind you'll have to supply both sides of the conversation." : `This conversation is just between ${partner?.real_name ?? "the two of you"} and you. ${partner?.profile?.title ? `${partner.real_name.split(" ")[0]} is ${partner.profile.title}.` : ""}`.trim() }));
    if (partner && partner.id !== me()) host.append(el("div", { class: "intro-actions" }, textButton("View profile", { onClick: () => openProfile(partner.id) })));
    return host;
  }
  if (info.is_mpim) {
    host.append(el("h2", { class: "intro-title", text: conversationTitle(info) }));
    host.append(el("p", { class: "intro-text", text: `This is the very beginning of your group conversation with ${mpimMembers(info).map(userName).join(", ")}.` }));
    return host;
  }
  host.append(el("div", { class: "intro-icon" }, icon(info.is_private ? "lock" : "hash")));
  host.append(el("h2", { class: "intro-title", text: state.messages.length === 0 ? `You're looking at the #${info.name} channel` : `This is the very beginning of the #${info.name} channel` }));
  const purpose = info.purpose?.value;
  const creator = info.creator ? userName(info.creator) : undefined;
  host.append(el("p", { class: "intro-text", text: purpose ? `${purpose} ${creator ? `Created by ${creator} on ${longDate(String(info.created), tz())}.` : ""}`.trim() : creator ? `Created by ${creator} on ${longDate(String(info.created), tz())}. ${info.is_private ? "This channel is private — only invited members can see it." : "Anyone in the workspace can join."}` : "" }));
  if (!info.is_archived) {
    const actions = el("div", { class: "intro-actions" });
    actions.append(textButton("Add people", { onClick: () => openPeopleDialog("invite"), class: "" }));
    actions.firstChild.prepend(icon("user_add"));
    actions.append(textButton(info.topic?.value ? "Edit topic" : "Set a topic", { onClick: () => openTopicDialog() }));
    host.append(actions);
  }
  return host;
}

function previewCard(info) {
  const host = el("div", { class: "channel-intro" });
  host.append(el("div", { class: "intro-icon" }, icon(info.is_private ? "lock" : "hash")));
  host.append(el("h2", { class: "intro-title", text: `#${info.name}` }));
  const purpose = info.purpose?.value;
  host.append(el("p", { class: "intro-text", text: `${purpose ? `${purpose} ` : ""}${info.num_members ?? 0} member${info.num_members === 1 ? "" : "s"}${info.is_archived ? " · archived" : ""}. You're not a member of this channel yet, so its history isn't shown here — join to read and send messages.` }));
  return host;
}

// ---------------------------------------------------------------------------------------------
// Message rows
// ---------------------------------------------------------------------------------------------

function messageRow(message, { continued = false, channel, inThread = false, compact = false } = {}) {
  const author = userOf(message.user);
  const row = el("article", { class: "msg", attrs: { "data-ts": message.ts, "data-channel": channel, tabindex: "-1" } });
  if (message.subtype === "channel_join") row.classList.add("system");
  if (message.subtype === "tombstone") row.classList.add("tombstone");
  if (continued) row.classList.add("continued");
  const gutter = el("div", { class: "msg-gutter" });
  if (continued) gutter.append(el("span", { class: "msg-hover-time", text: clockTime(message.ts, tz()).replace(/ [AP]M$/, "") }));
  else {
    const picture = avatar(author ?? { id: message.user }, "lg");
    picture.setAttribute("role", "button");
    picture.setAttribute("tabindex", "0");
    picture.setAttribute("aria-label", `View profile of ${userName(message.user)}`);
    picture.addEventListener("click", () => openProfile(message.user));
    picture.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") openProfile(message.user);
    });
    gutter.append(picture);
  }
  const main = el("div", { class: "msg-main" });
  if (!continued) {
    const head = el("div", { class: "msg-head" });
    const name = el("button", { class: "msg-author", text: userName(message.user), attrs: { type: "button" } });
    name.addEventListener("click", () => openProfile(message.user));
    head.append(name);
    if (author?.is_bot || message.subtype === "bot_message") head.append(el("span", { class: "app-badge", text: "APP" }));
    if (author?.deleted) head.append(el("span", { class: "deactivated-badge", text: "Deactivated" }));
    head.append(el("button", { class: "msg-time", text: clockTime(message.ts, tz()), title: fullDate(message.ts, tz()), attrs: { type: "button", "aria-label": fullDate(message.ts, tz()) } }));
    main.append(head);
  }
  if (message.subtype === "thread_broadcast") {
    const parent = state.messages.find((entry) => entry.ts === message.thread_ts);
    if (inThread) main.append(el("div", { class: "msg-broadcast", text: "Also sent to the channel" }));
    else main.append(el("div", { class: "msg-broadcast", text: parent ? `replied to a thread: ${plainText(parent.text, resolve).slice(0, 80)}` : "replied to a thread" }));
  }
  const text = el("div", { class: "msg-text" });
  renderText(text, message.text, { resolve, onMention: openProfile, onChannel: (id) => navigate(id) });
  // Jumbo emoji only when every shortcode resolved to a known emoji (unknown names stay literal text at normal size).
  const shortcodes = message.text.trim().match(/:[a-z0-9_+-]+:/g) ?? [];
  if (/^(?::[a-z0-9_+-]+:\s*){1,3}$/.test(message.text.trim()) && text.querySelectorAll(".msg-emoji").length === shortcodes.length) text.classList.add("emoji-only");
  if (message.edited) text.append(el("span", { class: "msg-edited", text: "(edited)" }));
  main.append(text);
  if (Array.isArray(message.reactions) && message.reactions.length > 0) main.append(reactionsRow(message, channel));
  if (!inThread && message.reply_count > 0 && message.thread_ts === message.ts) main.append(threadFooter(message, channel));
  row.append(gutter, main);
  if (!compact && message.subtype !== "channel_join" && message.subtype !== "tombstone") row.append(messageActions(message, channel, { inThread }));
  return row;
}

function reactionsRow(message, channel) {
  const host = el("div", { class: "msg-reactions" });
  for (const reaction of message.reactions) {
    const mine = reaction.users.includes(me());
    const names = reaction.users.map(userName).join(", ");
    const chip = el("button", { class: "reaction", title: `${names} reacted with :${reaction.name}:`, attrs: { type: "button", "aria-pressed": String(mine), "aria-label": `${emojiLabel(reaction.name)} ${reaction.count}, ${mine ? "remove your reaction" : "react"}` } }, [el("span", { class: "reaction-emoji", text: emoji(reaction.name) }), el("span", { text: String(reaction.count) })]);
    chip.addEventListener("click", () => action(() => toggleReaction(channel, message, reaction.name, mine)));
    host.append(chip);
  }
  const add = el("button", { class: "reaction reaction-add", attrs: { type: "button", "aria-label": "Add reaction", "aria-expanded": "false" }, title: "Add reaction" }, icon("emoji_add"));
  add.addEventListener("click", (event) => openEmojiPicker(event.currentTarget, (name) => action(() => toggleReaction(channel, message, name, false))));
  host.append(add);
  return host;
}

function threadFooter(message, channel) {
  const host = el("button", { class: "msg-thread", attrs: { type: "button", "aria-label": `Open thread, ${message.reply_count} replies` } });
  const avatars = el("span", { class: "thread-avatars" });
  for (const id of (message.reply_users ?? []).slice(0, 3)) avatars.append(avatar(userOf(id) ?? { id }, "md"));
  host.append(avatars, el("span", { class: "thread-link", text: `${message.reply_count} repl${message.reply_count === 1 ? "y" : "ies"}` }));
  if (message.latest_reply) host.append(el("span", { class: "thread-last", text: `Last reply ${relative(message.latest_reply, nowTs())}` }));
  host.append(el("span", { class: "thread-view" }, [el("span", { text: "View thread" }), icon("chevron_right")]));
  host.addEventListener("click", () => navigate(`${channel}/thread/${message.ts}`));
  return host;
}

function messageActions(message, channel, { inThread }) {
  const bar = el("div", { class: "msg-actions", attrs: { role: "toolbar", "aria-label": "Message actions" } });
  const info = channel === state.current ? state.info : conversationOf(channel);
  const writable = info?.is_member && !info?.is_archived;
  for (const name of QUICK_REACTIONS) {
    const mine = (message.reactions ?? []).some((reaction) => reaction.name === name && reaction.users.includes(me()));
    const button = el("button", { class: "quick-reaction", text: emoji(name), title: `${emojiLabel(name)}`, attrs: { type: "button", "aria-label": `React with ${emojiLabel(name)}` } });
    button.disabled = !writable;
    button.addEventListener("click", () => action(() => toggleReaction(channel, message, name, mine)));
    bar.append(button);
  }
  const react = iconButton("emoji_add", "Find another reaction", { onClick: (event) => openEmojiPicker(event.currentTarget, (name) => action(() => toggleReaction(channel, message, name, false))) });
  react.setAttribute("aria-expanded", "false");
  react.disabled = !writable;
  bar.append(react);
  if (!inThread && message.subtype !== "channel_join") {
    bar.append(iconButton("thread", "Reply in thread", { onClick: () => navigate(`${channel}/thread/${message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : message.ts}`) }));
  }
  const forward = iconButton("forward", "Forward message");
  forward.dataset.ns = "forward";
  const later = iconButton("bookmark", "Save for later");
  later.dataset.ns = "save";
  bar.append(forward, later);
  const pinned = state.pinned.has(message.ts) || (Array.isArray(message.pinned_to) && message.pinned_to.includes(channel));
  const more = iconButton("more_v", "More actions", {
    onClick: (event) => {
      const own = message.user === me();
      const items = [];
      items.push({ label: pinned ? "Unpin from channel" : "Pin to channel", icon: "pin", disabled: !writable, onSelect: () => action(() => togglePin(channel, message, pinned)) });
      items.push({ label: "Copy link to message", icon: "link", onSelect: () => copyPermalink(message) });
      if (own || state.me?.is_admin) items.push("divider");
      if (own) items.push({ label: "Edit message", icon: "pencil", disabled: !writable || inThread || message.subtype === "thread_broadcast", onSelect: () => beginEdit(message) });
      if (own || state.me?.is_admin) items.push({ label: "Delete message…", icon: "trash", danger: true, disabled: !writable, onSelect: () => action(() => deleteMessage(channel, message)) });
      const row = event.currentTarget.closest(".msg");
      row.classList.add("menu-open");
      const menu = openMenu(event.currentTarget, items, { align: "end" });
      const observer = new MutationObserver(() => {
        if (!menu.isConnected) {
          row.classList.remove("menu-open");
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true });
    },
  });
  more.setAttribute("aria-expanded", "false");
  bar.append(more);
  return bar;
}

async function copyPermalink(message) {
  try {
    await navigator.clipboard.writeText(message.permalink ?? `${state.identity.url}archives/${state.current}/p${message.ts.replace(".", "")}`);
    toast("Link copied (it points at the synthetic workspace URL and resolves nowhere)");
  } catch {
    toast("Couldn't copy the link in this browser.", { error: true });
  }
}

async function toggleReaction(channel, message, name, mine) {
  try {
    await call(mine ? "reactions.remove" : "reactions.add", { channel, timestamp: message.ts, name }, key());
  } catch (error) {
    if (error instanceof ToolError && (error.is("ALREADY_REACTED") || error.is("NO_REACTION"))) {
      // Someone (or another tab) changed it first; the reload below shows the real state.
    } else throw error;
  }
  await reloadAfterWrite(channel, message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : undefined);
}

async function togglePin(channel, message, pinned) {
  await call(pinned ? "pins.remove" : "pins.add", { channel, timestamp: message.ts }, key());
  toast(pinned ? "Unpinned from channel" : "Pinned to channel");
  await reloadAfterWrite(channel);
  if (state.view === "pins") await renderPins();
}

async function deleteMessage(channel, message) {
  const preview = messageRow(message, { channel, compact: true });
  const ok = await confirmDialog("Delete message", "Are you sure you want to delete this message? This cannot be undone.", "Delete", { danger: true, preview });
  if (!ok) return;
  await call("chat.delete", { channel, ts: message.ts }, key());
  if (state.editing === message.ts) cancelEdit();
  await reloadAfterWrite(channel, message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : undefined);
}

/** Re-read the current conversation (and the open thread) after a write, preserving scroll and composer text. */
async function reloadAfterWrite(channel, threadTs) {
  if (state.current === channel) await loadConversation(channel, { keepScroll: true });
  else await loadConversations();
  if (state.thread && state.thread.channel === channel && (threadTs === undefined || state.thread.ts === threadTs || state.thread.ts !== threadTs)) await loadThread({ keepScroll: true });
}

async function loadOlder() {
  if (!state.hasMore || !state.nextCursor) return;
  const result = await call("conversations.history", { channel: state.current, limit: PAGE, cursor: state.nextCursor });
  state.messages = [...[...result.messages].reverse(), ...state.messages];
  state.hasMore = result.has_more;
  state.nextCursor = result.response_metadata.next_cursor;
  renderMessages({ keepScroll: true });
}

// ---------------------------------------------------------------------------------------------
// Footer: composer, join bar, archived banner
// ---------------------------------------------------------------------------------------------

const composerInput = $("#composer-input");
function renderFooter() {
  const info = state.info;
  const footer = $("#pane-footer");
  const composer = $("#composer");
  const banner = $("#composer-banner");
  const note = $("#composer-note");
  footer.hidden = state.view !== "messages";
  note.hidden = true;
  banner.hidden = true;
  composer.hidden = false;
  if (!info) return;
  if (!info.is_member) {
    composer.hidden = true;
    banner.hidden = false;
    banner.replaceChildren();
    if (info.is_archived) {
      banner.append(el("p", { class: "banner-title", text: `#${info.name} has been archived` }), el("p", { text: "Archived channels can't be joined. You can still browse the channel list." }));
    } else if (info.is_channel && !info.is_private) {
      banner.className = "join-bar";
      banner.append(el("div", { class: "join-title", text: `#${info.name}` }), el("div", { class: "join-actions" }, [textButton("Details", { onClick: () => openDetails("about") }), textButton("Join channel", { class: "primary", onClick: () => action(() => joinChannel(info.id)) })]));
      return;
    } else banner.append(el("p", { text: "You're not a member of this conversation." }));
    banner.className = "composer-banner";
    return;
  }
  if (info.is_archived) {
    composer.hidden = true;
    banner.hidden = false;
    banner.className = "composer-banner";
    banner.replaceChildren(el("p", { class: "banner-title", text: `You are viewing #${info.name}` }), el("p", { text: "This channel has been archived. Messages can be read but no longer sent, edited or reacted to." }), el("div", { class: "banner-actions" }, textButton("Browse channels", { onClick: () => navigate("browse") })));
    return;
  }
  const label = info.is_im ? `Message ${conversationTitle(info)}` : info.is_mpim ? `Message ${conversationTitle(info)}` : `Message #${info.name}`;
  composerInput.placeholder = label;
  $("#composer-label").textContent = label;
  composer.classList.toggle("hide-toolbar", !state.toolbar);
  $("#composer-format").setAttribute("aria-pressed", String(state.toolbar));
  $("#composer-format").setAttribute("aria-label", state.toolbar ? "Hide formatting" : "Show formatting");
  updateSendState();
}

function updateSendState() {
  $("#send").disabled = composerInput.value.trim().length === 0;
  composerInput.style.height = "auto";
  composerInput.style.height = `${Math.min(composerInput.scrollHeight, window.innerHeight * 0.4)}px`;
}
composerInput.addEventListener("input", updateSendState);
composerInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void action(sendMessage);
  } else if (event.key === "Escape" && state.editing) {
    event.preventDefault();
    cancelEdit();
  } else if (event.key === "ArrowUp" && composerInput.value.length === 0 && !state.editing) {
    const own = [...state.messages].reverse().find((message) => message.user === me() && !message.subtype);
    if (own) {
      event.preventDefault();
      beginEdit(own);
    }
  }
});
$("#send").addEventListener("click", () => action(sendMessage));

/** Turn typed `@handle` mentions into the wire form the workspace stores (`<@Uxxx>`). */
function encodeMentions(text) {
  return text.replace(/(^|[\s(])@([a-z0-9._-]{1,21})\b/g, (whole, lead, handle) => {
    const user = [...state.users.values()].find((entry) => entry.name === handle);
    return user ? `${lead}<@${user.id}>` : whole;
  });
}
function decodeMentions(text) {
  return String(text).replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (whole, id) => (userOf(id) ? `@${userOf(id).name}` : whole));
}

async function sendMessage() {
  const raw = composerInput.value;
  if (raw.trim().length === 0 || !state.info?.is_member || state.info?.is_archived) return;
  const text = encodeMentions(raw);
  const note = $("#composer-note");
  note.hidden = true;
  const channel = state.current;
  try {
    if (state.editing) {
      await call("chat.update", { channel, ts: state.editing, text }, key());
      cancelEdit();
    } else {
      await call("chat.post-message", { channel, text }, key());
      composerInput.value = "";
    }
    updateSendState();
    await loadConversation(channel, { keepScroll: false });
  } catch (error) {
    if (error instanceof ToolError && error.is("RATELIMITED")) {
      note.hidden = false;
      note.replaceChildren(el("span", { text: "Slack is rate-limiting posts right now (429 ratelimited, Retry-After 30 s). Your message wasn't sent and is kept here — " }), textButton("try again", { class: "link-btn", onClick: () => action(sendMessage) }));
      note.lastChild.classList.remove("btn");
      return;
    }
    if (error instanceof ToolError && (error.is("IS_ARCHIVED") || error.is("NOT_IN_CHANNEL") || error.is("CHANNEL_NOT_FOUND"))) {
      await loadConversation(channel, { keepScroll: true });
    }
    throw error;
  }
}

function beginEdit(message) {
  if (!state.info?.is_member || state.info?.is_archived || message.user !== me()) return;
  state.editing = message.ts;
  composerInput.value = decodeMentions(message.text);
  composerInput.focus();
  composerInput.setSelectionRange(composerInput.value.length, composerInput.value.length);
  updateSendState();
  const note = $("#composer-note");
  note.hidden = false;
  note.style.color = "";
  note.replaceChildren(el("span", { class: "composer-hint", text: "Editing message · Enter to save · Esc to cancel" }), textButton("Cancel", { class: "link-btn", onClick: cancelEdit }));
  note.lastChild.classList.remove("btn");
  $("#composer").classList.add("editing");
}
function cancelEdit() {
  state.editing = undefined;
  composerInput.value = "";
  updateSendState();
  $("#composer-note").hidden = true;
  $("#composer").classList.remove("editing");
}

// Formatting toolbar: wraps the selection with mrkdwn markers (the workspace stores text; the client renders the markers).
function wrapSelection(before, after = before, placeholder = "text", input = composerInput) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const selected = input.value.slice(start, end) || placeholder;
  input.setRangeText(`${before}${selected}${after}`, start, end, "select");
  input.setSelectionRange(start + before.length, start + before.length + selected.length);
  input.focus();
  input.dispatchEvent(new Event("input"));
}
function prefixLines(prefix, numbered = false, input = composerInput) {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? start;
  const value = input.value;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", end) === -1 ? value.length : value.indexOf("\n", end);
  const lines = value.slice(lineStart, lineEnd).split("\n");
  const replaced = lines.map((line, index) => `${numbered ? `${index + 1}. ` : prefix}${line}`).join("\n");
  input.setRangeText(replaced, lineStart, lineEnd, "end");
  input.focus();
  input.dispatchEvent(new Event("input"));
}
function applyFormat(format, input = composerInput) {
  if (format === "link") wrapSelection("<https://", "|link text>", "example.test", input);
  else if (format === "ol") prefixLines("", true, input);
  else if (format === "ul") prefixLines("• ", false, input);
  else if (format === "quote") prefixLines("> ", false, input);
  else if (format === "```") wrapSelection("```\n", "\n```", "code", input);
  else wrapSelection(format, format, "text", input);
}
for (const button of $$("#composer-toolbar .fmt-btn")) button.addEventListener("click", () => applyFormat(button.dataset.fmt));
$("#composer-format").addEventListener("click", () => {
  state.toolbar = !state.toolbar;
  writePreference("toolbar", String(state.toolbar));
  renderFooter();
});
$("#composer-emoji").addEventListener("click", (event) => openEmojiPicker(event.currentTarget, (name) => wrapSelection(`:${name}: `, "", ""), { above: true }));
$("#composer-mention").addEventListener("click", (event) => {
  const items = [...state.users.values()]
    .filter((user) => !user.deleted && user.id !== me())
    .sort((left, right) => left.real_name.localeCompare(right.real_name))
    .map((user) => ({ label: user.real_name, detail: `@${user.name}`, onSelect: () => wrapSelection(`@${user.name} `, "", "") }));
  openMenu(event.currentTarget, items.length > 0 ? items : [{ label: "No one else to mention", disabled: true }], { above: true, header: "Mention someone" });
});
$("#composer-plus").addEventListener("click", (event) => {
  openMenu(event.currentTarget, [{ label: "Attach files isn't available", detail: "synthetic workspace", disabled: true }, { label: "Post a code block", icon: "code_block", onSelect: () => wrapSelection("```\n", "\n```", "code") }, { label: "Mention someone", icon: "at", onSelect: () => $("#composer-mention").click() }], { above: true });
});

async function joinChannel(id) {
  await call("conversations.join", { channel: id }, key());
  toast(`You joined #${conversationOf(id)?.name ?? id}`);
  await loadConversations();
  await loadConversation(id);
}

// ---------------------------------------------------------------------------------------------
// Emoji picker
// ---------------------------------------------------------------------------------------------

function openEmojiPicker(anchor, onPick, { above = false } = {}) {
  const picker = el("div", { class: "emoji-picker" });
  const search = el("input", { class: "emoji-search", attrs: { type: "text", placeholder: "Search all emoji", "aria-label": "Search emoji" } });
  const grid = el("div", { class: "emoji-grid", attrs: { role: "listbox", "aria-label": "Emoji" } });
  const custom = el("div", { class: "emoji-custom" });
  const customInput = el("input", { attrs: { type: "text", placeholder: "or type a :name:", "aria-label": "Emoji name" } });
  const customButton = textButton("Add", { class: "small", onClick: () => pick(customInput.value.trim().replace(/^:|:$/g, "")) });
  custom.append(customInput, customButton);
  const pick = (name) => {
    if (!name) return;
    closeMenus();
    onPick(name);
  };
  const fill = (filter) => {
    grid.replaceChildren();
    const names = PICKER_EMOJI.filter((name) => name.includes(filter.toLowerCase().replaceAll(" ", "_")));
    for (const name of names) {
      const cell = el("button", { class: "emoji-cell", text: emoji(name), title: `:${name}:`, attrs: { type: "button", role: "option", "aria-label": emojiLabel(name) } });
      cell.addEventListener("click", () => pick(name));
      grid.append(cell);
    }
    if (names.length === 0) grid.append(el("div", { class: "emoji-empty", text: "No emoji found — type its :name: below" }));
  };
  search.addEventListener("input", () => fill(search.value));
  customInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      pick(customInput.value.trim().replace(/^:|:$/g, ""));
    }
  });
  fill("");
  picker.append(search, grid, custom);
  openMenu(anchor, picker, { align: "end", above, className: "emoji-menu" });
}

// ---------------------------------------------------------------------------------------------
// Right panel: thread and profile
// ---------------------------------------------------------------------------------------------

function openPanel(kind, title, subtitle = "") {
  state.panel = kind;
  $("#side-title").textContent = title;
  $("#side-subtitle").textContent = subtitle;
  $("#side-panel").hidden = false;
}
function closePanel() {
  state.panel = undefined;
  state.thread = undefined;
  state.profile = undefined;
  $("#side-panel").hidden = true;
  $("#side-body").replaceChildren();
  if (currentHash().includes("/thread/")) navigate(currentHash().split("/")[0]);
}
$("#side-close").addEventListener("click", closePanel);

async function openThread(channel, ts) {
  const conversation = conversationOf(channel) ?? state.info;
  state.thread = { channel, ts, parent: undefined, replies: [], hasMore: false, cursor: "" };
  openPanel("thread", "Thread", conversation ? (isDm(conversation) ? conversationTitle(conversation) : `#${conversation.name}`) : "");
  $("#side-body").replaceChildren(skeleton(3));
  await loadThread();
}

async function loadThread({ keepScroll = false } = {}) {
  const thread = state.thread;
  if (!thread) return;
  const body = $("#side-body");
  const previous = body.scrollTop;
  try {
    const result = await call("conversations.replies", { channel: thread.channel, ts: thread.ts, limit: PAGE });
    if (state.thread !== thread) return;
    thread.parent = result.messages[0];
    thread.replies = result.messages.slice(1);
    thread.hasMore = result.has_more;
    thread.cursor = result.response_metadata.next_cursor;
  } catch (error) {
    if (state.thread !== thread) return;
    body.replaceChildren();
    if (error instanceof ToolError && error.is("THREAD_NOT_FOUND")) body.append(stateCard("This thread no longer exists", "The message was deleted or the world was reset.", { actions: [textButton("Close", { onClick: closePanel })] }));
    else if (error instanceof ToolError && error.denied) body.append(stateCard("You don't have permission to view threads", "This actor has no grant for conversations.replies (missing_scope).", { error: true }));
    else body.append(stateCard("Couldn't load this thread", describe(error), { error: true, actions: [textButton("Try again", { onClick: () => action(() => loadThread()) })] }));
    return;
  }
  renderThread();
  if (keepScroll) body.scrollTop = previous;
  else body.scrollTop = body.scrollHeight;
}

function renderThread() {
  const thread = state.thread;
  const body = $("#side-body");
  const draft = $("#thread-input")?.value ?? "";
  const broadcast = $("#thread-broadcast")?.checked ?? false;
  body.replaceChildren();
  const messages = el("div", { class: "thread-messages" });
  messages.append(messageRow(thread.parent, { channel: thread.channel, inThread: true }));
  const count = thread.parent.reply_count ?? thread.replies.length;
  if (count > 0 || thread.replies.length > 0) messages.append(el("div", { class: "replies-divider", text: `${count} repl${count === 1 ? "y" : "ies"}` }));
  let previous;
  for (const reply of thread.replies) {
    const continued = previous !== undefined && previous.user === reply.user && !reply.subtype && !previous.subtype && tsSeconds(reply.ts) - tsSeconds(previous.ts) < 300;
    messages.append(messageRow(reply, { channel: thread.channel, inThread: true, continued }));
    previous = reply;
  }
  if (thread.hasMore) messages.append(textButton("Load more replies", { class: "load-more", onClick: () => action(loadMoreReplies) }));
  body.append(messages);
  const info = thread.channel === state.current ? state.info : conversationOf(thread.channel);
  const composerHost = el("div", { class: "thread-composer" });
  if (info && info.is_member && !info.is_archived && thread.parent.subtype !== "tombstone") {
    // The thread composer is the same composer as the channel one: formatting toolbar, +, format toggle, emoji,
    // mention, clips, shortcuts and a send button with its schedule caret.
    const composer = el("div", { class: `composer thread-composer-box${state.toolbar ? "" : " hide-toolbar"}` });
    const input = el("textarea", { attrs: { id: "thread-input", rows: "1", placeholder: "Reply…", "aria-label": "Reply in thread", spellcheck: "true" } });
    input.value = draft;
    const fmt = (format, iconName, label) => {
      const button = el("button", { class: "fmt-btn", attrs: { type: "button", "aria-label": label, title: label } }, icon(iconName));
      button.addEventListener("click", () => applyFormat(format, input));
      return button;
    };
    const divider = () => el("span", { class: "fmt-divider", attrs: { role: "separator" } });
    const toolbar = el("div", { class: "composer-toolbar" }, [
      fmt("*", "bold", "Bold"), fmt("_", "italic", "Italic"), fmt("~", "strike", "Strikethrough"), divider(),
      fmt("link", "link", "Link"), divider(), fmt("ol", "list_ol", "Ordered list"), fmt("ul", "list_ul", "Bulleted list"), divider(),
      fmt("quote", "quote", "Blockquote"), divider(), fmt("`", "code", "Code"), fmt("```", "code_block", "Code block"),
    ]);
    const plain = (iconName, label, attrs = {}) => el("button", { class: "fmt-btn", attrs: { type: "button", "aria-label": label, title: label, ...attrs } }, icon(iconName));
    const plus = el("button", { class: "composer-plus", attrs: { type: "button", "aria-label": "Attach", title: "Attach", "aria-expanded": "false" } }, icon("plus"));
    const formatToggle = plain("format", state.toolbar ? "Hide formatting" : "Show formatting", { "aria-pressed": String(state.toolbar) });
    const emojiButton = plain("emoji", "Emoji", { "aria-expanded": "false" });
    const mentionButton = plain("at", "Mention someone", { "aria-expanded": "false" });
    const mention = (anchor) => openMenu(anchor, [...state.users.values()].filter((user) => !user.deleted && user.id !== me()).sort((left, right) => left.real_name.localeCompare(right.real_name)).map((user) => ({ label: user.real_name, detail: `@${user.name}`, onSelect: () => insertAt(input, `@${user.name} `) })), { above: true, header: "Mention someone" });
    emojiButton.addEventListener("click", (event) => openEmojiPicker(event.currentTarget, (name) => insertAt(input, `:${name}: `), { above: true }));
    mentionButton.addEventListener("click", (event) => mention(event.currentTarget));
    plus.addEventListener("click", (event) => openMenu(event.currentTarget, [{ label: "Attach files isn't available", detail: "synthetic workspace", disabled: true }, { label: "Post a code block", icon: "code_block", onSelect: () => applyFormat("```", input) }, { label: "Mention someone", icon: "at", onSelect: () => mention(mentionButton) }], { above: true }));
    formatToggle.addEventListener("click", () => {
      state.toolbar = !state.toolbar;
      writePreference("toolbar", String(state.toolbar));
      composer.classList.toggle("hide-toolbar", !state.toolbar);
      formatToggle.setAttribute("aria-pressed", String(state.toolbar));
      formatToggle.setAttribute("aria-label", state.toolbar ? "Hide formatting" : "Show formatting");
      formatToggle.title = state.toolbar ? "Hide formatting" : "Show formatting";
      renderFooter();
    });
    const actions = el("div", { class: "composer-actions" });
    const start = el("div", { class: "composer-actions-start" }, [
      plus, formatToggle, emojiButton, mentionButton, divider(),
      plain("video", "Record video clip", { "data-ns": "video" }), plain("mic", "Record audio clip", { "data-ns": "audio" }), divider(),
      plain("slash", "Run shortcut", { "data-ns": "shortcuts", "aria-expanded": "false" }),
    ]);
    const send = el("button", { class: "send-btn", attrs: { type: "button", "aria-label": "Send now", title: "Send now" } }, icon("send"));
    send.disabled = draft.trim().length === 0;
    const caret = el("button", { class: "send-caret", attrs: { type: "button", "data-ns": "schedule", "aria-label": "Schedule for later", title: "Schedule for later", "aria-expanded": "false" } }, icon("chevron_down"));
    actions.append(start, el("div", { class: "composer-actions-end" }, [send, el("span", { class: "send-divider", attrs: { "aria-hidden": "true" } }), caret]));
    const check = el("label", { class: "broadcast-check" }, [el("input", { attrs: { type: "checkbox", id: "thread-broadcast" } }), el("span", { text: `Also send to ${isDm(info) ? conversationTitle(info) : `#${info.name}`}` })]);
    check.firstChild.checked = broadcast;
    composer.append(toolbar, input, actions, check);
    const note = el("p", { class: "composer-note", attrs: { role: "alert" } });
    note.hidden = true;
    const submit = () =>
      action(async () => {
        const text = input.value.trim();
        if (text.length === 0) return;
        note.hidden = true;
        try {
          if (check.firstChild.checked) await call("chat.post-message", { channel: thread.channel, text: encodeMentions(text), thread_ts: thread.ts, reply_broadcast: true }, key());
          else await call("chat.reply", { channel: thread.channel, thread_ts: thread.ts, text: encodeMentions(text) }, key());
          input.value = "";
          check.firstChild.checked = false;
          await loadThread();
          if (state.current === thread.channel) await loadConversation(thread.channel, { keepScroll: true });
          else await loadConversations();
        } catch (error) {
          if (error instanceof ToolError && error.is("RATELIMITED")) {
            note.hidden = false;
            note.textContent = "Slack is rate-limiting posts right now (429). Your reply wasn't sent and is kept here — try again in 30 seconds.";
            return;
          }
          throw error;
        }
      });
    input.addEventListener("input", () => {
      send.disabled = input.value.trim().length === 0;
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void submit();
      }
    });
    send.addEventListener("click", () => void submit());
    composerHost.append(composer, note);
  } else if (info?.is_archived) composerHost.append(el("div", { class: "composer-banner" }, el("p", { text: "This channel is archived — replies can't be added." })));
  else if (thread.parent.subtype === "tombstone") composerHost.append(el("div", { class: "composer-banner" }, el("p", { text: "The original message was deleted; the thread stays readable." })));
  body.append(composerHost);
}

function insertAt(input, text) {
  const start = input.selectionStart ?? input.value.length;
  input.setRangeText(text, start, input.selectionEnd ?? start, "end");
  input.focus();
  input.dispatchEvent(new Event("input"));
}

async function loadMoreReplies() {
  const thread = state.thread;
  if (!thread?.hasMore) return;
  const result = await call("conversations.replies", { channel: thread.channel, ts: thread.ts, limit: PAGE, cursor: thread.cursor });
  thread.replies.push(...result.messages);
  thread.hasMore = result.has_more;
  thread.cursor = result.response_metadata.next_cursor;
  renderThread();
}

async function openProfile(userId) {
  state.thread = undefined;
  state.profile = userId;
  openPanel("profile", "Profile");
  const body = $("#side-body");
  body.replaceChildren(skeleton(2));
  let user;
  try {
    user = (await call("users.info", { user: userId })).user;
  } catch (error) {
    if (state.profile !== userId) return;
    body.replaceChildren(stateCard("Profile unavailable", error instanceof ToolError && error.is("USER_NOT_FOUND") ? "This person doesn't exist in the workspace." : describe(error), { error: !(error instanceof ToolError && error.is("USER_NOT_FOUND")) }));
    return;
  }
  if (state.profile !== userId) return;
  state.users.set(user.id, user);
  body.replaceChildren();
  body.append(el("div", { class: "profile-avatar-wrap" }, avatar(user, "xxl")));
  const profile = el("div", { class: "profile" });
  const name = el("h3", { class: "profile-name", text: user.real_name });
  if (user.is_bot) name.append(el("span", { class: "app-badge", text: "APP" }));
  if (user.deleted) name.append(el("span", { class: "deactivated-badge", text: "Deactivated" }));
  if (user.id === me()) name.append(el("span", { class: "presence active", attrs: { "aria-label": "Active" } }));
  profile.append(name);
  if (user.profile.display_name && user.profile.display_name !== user.real_name) profile.append(el("div", { class: "profile-handle", text: `@${user.profile.display_name}` }));
  if (user.profile.title) profile.append(el("div", { class: "profile-title", text: user.profile.title }));
  if (user.profile.status_text || user.profile.status_emoji) {
    const status = el("div", { class: "profile-status" });
    renderText(status, `${user.profile.status_emoji ? `${user.profile.status_emoji} ` : ""}${user.profile.status_text}`, { resolve });
    profile.append(status);
  }
  profile.append(el("div", { class: "profile-time" }, [icon("clock"), el("span", { text: `${clockTime(nowTs(), user.tz_offset)} local time${user.tz_label ? ` · ${user.tz_label}` : ""}` })]));
  const actions = el("div", { class: "profile-actions" });
  if (user.id !== me() && !user.deleted) {
    actions.append(textButton("Message", { onClick: () => action(() => openDirectMessage([user.id])) }));
    actions.firstChild.prepend(icon("dm"));
  }
  if (user.id === me()) actions.append(textButton("This is you", { attrs: { disabled: "" } }));
  profile.append(actions);
  const contact = el("section", { class: "profile-section" }, el("h3", { text: "Contact information" }));
  const list = el("dl");
  if (user.profile.email) list.append(el("div", {}, [el("dt", { text: "Email address" }), el("dd", { text: user.profile.email })]));
  list.append(el("div", {}, [el("dt", { text: "Time zone" }), el("dd", { class: "plain", text: `${user.tz_label || user.tz} (${user.tz})` })]));
  list.append(el("div", {}, [el("dt", { text: "Member ID" }), el("dd", { class: "plain", text: user.id })]));
  if (user.is_admin || user.is_owner) list.append(el("div", {}, [el("dt", { text: "Role" }), el("dd", { class: "plain", text: user.is_owner ? "Workspace Owner" : "Workspace Admin" })]));
  contact.append(list);
  profile.append(contact);
  body.append(profile);
}

async function openDirectMessage(userIds) {
  const result = await call("conversations.open", { users: userIds.join(","), return_im: true }, key());
  await loadConversations();
  navigate(result.channel.id);
}

// ---------------------------------------------------------------------------------------------
// Pins tab
// ---------------------------------------------------------------------------------------------

async function renderPins() {
  const body = paneBody();
  body.append(skeleton(2));
  let items;
  try {
    items = (await call("pins.list", { channel: state.current })).items;
  } catch (error) {
    body.replaceChildren(stateCard("Pinned messages can't be shown", describe(error), { error: true }));
    return;
  }
  body.replaceChildren();
  const scroll = el("div", { class: "view-scroll" });
  body.append(scroll);
  state.pinCount = items.length;
  $("#pins-count").textContent = items.length > 0 ? String(items.length) : "";
  if (items.length === 0) {
    scroll.append(stateCard("No pinned items yet", "Pin important messages with the More actions menu so everyone in the channel can find them here."));
    return;
  }
  const list = el("div", { class: "pins-list" });
  for (const item of items) {
    const card = el("article", { class: "pin-item" });
    card.append(el("div", { class: "pin-meta" }, [icon("pin"), el("span", { text: `Pinned by ${userName(item.created_by)} · ${fullDate(String(item.created), tz())}` })]));
    card.append(messageRow(item.message, { channel: state.current, compact: true }));
    const actions = el("div", { class: "pin-actions" });
    actions.append(textButton("Jump to message", { class: "small", onClick: () => jumpTo(state.current, item.message.ts) }));
    if (state.info?.is_member && !state.info?.is_archived) actions.append(textButton("Unpin", { class: "small", onClick: () => action(() => togglePin(state.current, item.message, true)) }));
    card.append(actions);
    list.append(card);
  }
  scroll.append(list);
}

/** Open a conversation and scroll to one message, paging back through history until it is loaded (bounded). */
async function jumpTo(channel, ts) {
  state.highlight = ts;
  if (state.current !== channel || state.view !== "messages" || !state.messages.some((message) => message.ts === ts)) {
    await loadConversation(channel, { keepScroll: false });
    navigate(channel);
    for (let page = 0; page < 20 && state.hasMore && !state.messages.some((message) => message.ts === ts || message.ts === state.messages[0]?.thread_ts); page += 1) {
      if (state.messages.some((message) => message.ts === ts)) break;
      if (state.messages.length > 0 && tsSeconds(state.messages[0].ts) < tsSeconds(ts)) break;
      await loadOlder();
    }
    state.highlight = ts;
  }
  const target = state.messages.find((message) => message.ts === ts);
  if (!target) {
    // A thread reply: open its thread instead.
    const parent = state.messages.find((message) => message.thread_ts && message.reply_count > 0 && tsSeconds(message.ts) <= tsSeconds(ts));
    state.highlight = undefined;
    renderMessages({ keepScroll: true });
    if (parent) navigate(`${channel}/thread/${parent.ts}`);
    else toast("That message is inside a thread that isn't loaded here.");
    return;
  }
  renderMessages({ keepScroll: true });
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = $("#search").value.trim();
  if (query.length === 0) return;
  navigate(`search/${query}`);
});
$("#search").addEventListener("input", () => {
  $("#search-form").classList.toggle("has-value", $("#search").value.length > 0);
  $("#search-clear").hidden = $("#search").value.length === 0;
});
$("#search-clear").addEventListener("click", () => {
  $("#search").value = "";
  $("#search-form").classList.remove("has-value");
  $("#search-clear").hidden = true;
  $("#search").focus();
});

async function runSearch(query, { page = 1, sort } = {}) {
  showView("search");
  const search = state.search;
  if (search.query !== query) search.page = 1;
  search.query = query;
  search.page = page;
  if (sort) search.sort = sort;
  $("#pane-title-text").textContent = "Search";
  $("#pane-title-glyph").replaceChildren(icon("search"));
  const body = paneBody();
  body.append(searchHeader(undefined));
  body.append(skeleton(3));
  search.loading = true;
  try {
    search.result = await call("search.messages", { query, count: SEARCH_PAGE, page: search.page, sort: search.sort, sort_dir: "desc" });
    search.error = undefined;
  } catch (error) {
    search.error = error;
    search.result = undefined;
  } finally {
    search.loading = false;
  }
  if (state.view !== "search" || state.search.query !== query) return;
  renderSearch();
}

function searchHeader(result) {
  const header = el("div", { class: "results-header" });
  header.append(el("h2", { class: "results-query", text: state.search.query }));
  const tabs = el("div", { class: "results-tabs", attrs: { role: "tablist" } });
  const messages = el("button", { class: "results-tab", attrs: { type: "button", role: "tab", "aria-current": "page" } }, el("span", { text: "Messages" }));
  if (result) messages.append(el("span", { class: "count", text: String(result.messages.total) }));
  tabs.append(messages);
  header.append(tabs);
  return header;
}

function renderSearch() {
  const search = state.search;
  const body = paneBody();
  body.append(searchHeader(search.result));
  const filters = el("div", { class: "results-filters" });
  const inChip = el("button", { class: "filter-chip", attrs: { type: "button", "aria-expanded": "false" } }, [el("span", { text: "In" }), icon("chevron_down")]);
  inChip.addEventListener("click", (event) => {
    const items = state.conversations.filter((conversation) => conversation.is_member && !isDm(conversation)).map((conversation) => ({ label: `#${conversation.name}`, icon: conversation.is_private ? "lock" : "hash", onSelect: () => navigate(`search/${stripModifier(search.query, "in:")} in:#${conversation.name}`.trim()) }));
    openMenu(event.currentTarget, items, { header: "Search in channel" });
  });
  const fromChip = el("button", { class: "filter-chip", attrs: { type: "button", "aria-expanded": "false" } }, [el("span", { text: "From" }), icon("chevron_down")]);
  fromChip.addEventListener("click", (event) => {
    const items = [...state.users.values()].filter((user) => !user.deleted).map((user) => ({ label: user.real_name, detail: `@${user.name}`, onSelect: () => navigate(`search/${stripModifier(search.query, "from:")} from:@${user.name}`.trim()) }));
    openMenu(event.currentTarget, items, { header: "Search messages from" });
  });
  const pinnedChip = el("button", { class: "filter-chip", attrs: { type: "button", "aria-pressed": String(/\bis:pinned\b/.test(search.query)) } }, el("span", { text: "Pinned" }));
  pinnedChip.addEventListener("click", () => navigate(`search/${/\bis:pinned\b/.test(search.query) ? search.query.replace(/\s*\bis:pinned\b/, "").trim() : `${search.query} is:pinned`}`));
  const sortChip = el("button", { class: "filter-chip results-sort", attrs: { type: "button", "aria-expanded": "false" } }, [icon("sort"), el("span", { text: search.sort === "score" ? "Most relevant" : "Most recent" }), icon("chevron_down")]);
  sortChip.addEventListener("click", (event) => openMenu(event.currentTarget, [{ label: "Most relevant", onSelect: () => runSearch(search.query, { page: 1, sort: "score" }) }, { label: "Most recent", onSelect: () => runSearch(search.query, { page: 1, sort: "timestamp" }) }], { align: "end" }));
  filters.append(inChip, fromChip, pinnedChip, sortChip);
  body.append(filters);
  const scroll = el("div", { class: "view-scroll" });
  body.append(scroll);
  if (search.error) {
    const error = search.error;
    if (error instanceof ToolError && error.is("INVALID_ARGUMENTS")) scroll.append(stateCard("That search isn't supported here", `${error.message}. Supported modifiers: from:@user, in:#channel, in:@user, is:pinned, is:thread, has:reaction, before:/after:/on:/during: YYYY-MM-DD, quoted phrases.`, { error: true }));
    else if (error instanceof ToolError && error.is("SERVICE_UNAVAILABLE")) scroll.append(stateCard("Search is temporarily unavailable", "The workspace answered 503 service_unavailable. Nothing was changed.", { error: true, actions: [textButton("Try again", { onClick: () => runSearch(search.query, { page: search.page }) })] }));
    else if (error instanceof ToolError && error.denied) scroll.append(stateCard("You don't have permission to search", "This actor has no grant for search.messages (missing_scope).", { error: true }));
    else scroll.append(stateCard("Search failed", describe(error), { error: true }));
    return;
  }
  const result = search.result.messages;
  if (result.total === 0) {
    scroll.append(stateCard("No results", `Nothing matched “${state.search.query}” in the conversations you're a member of. Try different keywords or a modifier like from:@name or in:#channel.`));
    return;
  }
  const terms = search.query
    .split(/\s+/)
    .filter((term) => term.length > 0 && !/^[a-z]+:/.test(term) && !/^-/.test(term))
    .map((term) => term.replace(/^"|"$/g, ""));
  for (const match of result.matches) {
    const row = el("button", { class: "result", attrs: { type: "button" } });
    const head = el("div", { class: "result-head" });
    const channelLabel = el("span", { class: "result-channel" });
    if (match.channel.is_im || match.channel.is_mpim) {
      const conversation = conversationOf(match.channel.id);
      channelLabel.append(icon("dm"), el("span", { text: conversation ? conversationTitle(conversation) : "Direct message" }));
    } else channelLabel.append(icon(match.channel.is_private ? "lock" : "hash"), el("span", { text: match.channel.name }));
    head.append(channelLabel, el("span", { text: shortDate(match.ts, nowTs(), tz()) }));
    row.append(head);
    const bodyRow = el("div", { class: "result-body" });
    bodyRow.append(avatar(userOf(match.user) ?? { id: match.user }, "lg"));
    const text = el("div", { class: "result-text" });
    text.append(el("span", { class: "result-author", text: userName(match.user) }));
    highlightTerms(text, plainText(match.text, resolve), terms);
    bodyRow.append(text);
    row.append(bodyRow);
    row.addEventListener("click", () => action(() => jumpTo(match.channel.id, match.ts)));
    scroll.append(row);
  }
  const pagination = result.pagination;
  const pager = el("div", { class: "results-pager" });
  const prev = el("button", { class: "pager-btn", attrs: { type: "button", "aria-label": "Previous page" } }, icon("chevron_left"));
  prev.disabled = pagination.page <= 1;
  prev.addEventListener("click", () => runSearch(search.query, { page: pagination.page - 1 }));
  const next = el("button", { class: "pager-btn", attrs: { type: "button", "aria-label": "Next page" } }, icon("chevron_right"));
  next.disabled = pagination.page >= pagination.page_count;
  next.addEventListener("click", () => runSearch(search.query, { page: pagination.page + 1 }));
  pager.append(prev, el("span", { text: `${pagination.first}–${pagination.last} of ${pagination.total_count}` }), next);
  scroll.append(pager);
}

function stripModifier(query, modifier) {
  return query.replace(new RegExp(`\\s*\\b${modifier}\\S+`, "g"), "").trim();
}

/** Append `text` to `target` with each search term wrapped in <mark>; purely text-node based. */
function highlightTerms(target, text, terms) {
  const lowered = terms.map((term) => term.toLowerCase()).filter((term) => term.length > 0);
  if (lowered.length === 0) {
    target.append(text);
    return;
  }
  let index = 0;
  const lowerText = text.toLowerCase();
  while (index < text.length) {
    let best = -1;
    let bestTerm = "";
    for (const term of lowered) {
      const found = lowerText.indexOf(term, index);
      if (found !== -1 && (best === -1 || found < best)) {
        best = found;
        bestTerm = term;
      }
    }
    if (best === -1) {
      target.append(text.slice(index));
      break;
    }
    if (best > index) target.append(text.slice(index, best));
    target.append(el("mark", { text: text.slice(best, best + bestTerm.length) }));
    index = best + bestTerm.length;
  }
}

// ---------------------------------------------------------------------------------------------
// Browse channels and People directory
// ---------------------------------------------------------------------------------------------

async function renderBrowse() {
  $("#pane-title-text").textContent = "Browse channels";
  $("#pane-title-glyph").replaceChildren(icon("channel_browse"));
  const body = paneBody();
  body.append(skeleton(3));
  await loadConversations();
  if (state.view !== "browse") return;
  const counts = new Map();
  await Promise.all(
    state.conversations
      .filter((conversation) => conversation.is_channel && !isDm(conversation))
      .slice(0, 200)
      .map((conversation) =>
        call("conversations.info", { channel: conversation.id, include_num_members: true })
          .then((result) => counts.set(conversation.id, result.channel.num_members))
          .catch(() => undefined),
      ),
  );
  if (state.view !== "browse") return;
  body.replaceChildren();
  const header = el("div", { class: "browse-header" }, [el("h2", { text: "All channels" }), textButton("Create channel", { class: "primary", onClick: () => openCreateChannel() })]);
  const tools = el("div", { class: "browse-tools" });
  const field = el("div", { class: "field" }, [el("span", { class: "field-prefix" }, icon("search"))]);
  const input = el("input", { attrs: { type: "text", placeholder: "Search for channels", "aria-label": "Search for channels" } });
  input.value = state.browse.filter;
  field.append(input);
  tools.append(field);
  const scroll = el("div", { class: "view-scroll" });
  body.append(header, tools, scroll);
  const fill = () => {
    scroll.replaceChildren();
    const filter = state.browse.filter.toLowerCase().replace(/^#/, "");
    const channels = state.conversations
      .filter((conversation) => conversation.is_channel && !isDm(conversation) && (filter.length === 0 || conversation.name.includes(filter) || (conversation.purpose?.value ?? "").toLowerCase().includes(filter)))
      .sort((left, right) => Number(left.is_archived) - Number(right.is_archived) || left.name.localeCompare(right.name));
    if (channels.length === 0) {
      scroll.append(stateCard(state.conversations.length === 0 ? "No channels yet" : "No channels match", state.conversations.length === 0 ? "This workspace has no channels you can see. Create one to get started." : `Nothing named “${state.browse.filter}”. Try another name or create the channel.`, { actions: [textButton("Create channel", { class: "primary", onClick: () => openCreateChannel(state.browse.filter) })] }));
      return;
    }
    scroll.append(el("div", { class: "results-note", text: `${channels.length} channel${channels.length === 1 ? "" : "s"}` }));
    for (const conversation of channels) {
      const row = el("div", { class: "browse-row" });
      const main = el("div", { class: "browse-main" });
      const name = el("button", { class: "browse-name", attrs: { type: "button" } }, [icon(conversation.is_private ? "lock" : "hash"), el("span", { text: conversation.name })]);
      if (conversation.is_archived) name.append(el("span", { class: "archived-badge", text: "Archived" }));
      name.addEventListener("click", () => navigate(conversation.id));
      const meta = el("div", { class: "browse-meta" });
      if (conversation.is_member) meta.append(el("span", { class: "browse-joined", text: "Joined" }));
      const members = counts.get(conversation.id);
      if (members !== undefined) meta.append(el("span", { class: conversation.is_member ? "dot" : "", text: `${members} member${members === 1 ? "" : "s"}` }));
      if (conversation.purpose?.value) meta.append(el("span", { class: "dot", text: conversation.purpose.value }));
      main.append(name, meta);
      row.append(main);
      if (conversation.is_member) row.append(el("span", { class: "btn small joined browse-join joined" }, [icon("check"), el("span", { text: "Joined" })]));
      else if (!conversation.is_archived && !conversation.is_private) row.append(textButton("Join", { class: "small primary browse-join", onClick: () => action(() => joinChannel(conversation.id)) }));
      else row.append(textButton("View", { class: "small browse-join", onClick: () => navigate(conversation.id) }));
      scroll.append(row);
    }
  };
  input.addEventListener("input", () => {
    state.browse.filter = input.value;
    fill();
  });
  fill();
}

async function renderPeople() {
  $("#pane-title-text").textContent = "People";
  $("#pane-title-glyph").replaceChildren(icon("users"));
  const body = paneBody();
  body.append(skeleton(3));
  try {
    await loadIdentity();
  } catch (error) {
    body.replaceChildren(stateCard("People can't be listed", describe(error), { error: true }));
    return;
  }
  if (state.view !== "people") return;
  body.replaceChildren();
  const header = el("div", { class: "browse-header" }, el("h2", { text: `Members of ${state.identity.team}` }));
  const tools = el("div", { class: "browse-tools" });
  const field = el("div", { class: "field" }, [el("span", { class: "field-prefix" }, icon("search"))]);
  const input = el("input", { attrs: { type: "text", placeholder: "Search by name or title", "aria-label": "Search people" } });
  input.value = state.people.filter;
  field.append(input);
  tools.append(field);
  const scroll = el("div", { class: "view-scroll" });
  body.append(header, tools, scroll);
  const fill = () => {
    scroll.replaceChildren();
    const filter = state.people.filter.toLowerCase();
    const users = [...state.users.values()]
      .filter((user) => filter.length === 0 || user.real_name.toLowerCase().includes(filter) || user.name.includes(filter) || (user.profile.title ?? "").toLowerCase().includes(filter))
      .sort((left, right) => Number(left.deleted) - Number(right.deleted) || left.real_name.localeCompare(right.real_name));
    if (users.length === 0) {
      scroll.append(stateCard("No one matches", `Nobody named “${state.people.filter}” in this workspace.`));
      return;
    }
    scroll.append(el("div", { class: "results-note", text: `${users.length} member${users.length === 1 ? "" : "s"}` }));
    for (const user of users) {
      const row = el("div", { class: "browse-row" });
      row.append(avatar(user, "lg"));
      const main = el("div", { class: "browse-main" });
      const name = el("button", { class: "browse-name", attrs: { type: "button" } }, el("span", { text: user.real_name }));
      if (user.is_bot) name.append(el("span", { class: "app-badge", text: "APP" }));
      if (user.deleted) name.append(el("span", { class: "deactivated-badge", text: "Deactivated" }));
      if (user.id === me()) name.append(el("span", { class: "archived-badge", text: "you" }));
      name.addEventListener("click", () => openProfile(user.id));
      const meta = el("div", { class: "browse-meta" }, el("span", { text: `@${user.name}` }));
      if (user.profile.title) meta.append(el("span", { class: "dot", text: user.profile.title }));
      main.append(name, meta);
      row.append(main);
      if (user.id !== me() && !user.deleted) row.append(textButton("Message", { class: "small browse-join", onClick: () => action(() => openDirectMessage([user.id])) }));
      scroll.append(row);
    }
  };
  input.addEventListener("input", () => {
    state.people.filter = input.value;
    fill();
  });
  fill();
}

// ---------------------------------------------------------------------------------------------
// Dialogs: create channel, topic, people (invite / new message), details, about
// ---------------------------------------------------------------------------------------------

for (const button of $$("[data-close]")) button.addEventListener("click", () => button.closest("dialog")?.close("cancel"));

const createDialog = $("#create-channel-dialog");
const channelName = $("#channel-name");
channelName.addEventListener("input", () => {
  const normalized = channelName.value.toLowerCase().replace(/\s+/g, "-");
  if (normalized !== channelName.value) channelName.value = normalized;
  $("#channel-name-counter").textContent = String(80 - channelName.value.length);
  $("#create-channel-submit").disabled = channelName.value.trim().replace(/^#/, "").length === 0;
  $("#create-channel-error").hidden = true;
});
for (const radio of $$("#create-channel-form input[name=visibility]")) {
  radio.addEventListener("change", () => $("#channel-name-prefix").replaceChildren(icon(radio.value === "private" && radio.checked ? "lock" : "hash")));
}
function openCreateChannel(prefill = "") {
  channelName.value = prefill.replace(/^#/, "");
  $("#channel-name-counter").textContent = String(80 - channelName.value.length);
  $("#create-channel-submit").disabled = channelName.value.trim().length === 0;
  $("#create-channel-error").hidden = true;
  $("#create-channel-form").visibility.value = "public";
  $("#channel-name-prefix").replaceChildren(icon("hash"));
  createDialog.showModal();
  channelName.focus();
}
$("#create-channel-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void action(
    async () => {
      const isPrivate = $("#create-channel-form").visibility.value === "private";
      const result = await call("conversations.create", { name: channelName.value.trim(), is_private: isPrivate }, key());
      createDialog.close("ok");
      toast(`Created #${result.channel.name}`);
      await loadConversations();
      navigate(result.channel.id);
    },
    {
      onError: (error) => {
        const box = $("#create-channel-error");
        box.hidden = false;
        box.textContent = describe(error);
      },
    },
  );
});

const topicDialog = $("#topic-dialog");
function openTopicDialog() {
  if (!state.info) return;
  $("#topic-input").value = state.info.topic?.value ?? "";
  $("#topic-error").hidden = true;
  $("#topic-title").textContent = state.info.topic?.value ? "Edit topic" : "Add a topic";
  topicDialog.showModal();
  $("#topic-input").focus();
}
$("#topic-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void action(
    async () => {
      await call("conversations.set-topic", { channel: state.current, topic: $("#topic-input").value.trim() }, key());
      topicDialog.close("ok");
      await loadConversations();
      await loadConversation(state.current, { keepScroll: true });
      if ($("#details-dialog").open) renderDetails("about");
    },
    {
      onError: (error) => {
        const box = $("#topic-error");
        box.hidden = false;
        box.textContent = describe(error);
      },
    },
  );
});
$("#pane-topic").addEventListener("click", () => {
  if (state.info?.is_member && !state.info?.is_archived) openTopicDialog();
  else openDetails("about");
});

const peopleDialog = $("#people-dialog");
const people = { mode: "invite", selected: new Set() };
function openPeopleDialog(mode) {
  people.mode = mode;
  people.selected = new Set();
  $("#people-filter").value = "";
  $("#people-error").hidden = true;
  if (mode === "invite") {
    $("#people-title").textContent = "Add people";
    $("#people-subtitle").textContent = `#${state.info?.name ?? ""}`;
    $("#people-submit").textContent = "Add";
  } else {
    $("#people-title").textContent = "New message";
    $("#people-subtitle").textContent = "Choose up to 8 people to message";
    $("#people-submit").textContent = "Go";
  }
  renderPeopleList();
  peopleDialog.showModal();
  $("#people-filter").focus();
}
$("#people-filter").addEventListener("input", renderPeopleList);
async function renderPeopleList() {
  const list = $("#people-list");
  const filter = $("#people-filter").value.toLowerCase();
  let members = new Set();
  if (people.mode === "invite" && state.current) {
    try {
      let cursor;
      for (let page = 0; page < 20; page += 1) {
        const result = await call("conversations.members", { channel: state.current, limit: 200, ...(cursor ? { cursor } : {}) });
        for (const id of result.members) members.add(id);
        cursor = result.response_metadata.next_cursor;
        if (!cursor) break;
      }
    } catch {
      members = new Set();
    }
  }
  list.replaceChildren();
  const candidates = [...state.users.values()]
    .filter((user) => user.id !== me() && !user.deleted)
    .filter((user) => filter.length === 0 || user.real_name.toLowerCase().includes(filter) || user.name.includes(filter))
    .sort((left, right) => left.real_name.localeCompare(right.real_name));
  if (candidates.length === 0) list.append(el("li", { class: "people-empty", text: "No one matches." }));
  for (const user of candidates) {
    const already = members.has(user.id);
    const row = el("button", { class: "person-row", attrs: { type: "button", role: "option", "aria-selected": String(people.selected.has(user.id)) } });
    row.disabled = already;
    row.append(avatar(user, "lg"));
    const main = el("div", { class: "member-main" });
    main.append(el("div", { class: "person-name" }, [el("span", { text: user.real_name }), el("span", { class: "person-handle", text: `@${user.name}` }), already ? el("span", { class: "person-handle", text: "· already in channel" }) : null]));
    if (user.profile.title) main.append(el("div", { class: "person-title", text: user.profile.title }));
    row.append(main, el("span", { class: "person-check" }, icon("check")));
    row.addEventListener("click", () => {
      if (people.selected.has(user.id)) people.selected.delete(user.id);
      else if (people.mode === "dm" && people.selected.size >= 8) toast("You can message up to 8 people at once.", { error: true });
      else people.selected.add(user.id);
      renderPeopleList();
    });
    list.append(row);
  }
  const chips = $("#people-selected");
  chips.replaceChildren();
  for (const id of people.selected) {
    const user = userOf(id);
    const chip = el("span", { class: "chip" }, [avatar(user ?? { id }, "sm"), el("span", { text: user?.real_name ?? id })]);
    const remove = el("button", { class: "chip-remove", attrs: { type: "button", "aria-label": `Remove ${user?.real_name ?? id}` } }, icon("close"));
    remove.addEventListener("click", () => {
      people.selected.delete(id);
      renderPeopleList();
    });
    chip.append(remove);
    chips.append(chip);
  }
  $("#people-submit").disabled = people.selected.size === 0;
}
$("#people-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void action(
    async () => {
      const ids = [...people.selected];
      if (people.mode === "invite") {
        await call("conversations.invite", { channel: state.current, users: ids.join(",") }, key());
        peopleDialog.close("ok");
        toast(`Added ${ids.length} ${ids.length === 1 ? "person" : "people"} to #${state.info?.name}`);
        await loadConversation(state.current, { keepScroll: true });
        if ($("#details-dialog").open) renderDetails("members");
      } else {
        peopleDialog.close("ok");
        await openDirectMessage(ids);
      }
    },
    {
      onError: (error) => {
        const box = $("#people-error");
        box.hidden = false;
        box.textContent = describe(error);
      },
    },
  );
});

const detailsDialog = $("#details-dialog");
function openDetails(tab = "about") {
  if (!state.info) return;
  const info = state.info;
  $("#details-glyph").replaceChildren(isDm(info) ? "" : icon(info.is_private ? "lock" : "hash"));
  $("#details-name").textContent = isDm(info) ? conversationTitle(info) : info.name;
  $$("#details-tabs .modal-tab").forEach((button) => (button.hidden = button.dataset.tab === "settings" && (isDm(info) || !info.is_member)));
  detailsDialog.showModal();
  renderDetails(tab);
}
for (const tab of $$("#details-tabs .modal-tab")) tab.addEventListener("click", () => renderDetails(tab.dataset.tab));
async function renderDetails(tab) {
  const info = state.info;
  $$("#details-tabs .modal-tab").forEach((button) => {
    if (button.dataset.tab === tab) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const body = $("#details-body");
  body.replaceChildren();
  const editable = info.is_member && !info.is_archived && !isDm(info);
  if (tab === "about") {
    const block = el("div", { class: "detail-block" });
    if (!isDm(info)) {
      const topicRow = el("div", { class: "detail-row" }, el("div", {}, [el("div", { class: "detail-label", text: "Topic" }), el("div", { class: `detail-value ${info.topic?.value ? "" : "muted"}`.trim(), text: info.topic?.value || "Add a topic" })]));
      if (editable) topicRow.append(textButton("Edit", { class: "detail-edit", onClick: openTopicDialog }));
      topicRow.lastChild.classList.remove("btn");
      block.append(topicRow);
      block.append(el("div", { class: "detail-row" }, el("div", {}, [el("div", { class: "detail-label", text: "Description" }), el("div", { class: `detail-value ${info.purpose?.value ? "" : "muted"}`.trim(), text: info.purpose?.value || "No description" })])));
    }
    const created = el("div", { class: "detail-row" }, el("div", {}, [el("div", { class: "detail-label", text: "Created" }), el("div", { class: "detail-value", text: `${info.creator ? `Created by ${userName(info.creator)} on ` : "Created on "}${longDate(String(info.created), tz())}` })]));
    block.append(created);
    if (info.is_archived) block.append(el("div", { class: "detail-row" }, el("div", {}, [el("div", { class: "detail-label", text: "Archived" }), el("div", { class: "detail-value", text: "This channel has been archived. It is read-only." })])));
    body.append(block);
    if (!isDm(info) && !info.is_member) body.append(el("div", { class: "detail-block" }, el("div", { class: "detail-row" }, [el("div", {}, [el("div", { class: "detail-label", text: "You're not a member" }), el("div", { class: "detail-value muted", text: info.is_archived ? "Archived channels can't be joined." : info.is_private ? "Private channels are joined by invitation." : "Join to read and send messages." })]), !info.is_archived && !info.is_private ? textButton("Join", { class: "small primary", onClick: () => action(async () => (detailsDialog.close(), await joinChannel(info.id))) }) : null])));
    body.append(el("p", { class: "detail-footer", text: `Channel ID: ${info.id}` }));
    return;
  }
  if (tab === "members") {
    body.append(skeleton(2));
    let ids = [];
    try {
      let cursor;
      for (let page = 0; page < 20; page += 1) {
        const result = await call("conversations.members", { channel: info.id, limit: 200, ...(cursor ? { cursor } : {}) });
        ids.push(...result.members);
        cursor = result.response_metadata.next_cursor;
        if (!cursor) break;
      }
    } catch (error) {
      body.replaceChildren(stateCard("Members can't be listed", describe(error), { error: true }));
      return;
    }
    body.replaceChildren();
    $("#details-members-count").textContent = String(ids.length);
    const toolbar = el("div", { class: "members-toolbar" });
    const field = el("div", { class: "field" }, [el("span", { class: "field-prefix" }, icon("search"))]);
    const input = el("input", { attrs: { type: "text", placeholder: "Find members", "aria-label": "Find members" } });
    field.append(input);
    toolbar.append(field);
    if (editable) {
      const add = textButton("Add people", { onClick: () => openPeopleDialog("invite") });
      add.prepend(icon("user_add"));
      toolbar.append(add);
    }
    body.append(toolbar);
    const list = el("div", { class: "members-list" });
    body.append(list);
    const fill = () => {
      list.replaceChildren();
      const filter = input.value.toLowerCase();
      const members = ids
        .map((id) => userOf(id) ?? { id, real_name: id, name: id, profile: {} })
        .filter((user) => filter.length === 0 || user.real_name.toLowerCase().includes(filter) || user.name.includes(filter))
        .sort((left, right) => (left.id === me() ? -1 : right.id === me() ? 1 : left.real_name.localeCompare(right.real_name)));
      if (members.length === 0) list.append(el("p", { class: "people-empty", text: "No members match." }));
      for (const user of members) {
        const row = el("button", { class: "member-row", attrs: { type: "button" } });
        row.append(avatar(user, "lg"));
        const main = el("div", { class: "member-main" });
        const name = el("div", { class: "member-name" }, el("span", { text: user.real_name }));
        if (user.id === me()) name.append(el("span", { class: "archived-badge", text: "you" }));
        if (user.is_bot) name.append(el("span", { class: "app-badge", text: "APP" }));
        if (user.deleted) name.append(el("span", { class: "deactivated-badge", text: "Deactivated" }));
        if (user.is_admin) name.append(el("span", { class: "archived-badge", text: user.is_owner ? "Owner" : "Admin" }));
        main.append(name, el("div", { class: "member-sub", text: [`@${user.name}`, user.profile?.title].filter(Boolean).join(" · ") }));
        row.append(main);
        row.addEventListener("click", () => {
          detailsDialog.close();
          openProfile(user.id);
        });
        list.append(row);
      }
    };
    input.addEventListener("input", fill);
    fill();
    return;
  }
  if (tab === "settings") {
    const block = el("div", { class: "detail-block" });
    block.append(el("div", { class: "settings-row" }, [el("div", {}, [el("div", { class: "detail-label", text: "Channel name" }), el("div", { class: "detail-value", text: `#${info.name}` })]), el("span", { class: "detail-value muted", text: "Renaming isn't available" })]));
    block.append(el("div", { class: "settings-row" }, [el("div", {}, [el("div", { class: "detail-label", text: "Visibility" }), el("div", { class: "detail-value", text: info.is_private ? "Private — only invited members can see this channel" : "Public — anyone in the workspace can join" })])]));
    body.append(block);
    if (!info.is_archived) {
      const danger = el("div", { class: "detail-block" });
      const row = el("div", { class: "settings-row" }, el("div", {}, [el("div", { class: "detail-label", text: "Archive channel for everyone" }), el("div", { class: "detail-value muted", text: "Members won't be able to send messages. The channel stays readable in Browse channels." })]));
      const archive = textButton("Archive channel", { class: "danger-outline", onClick: () => action(archiveCurrent) });
      archive.disabled = info.is_general;
      if (info.is_general) archive.title = "The general channel can't be archived";
      row.append(archive);
      danger.append(row);
      body.append(danger);
    }
  }
}

async function archiveCurrent() {
  const info = state.info;
  const ok = await confirmDialog(`Archive #${info.name}?`, "When you archive a channel, it's archived for everyone. That means no one will be able to send messages in it, but its history stays readable and searchable. Archived channels can't be unarchived in this workspace.", "Archive channel", { danger: true });
  if (!ok) return;
  await call("conversations.archive", { channel: info.id }, key());
  detailsDialog.close();
  toast(`#${info.name} was archived`);
  await loadConversations();
  await loadConversation(info.id);
}

$("#pane-title").addEventListener("click", () => {
  if (state.view === "messages" || state.view === "pins") openDetails("about");
});
$("#pane-details").addEventListener("click", () => openDetails("about"));
$("#members-pill").addEventListener("click", () => openDetails("members"));
for (const tab of $$(".pane-tab[data-tab]")) {
  tab.addEventListener("click", () => {
    if (tab.dataset.tab === "pins") navigate(`pins`);
    else navigate(state.current ?? "");
  });
}

function openAbout() {
  const list = $("#about-list");
  list.replaceChildren();
  const rows = [
    ["Workspace", state.identity?.team ?? "—"],
    ["URL", state.identity?.url ?? "—"],
    ["Team ID", state.identity?.team_id ?? "—"],
    ["Signed in as", state.me ? `${state.me.real_name} (@${state.me.name})` : "—"],
    ["Members", String(state.users.size)],
    ["Conversations visible to you", String(state.conversations.length)],
  ];
  for (const [label, value] of rows) list.append(el("dt", { text: label }), el("dd", { text: value }));
  $("#about-dialog").showModal();
}

// ---------------------------------------------------------------------------------------------
// Rail, sidebar controls, menus
// ---------------------------------------------------------------------------------------------

for (const button of $$(".rail-item:not([data-ns])")) {
  button.addEventListener("click", (event) => {
    const view = button.dataset.view;
    if (view === "more") {
      openMenu(event.currentTarget, [
        { label: "Browse channels", icon: "channel_browse", onSelect: () => navigate("browse") },
        { label: "People", icon: "users", onSelect: () => navigate("people") },
        "divider",
        { label: "About this workspace", icon: "info", onSelect: openAbout },
      ], { align: "start" });
      return;
    }
    state.railView = view;
    // Leaving search, browse or people for a sidebar tab returns the main pane to a conversation, like Slack does.
    if (state.view !== "messages" && state.view !== "pins") {
      const target = state.current ?? defaultConversation()?.id;
      if (target) navigate(target);
      else renderSidebar();
    } else renderSidebar();
    if (window.matchMedia("(max-width: 768px)").matches) $("#shell").classList.add("sidebar-open");
  });
}
$("#rail-create").addEventListener("click", (event) => openMenu(event.currentTarget, [{ label: "Message", icon: "compose", detail: "Start a direct message", onSelect: () => openPeopleDialog("dm") }, { label: "Channel", icon: "hash", detail: "Create a new channel", onSelect: () => openCreateChannel() }], { align: "start", above: true, header: "Create new" }));
$("#me-button").addEventListener("click", (event) => openMenu(event.currentTarget, [{ label: "Profile", icon: "users", onSelect: () => openProfile(me()) }, { label: "About this workspace", icon: "info", onSelect: openAbout }], { align: "start", above: true, header: state.me?.real_name ?? "You" }));
$("#workspace-tile").addEventListener("click", (event) => workspaceMenu(event.currentTarget));
$("#workspace-menu").addEventListener("click", (event) => workspaceMenu(event.currentTarget));
function workspaceMenu(anchor) {
  openMenu(anchor, [
    { label: "About this workspace", icon: "info", onSelect: openAbout },
    "divider",
    { label: "Create a channel", icon: "hash", onSelect: () => openCreateChannel() },
    { label: "Browse channels", icon: "channel_browse", onSelect: () => navigate("browse") },
    { label: "People", icon: "users", onSelect: () => navigate("people") },
    "divider",
    { label: "Refresh from the world", icon: "refresh", onSelect: () => action(() => refresh(false)) },
  ], { header: state.identity?.url ?? "" });
}
$("#sidebar-filter").addEventListener("click", (event) => openMenu(event.currentTarget, [{ label: state.unreadOnly ? "Show all conversations" : "Show unread only", icon: "filter", onSelect: () => ((state.unreadOnly = !state.unreadOnly), renderSidebar()) }, { label: state.channelsOpen && state.dmsOpen ? "Collapse all sections" : "Expand all sections", icon: "chevron_down", onSelect: () => ((state.channelsOpen = state.dmsOpen = !(state.channelsOpen && state.dmsOpen)), writePreference("channelsOpen", String(state.channelsOpen)), writePreference("dmsOpen", String(state.dmsOpen)), renderSidebar()) }], { align: "end" }));
$("#compose").addEventListener("click", () => openPeopleDialog("dm"));
$("#add-dm").addEventListener("click", () => openPeopleDialog("dm"));
$("#add-channels").addEventListener("click", (event) => openMenu(event.currentTarget, [{ label: "Create a new channel", icon: "hash", onSelect: () => openCreateChannel() }, { label: "Browse channels", icon: "channel_browse", onSelect: () => navigate("browse") }]));
$("#channels-toggle").addEventListener("click", () => {
  state.channelsOpen = !state.channelsOpen;
  writePreference("channelsOpen", String(state.channelsOpen));
  renderSidebar();
});
$("#apps-toggle").addEventListener("click", () => {
  state.appsOpen = !state.appsOpen;
  writePreference("appsOpen", String(state.appsOpen));
  renderSidebar();
});
$("#nav-directories").addEventListener("click", (event) => openMenu(event.currentTarget, [{ label: "People", icon: "users", detail: "Workspace members", onSelect: () => navigate("people") }, { label: "Channels", icon: "channel_browse", detail: "Browse all channels", onSelect: () => navigate("browse") }], { header: "Directories" }));
for (const button of $$("[data-section-add]")) button.addEventListener("click", () => $(`#${button.dataset.sectionAdd}`).click());
for (const button of $$("[data-section-options]")) {
  button.addEventListener("click", (event) => {
    const channels = button.dataset.sectionOptions === "Channels";
    const open = channels ? state.channelsOpen : state.dmsOpen;
    openMenu(event.currentTarget, [
      { label: open ? "Collapse section" : "Expand section", icon: "chevron_down", onSelect: () => (channels ? $("#channels-toggle") : $("#dms-toggle")).click() },
      { label: state.unreadOnly ? "Show all conversations" : "Show unread only", icon: "filter", onSelect: () => ((state.unreadOnly = !state.unreadOnly), renderSidebar()) },
      "divider",
      channels ? { label: "Create a channel", icon: "hash", onSelect: () => openCreateChannel() } : { label: "New message", icon: "compose", onSelect: () => openPeopleDialog("dm") },
      channels ? { label: "Browse channels", icon: "channel_browse", onSelect: () => navigate("browse") } : { label: "People", icon: "users", onSelect: () => navigate("people") },
    ], { header: button.dataset.sectionOptions });
  });
}
$("#pane-more").addEventListener("click", (event) => {
  const info = state.info;
  if (!info) return;
  const channel = !isDm(info);
  openMenu(event.currentTarget, [
    { label: channel ? "Open channel details" : "Open conversation details", icon: "info", onSelect: () => openDetails("about") },
    { label: "View members", icon: "users", disabled: info.is_im === true, onSelect: () => openDetails("members") },
    ...(channel ? [{ label: "Edit topic", icon: "pencil", disabled: !info.is_member || info.is_archived, onSelect: () => openTopicDialog() }] : []),
    { label: "Pinned messages", icon: "pin", onSelect: () => navigate("pins") },
    "divider",
    { label: "Search in conversation", icon: "search", disabled: !channel, onSelect: () => navigate(`search/in:#${info.name}`) },
    ...(channel ? [{ label: "Channel settings", onSelect: () => openDetails("settings") }] : []),
  ], { align: "end" });
});
$("#dms-toggle").addEventListener("click", () => {
  state.dmsOpen = !state.dmsOpen;
  writePreference("dmsOpen", String(state.dmsOpen));
  renderSidebar();
});
$("#help").addEventListener("click", (event) => openMenu(event.currentTarget, [
  { label: "Keyboard shortcuts", disabled: true },
  { label: "Alt ↑ / Alt ↓", detail: "Previous / next conversation", disabled: true },
  { label: "Ctrl/⌘ K", detail: "Search", disabled: true },
  { label: "↑ in an empty composer", detail: "Edit your last message", disabled: true },
  { label: "Esc", detail: "Close panel or dialog", disabled: true },
  "divider",
  { label: "Synthetic workspace served by a Firedrill Tool — messages never leave this world.", disabled: true },
], { align: "end", className: "wide-menu" }));
$("#nav-menu").addEventListener("click", () => $("#shell").classList.toggle("sidebar-open"));
$("#pane").addEventListener("pointerdown", () => {
  if (window.matchMedia("(max-width: 768px)").matches) $("#shell").classList.remove("sidebar-open");
});

document.addEventListener("keydown", (event) => {
  const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "") || document.activeElement?.isContentEditable;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("#search").focus();
    $("#search").select();
  } else if (event.key === "Escape" && !menuOpen() && !document.querySelector("dialog[open]")) {
    if (state.panel) closePanel();
    else if (document.activeElement === $("#search")) $("#search").blur();
  } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && !inField) {
    const links = $$(".sb-link");
    const index = links.findIndex((link) => link.dataset.id === state.current);
    const next = links[(index + (event.key === "ArrowDown" ? 1 : -1) + links.length) % links.length];
    if (next) {
      event.preventDefault();
      navigate(next.dataset.id);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

function renderEmptyWorkspace() {
  state.current = undefined;
  showView("messages");
  $("#pane-title-text").textContent = state.identity?.team ?? "Workspace";
  $("#pane-title-glyph").replaceChildren();
  $("#pane-tabs").hidden = true;
  $("#pane-footer").hidden = true;
  const body = paneBody();
  body.append(stateCard("No conversations yet", "This workspace has no channels or direct messages you can see. Create a channel to get started.", { actions: [textButton("Create channel", { class: "primary", onClick: () => openCreateChannel() })] }));
}

function renderFatal(error) {
  state.fatal = error;
  renderSidebarSkeleton();
  $("#channel-list").replaceChildren();
  $("#dm-list").replaceChildren();
  const body = paneBody();
  $("#pane-tabs").hidden = true;
  $("#pane-footer").hidden = true;
  $("#pane-title-text").textContent = "Slack (synthetic)";
  $(".pane-title-chevron").toggleAttribute("hidden", true);
  $("#workspace-name").textContent = "Workspace";
  $("#workspace-initial").textContent = "W";
  if (error instanceof ToolError && error.is("INVALID_AUTH")) {
    body.append(stateCard("This actor isn't a member of the workspace", "Every call answered invalid_auth: the acting actor's attributes.userId names no users row in this world (an actor without that attribute acts as the workspace's first active member). Fix or remove the attribute in firedrill/world.json (see the package README) and reopen the app.", { error: true, actions: [textButton("Retry", { onClick: () => action(() => refresh(true)) })] }));
  } else if (error instanceof ToolError && error.denied) {
    body.append(stateCard("You don't have permission to use this workspace", "This actor has no grant for auth.test or users.list (missing_scope). Grant the Tool's operations to the actor in the world definition.", { error: true, actions: [textButton("Retry", { onClick: () => action(() => refresh(true)) })] }));
  } else body.append(stateCard("The workspace can't be reached", describe(error), { error: true, actions: [textButton("Retry", { onClick: () => action(() => refresh(true)) })] }));
}

async function refresh(first) {
  try {
    await loadIdentity();
    await loadConversations();
    state.fatal = undefined;
  } catch (error) {
    renderFatal(error);
    return;
  }
  if (first) {
    const hash = currentHash();
    nav.stack = [hash];
    nav.index = 0;
    renderNavButtons();
    await openRoute(hash);
    return;
  }
  // Something changed in the world: re-read what is on screen without touching composer text.
  if (state.view === "messages" && state.current && !state.paneError) await loadConversation(state.current, { keepScroll: true });
  else if (state.view === "messages" && state.current) await loadConversation(state.current, { keepScroll: false });
  else if (state.view === "pins") await renderPins();
  else if (state.view === "search" && state.search.query) await runSearch(state.search.query, { page: state.search.page });
  else if (state.view === "browse") await renderBrowse();
  else if (state.view === "people") await renderPeople();
  if (state.thread) await loadThread({ keepScroll: true });
  if (state.panel === "profile" && state.profile) await openProfile(state.profile);
}

hydrateIcons();
renderSidebarSkeleton();
watchWorld(refresh, () => !document.querySelector("dialog[open]") && !isPending());
