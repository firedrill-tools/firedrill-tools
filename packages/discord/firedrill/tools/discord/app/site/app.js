// Discord Tool browser app. Every control calls the Tool's own operations through /_firedrill/client.js; nothing
// here is authoritative. Records are re-read after each write and whenever the world revision moves.
import { hydrateIcons, icon } from "./icons.js";
import {
  $,
  AVATAR_COLOURS,
  avatarIndex,
  PICKER_EMOJI,
  QUICK_EMOJI,
  ToolError,
  avatar,
  call,
  closeLayer,
  compareIds,
  confirmModal,
  displayName,
  dividerDate,
  el,
  emojiArg,
  emojiNode,
  emojiText,
  fullStamp,
  iconButton,
  isPending,
  menu,
  messageStamp,
  layerAnchor,
  modal,
  nonce,
  overlay,
  parseTime,
  popout,
  roleColour,
  sameDay,
  shortDate,
  snowflakeMs,
  clock,
  toast,
  watchWorld,
} from "./ui.js";

// ---------------------------------------------------------------------------------------------
// Permissions (same algorithm the Tool enforces; used only to hide or disable controls)
// ---------------------------------------------------------------------------------------------

const P = {
  ADMINISTRATOR: 1n << 3n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
};
const DM_PERMS = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.ADD_REACTIONS;
const bits = (value) => (typeof value === "string" && /^[0-9]{1,20}$/.test(value) ? BigInt(value) : 0n);
const has = (value, bit) => (value & bit) === bit;
const THREAD_TYPES = new Set([10, 11, 12]);

function channelPerms(data, channel) {
  if (!data) return DM_PERMS;
  const base = data.base;
  if (has(base, P.ADMINISTRATOR) || data.guild.owner_id === state.me.id) return (1n << 53n) - 1n;
  const source = THREAD_TYPES.has(channel.type) ? data.channels.find((candidate) => candidate.id === channel.parent_id) ?? channel : channel;
  let value = base;
  const list = Array.isArray(source.permission_overwrites) ? source.permission_overwrites : [];
  const everyone = list.find((o) => o.type === 0 && o.id === data.guild.id);
  if (everyone) value = (value & ~bits(everyone.deny)) | bits(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of list) {
    if (o.type === 0 && o.id !== data.guild.id && data.myRoles.includes(o.id)) {
      allow |= bits(o.allow);
      deny |= bits(o.deny);
    }
  }
  value = (value & ~deny) | allow;
  const mine = list.find((o) => o.type === 1 && o.id === state.me.id);
  if (mine) value = (value & ~bits(mine.deny)) | bits(mine.allow);
  return has(value, P.VIEW_CHANNEL) ? value : 0n;
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

const PAGE = 50;
const MEMBER_PAGE = 100;
// The Tool also caps each page at about 900 KB of UTF-8 JSON, so a short page ends a list only when it is too small to have
// hit that cap (one row is far below 150 KB and a UTF-8 byte needs at least a third of a UTF-16 unit).
const BYTE_CAPPED_PAGE_UNITS = 200000;
function mayHaveMore(rows, requested) {
  if (rows.length === 0) return false;
  return rows.length >= requested || JSON.stringify(rows).length > BYTE_CAPPED_PAGE_UNITS;
}
const state = {
  me: undefined,
  guilds: [],
  nowMs: 0,
  dms: [],
  guildData: new Map(),
  route: { guildId: "@me", channelId: undefined },
  showMembers: readPref("members", "true") === "true",
  collapsed: new Set(JSON.parse(readPref("collapsed", "[]") || "[]")),
  lastSeen: loadLastSeen(),
  main: undefined, // Chat instance
  side: undefined, // { kind: "thread", chat } | { kind: "new-thread", ... }
  members: new Map(), // guildId -> { list, after, done, loading, error }
  friendsTab: "online",
  // Local, visual-only voice state for the user panel (the Tool has no voice).
  voice: { muted: readPref("mic-muted", "false") === "true", deafened: readPref("deafened", "false") === "true", mutedBeforeDeafen: false },
};

function readPref(name, fallback) {
  try {
    return localStorage.getItem(`discord-tool:${name}`) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(name, value) {
  try {
    localStorage.setItem(`discord-tool:${name}`, value);
  } catch {
    // Preferences are a convenience only.
  }
}
function loadLastSeen() {
  try {
    const raw = localStorage.getItem("discord-tool:last-seen");
    return raw ? new Map(Object.entries(JSON.parse(raw))) : undefined;
  } catch {
    return undefined;
  }
}
function markSeen(channel) {
  if (!channel?.last_message_id || !state.lastSeen) return;
  state.lastSeen.set(channel.id, channel.last_message_id);
  writePref("last-seen", JSON.stringify(Object.fromEntries(state.lastSeen)));
}
/** Unread = newer than what this browser last saw. Before any visit, activity from the last virtual day counts as unread. */
function isUnread(channel) {
  if (!channel?.last_message_id || channel.id === state.route.channelId) return false;
  const seen = state.lastSeen?.get(channel.id);
  if (seen) return compareIds(channel.last_message_id, seen) > 0;
  return state.nowMs - snowflakeMs(channel.last_message_id) < 86400000;
}

const app = $("#app");
const content = $("#content");

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

async function boot() {
  $("#boot").hidden = false;
  $("#fatal").hidden = true;
  try {
    state.me = await call("users.get", { user_id: "@me" });
  } catch (error) {
    return fatal(error);
  }
  try {
    await loadGuilds();
    await loadDms();
  } catch (error) {
    return fatal(error);
  }
  if (!state.lastSeen) state.lastSeen = new Map();
  $("#boot").hidden = true;
  app.hidden = false;
  renderUserPanel();
  applyRoute(parseHash());
  watchWorld(refreshAll, () => !document.querySelector(".edit-box"));
}

function fatal(error) {
  $("#boot").hidden = true;
  app.hidden = true;
  $("#fatal").hidden = false;
  if (error instanceof ToolError && error.denied) {
    $("#fatal-title").textContent = "You don't have access";
    $("#fatal-text").textContent = "This Firedrill actor has no grants for the Discord Tool, so every request is denied. Ask the world owner to grant the Discord operations to this actor, then try again.";
  } else if (error instanceof ToolError && error.is("UNAUTHORIZED")) {
    $("#fatal-title").textContent = "401: Unauthorized";
    $("#fatal-text").textContent = "This actor's userId does not match any Discord account in this world. Update the actor's userId attribute or remove it to act as the default account.";
  } else {
    $("#fatal-title").textContent = "Something went wrong";
    $("#fatal-text").textContent = error?.message ?? "The local environment is unavailable.";
  }
}
$("#fatal-retry").addEventListener("click", () => void boot());

async function loadGuilds() {
  const result = await call("users.list-my-guilds", { user_id: "@me", with_counts: true });
  state.guilds = result.guilds;
  state.nowMs = parseTime(result.server_time);
  renderGuildRail();
}

async function loadDms() {
  const result = await call("users.list-dm-channels", { user_id: "@me" });
  state.dms = result.channels;
}

async function loadGuildData(guildId, force = false) {
  if (!force && state.guildData.has(guildId)) return state.guildData.get(guildId);
  const partial = state.guilds.find((g) => g.id === guildId);
  const [guild, channels, roles, member, threads] = await Promise.all([
    call("guilds.get", { guild_id: guildId, with_counts: true }),
    call("guilds.list-channels", { guild_id: guildId }),
    call("roles.list", { guild_id: guildId }),
    call("guild-members.get", { guild_id: guildId, user_id: state.me.id }),
    call("guilds.list-active-threads", { guild_id: guildId }),
  ]);
  const data = {
    guild,
    channels: channels.channels,
    roles: roles.roles,
    member,
    myRoles: member.roles,
    base: bits(partial?.permissions ?? "0"),
    threads: threads.threads,
    threadMembers: new Set(threads.members.map((m) => m.id)),
  };
  state.guildData.set(guildId, data);
  return data;
}

async function refreshAll() {
  try {
    await loadGuilds();
    await loadDms();
    const guildId = state.route.guildId;
    if (guildId !== "@me" && state.guilds.some((g) => g.id === guildId)) {
      await loadGuildData(guildId, true);
      state.members.delete(guildId);
    }
    for (const key of [...state.guildData.keys()]) if (key !== guildId) state.guildData.delete(key);
    renderSidebar();
    renderUserPanel();
    await state.main?.refresh();
    if (state.side?.chat) await state.side.chat.refresh();
    if (state.showMembers && guildId !== "@me") void renderMembers();
  } catch (error) {
    toast(error.message, { error: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

/** Pages that are not channels, at the client's own paths for Nitro, the Shop and server discovery. */
const PAGE_HASHES = new Map([
  ["#/store", "nitro"],
  ["#/shop", "shop"],
  ["#/guild-discovery", "discover"],
]);

function parseHash() {
  const page = PAGE_HASHES.get(location.hash);
  if (page) return { guildId: page === "discover" ? "discover" : "@me", channelId: undefined, page };
  const match = /^#\/channels\/(@me|[0-9]{1,20})(?:\/([0-9]{1,20}))?$/.exec(location.hash);
  if (!match) return { guildId: state.guilds[0]?.id ?? "@me", channelId: undefined };
  return { guildId: match[1], channelId: match[2] };
}

function navigate(guildId, channelId) {
  const hash = `#/channels/${guildId}${channelId ? `/${channelId}` : ""}`;
  if (location.hash !== hash) history.pushState(null, "", hash);
  void applyRoute({ guildId, channelId });
}
window.addEventListener("popstate", () => void applyRoute(parseHash()));

function navigatePage(page) {
  const hash = page === "friends" ? "#/channels/@me" : [...PAGE_HASHES].find(([, value]) => value === page)?.[0];
  if (!hash) return;
  if (location.hash !== hash) history.pushState(null, "", hash);
  void applyRoute(page === "friends" ? { guildId: "@me", channelId: undefined, page } : parseHash());
}

async function applyRoute(route) {
  app.classList.remove("nav-open");
  $("#sidebar-scrim").hidden = true;
  closeSide();
  if (route.guildId !== "@me" && route.guildId !== "discover" && !state.guilds.some((g) => g.id === route.guildId)) route = { guildId: state.guilds[0]?.id ?? "@me", channelId: undefined };
  state.route = { ...route };
  if (route.guildId === "@me" || route.guildId === "discover") {
    // Home opens on Friends, as the client does; a DM id that is not in this actor's list falls back to Friends.
    const dm = route.page ? undefined : state.dms.find((d) => d.id === route.channelId);
    if (!dm) {
      state.route = { guildId: route.guildId, channelId: undefined, page: route.page ?? "friends" };
      if (route.channelId) history.replaceState(null, "", "#/channels/@me");
    }
    renderGuildRail();
    renderSidebar();
    if (!dm) return renderPage(state.route.page);
    openChat({ channel: dm, data: undefined });
    return;
  }
  renderGuildRail();
  renderSidebarLoading();
  content.replaceChildren(skeletonPane());
  let data;
  try {
    data = await loadGuildData(route.guildId);
  } catch (error) {
    content.replaceChildren(stateCard("warning", "Couldn't load this server", error.message, () => navigate(route.guildId, route.channelId)));
    $("#sidebar-list").replaceChildren(el("div", { class: "sidebar-empty", text: error.message }));
    return;
  }
  if (state.route.guildId !== route.guildId) return;
  let channelId = route.channelId;
  const all = [...data.channels, ...data.threads];
  let channel = all.find((c) => c.id === channelId);
  if (!channel && channelId) {
    try {
      channel = await call("channels.get", { channel_id: channelId });
      if (channel.guild_id !== route.guildId) channel = undefined;
    } catch (error) {
      if (error.is("MISSING_ACCESS")) {
        state.route.channelId = channelId;
        renderSidebar();
        content.replaceChildren(stateCard("lock", "You do not have permission to view this channel", "Ask a moderator for access, or pick another channel."));
        return;
      }
      channel = undefined;
    }
  }
  if (!channel) {
    const remembered = readPref(`last-channel:${route.guildId}`, "");
    const textual = (c) => (c.type === 0 || c.type === 5) && has(channelPerms(data, c), P.VIEW_CHANNEL);
    channel = data.channels.find((c) => c.id === remembered && textual(c)) ?? data.channels.find((c) => c.id === data.guild.system_channel_id && textual(c)) ?? sortChannels(data).flatMap((g) => g.children).find(textual);
    channelId = channel?.id;
    if (channelId) history.replaceState(null, "", `#/channels/${route.guildId}/${channelId}`);
  }
  state.route.channelId = channel?.id;
  renderSidebar();
  if (!channel) {
    content.replaceChildren(stateCard("hash", "No Text Channels", "You find yourself in a strange place. You don't have access to any text channels, or there are none in this server."));
    return;
  }
  if (THREAD_TYPES.has(channel.type) && !data.threads.some((t) => t.id === channel.id)) data.extraThread = channel;
  writePref(`last-channel:${route.guildId}`, channel.id);
  openChat({ channel, data });
}

// ---------------------------------------------------------------------------------------------
// Guild rail
// ---------------------------------------------------------------------------------------------

function acronym(name) {
  return name
    .replace(/'s /g, " ")
    .replace(/\w+/g, (word) => word[0])
    .replace(/\s/g, "")
    .slice(0, 5);
}

function renderGuildRail() {
  const list = $("#guild-list");
  list.replaceChildren();
  $("#home-slot").classList.toggle("selected", state.route.guildId === "@me");
  $("#discover-slot").classList.toggle("selected", state.route.guildId === "discover");
  for (const guild of state.guilds) {
    const short = acronym(guild.name);
    const tile = el("button", {
      class: `guild-tile ${short.length > 3 ? "small-text" : ""}`,
      text: short,
      attrs: { type: "button", "aria-label": guild.name, "data-tooltip": guild.name, "data-tooltip-side": "right", "aria-current": state.route.guildId === guild.id ? "page" : undefined },
      on: { click: () => navigate(guild.id) },
    });
    list.append(el("div", { class: `guild-slot ${state.route.guildId === guild.id ? "selected" : ""}` }, [el("span", { class: "guild-pill", attrs: { "aria-hidden": "true" } }), tile]));
  }
}
$("#home-button").addEventListener("click", () => navigate("@me"));
$("#add-server-button").addEventListener("click", () => openAddServer());
$("#discover-button").addEventListener("click", () => navigatePage("discover"));

// ---------------------------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------------------------

function sortChannels(data) {
  const visible = data.channels.filter((c) => c.type !== 4);
  const byOrder = (a, b) => (a.type === 2) - (b.type === 2) || a.position - b.position || compareIds(a.id, b.id);
  const groups = [{ category: null, children: visible.filter((c) => !c.parent_id).sort(byOrder) }];
  for (const category of data.channels.filter((c) => c.type === 4).sort((a, b) => a.position - b.position || compareIds(a.id, b.id))) {
    groups.push({ category, children: visible.filter((c) => c.parent_id === category.id).sort(byOrder) });
  }
  return groups;
}

function renderSidebarLoading() {
  const guild = state.guilds.find((g) => g.id === state.route.guildId);
  $("#sidebar-header").replaceChildren(el("div", { class: "guild-header-btn" }, el("span", { class: "name", text: guild?.name ?? "" })));
  const skeleton = el("div", { class: "skeleton" });
  for (let i = 0; i < 6; i += 1) skeleton.append(el("div", { class: "skeleton-row" }, el("div", { class: "skeleton-lines" }, el("div", { class: "skeleton-line" }))));
  $("#sidebar-list").replaceChildren(skeleton);
}

function renderSidebar() {
  if (state.route.guildId === "@me") return renderDmSidebar();
  if (state.route.guildId === "discover") return renderDiscoverSidebar();
  const data = state.guildData.get(state.route.guildId);
  if (!data) return renderSidebarLoading();
  const header = el(
    "button",
    { class: "guild-header-btn", attrs: { type: "button", "aria-expanded": "false", "aria-haspopup": "dialog" } },
    [el("span", { class: "name", text: data.guild.name }), icon("chevron_down", 18)],
  );
  header.addEventListener("click", () => openGuildPopout(header, data));
  $("#sidebar-header").replaceChildren(header);

  const list = $("#sidebar-list");
  const scroll = list.scrollTop;
  list.replaceChildren(el("div", { class: "guild-banner-space" }));
  for (const group of sortChannels(data)) {
    const children = group.children.filter((c) => has(channelPerms(data, c), P.VIEW_CHANNEL));
    if (group.category && children.length === 0) continue;
    const section = el("div", { class: "category" });
    if (group.category) {
      const collapsed = state.collapsed.has(group.category.id);
      section.classList.toggle("collapsed", collapsed);
      section.append(
        el(
          "button",
          {
            class: "category-btn",
            attrs: { type: "button", "aria-expanded": String(!collapsed) },
            on: {
              click: () => {
                if (state.collapsed.has(group.category.id)) state.collapsed.delete(group.category.id);
                else state.collapsed.add(group.category.id);
                writePref("collapsed", JSON.stringify([...state.collapsed]));
                renderSidebar();
              },
            },
          },
          [icon("chevron_down", 12), el("span", { class: "label", text: group.category.name })],
        ),
      );
    }
    for (const channel of children) {
      section.append(channelRow(data, channel));
      const threads = [...data.threads, ...(data.extraThread ? [data.extraThread] : [])].filter(
        (t) => t.parent_id === channel.id && (t.member || t.id === state.route.channelId),
      );
      for (const thread of threads) {
        section.append(
          el("div", { class: `thread-row ${thread.id === state.route.channelId ? "selected channel-row" : "channel-row"} ${isUnread(thread) ? "unread" : ""}` }, [
            el(
              "button",
              { class: "channel-link", attrs: { type: "button", "aria-current": thread.id === state.route.channelId ? "page" : undefined }, on: { click: () => navigate(data.guild.id, thread.id) } },
              el("span", { class: "name", text: thread.name }),
            ),
          ]),
        );
      }
    }
    list.append(section);
  }
  list.scrollTop = scroll;
}

function channelIcon(data, channel) {
  if (channel.type === 2) return "speaker";
  if (channel.type === 5) return "announcement";
  if (THREAD_TYPES.has(channel.type)) return "thread";
  if (data && channel.id === data.guild.rules_channel_id) return "rules";
  const everyone = (channel.permission_overwrites ?? []).find((o) => o.type === 0 && o.id === data?.guild.id);
  if (everyone && has(bits(everyone.deny), P.VIEW_CHANNEL)) return "hash_lock";
  return "hash";
}

function channelRow(data, channel) {
  const selected = channel.id === state.route.channelId;
  const voice = channel.type === 2;
  const row = el("div", { class: `channel-row ${selected ? "selected" : ""} ${voice ? "voice" : ""} ${isUnread(channel) ? "unread" : ""}` });
  const link = el(
    "button",
    {
      class: "channel-link",
      attrs: {
        type: "button",
        "aria-current": selected ? "page" : undefined,
        "aria-disabled": voice ? "true" : undefined,
        "data-tooltip": voice ? "Voice isn't available in this simulation" : undefined,
        "aria-label": `${channel.name} (${voice ? "voice channel" : channel.type === 5 ? "announcement channel" : "text channel"})`,
      },
      on: { click: () => (voice ? undefined : navigate(data.guild.id, channel.id)) },
    },
    [icon(channelIcon(data, channel), 20), el("span", { class: "name", text: channel.name })],
  );
  row.append(link);
  return row;
}

function openGuildPopout(anchor, data) {
  anchor.setAttribute("aria-expanded", "true");
  const roles = data.roles.filter((r) => data.myRoles.includes(r.id)).sort((a, b) => b.position - a.position);
  const body = el("div", { class: "guild-popout" }, [
    el("h3", { text: data.guild.name }),
    data.guild.description ? el("p", { text: data.guild.description }) : null,
    el("div", { class: "guild-stats" }, [
      el("span", {}, [el("i", { class: "dot green" }), `${data.guild.approximate_presence_count ?? 0} Online`]),
      el("span", {}, [el("i", { class: "dot" }), `${data.guild.approximate_member_count ?? 0} Members`]),
    ]),
    el("div", { class: "profile-divider" }),
    el("div", { class: "profile-section" }, [
      el("h4", { text: roles.length ? "Your Roles" : "Your Roles" }),
      roles.length ? roleChips(roles) : el("p", { text: "No roles" }),
    ]),
    el("div", { class: "profile-section" }, [el("h4", { text: "Owner" }), el("p", { text: memberName(data, data.guild.owner_id) })]),
  ]);
  popout(anchor, body, { placement: "bottom-start", onClose: () => anchor.setAttribute("aria-expanded", "false") });
}

function roleChips(roles) {
  const wrap = el("div", { class: "role-chips" });
  for (const role of roles) {
    const dot = el("span", { class: "role-dot" });
    if (role.color) dot.style.background = roleColour(role.color);
    wrap.append(el("span", { class: "role-chip" }, [dot, el("span", { text: role.name })]));
  }
  return wrap;
}

function renderDmSidebar() {
  const search = el("button", { class: "dm-search", text: "Find or start a conversation", attrs: { type: "button" }, on: { click: () => openQuickSwitcher() } });
  $("#sidebar-header").replaceChildren(search);
  const list = $("#sidebar-list");
  list.replaceChildren(
    el("div", { class: "nav-rows" }, [navRow("friends", "friends", "Friends"), navRow("nitro", "nitro", "Nitro"), navRow("shop", "shop", "Shop")]),
    el("div", { class: "sidebar-heading" }, [
      el("span", { text: "Direct Messages" }),
      iconButton("plus", "Create DM", () => openQuickSwitcher(), { size: 16 }),
    ]),
  );
  if (state.dms.length === 0) list.append(el("div", { class: "sidebar-empty", text: "No direct messages yet." }));
  for (const dm of state.dms) {
    const user = dm.recipients[0];
    const selected = dm.id === state.route.channelId;
    list.append(
      el("div", { class: `dm-row ${selected ? "selected" : ""}` }, [
        el(
          "button",
          { class: "dm-link", attrs: { type: "button", "aria-current": selected ? "page" : undefined }, on: { click: () => navigate("@me", dm.id) } },
          [avatar(user, 32), el("span", { class: "name", text: displayName(user) })],
        ),
      ]),
    );
  }
}

function navRow(page, glyph, label) {
  const selected = state.route.page === page;
  return el(
    "div",
    { class: `nav-item ${selected ? "selected" : ""}` },
    el("button", { class: "nav-row", attrs: { type: "button", "aria-current": selected ? "page" : undefined }, on: { click: () => navigatePage(page) } }, [
      icon(glyph, 24),
      el("span", { class: "name", text: label }),
    ]),
  );
}

function renderDiscoverSidebar() {
  $("#sidebar-header").replaceChildren(el("h2", { class: "discover-heading", text: "Discover" }));
  $("#sidebar-list").replaceChildren(el("div", { class: "nav-rows" }, navRow("discover", "compass", "Servers")));
}

function renderUserPanel() {
  const me = state.me;
  const chip = el("button", { class: "user-chip", attrs: { type: "button", "aria-label": `${displayName(me)}, open profile` } }, [
    el("span", { class: "avatar-wrap" }, [avatar(me, 32), el("span", { class: "status-dot", attrs: { "aria-hidden": "true" } })]),
    el("span", { class: "names" }, [el("span", { class: "display", text: displayName(me) }), el("span", { class: "username", text: me.username })]),
  ]);
  chip.addEventListener("click", () => openProfile(chip, me, state.guildData.get(state.route.guildId), "top-start"));
  // Mute and deafen are local visual toggles only; the Tool has no voice. Deafen also mutes, as the client does.
  const mute = el("button", { class: "panel-btn", attrs: { type: "button", role: "switch", "aria-label": "Mute" } });
  const deafen = el("button", { class: "panel-btn", attrs: { type: "button", role: "switch", "aria-label": "Deafen" } });
  const settings = el("button", { class: "panel-btn", attrs: { type: "button", "aria-label": "User Settings", "data-tooltip": "User Settings" } }, icon("gear", 20));
  const paint = () => {
    const { muted, deafened } = state.voice;
    const micOff = muted || deafened;
    mute.replaceChildren(icon(micOff ? "mic_off" : "mic", 20));
    mute.setAttribute("aria-checked", String(micOff));
    mute.setAttribute("data-tooltip", micOff ? "Unmute" : "Mute");
    deafen.replaceChildren(icon(deafened ? "headset_off" : "headset", 20));
    deafen.setAttribute("aria-checked", String(deafened));
    deafen.setAttribute("data-tooltip", deafened ? "Undeafen" : "Deafen");
    writePref("mic-muted", String(muted));
    writePref("deafened", String(deafened));
  };
  mute.addEventListener("click", () => {
    const voice = state.voice;
    if (voice.deafened) {
      voice.deafened = false;
      voice.muted = false;
    } else voice.muted = !voice.muted;
    paint();
  });
  deafen.addEventListener("click", () => {
    const voice = state.voice;
    if (voice.deafened) {
      voice.deafened = false;
      voice.muted = voice.mutedBeforeDeafen;
    } else {
      voice.mutedBeforeDeafen = voice.muted;
      voice.deafened = true;
      voice.muted = true;
    }
    paint();
  });
  settings.addEventListener("click", () => openSettings());
  paint();
  $("#user-panel").replaceChildren(chip, el("div", { class: "panel-buttons" }, [mute, deafen, settings]));
}

// ---------------------------------------------------------------------------------------------
// Home pages: Friends, Nitro, Shop, Discover. The Tool models no friendships, presence, purchases or public servers,
// so these render the client's empty states or a "not simulated" panel; nothing here is invented.
// ---------------------------------------------------------------------------------------------

const NOT_SIMULATED = {
  nitro: { glyph: "nitro", title: "Nitro", heading: "Nitro isn't simulated by this Tool", text: "Subscriptions, boosts and perks aren't part of this world, so there is nothing to buy or manage here." },
  shop: { glyph: "shop", title: "Shop", heading: "The Shop isn't simulated by this Tool", text: "Avatar decorations, profile effects and purchases aren't part of this world." },
  discover: { glyph: "compass", title: "Discover", heading: "Server discovery isn't simulated by this Tool", text: "Public servers aren't part of this world. The servers in the rail come from its starting data." },
};

function headerButton(glyph, label, onClick, options = {}) {
  return iconButton(glyph, label, onClick, { ...options, attrs: { "data-tooltip-side": "bottom", ...(options.attrs ?? {}) } });
}

function infoPopout(anchor, glyph, title, text) {
  popout(
    anchor,
    el("div", { class: "header-popout" }, [
      el("div", { class: "header-popout-head" }, [icon(glyph, 24), el("span", { text: title })]),
      el("div", { class: "header-popout-body" }, [el("div", { class: "empty-art small" }, icon(glyph, 40)), el("p", { text })]),
    ]),
    { placement: "bottom-end", toggle: true },
  );
}

function inboxButton() {
  const button = headerButton("inbox", "Inbox", () => infoPopout(button, "inbox", "Inbox", "The inbox isn't simulated by this Tool."), { class: "hdr-extra" });
  return button;
}

function helpButton() {
  const button = headerButton("help", "Help", () => infoPopout(button, "help", "Help", "The Help Center isn't part of this simulated world."), { class: "hdr-extra" });
  return button;
}

function openNotificationMenu(anchor, thread) {
  menu(
    anchor,
    [
      { label: thread ? "Mute Thread" : "Mute Channel", disabled: true },
      "separator",
      { label: "Use Category Default", radio: true, disabled: true },
      { label: "All Messages", radio: false, disabled: true },
      { label: "Only @mentions", radio: false, disabled: true },
      { label: "Nothing", radio: false, disabled: true },
      "separator",
      { note: "Notification settings aren't simulated by this Tool." },
    ],
    "bottom-end",
    { toggle: true },
  );
}

function renderPage(page) {
  closeChat();
  if (page === "friends") return renderFriends();
  const info = NOT_SIMULATED[page] ?? NOT_SIMULATED.nitro;
  content.replaceChildren(
    el("div", { class: "chat page" }, [
      el("header", { class: "chat-header" }, [mobileMenuButton(), icon(info.glyph, 24, "title-icon"), el("h1", { class: "title", text: info.title }), el("div", { class: "header-tools" }, [inboxButton(), helpButton()])]),
      el("div", { class: "page-state" }, [el("div", { class: "empty-art" }, icon(info.glyph, 64)), el("h2", { text: info.heading }), el("p", { text: info.text })]),
    ]),
  );
}

const FRIEND_TABS = [
  ["online", "Online"],
  ["all", "All"],
  ["pending", "Pending"],
  ["blocked", "Blocked"],
];
const FRIEND_EMPTY = {
  online: ["friends", "No one's around right now."],
  all: ["friends", "You don't have any friends here yet."],
  pending: ["inbox", "There are no pending friend requests."],
  blocked: ["block", "You haven't blocked anyone."],
};

function renderFriends() {
  const tab = state.friendsTab;
  const select = (id) => {
    state.friendsTab = id;
    renderFriends();
    content.querySelector(".friends-tab.selected")?.focus();
  };
  const tabButton = (id, label, className = "") =>
    el("button", {
      class: `friends-tab ${className} ${tab === id ? "selected" : ""}`.trim(),
      text: label,
      attrs: { type: "button", role: "tab", "aria-selected": String(tab === id) },
      on: { click: () => select(id) },
    });
  const header = el("header", { class: "chat-header friends-header" }, [
    mobileMenuButton(),
    icon("friends", 24, "title-icon"),
    el("h1", { class: "title", text: "Friends" }),
    el("div", { class: "topic-divider" }),
    el("div", { class: "friends-tabs", attrs: { role: "tablist", "aria-label": "Friends" } }, [...FRIEND_TABS.map(([id, label]) => tabButton(id, label)), tabButton("add", "Add Friend", "add-friend-tab")]),
    el("div", { class: "header-tools" }, [headerButton("dm_add", "Create DM", () => openQuickSwitcher()), el("div", { class: "tools-divider" }), inboxButton(), helpButton()]),
  ]);
  const main = el("div", { class: "friends-main", attrs: { role: "tabpanel" } });
  if (tab === "add") main.append(addFriendPanel());
  else {
    const [glyph, text] = FRIEND_EMPTY[tab];
    main.append(
      el("div", { class: "page-state" }, [
        el("div", { class: "empty-art" }, icon(glyph, 64)),
        el("p", { text }),
        tab === "all" ? el("button", { class: "btn btn-primary", text: "Add Friend", attrs: { type: "button" }, on: { click: () => select("add") } }) : null,
      ]),
    );
  }
  const active = el("aside", { class: "active-now", attrs: { "aria-label": "Active Now" } }, [
    el("h2", { text: "Active Now" }),
    el("div", { class: "active-now-empty" }, [el("h3", { text: "It's quiet for now" }), el("p", { text: "When a friend starts an activity, like playing a game or hanging out in voice, it will show up here." })]),
  ]);
  content.replaceChildren(el("div", { class: "chat friends" }, [header, el("div", { class: "friends-body" }, [main, active])]));
}

/** The client's Add Friend form, rendered disabled: the Tool has no friend requests. */
function addFriendPanel() {
  const input = el("input", {
    class: "add-friend-input",
    attrs: { type: "text", disabled: true, "aria-label": "Username", placeholder: "You can add friends with their Discord username.", "aria-describedby": "add-friend-note", autocomplete: "off" },
  });
  const form = el("form", { class: "add-friend-form", attrs: { "aria-disabled": "true" } }, [input, el("button", { class: "btn btn-primary btn-sm", text: "Send Friend Request", attrs: { type: "submit", disabled: true } })]);
  form.addEventListener("submit", (event) => event.preventDefault());
  return el("div", { class: "add-friend" }, [
    el("h2", { class: "add-friend-title", text: "Add Friend" }),
    el("p", { class: "add-friend-text", text: "You can add friends with their Discord username." }),
    form,
    el("p", { class: "not-simulated-note", attrs: { id: "add-friend-note" } }, [icon("lock", 16), el("span", { text: "Friend requests aren't simulated by this Tool, so this form is disabled." })]),
    el("div", { class: "add-friend-divider" }),
    el("h2", { class: "add-friend-title", text: "Other places to make friends" }),
    el("button", { class: "explore-card", attrs: { type: "button" }, on: { click: () => navigatePage("discover") } }, [
      el("span", { class: "explore-icon" }, icon("compass", 24)),
      el("span", { class: "grow", text: "Explore Discoverable Servers" }),
      icon("chevron_right", 20),
    ]),
  ]);
}

function openInfoModal(title, text) {
  modal({
    title,
    className: "modal-info",
    build: (body) => body.append(el("p", { class: "modal-text", text })),
    footer: (close) => [el("button", { class: "btn btn-primary", text: "Okay", attrs: { type: "button", autofocus: true }, on: { click: close } })],
  });
}

function openAddServer() {
  openInfoModal("Add a Server", "Creating and joining servers isn't simulated by this Tool. The servers in this world come from its starting data.");
}

function openGift() {
  openInfoModal("Send a gift", "Gifting Nitro isn't simulated by this Tool.");
}

const SETTINGS_SECTIONS = [
  ["User Settings", ["My Account", "Profiles", "Content & Social", "Data & Privacy", "Authorized Apps", "Devices", "Connections"]],
  ["Billing Settings", ["Nitro", "Server Boost", "Subscriptions", "Gift Inventory", "Billing"]],
  ["App Settings", ["Appearance", "Accessibility", "Voice & Video", "Chat", "Notifications", "Keybinds", "Language", "Advanced"]],
];

/** A minimal User Settings screen: My Account read from `users.get @me`; every other section is not simulated. */
function openSettings() {
  const me = state.me;
  overlay({
    label: "User Settings",
    className: "settings",
    build: (node, close) => {
      const nav = el("div", { class: "settings-nav-inner" });
      SETTINGS_SECTIONS.forEach(([heading, items], index) => {
        if (index > 0) nav.append(el("div", { class: "settings-nav-sep", attrs: { role: "separator" } }));
        nav.append(el("div", { class: "settings-nav-heading", text: heading }));
        for (const item of items) {
          nav.append(
            item === "My Account"
              ? el("button", { class: "settings-nav-item selected", text: item, attrs: { type: "button", "aria-current": "page" } })
              : el("div", { class: "settings-nav-item disabled", text: item, attrs: { "aria-disabled": "true", "data-tooltip": "Not simulated by this Tool", "data-tooltip-side": "right" } }),
          );
        }
      });
      const banner = el("div", { class: "account-banner" });
      banner.style.background = AVATAR_COLOURS[avatarIndex(me.id)];
      const field = (label, value) =>
        el("div", { class: "account-field" }, [
          el("div", { class: "account-field-text" }, [el("h3", { text: label }), el("div", { class: "account-field-value", text: value })]),
          el("button", { class: "btn btn-secondary btn-sm", text: "Edit", attrs: { type: "button", disabled: true, "aria-label": `Edit ${label} (not simulated)` } }),
        ]);
      const fields = el("div", { class: "account-fields" }, [field("Display Name", displayName(me)), field("Username", me.username)]);
      if (typeof me.email === "string" && me.email.includes("@")) {
        const [local, domain] = [me.email.slice(0, me.email.lastIndexOf("@")), me.email.slice(me.email.lastIndexOf("@") + 1)];
        fields.append(field("Email", `${"*".repeat(Math.max(4, local.length))}@${domain}`));
      }
      node.append(
        el("nav", { class: "settings-nav thin-scroll", attrs: { "aria-label": "User Settings" } }, nav),
        el("div", { class: "settings-main" }, [
          el("main", { class: "settings-content" }, [
            el("h2", { class: "settings-title", text: "My Account" }),
            el("div", { class: "settings-notice", attrs: { role: "note" } }, [icon("lock", 20), el("span", { text: "Settings aren't simulated by this Tool. These details are read from the world and can't be changed here." })]),
            el("section", { class: "account-card", attrs: { "aria-label": "Account" } }, [
              banner,
              el("div", { class: "account-head" }, [
                el("span", { class: "account-avatar" }, avatar(me, 80)),
                el("span", { class: "account-name", text: displayName(me) }),
                el("button", { class: "btn btn-primary btn-sm", text: "Edit User Profile", attrs: { type: "button", disabled: true } }),
              ]),
              fields,
            ]),
          ]),
          el("div", { class: "settings-close" }, [
            el("button", { class: "settings-close-btn", attrs: { type: "button", "aria-label": "Close settings", autofocus: true }, on: { click: close } }, icon("close", 18)),
            el("span", { class: "settings-close-key", text: "ESC", attrs: { "aria-hidden": "true" } }),
          ]),
        ]),
      );
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

function stateCard(glyph, title, text, retry, actionLabel, onAction) {
  return el("div", { class: "pane-state" }, [
    mobileMenuButton(),
    icon(glyph, 64),
    el("h2", { text: title }),
    el("p", { text }),
    retry ? el("button", { class: "btn btn-primary", text: "Try Again", attrs: { type: "button" }, on: { click: retry } }) : null,
    actionLabel ? el("button", { class: "btn btn-primary", text: actionLabel, attrs: { type: "button" }, on: { click: onAction } }) : null,
  ]);
}

function skeletonPane() {
  const wrap = el("div", { class: "chat" }, [el("div", { class: "chat-header" })]);
  const body = el("div", { class: "skeleton", attrs: { "aria-label": "Loading messages" } });
  for (let i = 0; i < 6; i += 1) {
    body.append(el("div", { class: "skeleton-row" }, [el("div", { class: "skeleton-avatar" }), el("div", { class: "skeleton-lines" }, [el("div", { class: "skeleton-line" }), el("div", { class: "skeleton-line" })])]));
  }
  wrap.append(el("div", { class: "scroller" }, el("div", { class: "scroller-inner" }, body)));
  return wrap;
}

function mobileMenuButton() {
  return iconButton(
    "menu",
    "Open navigation",
    () => {
      app.classList.add("nav-open");
      $("#sidebar-scrim").hidden = false;
    },
    { class: "mobile-menu" },
  );
}
$("#sidebar-scrim").addEventListener("click", () => {
  app.classList.remove("nav-open");
  $("#sidebar-scrim").hidden = true;
});

function roleFor(data, userId, member) {
  if (!data) return undefined;
  const roleIds = member?.roles ?? state.members.get(data.guild.id)?.list.find((m) => m.user.id === userId)?.roles ?? (userId === state.me.id ? data.myRoles : []);
  return data.roles.filter((r) => roleIds.includes(r.id) && r.color).sort((a, b) => b.position - a.position)[0];
}

function memberName(data, userId, fallbackUser) {
  const member = data ? state.members.get(data.guild.id)?.list.find((m) => m.user.id === userId) : undefined;
  if (member) return member.nick || displayName(member.user);
  if (userId === state.me.id && data) return data.member.nick || displayName(state.me);
  return displayName(fallbackUser) ?? "Unknown User";
}

function describeError(error) {
  if (error.is?.("RATE_LIMITED")) return "You are being rate limited.";
  return error.message;
}

// ---------------------------------------------------------------------------------------------
// Chat view (used for the main pane and the thread side panel)
// ---------------------------------------------------------------------------------------------

function closeChat() {
  state.main = undefined;
}

function openChat({ channel, data }) {
  closeChat();
  const layout = el("div", { class: "chat" });
  const body = el("div", { class: "chat-body" });
  const chat = new Chat({ channel, data, mode: "main" });
  state.main = chat;
  layout.append(chat.header, body);
  body.append(chat.root);
  const membersPane = el("aside", { class: "members", attrs: { "aria-label": "Members", id: "members" } });
  if (data && state.showMembers && !THREAD_TYPES.has(channel.type)) body.append(membersPane);
  const sideHost = el("div", { class: "side-host", attrs: { id: "side-host" } });
  body.append(sideHost);
  content.replaceChildren(layout);
  markSeen(channel);
  void chat.load();
  if (data && state.showMembers && !THREAD_TYPES.has(channel.type)) void renderMembers();
}

class Chat {
  constructor({ channel, data, mode }) {
    this.channel = channel;
    this.data = data;
    this.mode = mode;
    this.messages = [];
    this.hasMore = false;
    this.loading = false;
    this.error = undefined;
    this.reply = undefined;
    this.editing = undefined;
    this.sending = false;
    this.failed = [];
    this.header = this.buildHeader();
    this.root = el("div", { class: "chat-main" });
    this.scroller = el("div", { class: "scroller", attrs: { tabindex: "-1" } });
    this.inner = el("div", { class: "scroller-inner" });
    this.list = el("ol", { class: "messages", attrs: { "aria-label": `Messages in ${this.label()}` } });
    this.scroller.append(this.inner);
    this.composerWrap = el("div", { class: "composer-wrap" });
    this.root.append(this.scroller, this.composerWrap);
    this.scroller.addEventListener("scroll", () => {
      if (this.scroller.scrollTop < 120 && this.hasMore && !this.loading) void this.loadOlder();
    });
    this.buildComposer();
  }

  get isDm() {
    return this.channel.type === 1;
  }
  get isThread() {
    return THREAD_TYPES.has(this.channel.type);
  }
  get perms() {
    return channelPerms(this.data, this.channel);
  }
  label() {
    if (this.isDm) return `@${displayName(this.channel.recipients[0])}`;
    return this.isThread ? this.channel.name : `#${this.channel.name}`;
  }

  buildHeader() {
    const channel = this.channel;
    const header = el("header", { class: "chat-header" });
    if (this.mode === "main") header.append(mobileMenuButton());
    if (this.isDm) {
      header.append(icon("at", 24, "title-icon"), el("h1", { class: "title", text: displayName(channel.recipients[0]) }));
    } else if (this.isThread) {
      const parent = this.data?.channels.find((c) => c.id === channel.parent_id);
      header.append(icon("thread", 24, "title-icon"));
      if (this.mode === "main" && parent) {
        header.append(
          el("button", { class: "crumb", text: parent.name, attrs: { type: "button" }, on: { click: () => navigate(this.data.guild.id, parent.id) } }),
          el("span", { class: "crumb-sep", text: "›" }),
        );
      }
      header.append(el("h1", { class: "title", text: channel.name }));
      if (channel.thread_metadata?.locked) header.append(el("span", { class: "tag", text: "Locked" }));
      else if (channel.thread_metadata?.archived) header.append(el("span", { class: "tag", text: "Archived" }));
    } else {
      header.append(icon(channelIcon(this.data, channel), 24, "title-icon"), el("h1", { class: "title", text: channel.name }));
      if (channel.topic) header.append(el("div", { class: "topic-divider" }), el("div", { class: "topic", text: channel.topic, title: channel.topic }));
    }
    const tools = el("div", { class: "header-tools" });
    if (this.mode === "side") {
      tools.append(iconButton("close", "Close", () => closeSide()));
    } else {
      // The client's order: Threads, Notification Settings, Pinned Messages, Member List, Search, Inbox, Help.
      const channelView = !this.isDm && !this.isThread;
      if (channelView) {
        const threadsButton = headerButton("threads", "Threads", () => openThreadsPopout(threadsButton, this));
        tools.append(threadsButton);
      }
      if (!this.isDm) {
        const bell = headerButton("bell", "Notification Settings", () => openNotificationMenu(bell, this.isThread), { class: "hdr-extra" });
        tools.append(bell);
      }
      const pins = headerButton("pin", "Pinned Messages", () => infoPopout(pins, "pin", "Pinned Messages", "Pinned messages aren't simulated by this Tool."), { class: "hdr-extra" });
      tools.append(pins);
      if (channelView) {
        const toggle = headerButton("members", state.showMembers ? "Hide Member List" : "Show Member List", () => this.toggleMembers(toggle), {
          class: "members-toggle",
          attrs: { "aria-pressed": String(state.showMembers) },
        });
        tools.append(toggle);
      }
      tools.append(
        el("div", { class: "header-search", attrs: { role: "search", "aria-disabled": "true", "data-tooltip": "Search isn't available in this simulation", "data-tooltip-side": "bottom" } }, [
          el("span", { text: "Search" }),
          icon("search", 16),
        ]),
        inboxButton(),
        helpButton(),
      );
    }
    header.append(tools);
    return header;
  }

  /** Show or hide the member list in place, keeping the message list, its scroll position and the draft. */
  toggleMembers(button) {
    state.showMembers = !state.showMembers;
    writePref("members", String(state.showMembers));
    const label = state.showMembers ? "Hide Member List" : "Show Member List";
    button.setAttribute("aria-pressed", String(state.showMembers));
    button.setAttribute("aria-label", label);
    button.setAttribute("data-tooltip", label);
    const body = this.root.parentElement;
    const existing = document.getElementById("members");
    if (!state.showMembers) existing?.remove();
    else if (body && !existing) {
      body.insertBefore(el("aside", { class: "members", attrs: { "aria-label": "Members", id: "members" } }), document.getElementById("side-host"));
      void renderMembers();
    }
  }

  // ---- loading ------------------------------------------------------------------------------

  async load() {
    this.loading = true;
    this.inner.replaceChildren(skeletonPane().querySelector(".skeleton"));
    try {
      const result = await call("messages.list", { channel_id: this.channel.id, limit: PAGE });
      this.messages = result.messages.reverse();
      this.hasMore = mayHaveMore(result.messages, PAGE);
      this.error = undefined;
    } catch (error) {
      this.error = error;
    } finally {
      this.loading = false;
    }
    this.render({ stick: true });
  }

  async loadOlder() {
    if (!this.messages.length) return;
    this.loading = true;
    const before = this.messages[0].id;
    const height = this.scroller.scrollHeight;
    try {
      const result = await call("messages.list", { channel_id: this.channel.id, before, limit: PAGE });
      const older = result.messages.reverse();
      this.messages = [...older, ...this.messages];
      this.hasMore = mayHaveMore(older, PAGE);
    } catch (error) {
      toast(describeError(error), { error: true });
      this.hasMore = false;
    } finally {
      this.loading = false;
    }
    this.render();
    this.scroller.scrollTop = this.scroller.scrollHeight - height;
  }

  /** Re-read the newest window (keeps up to 100 already-loaded messages in view). */
  async refresh() {
    if (this.loading) return;
    const nearBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 80;
    try {
      const fresh = await call("channels.get", { channel_id: this.channel.id });
      this.channel = this.isDm ? { ...fresh, recipients: fresh.recipients ?? this.channel.recipients } : fresh;
      const limit = Math.min(100, Math.max(PAGE, this.messages.length));
      const result = await call("messages.list", { channel_id: this.channel.id, limit });
      this.messages = result.messages.reverse();
      this.hasMore = mayHaveMore(result.messages, limit);
      this.error = undefined;
    } catch (error) {
      this.error = error;
    }
    this.render({ stick: nearBottom });
    this.buildComposer();
    if (this.mode === "main") markSeen(this.channel);
  }

  async reloadMessage(messageId) {
    try {
      const message = await call("messages.get", { channel_id: this.channel.id, message_id: messageId });
      const index = this.messages.findIndex((m) => m.id === messageId);
      if (index >= 0) this.messages[index] = message;
    } catch (error) {
      if (error.is("UNKNOWN_MESSAGE")) this.messages = this.messages.filter((m) => m.id !== messageId);
      else toast(describeError(error), { error: true });
    }
    this.render();
  }

  // ---- rendering ----------------------------------------------------------------------------

  render({ stick = false } = {}) {
    const scroll = this.scroller.scrollTop;
    this.inner.replaceChildren();
    if (this.error) {
      if (this.error.is("MISSING_ACCESS") || this.error.denied) {
        this.inner.replaceChildren(stateCard("lock", "You do not have permission to view this channel", this.error.denied ? "This actor has no grant for reading messages." : this.error.message));
      } else {
        this.inner.append(
          el("div", { class: "error-bar", attrs: { role: "alert" } }, [
            icon("warning", 20),
            el("span", { text: describeError(this.error) }),
            el("button", { class: "btn btn-sm btn-secondary", text: "Retry", attrs: { type: "button" }, on: { click: () => void this.load() } }),
          ]),
        );
      }
      return;
    }
    if (this.hasMore) this.inner.append(el("div", { class: "load-older", text: "Loading older messages…" }));
    else this.inner.append(this.hero());
    this.list.replaceChildren();
    let previous;
    for (const message of this.messages) {
      const ms = parseTime(message.timestamp);
      if (!previous || !sameDay(parseTime(previous.timestamp), ms)) {
        this.list.append(el("li", { class: "divider", attrs: { role: "separator" } }, el("span", { text: dividerDate(ms) })));
      }
      this.list.append(this.messageNode(message, previous));
      previous = message;
    }
    for (const failed of this.failed) this.list.append(this.failedNode(failed));
    this.inner.append(this.list);
    if (stick) this.scroller.scrollTop = this.scroller.scrollHeight;
    else this.scroller.scrollTop = scroll;
  }

  hero() {
    const channel = this.channel;
    if (this.isDm) {
      const user = channel.recipients[0];
      return el("div", { class: "channel-hero" }, [
        avatar(user, 80),
        el("h2", { class: "hero-dm-name", text: displayName(user) }),
        el("div", { class: "hero-dm-user", text: user.username }),
        el("p", { class: "hero-sub" }, ["This is the beginning of your direct message history with ", el("strong", { text: displayName(user) }), "."]),
      ]);
    }
    if (this.isThread) {
      const owner = this.data ? memberName(this.data, channel.owner_id) : "";
      return el("div", { class: "channel-hero" }, [
        el("div", { class: "hero-icon" }, icon("thread", 42)),
        el("h2", { class: "hero-title", text: channel.name }),
        el("p", { class: "hero-sub" }, ["Started by ", el("strong", { text: owner })]),
      ]);
    }
    return el("div", { class: "channel-hero" }, [
      el("div", { class: "hero-icon" }, icon(channelIcon(this.data, channel), 42)),
      el("h2", { class: "hero-title", text: `Welcome to #${channel.name}!` }),
      el("p", { class: "hero-sub", text: `This is the start of the #${channel.name} channel.${channel.topic ? ` ${channel.topic}` : ""}` }),
    ]);
  }

  isGrouped(message, previous) {
    if (!previous || message.type !== 0 || previous.type === 7 || previous.type === 18) return false;
    if (previous.author.id !== message.author.id) return false;
    if (message.message_reference) return false;
    const gap = parseTime(message.timestamp) - parseTime(previous.timestamp);
    return gap >= 0 && gap < 7 * 60 * 1000 && sameDay(parseTime(previous.timestamp), parseTime(message.timestamp));
  }

  mentionsMe(message) {
    if (message.mention_everyone) return true;
    if (message.mentions.some((u) => u.id === state.me.id)) return true;
    return Boolean(this.data && message.mention_roles.some((id) => this.data.myRoles.includes(id)));
  }

  nameNode(user, className = "author") {
    const node = el("span", { class: className, text: this.data ? memberName(this.data, user.id, user) : displayName(user), attrs: { role: "button", tabindex: "0" } });
    const role = roleFor(this.data, user.id);
    if (role) node.style.color = roleColour(role.color);
    const open = () => openProfile(node, user, this.data);
    node.addEventListener("click", open);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open();
    });
    return node;
  }

  messageNode(message, previous) {
    const ms = parseTime(message.timestamp);
    if (message.type === 7 || message.type === 18) return this.systemNode(message, ms);
    const grouped = this.isGrouped(message, previous);
    const item = el("li", {
      class: `message ${grouped ? "" : "group-start"} ${this.mentionsMe(message) ? "mentioned" : ""} ${message.message_reference ? "has-reply" : ""}`,
      attrs: { id: `msg-${this.mode}-${message.id}`, tabindex: "-1", "aria-label": `${displayName(message.author)}, ${fullStamp(ms)}` },
    });
    if (message.message_reference) item.append(this.replyBar(message));
    if (grouped) {
      item.append(el("span", { class: "hover-time", text: clock(ms), title: fullStamp(ms) }));
    } else {
      const face = avatar(message.author, 40);
      face.classList.add("message-avatar");
      face.setAttribute("role", "button");
      face.setAttribute("aria-label", `Open profile of ${displayName(message.author)}`);
      face.addEventListener("click", () => openProfile(face, message.author, this.data, "right-start"));
      item.append(face);
      const header = el("div", { class: "message-header" }, [this.nameNode(message.author)]);
      if (message.author.bot) header.append(el("span", { class: "bot-tag", text: "APP" }));
      header.append(el("time", { class: "timestamp", text: messageStamp(ms, state.nowMs), attrs: { datetime: message.timestamp, "data-tooltip": fullStamp(ms) } }));
      item.append(header);
    }
    if (this.editing === message.id) item.append(this.editBox(message));
    else if (message.content) {
      const body = el("div", { class: "message-content" });
      renderMarkdown(body, message.content, this.data, message);
      if (message.edited_timestamp) body.append(el("span", { class: "edited", text: "(edited)", attrs: { "data-tooltip": fullStamp(parseTime(message.edited_timestamp)) } }));
      item.append(body);
    }
    if (message.flags & 4) {
      // Embeds suppressed.
    } else {
      for (const embed of message.embeds) item.append(embedNode(embed));
    }
    if (message.thread) item.append(this.threadChip(message.thread));
    if (message.reactions?.length) item.append(this.reactionsNode(message));
    item.append(this.toolbar(message));
    return item;
  }

  systemNode(message, ms) {
    const item = el("li", { class: "message system-message group-start", attrs: { id: `msg-${this.mode}-${message.id}` } });
    const text = el("div", { class: "message-content" });
    if (message.type === 7) {
      item.append(icon("join", 18, "sys-icon join"));
      text.append(this.nameNode(message.author, "strong"), " joined the server.");
    } else {
      item.append(icon("thread", 18, "sys-icon thread"));
      const threadName = message.content || "a thread";
      const open = el("span", { class: "strong", text: threadName, attrs: { role: "button", tabindex: "0" } });
      const threadId = message.message_reference?.channel_id;
      open.addEventListener("click", () => threadId && this.data && openThreadById(this.data, threadId));
      text.append(this.nameNode(message.author, "strong"), " started a thread: ", open, ". See all ");
      const all = el("span", { class: "strong", text: "threads", attrs: { role: "button", tabindex: "0" } });
      all.addEventListener("click", () => openThreadsPopout(all, this));
      text.append(all, ".");
    }
    text.append(el("time", { class: "timestamp", text: messageStamp(ms, state.nowMs), attrs: { datetime: message.timestamp, "data-tooltip": fullStamp(ms) } }));
    item.append(text);
    return item;
  }

  replyBar(message) {
    const ref = message.referenced_message;
    const bar = el("div", { class: "reply-bar" });
    if (!ref) {
      bar.append(el("span", { class: "reply-deleted-icon" }, icon("reply", 10)), el("span", { class: "reply-text reply-missing", text: "Original message was deleted" }));
      return bar;
    }
    const jump = () => {
      const target = document.getElementById(`msg-${this.mode}-${ref.id}`);
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        target.classList.add("highlight");
        setTimeout(() => target.classList.remove("highlight"), 1600);
      } else toast("That message is further up in the conversation.");
    };
    const snippet = ref.content ? ref.content.replace(/\s+/g, " ") : ref.embeds.length ? "Click to see attachment" : "";
    const text = el("span", { class: "reply-text", text: snippet, attrs: { role: "button", tabindex: "0" }, on: { click: jump } });
    bar.append(avatar(ref.author, 16), this.nameNode(ref.author, "reply-author"), text);
    return bar;
  }

  threadChip(thread) {
    const count = thread.message_count;
    const chip = el("button", { class: "thread-chip", attrs: { type: "button", "aria-label": `Open thread ${thread.name}` } }, [
      el("span", { class: "thread-chip-top" }, [
        el("span", { class: "thread-chip-name", text: thread.name }),
        el("span", { class: "thread-chip-count" }, [`${count} ${count === 1 ? "Message" : "Messages"}`, icon("chevron_right", 16)]),
      ]),
      el("span", {
        class: "thread-chip-meta",
        text: thread.thread_metadata.locked ? "This thread is locked." : thread.thread_metadata.archived ? "This thread is archived." : thread.last_message_id ? `Last message ${ago(snowflakeMs(thread.last_message_id))}` : "No messages yet",
      }),
    ]);
    chip.addEventListener("click", () => openThreadSide(this.data, thread));
    return chip;
  }

  reactionsNode(message) {
    const wrap = el("div", { class: "reactions" });
    for (const reaction of message.reactions) {
      const label = emojiText(reaction.emoji);
      const pill = el("button", {
        class: `reaction ${reaction.me ? "me" : ""}`,
        attrs: { type: "button", "aria-pressed": String(reaction.me), "aria-label": `${label}, ${reaction.count} reaction${reaction.count === 1 ? "" : "s"}`, "data-tooltip": `${label}` },
      }, [emojiNode(reaction.emoji), el("span", { class: "reaction-count", text: reaction.count })]);
      pill.addEventListener("click", () => void this.toggleReaction(message, reaction.emoji, reaction.me));
      pill.addEventListener("mouseenter", () => void this.loadReactors(pill, message, reaction), { once: true });
      wrap.append(pill);
    }
    if (this.canReact(message, true)) {
      const add = el("button", { class: "reaction reaction-add", attrs: { type: "button", "aria-label": "Add Reaction", "data-tooltip": "Add Reaction" } }, icon("reaction_add", 18));
      add.addEventListener("click", () => this.openPicker(add, message));
      wrap.append(add);
    }
    return wrap;
  }

  async loadReactors(pill, message, reaction) {
    try {
      const result = await call("reactions.list-users", { channel_id: this.channel.id, message_id: message.id, emoji_name: emojiArg(reaction.emoji), limit: 100 });
      const names = result.users.map((u) => (this.data ? memberName(this.data, u.id, u) : displayName(u)));
      const shown = names.slice(0, 3);
      const rest = reaction.count - shown.length;
      const who = rest > 0 ? `${shown.join(", ")} and ${rest} other${rest === 1 ? "" : "s"}` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0] ?? "nobody";
      pill.setAttribute("data-tooltip", `${who} reacted with ${emojiText(reaction.emoji)}`);
      if (pill.matches(":hover")) pill.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    } catch (error) {
      pill.setAttribute("data-tooltip", describeError(error));
    }
  }

  canReact(message, joiningOnly = false) {
    if (this.isThread && this.channel.thread_metadata?.archived) return false;
    return joiningOnly ? has(this.perms, P.ADD_REACTIONS) : true;
  }

  async toggleReaction(message, emoji, mine) {
    try {
      if (mine) await call("reactions.remove", { channel_id: this.channel.id, message_id: message.id, emoji_name: emojiArg(emoji), user_id: "@me" }, { mutation: true });
      else await call("reactions.add", { channel_id: this.channel.id, message_id: message.id, emoji_name: emojiArg(emoji), user_id: "@me" }, { mutation: true });
    } catch (error) {
      toast(error.is("MAX_REACTIONS") ? "Reaction blocked: this message already has the maximum of 20 different reactions." : describeError(error), { error: true });
    }
    await this.reloadMessage(message.id);
  }

  openPicker(anchor, message, onPick) {
    const pick =
      onPick ??
      ((emoji) => {
        const existing = message.reactions?.find((r) => emojiArg(r.emoji) === emojiArg(emoji));
        void this.toggleReaction(message, emoji, Boolean(existing?.me));
      });
    openEmojiPicker(anchor, this.data, (emoji) => {
      closeLayer();
      pick(emoji);
    });
  }

  toolbar(message) {
    const bar = el("div", { class: "toolbar", attrs: { role: "toolbar", "aria-label": "Message actions" } });
    const mine = message.author.id === state.me.id;
    const perms = this.perms;
    const canSend = this.sendBlocker() === undefined;
    if (this.canReact(message)) {
      for (const emoji of QUICK_EMOJI.slice(0, 3)) {
        bar.append(el("button", { class: "quick", text: emoji, attrs: { type: "button", "aria-label": `React with ${emoji}`, "data-tooltip": `React with ${emoji}` }, on: { click: () => void this.toggleReaction(message, { id: null, name: emoji }, Boolean(message.reactions?.find((r) => !r.emoji.id && r.emoji.name === emoji)?.me)) } }));
      }
      bar.append(el("span", { class: "sep" }));
      const add = el("button", { attrs: { type: "button", "aria-label": "Add Reaction", "data-tooltip": "Add Reaction" } }, icon("reaction_add", 20));
      add.addEventListener("click", () => this.openPicker(add, message));
      bar.append(add);
    }
    if (mine && (message.type === 0 || message.type === 19)) {
      bar.append(el("button", { attrs: { type: "button", "aria-label": "Edit", "data-tooltip": "Edit" }, on: { click: () => this.startEdit(message) } }, icon("pencil", 20)));
    }
    if (canSend) {
      bar.append(el("button", { attrs: { type: "button", "aria-label": "Reply", "data-tooltip": "Reply" }, on: { click: () => this.startReply(message) } }, icon("reply", 20)));
    }
    const canThread = !this.isDm && !this.isThread && !message.thread && has(perms, P.CREATE_PUBLIC_THREADS) && (message.type === 0 || message.type === 19);
    if (canThread) bar.append(el("button", { attrs: { type: "button", "aria-label": "Create Thread", "data-tooltip": "Create Thread" }, on: { click: () => openNewThread(this, message) } }, icon("threads", 20)));
    const more = el("button", { attrs: { type: "button", "aria-label": "More", "data-tooltip": "More", "aria-haspopup": "menu" } }, icon("more", 20));
    more.addEventListener("click", () => {
      const items = [];
      if (this.canReact(message)) items.push({ label: "Add Reaction", icon: "reaction_add", onSelect: () => this.openPicker(more, message) });
      if (mine && (message.type === 0 || message.type === 19)) items.push({ label: "Edit Message", icon: "pencil", onSelect: () => this.startEdit(message) });
      if (canSend) items.push({ label: "Reply", icon: "reply", onSelect: () => this.startReply(message) });
      if (canThread) items.push({ label: "Create Thread", icon: "threads", onSelect: () => openNewThread(this, message) });
      if (message.thread) items.push({ label: "Open Thread", icon: "threads", onSelect: () => openThreadSide(this.data, message.thread) });
      items.push("separator");
      if (message.content) items.push({ label: "Copy Text", icon: "copy", onSelect: () => copy(message.content, "Copied text") });
      items.push({ label: "Copy Message ID", icon: "copy", onSelect: () => copy(message.id, "Copied message ID") });
      const canDelete = (mine || has(perms, P.MANAGE_MESSAGES) && !this.isDm) && !(this.isThread && this.channel.thread_metadata?.archived);
      if (canDelete) {
        items.push("separator");
        items.push({ label: "Delete Message", icon: "trash", danger: true, onSelect: () => void this.deleteMessage(message) });
      }
      menu(more, items, "bottom-end");
    });
    bar.append(more);
    return bar;
  }

  failedNode(failed) {
    const item = el("li", { class: `message group-start ${failed.pending ? "pending" : "failed"}` });
    const face = avatar(state.me, 40);
    face.classList.add("message-avatar");
    item.append(face);
    item.append(
      el("div", { class: "message-header" }, [
        el("span", { class: "author", text: this.data ? memberName(this.data, state.me.id, state.me) : displayName(state.me) }),
        el("time", { class: "timestamp", text: failed.pending ? "Sending…" : "Not delivered" }),
      ]),
    );
    item.append(el("div", { class: "message-content", text: failed.args.content }));
    if (!failed.pending) {
      item.append(
        el("div", { class: "failed-hint" }, [
          `${failed.error} `,
          el("button", { text: "Retry", attrs: { type: "button" }, on: { click: () => void this.sendArgs(failed.args, failed.key, failed) } }),
          " · ",
          el("button", {
            text: "Discard",
            attrs: { type: "button" },
            on: {
              click: () => {
                this.failed = this.failed.filter((f) => f !== failed);
                this.render();
              },
            },
          }),
        ]),
      );
    }
    return item;
  }

  // ---- composer -----------------------------------------------------------------------------

  sendBlocker() {
    const perms = this.perms;
    if (this.isDm) return undefined;
    if (this.isThread) {
      if (this.channel.thread_metadata?.locked && !has(perms, P.MANAGE_THREADS)) return "This thread is locked.";
      if (!has(perms, P.SEND_MESSAGES_IN_THREADS)) return "You do not have permission to send messages in this thread.";
      return undefined;
    }
    if (!has(perms, P.SEND_MESSAGES)) return "You do not have permission to send messages in this channel.";
    return undefined;
  }

  buildComposer() {
    const previous = this.textarea?.value ?? "";
    const focused = document.activeElement === this.textarea;
    this.composerWrap.replaceChildren();
    const blocker = this.sendBlocker();
    if (blocker) {
      this.textarea = undefined;
      this.composerWrap.append(el("div", { class: "composer disabled", attrs: { "aria-disabled": "true" } }, el("div", { class: "composer-disabled", text: blocker })), el("div", { class: "composer-foot" }));
      return;
    }
    if (this.reply) {
      const bar = el("div", { class: "composer-bar" }, [el("span", {}, ["Replying to ", el("strong", { text: this.data ? memberName(this.data, this.reply.message.author.id, this.reply.message.author) : displayName(this.reply.message.author) })])]);
      const actions = el("div", { class: "actions" });
      if (this.reply.message.author.id !== state.me.id) {
        const toggle = el("button", {
          class: `mention-toggle ${this.reply.ping ? "" : "off"}`,
          attrs: { type: "button", "aria-pressed": String(this.reply.ping), "data-tooltip": this.reply.ping ? "Click to disable pinging the original author." : "Click to enable pinging the original author." },
          on: {
            click: () => {
              this.reply.ping = !this.reply.ping;
              this.buildComposer();
            },
          },
        }, [icon("at", 16), this.reply.ping ? "On" : "Off"]);
        actions.append(toggle);
      }
      actions.append(iconButton("close", "Cancel Reply", () => this.cancelReply(), { size: 16, class: "reply-close" }));
      bar.append(actions);
      this.composerWrap.append(bar);
    }
    const textarea = el("textarea", { attrs: { rows: "1", "aria-label": `Message ${this.label()}`, placeholder: `Message ${this.label()}`, maxlength: "4000", spellcheck: "true" } });
    textarea.value = previous;
    this.textarea = textarea;
    const count = el("div", { class: "char-count", attrs: { "aria-live": "polite" } });
    const resize = () => {
      textarea.style.height = "44px";
      textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.5)}px`;
      const left = 2000 - textarea.value.length;
      count.textContent = left < 200 ? String(left) : "";
      count.classList.toggle("over", left < 0);
    };
    textarea.addEventListener("input", resize);
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send();
      } else if (event.key === "Escape" && this.reply) {
        event.preventDefault();
        this.cancelReply();
      } else if (event.key === "ArrowUp" && textarea.value === "") {
        const last = [...this.messages].reverse().find((m) => m.author.id === state.me.id && (m.type === 0 || m.type === 19));
        if (last) {
          event.preventDefault();
          this.startEdit(last);
        }
      }
    });
    const attach = el("button", { class: "attach", attrs: { type: "button", "aria-disabled": "true", "aria-label": "Upload a File", "data-tooltip": "Uploads aren't available in this simulation" } }, icon("plus_circle", 24));
    const insertEmoji = (emoji) => {
      closeLayer();
      const insert = emoji.id ? `<:${emoji.name}:${emoji.id}>` : emoji.name;
      const start = textarea.selectionStart ?? textarea.value.length;
      textarea.value = `${textarea.value.slice(0, start)}${insert}${textarea.value.slice(textarea.selectionEnd ?? start)}`;
      textarea.focus();
      resize();
    };
    // Gift, GIF, Sticker, Emoji. The three expression buttons open one picker above the composer on their tab.
    const tools = el("div", { class: "composer-tools" });
    const expressionButton = (glyph, label, tab) => {
      const button = el("button", { class: `composer-${tab}`, attrs: { type: "button", "aria-label": label, "aria-haspopup": "dialog" } }, icon(glyph, 24));
      button.addEventListener("click", () => {
        if (layerAnchor() === tools && this.expressionTab === tab) return closeLayer();
        this.expressionTab = tab;
        openEmojiPicker(tools, this.data, insertEmoji, "top-end", tab);
      });
      return button;
    };
    const gift = el("button", { class: "composer-gift", attrs: { type: "button", "aria-label": "Send a gift", "aria-haspopup": "dialog" } }, icon("gift", 24));
    gift.addEventListener("click", () => openGift());
    tools.append(gift, expressionButton("gif", "Open GIF picker", "gifs"), expressionButton("sticker", "Open sticker picker", "stickers"), expressionButton("emoji", "Select emoji", "emoji"));
    this.composerWrap.append(el("div", { class: "composer" }, [attach, textarea, tools]), count, (this.foot = el("div", { class: "composer-foot" })));
    requestAnimationFrame(resize);
    if (focused) textarea.focus();
  }

  startReply(message) {
    this.reply = { message, ping: true };
    this.buildComposer();
    this.textarea?.focus();
  }
  cancelReply() {
    this.reply = undefined;
    this.buildComposer();
    this.textarea?.focus();
  }

  async send() {
    if (!this.textarea || this.sending) return;
    const text = this.textarea.value;
    if (!text.trim()) return;
    if (text.length > 2000) {
      this.foot.textContent = "Your message can be at most 2000 characters.";
      this.foot.classList.add("error");
      return;
    }
    const args = { channel_id: this.channel.id, content: text, nonce: nonce(), enforce_nonce: true };
    if (this.reply) {
      args.message_reference = { message_id: this.reply.message.id, channel_id: this.channel.id, fail_if_not_exists: false };
      args.allowed_mentions = { parse: ["users", "roles", "everyone"], replied_user: this.reply.ping };
    }
    this.textarea.value = "";
    this.textarea.dispatchEvent(new Event("input"));
    this.reply = undefined;
    const entry = { args, key: crypto.randomUUID(), pending: true, afterId: this.messages.at(-1)?.id ?? "0" };
    this.failed.push(entry);
    this.buildComposer();
    this.textarea?.focus();
    await this.sendArgs(args, entry.key, entry);
  }

  /** Send (or retry) one message. The same nonce and idempotency key are reused on retry so a lost response never double-posts. */
  async sendArgs(args, key, entry) {
    this.sending = true;
    entry.pending = true;
    this.render({ stick: true });
    try {
      await call("messages.create", args, { idempotencyKey: key });
      this.failed = this.failed.filter((f) => f !== entry);
      if (this.foot) {
        this.foot.textContent = "";
        this.foot.classList.remove("error");
      }
    } catch (error) {
      entry.pending = false;
      entry.error = error.is("RATE_LIMITED")
        ? "You are being rate limited. Wait a moment, then retry."
        : error.is("SERVICE_UNAVAILABLE")
          ? "The message may not have been delivered."
          : describeError(error);
      if (error.is("RATE_LIMITED")) toast("You are being rate limited.", { error: true });
    } finally {
      this.sending = false;
    }
    await this.refresh();
    if (!entry.pending && this.failed.includes(entry)) {
      // The Tool may have committed the message even though the response was lost: the refreshed history is authoritative.
      const delivered = this.messages.find((m) => m.author.id === state.me.id && m.content === entry.args.content && compareIds(m.id, entry.afterId) > 0);
      if (delivered) {
        this.failed = this.failed.filter((f) => f !== entry);
        toast("The response was lost, but your message was delivered.");
      }
    }
    this.render({ stick: true });
  }

  startEdit(message) {
    this.editing = message.id;
    this.render();
    const box = this.list.querySelector(".edit-box textarea");
    box?.focus();
    box?.setSelectionRange(box.value.length, box.value.length);
  }

  editBox(message) {
    const textarea = el("textarea", { attrs: { "aria-label": "Edit message", rows: "1" } });
    textarea.value = message.content;
    const autosize = () => {
      textarea.style.height = "44px";
      textarea.style.height = `${textarea.scrollHeight}px`;
    };
    requestAnimationFrame(autosize);
    textarea.addEventListener("input", autosize);
    const cancel = () => {
      this.editing = undefined;
      this.render();
    };
    const save = async () => {
      const value = textarea.value;
      if (value === message.content) return cancel();
      if (!value.trim() && !message.embeds.length) {
        this.editing = undefined;
        return void this.deleteMessage(message);
      }
      textarea.disabled = true;
      try {
        await call("messages.edit", { channel_id: this.channel.id, message_id: message.id, content: value }, { mutation: true });
        this.editing = undefined;
      } catch (error) {
        textarea.disabled = false;
        toast(describeError(error), { error: true });
        return;
      }
      await this.reloadMessage(message.id);
    };
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void save();
      }
    });
    return el("div", { class: "edit-box" }, [
      textarea,
      el("div", { class: "edit-hint" }, ["escape to ", el("button", { text: "cancel", attrs: { type: "button" }, on: { click: cancel } }), " • enter to ", el("button", { text: "save", attrs: { type: "button" }, on: { click: () => void save() } })]),
    ]);
  }

  async deleteMessage(message) {
    const preview = el("ol", { class: "messages modal-preview" }, this.messageNode({ ...message, reactions: [], thread: undefined }, undefined));
    const ok = await confirmModal({ title: "Delete Message", text: "Are you sure you want to delete this message?", confirm: "Delete", preview });
    if (!ok) {
      this.render();
      return;
    }
    try {
      await call("messages.delete", { channel_id: this.channel.id, message_id: message.id }, { mutation: true });
      this.messages = this.messages.filter((m) => m.id !== message.id);
    } catch (error) {
      toast(describeError(error), { error: true });
    }
    await this.refresh();
  }
}

/** Compact relative time against world time, like the thread chip's "3d ago". */
function ago(ms) {
  const minutes = Math.max(0, Math.floor((state.nowMs - ms) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 43200) return `${Math.floor(minutes / 1440)}d ago`;
  return `${Math.floor(minutes / 43200)}mo ago`;
}

function copy(text, done) {
  navigator.clipboard?.writeText(text).then(
    () => toast(done),
    () => toast("Copying isn't allowed in this browser.", { error: true }),
  );
}

// ---------------------------------------------------------------------------------------------
// Message markup (Discord markdown subset, rendered as DOM nodes)
// ---------------------------------------------------------------------------------------------

const TOKEN = /(```[\s\S]*?```|`[^`\n]+`|<@!?[0-9]{1,20}>|<@&[0-9]{1,20}>|<#[0-9]{1,20}>|<a?:[A-Za-z0-9_]{2,32}:[0-9]{1,20}>|@everyone|@here|https?:\/\/[^\s<]+[^\s<.,:;"')\]]|\*\*[^*\n]+\*\*|(?<![A-Za-z0-9_])__[^_\n]+__(?![A-Za-z0-9_])|~~[^~\n]+~~|\*[^*\s][^*\n]*\*|(?<![A-Za-z0-9_])_[^_\n]+_(?![A-Za-z0-9_]))/g;

function renderMarkdown(parent, text, data, message) {
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    parent.append(tokenNode(match[0], data, message));
    last = match.index + match[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function tokenNode(token, data, message) {
  if (token.startsWith("```")) {
    const body = token.slice(3, -3).replace(/^[a-z0-9+-]*\n/i, "");
    return el("pre", {}, el("code", { text: body }));
  }
  if (token.startsWith("`")) return el("code", { class: "inline", text: token.slice(1, -1) });
  if (token.startsWith("<@&")) {
    const id = token.slice(3, -1);
    const role = data?.roles.find((r) => r.id === id);
    const node = el("span", { class: "mention", text: `@${role?.name ?? "unknown-role"}` });
    if (role?.color) {
      node.style.color = roleColour(role.color);
      node.style.background = `${roleColour(role.color)}1a`;
    }
    return node;
  }
  if (token.startsWith("<@")) {
    const id = token.replace(/[<@!>]/g, "");
    const user = message.mentions.find((u) => u.id === id);
    const node = el("span", { class: "mention", text: `@${user ? (data ? memberName(data, id, user) : displayName(user)) : "Unknown User"}`, attrs: { role: "button", tabindex: "0" } });
    if (user) node.addEventListener("click", () => openProfile(node, user, data));
    return node;
  }
  if (token.startsWith("<#")) {
    const id = token.slice(2, -1);
    const channel = data?.channels.find((c) => c.id === id);
    const node = el("span", { class: "mention", attrs: { role: "button", tabindex: "0" } }, [icon(channel ? channelIcon(data, channel) : "hash", 16), channel?.name ?? "unknown"]);
    node.style.display = "inline-flex";
    node.style.alignItems = "center";
    node.style.gap = "2px";
    node.style.verticalAlign = "bottom";
    if (channel) node.addEventListener("click", () => navigate(data.guild.id, channel.id));
    return node;
  }
  if (token.startsWith("<:") || token.startsWith("<a:")) {
    const [, name, id] = /^<a?:([^:]+):([0-9]+)>$/.exec(token) ?? [];
    return emojiNode({ id, name });
  }
  if (token === "@everyone" || token === "@here") return el("span", { class: "mention", text: token });
  if (token.startsWith("http")) return el("span", { class: "link", text: token, title: `Links open outside this simulation: ${token}` });
  if (token.startsWith("**")) return el("strong", { text: token.slice(2, -2) });
  if (token.startsWith("__")) return el("u", { text: token.slice(2, -2) });
  if (token.startsWith("~~")) return el("s", { text: token.slice(2, -2) });
  return el("em", { text: token.slice(1, -1) });
}

function embedNode(embed) {
  const node = el("article", { class: "embed" });
  if (typeof embed.color === "number") node.style.borderLeftColor = roleColour(embed.color) || "#1e1f22";
  if (embed.author?.name) node.append(el("div", { class: "embed-author", text: embed.author.name }));
  if (embed.title) node.append(el("div", { class: `embed-title ${embed.url ? "link" : ""}`, text: embed.title }));
  if (embed.description) node.append(el("div", { class: "embed-description", text: embed.description }));
  if (embed.fields?.length) {
    const fields = el("div", { class: "embed-fields" });
    for (const field of embed.fields) {
      fields.append(el("div", { class: `embed-field ${field.inline ? "inline" : ""}` }, [el("div", { class: "embed-field-name", text: field.name }), el("div", { class: "embed-field-value", text: field.value })]));
    }
    node.append(fields);
  }
  if (embed.footer?.text || embed.timestamp) {
    const parts = [embed.footer?.text, embed.timestamp ? messageStamp(parseTime(embed.timestamp), state.nowMs) : undefined].filter(Boolean);
    node.append(el("div", { class: "embed-footer", text: parts.join(" • ") }));
  }
  return node;
}

// ---------------------------------------------------------------------------------------------
// Emoji picker
// ---------------------------------------------------------------------------------------------

const EMOJI_NAMES = {
  "👍": "thumbsup", "❤️": "heart", "😂": "joy", "🎉": "tada", "🔥": "fire", "👀": "eyes", "✅": "white_check_mark", "🙏": "pray",
  "😀": "grinning", "😃": "smiley", "😄": "smile", "😁": "grin", "😆": "laughing", "😅": "sweat_smile", "🤣": "rofl", "😊": "blush",
  "😇": "innocent", "🙂": "slight_smile", "😉": "wink", "😍": "heart_eyes", "🥰": "smiling_face_with_hearts", "😘": "kissing_heart",
  "😎": "sunglasses", "🤔": "thinking", "😐": "neutral_face", "😬": "grimacing", "😴": "sleeping", "😭": "sob", "😡": "rage",
  "🤯": "exploding_head", "🥳": "partying_face", "👋": "wave", "👏": "clap", "🙌": "raised_hands", "💪": "muscle", "🤝": "handshake",
  "💡": "bulb", "🔧": "wrench", "🔩": "nut_and_bolt", "⚙️": "gear", "🔌": "electric_plug", "🔋": "battery", "💻": "computer",
  "🖥️": "desktop", "📦": "package", "📌": "pushpin", "📎": "paperclip", "📝": "pencil", "📷": "camera", "🧪": "test_tube",
  "🛠️": "tools", "⏰": "alarm_clock", "✔️": "heavy_check_mark", "❌": "x", "⚠️": "warning", "❓": "question", "❗": "exclamation",
  "💯": "100", "⭐": "star", "✨": "sparkles", "💬": "speech_balloon", "➕": "heavy_plus_sign", "➖": "heavy_minus_sign", "🔁": "repeat",
};

const EXPRESSION_TABS = [
  ["gifs", "GIFs"],
  ["stickers", "Stickers"],
  ["emoji", "Emoji"],
];
const EXPRESSION_EMPTY = {
  gifs: ["gif", "Search GIFs", "GIFs aren't simulated by this Tool."],
  stickers: ["sticker", "Search stickers", "Stickers aren't simulated by this Tool."],
};

/** Emoji picker. Opened from the composer (`initialTab`) it is the expression picker with GIFs and Stickers tabs, which are not simulated. */
function openEmojiPicker(anchor, data, onPick, placement = "left-start", initialTab) {
  const search = el("input", { class: "input", attrs: { type: "search", placeholder: "Find the perfect emoji", "aria-label": "Search emoji" } });
  const bodyNode = el("div", { class: "emoji-picker-body" });
  const preview = el("span", { class: "preview", text: "👍" });
  const previewName = el("span", { text: ":thumbsup:" });
  const hover = (emoji) => {
    preview.textContent = emoji.id ? "" : emoji.name;
    previewName.textContent = emoji.id ? `:${emoji.name}:` : `:${EMOJI_NAMES[emoji.name] ?? "emoji"}:`;
  };
  const draw = () => {
    const query = search.value.trim().toLowerCase().replace(/:/g, "");
    bodyNode.replaceChildren();
    const sections = [];
    const custom = (data?.guild.emojis ?? []).filter((e) => e.available !== false).map((e) => ({ id: e.id, name: e.name }));
    if (custom.length) sections.push([data.guild.name, custom]);
    for (const [title, list] of PICKER_EMOJI) sections.push([title, list.map((name) => ({ id: null, name }))]);
    let shown = 0;
    for (const [title, list] of sections) {
      const matches = list.filter((emoji) => !query || (emoji.id ? emoji.name.toLowerCase() : EMOJI_NAMES[emoji.name] ?? "").includes(query));
      if (!matches.length) continue;
      const grid = el("div", { class: "emoji-grid" });
      for (const emoji of matches) {
        shown += 1;
        const cell = el("button", { class: `emoji-cell ${emoji.id ? "custom" : ""}`, attrs: { type: "button", "aria-label": emoji.id ? `:${emoji.name}:` : `:${EMOJI_NAMES[emoji.name] ?? emoji.name}:` } }, emojiNode(emoji));
        cell.addEventListener("click", () => onPick(emoji));
        cell.addEventListener("mouseenter", () => hover(emoji));
        cell.addEventListener("focus", () => hover(emoji));
        grid.append(cell);
      }
      bodyNode.append(el("div", { class: "emoji-cat", text: title }), grid);
    }
    if (!shown) bodyNode.append(el("div", { class: "sidebar-empty", text: "No emoji match your search." }));
  };
  search.addEventListener("input", draw);
  const emojiPanel = [el("div", { class: "emoji-picker-head" }, search), bodyNode, el("div", { class: "emoji-picker-foot" }, [preview, previewName])];
  if (!initialTab) {
    draw();
    popout(anchor, el("div", { class: "emoji-picker" }, emojiPanel), { placement });
    search.focus();
    return;
  }
  let tab = initialTab;
  const tabs = el("div", { class: "expression-tabs", attrs: { role: "tablist", "aria-label": "Expression picker" } });
  const panel = el("div", { class: "expression-panel", attrs: { role: "tabpanel" } });
  const show = () => {
    tabs.replaceChildren(
      ...EXPRESSION_TABS.map(([id, label]) =>
        el("button", {
          class: `expression-tab ${id === tab ? "selected" : ""}`,
          text: label,
          attrs: { type: "button", role: "tab", "aria-selected": String(id === tab) },
          on: {
            click: () => {
              tab = id;
              show();
              (tab === "emoji" ? search : tabs.querySelector(".selected"))?.focus();
            },
          },
        }),
      ),
    );
    if (tab === "emoji") {
      draw();
      panel.replaceChildren(...emojiPanel);
      return;
    }
    const [glyph, placeholder, text] = EXPRESSION_EMPTY[tab];
    panel.replaceChildren(
      el("div", { class: "emoji-picker-head" }, el("input", { class: "input", attrs: { type: "search", placeholder, "aria-label": placeholder, disabled: true } })),
      el("div", { class: "expression-empty" }, [el("div", { class: "empty-art small" }, icon(glyph, 40)), el("p", { text })]),
    );
  };
  show();
  popout(anchor, el("div", { class: "emoji-picker expression-picker" }, [tabs, panel]), { placement });
  if (tab === "emoji") search.focus();
}

// ---------------------------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------------------------

function closeSide() {
  state.side = undefined;
  const host = document.getElementById("side-host");
  host?.replaceChildren();
  host?.parentElement?.classList.remove("has-side");
}

function sidePanel(children) {
  const host = document.getElementById("side-host");
  if (!host) return undefined;
  const panel = el("section", { class: "side-panel", attrs: { "aria-label": "Thread" } }, children);
  host.replaceChildren(panel);
  host.parentElement?.classList.add("has-side");
  return panel;
}

async function openThreadById(data, threadId) {
  try {
    const thread = await call("channels.get", { channel_id: threadId });
    openThreadSide(data, thread);
  } catch (error) {
    toast(describeError(error), { error: true });
  }
}

function openThreadSide(data, thread) {
  if (!document.getElementById("side-host")) return navigate(data.guild.id, thread.id);
  const chat = new Chat({ channel: thread, data, mode: "side" });
  state.side = { kind: "thread", chat };
  sidePanel([chat.header, chat.root]);
  void chat.load();
}

function openThreadsPopout(anchor, chat) {
  const data = chat.data;
  const channel = chat.isThread ? data.channels.find((c) => c.id === chat.channel.parent_id) : chat.channel;
  const threads = data.threads.filter((t) => t.parent_id === channel.id);
  const canCreate = has(channelPerms(data, channel), P.CREATE_PUBLIC_THREADS) || has(channelPerms(data, channel), P.CREATE_PRIVATE_THREADS);
  const list = el("div", { class: "threads-list" });
  const head = el("div", { class: "threads-head" }, [icon("threads", 24), el("span", { class: "grow", text: "Threads" })]);
  if (canCreate && state.main) {
    head.append(el("button", { class: "btn btn-sm btn-primary", text: "Create", attrs: { type: "button" }, on: { click: () => (closeLayer(), openNewThread(state.main)) } }));
  }
  head.append(iconButton("close", "Close", () => closeLayer()));
  if (!threads.length) {
    list.append(el("div", { class: "pane-state" }, [icon("threads", 64), el("h2", { text: "There are no threads." }), el("p", { text: "Stay focused on a conversation with a thread - a temporary text channel." })]));
  } else {
    list.append(el("div", { class: "threads-heading", text: `${threads.length} Active Thread${threads.length === 1 ? "" : "s"}` }));
    for (const thread of threads) {
      const meta = el("span", { class: "t-meta" }, [
        el("span", { text: memberName(data, thread.owner_id) }),
        "·",
        el("span", { text: `${thread.message_count} message${thread.message_count === 1 ? "" : "s"}` }),
        thread.last_message_id ? el("span", { text: `· ${messageStamp(snowflakeMs(thread.last_message_id), state.nowMs)}` }) : null,
        thread.thread_metadata.locked ? el("span", { class: "tag", text: "Locked" }) : null,
        thread.type === 12 ? el("span", { class: "tag", text: "Private" }) : null,
      ]);
      list.append(
        el("button", { class: "thread-card", attrs: { type: "button" }, on: { click: () => (closeLayer(), openThreadSide(data, thread)) } }, [el("span", { class: "t-name", text: thread.name }), meta]),
      );
    }
  }
  popout(anchor, el("div", { class: "threads-popout" }, [head, list]), { placement: "bottom-end", toggle: true });
}

/** "New Thread" side panel: from a message (threads.create-from-message) or standalone (threads.create). */
function openNewThread(chat, message) {
  const data = chat.data;
  const channel = chat.channel;
  const perms = channelPerms(data, channel);
  const header = el("header", { class: "chat-header" }, [icon("threads", 24, "title-icon"), el("h1", { class: "title", text: "New Thread" }), el("div", { class: "header-tools" }, iconButton("close", "Close", () => closeSide()))]);
  const form = el("form", { class: "side-form" });
  const nameInput = el("input", { class: "input", attrs: { id: "thread-name", maxlength: "100", required: true, placeholder: message ? "" : "New Thread", autocomplete: "off" } });
  if (message?.content) nameInput.value = message.content.replace(/<[@#&!:a-z0-9_]+>/gi, "").replace(/\s+/g, " ").trim().slice(0, 40);
  const archive = el("select", { class: "select", attrs: { id: "thread-archive" } }, [
    el("option", { text: "1 Hour", attrs: { value: "60" } }),
    el("option", { text: "24 Hours", attrs: { value: "1440" } }),
    el("option", { text: "3 Days", attrs: { value: "4320", selected: true } }),
    el("option", { text: "1 Week", attrs: { value: "10080" } }),
  ]);
  const privateBox = el("input", { attrs: { type: "checkbox", id: "thread-private", disabled: !has(perms, P.CREATE_PRIVATE_THREADS) } });
  const first = el("textarea", { class: "input", attrs: { id: "thread-first", rows: "3", maxlength: "2000", placeholder: "Enter a message to start the conversation!" } });
  first.style.height = "auto";
  first.style.resize = "vertical";
  const error = el("div", { class: "form-error", attrs: { role: "alert" } });
  const submit = el("button", { class: "btn btn-primary", text: "Create Thread", attrs: { type: "submit" } });
  const hero = el("div", { class: "side-hero" }, [el("div", { class: "hero-icon" }, icon("threads", 36))]);
  if (message) {
    form.append(el("ol", { class: "messages modal-preview" }, chat.messageNode({ ...message, reactions: [], thread: undefined }, undefined)));
  }
  form.append(
    el("div", { class: "field" }, [el("label", { class: "field-label", text: "Thread Name", attrs: { for: "thread-name" } }, el("span", { class: "req", text: "*" })), nameInput]),
    el("div", { class: "field" }, [el("label", { class: "field-label", text: "Archive After Inactivity", attrs: { for: "thread-archive" } }), archive]),
  );
  if (!message) {
    form.append(
      el("label", { class: "checkbox-row", attrs: { for: "thread-private" } }, [
        privateBox,
        el("span", {}, [el("div", { class: "title", text: "Private Thread" }), el("div", { class: "field-hint", text: has(perms, P.CREATE_PRIVATE_THREADS) ? "Only people you invite and moderators can see this thread." : "You don't have permission to create private threads here." })]),
      ]),
    );
  }
  form.append(el("div", { class: "field" }, [el("label", { class: "field-label", text: "Starter Message", attrs: { for: "thread-first" } }), first]), error, el("div", {}, submit));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      error.textContent = "Thread name is required.";
      return;
    }
    submit.disabled = true;
    error.textContent = "";
    let thread;
    try {
      thread = message
        ? await call("threads.create-from-message", { channel_id: channel.id, message_id: message.id, name, auto_archive_duration: Number(archive.value) }, { mutation: true })
        : await call("threads.create", { channel_id: channel.id, name, auto_archive_duration: Number(archive.value), type: privateBox.checked ? 12 : 11 }, { mutation: true });
    } catch (failure) {
      submit.disabled = false;
      error.textContent = failure.is("THREAD_ALREADY_CREATED") ? "A thread has already been created for this message." : describeError(failure);
      return;
    }
    if (first.value.trim()) {
      try {
        await call("messages.create", { channel_id: thread.id, content: first.value, nonce: nonce(), enforce_nonce: true }, { mutation: true });
      } catch (failure) {
        toast(`Thread created, but the first message failed: ${describeError(failure)}`, { error: true });
      }
    }
    await loadGuildData(data.guild.id, true);
    const fresh = state.guildData.get(data.guild.id);
    renderSidebar();
    if (state.main) {
      state.main.data = fresh;
      await state.main.refresh();
    }
    openThreadSide(fresh, thread);
  });
  state.side = { kind: "new-thread" };
  sidePanel([header, hero, form]);
  nameInput.focus();
}

// ---------------------------------------------------------------------------------------------
// Member list and profiles
// ---------------------------------------------------------------------------------------------

async function fetchMembers(guildId, more = false) {
  let entry = state.members.get(guildId);
  if (!entry || (!more && entry.error)) {
    entry = { list: [], after: "0", done: false, error: undefined };
    state.members.set(guildId, entry);
  }
  if (entry.done && !more) return entry;
  if (!more && entry.list.length) return entry;
  try {
    const result = await call("guild-members.list", { guild_id: guildId, limit: MEMBER_PAGE, after: entry.after });
    entry.list.push(...result.members);
    entry.after = result.members.at(-1)?.user.id ?? entry.after;
    entry.done = !mayHaveMore(result.members, MEMBER_PAGE);
  } catch (error) {
    entry.error = error;
  }
  return entry;
}

async function renderMembers(more = false) {
  const guildId = state.route.guildId;
  const data = state.guildData.get(guildId);
  const pane = document.getElementById("members");
  if (!data || !pane) return;
  const entry = await fetchMembers(guildId, more);
  if (state.route.guildId !== guildId || !document.getElementById("members")) return;
  pane.replaceChildren();
  if (entry.error) {
    pane.append(el("div", { class: "members-empty", text: entry.error.denied ? "You don't have permission to view the member list." : describeError(entry.error) }));
    return;
  }
  const hoisted = data.roles.filter((r) => r.hoist).sort((a, b) => b.position - a.position);
  const groups = new Map(hoisted.map((r) => [r.id, []]));
  const rest = [];
  for (const member of entry.list) {
    const top = hoisted.find((r) => member.roles.includes(r.id));
    (top ? groups.get(top.id) : rest).push(member);
  }
  const byName = (a, b) => (a.nick || displayName(a.user)).localeCompare(b.nick || displayName(b.user));
  const section = (title, members) => {
    if (!members.length) return;
    pane.append(el("h3", { class: "member-group", text: `${title} — ${members.length}` }));
    for (const member of members.sort(byName)) pane.append(memberRow(data, member));
  };
  for (const role of hoisted) section(role.name, groups.get(role.id));
  section("Members", rest);
  if (!entry.done) pane.append(el("button", { class: "btn btn-secondary btn-sm more-btn", text: "Load more members", attrs: { type: "button" }, on: { click: () => void renderMembers(true) } }));
  if (state.main && !state.main.loading && !state.main.editing) state.main.render();
}

function memberRow(data, member) {
  const role = roleFor(data, member.user.id, member);
  const name = el("span", { class: "name", text: member.nick || displayName(member.user) });
  if (role) name.style.color = roleColour(role.color);
  const line = el("span", { class: "name-line" }, [name, member.user.bot ? el("span", { class: "bot-tag", text: "APP" }) : null]);
  const text = el("span", { class: "member-text" }, [line, member.pending ? el("span", { class: "sub", text: "Pending membership screening" }) : null]);
  const row = el("button", { class: "member", attrs: { type: "button" } }, [avatar(member.user, 32), text]);
  row.addEventListener("click", () => openProfile(row, member.user, data, "left-start"));
  return row;
}

async function openProfile(anchor, user, data, placement = "right-start") {
  const banner = el("div", { class: "profile-banner" });
  banner.style.background = AVATAR_COLOURS[avatarIndex(user.id)];
  const body = el("div", { class: "profile-body" }, [el("div", { class: "sidebar-empty", text: "Loading…" })]);
  const card = el("div", { class: "profile" }, [banner, el("div", { class: "profile-avatar" }, avatar(user, 80)), body]);
  popout(anchor, card, { placement });
  let member;
  let memberError;
  if (data) {
    try {
      member = await call("guild-members.get", { guild_id: data.guild.id, user_id: user.id });
    } catch (error) {
      memberError = error;
    }
  }
  let fullUser = user;
  try {
    fullUser = await call("users.get", { user_id: user.id === state.me.id ? "@me" : user.id });
  } catch {
    fullUser = user;
  }
  body.replaceChildren(
    el("div", {}, [
      el("div", { class: "profile-name" }, [el("span", { text: member?.nick || displayName(fullUser) }), fullUser.bot ? el("span", { class: "bot-tag", text: "APP" }) : null]),
      el("div", { class: "profile-username", text: fullUser.username }),
    ]),
    el("div", { class: "profile-divider" }),
    el("div", { class: "profile-section" }, [
      el("h4", { text: "Member Since" }),
      el("p", {}, [el("img", { class: "since-mark", attrs: { src: "./assets/discord.svg", alt: "Discord" } }), shortDate(snowflakeMs(fullUser.id)), member ? el("span", { text: "•" }) : null, member ? el("span", { text: `${shortDate(parseTime(member.joined_at))} in ${data.guild.name}` }) : null]),
    ]),
  );
  if (member) {
    const roles = data.roles.filter((r) => member.roles.includes(r.id)).sort((a, b) => b.position - a.position);
    body.append(el("div", { class: "profile-section" }, [el("h4", { text: roles.length === 1 ? "Role" : "Roles" }), roles.length ? roleChips(roles) : el("p", { text: "No roles" })]));
  } else if (memberError && !memberError.is("UNKNOWN_MEMBER")) {
    body.append(el("div", { class: "form-error", text: describeError(memberError) }));
  }
  if (fullUser.id !== state.me.id) {
    const message = el("button", { class: "btn btn-primary btn-sm", text: `Message @${fullUser.username}`, attrs: { type: "button" } });
    message.addEventListener("click", () => void openDm(fullUser.id, message));
    body.append(message);
  }
}

async function openDm(userId, button) {
  if (button) button.disabled = true;
  try {
    const dm = await call("users.create-dm", { user_id: "@me", recipient_id: userId }, { mutation: true });
    await loadDms();
    closeLayer();
    navigate("@me", dm.id);
  } catch (error) {
    if (button) button.disabled = false;
    toast(describeError(error), { error: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Quick switcher: find or start a conversation
// ---------------------------------------------------------------------------------------------

function openQuickSwitcher() {
  modal({
    title: "Find or start a conversation",
    className: "quick-switcher",
    build: (body) => {
      const input = el("input", { class: "input qs-input", attrs: { type: "text", placeholder: "Where would you like to go?", "aria-label": "Search people and channels", autofocus: true, autocomplete: "off" } });
      const list = el("div", { class: "qs-list", attrs: { role: "listbox" } });
      body.append(input, list, el("div", { class: "qs-tip" }, [el("strong", { text: "Protip: " }), "Pick a person you share a server with to open a direct message."]));
      let people = [];
      let error;
      let active = 0;
      const draw = () => {
        const query = input.value.trim().toLowerCase().replace(/^@/, "");
        list.replaceChildren();
        list.items = [];
        if (error) {
          list.append(el("div", { class: "form-error", text: describeError(error) }));
          return;
        }
        const matches = people.filter(({ user }) => !query || user.username.toLowerCase().includes(query) || displayName(user).toLowerCase().includes(query)).slice(0, 30);
        const channels = [];
        for (const data of state.guildData.values()) {
          for (const channel of data.channels) {
            if ((channel.type === 0 || channel.type === 5) && has(channelPerms(data, channel), P.VIEW_CHANNEL) && (!query || channel.name.includes(query))) channels.push({ data, channel });
          }
        }
        if (!matches.length && !channels.length) {
          list.append(el("div", { class: "sidebar-empty", text: people.length ? "No results found." : "Loading…" }));
          return;
        }
        const items = [];
        if (matches.length) list.append(el("div", { class: "qs-heading", text: "People" }));
        for (const { user, where } of matches) {
          const item = el("button", { class: "qs-item", attrs: { type: "button", role: "option" } }, [avatar(user, 20), el("span", { text: displayName(user) }), el("span", { class: "uname", text: user.username }), el("span", { class: "where", text: where })]);
          item.addEventListener("click", () => void openDm(user.id, item));
          list.append(item);
          items.push(item);
        }
        if (channels.length) list.append(el("div", { class: "qs-heading", text: "Text Channels" }));
        for (const { data, channel } of channels.slice(0, 10)) {
          const item = el("button", { class: "qs-item", attrs: { type: "button", role: "option" } }, [icon(channelIcon(data, channel), 20), el("span", { text: channel.name }), el("span", { class: "where", text: data.guild.name })]);
          item.addEventListener("click", () => {
            closeLayer();
            navigate(data.guild.id, channel.id);
          });
          list.append(item);
          items.push(item);
        }
        active = Math.min(active, items.length - 1);
        items[active]?.classList.add("active");
        list.items = items;
      };
      input.addEventListener("input", () => {
        active = 0;
        draw();
      });
      input.addEventListener("keydown", (event) => {
        const items = list.items ?? [];
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          active = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(items.length, 1);
          items.forEach((item, i) => item.classList.toggle("active", i === active));
        } else if (event.key === "Enter") {
          event.preventDefault();
          items[active]?.click();
        }
      });
      draw();
      void (async () => {
        const seen = new Map();
        try {
          for (const guild of state.guilds) {
            let after = "0";
            // Page to the end of every guild (no page cap); pages are bounded by count and by response size.
            for (;;) {
              const result = await call("guild-members.list", { guild_id: guild.id, limit: 1000, after });
              for (const member of result.members) {
                if (member.user.id !== state.me.id && !seen.has(member.user.id)) seen.set(member.user.id, { user: member.user, where: guild.name });
              }
              if (!mayHaveMore(result.members, 1000)) break;
              after = result.members.at(-1).user.id;
            }
          }
        } catch (failure) {
          error = failure;
        }
        people = [...seen.values()].sort((a, b) => displayName(a.user).localeCompare(displayName(b.user)));
        draw();
      })();
    },
  });
}

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !app.hidden) {
    event.preventDefault();
    openQuickSwitcher();
  }
});

hydrateIcons();
void boot();
