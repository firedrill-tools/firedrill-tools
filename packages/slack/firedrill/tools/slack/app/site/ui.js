// DOM, Firedrill-client, formatting and interaction helpers for the Slack Tool app.
// Every record string reaches the page through textContent; nothing is injected as HTML.
import { getContext, invoke } from "/_firedrill/client.js";
import { icon } from "./icons.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Create an element. `options`: { class, text, title, attrs: {…} }. Text always goes through textContent. */
export function el(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.class) element.className = options.class;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.title !== undefined) element.title = options.title;
  if (options.attrs) for (const [name, value] of Object.entries(options.attrs)) if (value !== undefined && value !== null) element.setAttribute(name, String(value));
  for (const child of Array.isArray(children) ? children : [children]) if (child !== undefined && child !== null && child !== false) element.append(child);
  return element;
}

/** Square icon button with an accessible name; `options.tooltip === false` suppresses the title. */
export function iconButton(name, label, options = {}) {
  const button = el("button", { class: `icon-btn ${options.class ?? ""}`.trim(), title: options.tooltip === false ? undefined : label, attrs: { type: "button", "aria-label": label } });
  button.append(icon(name));
  if (options.onClick) button.addEventListener("click", options.onClick);
  return button;
}

export function textButton(text, options = {}) {
  const button = el("button", { class: `btn ${options.class ?? ""}`.trim(), text, attrs: { type: "button", ...(options.attrs ?? {}) } });
  if (options.onClick) button.addEventListener("click", options.onClick);
  return button;
}

// ---------------------------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------------------------

export class ToolError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
  get denied() {
    return this.status === "denied";
  }
  is(code) {
    return this.code === `tool.${code}` || this.code === code;
  }
}

/** Invoke one Tool operation; throws ToolError for every non-ok outcome. */
export async function call(operationId, args = {}, idempotencyKey) {
  const result = await invoke(operationId, args, idempotencyKey ? { idempotencyKey } : {});
  if (result.outcome.status !== "ok") {
    const error = result.outcome.error ?? {};
    throw new ToolError(result.outcome.status, error.code ?? result.outcome.status, error.message ?? `The operation was ${result.outcome.status}.`);
  }
  return result.outcome.value;
}

export const key = () => crypto.randomUUID();

const ERROR_TEXT = {
  RATELIMITED: "Slack is rate-limiting posts right now (429). Nothing was sent — try again in 30 seconds.",
  SERVICE_UNAVAILABLE: "History is temporarily unavailable (503). Try again in a moment.",
  NOT_IN_CHANNEL: "You're not a member of this conversation.",
  IS_ARCHIVED: "This channel is archived. It can be read but not changed.",
  ALREADY_ARCHIVED: "This channel is already archived.",
  CHANNEL_NOT_FOUND: "That conversation doesn't exist or isn't visible to you.",
  THREAD_NOT_FOUND: "This thread no longer exists — the world may have been reset.",
  MESSAGE_NOT_FOUND: "That message no longer exists.",
  CANT_UPDATE_MESSAGE: "Only the author can edit a message.",
  CANT_DELETE_MESSAGE: "Only the author or a workspace admin can delete this message.",
  ALREADY_REACTED: "You already reacted with that emoji.",
  NO_REACTION: "You haven't reacted with that emoji.",
  TOO_MANY_REACTIONS: "This message already has the maximum number of different reactions (50).",
  INVALID_NAME: "Channel names can only contain lowercase letters, numbers, hyphens, periods and underscores, and must be 80 characters or fewer.",
  NAME_TAKEN: "That name is already taken by a channel or user in this workspace.",
  ALREADY_IN_CHANNEL: "That person is already in the channel.",
  USER_NOT_FOUND: "That person doesn't exist or has been deactivated.",
  CANT_INVITE_SELF: "You can't invite yourself.",
  METHOD_NOT_SUPPORTED_FOR_CHANNEL_TYPE: "That action isn't available for this kind of conversation.",
  ALREADY_PINNED: "That message is already pinned.",
  NOT_PINNED: "That message isn't pinned.",
  NO_TEXT: "Type a message first.",
  NO_QUERY: "Type something to search for.",
  INVALID_CURSOR: "That page is no longer available. Reload the list.",
  INVALID_AUTH: "This actor doesn't resolve to a workspace member (invalid_auth). Its userId attribute names no users row — fix it, or remove it to act as the workspace's first active member.",
};

export function describe(error) {
  if (error instanceof ToolError) {
    if (error.denied) return "You don't have permission to do that in this workspace (missing_scope).";
    if (error.status === "unsupported") return "That operation isn't part of this Tool.";
    if (error.is("INVALID_ARGUMENTS")) return `Slack rejected the request: ${error.message}`;
    const code = error.code.replace(/^tool\./, "");
    return Object.hasOwn(ERROR_TEXT, code) ? ERROR_TEXT[code] : error.message;
  }
  return error?.message ?? "Something went wrong. Reload and try again.";
}

// ---------------------------------------------------------------------------------------------
// One user action at a time
// ---------------------------------------------------------------------------------------------

let pending = 0;
export const isPending = () => pending > 0;

/** Run a user action; a second exclusive action is ignored while one is in flight so a write cannot be submitted twice. */
export async function action(task, { exclusive = true, onError } = {}) {
  if (exclusive && pending > 0) return undefined;
  pending += 1;
  document.documentElement.toggleAttribute("data-busy", true);
  try {
    return await task();
  } catch (error) {
    if (onError) onError(error);
    else toast(describe(error), { error: true });
    return undefined;
  } finally {
    pending -= 1;
    document.documentElement.toggleAttribute("data-busy", pending > 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Toast (bottom-centre notice, the way the client reports "Message sent"/errors)
// ---------------------------------------------------------------------------------------------

let toastTimer;
export function toast(text, { error = false, timeout = 5000 } = {}) {
  const host = $("#toast");
  $("#toast-text").textContent = text;
  host.dataset.error = String(error);
  host.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    host.hidden = true;
  }, timeout);
}

// ---------------------------------------------------------------------------------------------
// Popover menus
// ---------------------------------------------------------------------------------------------

let openMenuElement;
export function closeMenus() {
  if (!openMenuElement) return;
  const anchor = openMenuElement.anchor;
  openMenuElement.remove();
  openMenuElement = undefined;
  if (anchor?.isConnected) {
    anchor.setAttribute("aria-expanded", "false");
    if (!document.activeElement || document.activeElement === document.body) anchor.focus();
  }
}
export const menuOpen = () => Boolean(openMenuElement);

/**
 * Open a menu near `anchor`. `content` is an array of items ({ label, icon?, danger?, disabled?, onSelect, detail? } or
 * "divider") or a prebuilt element. Positioned below (or above) the anchor, aligned start/end, clamped to the window.
 */
export function openMenu(anchor, content, { align = "start", className = "", header, above = false } = {}) {
  closeMenus();
  const menu = el("div", { class: `menu ${className}`.trim(), attrs: { role: "menu" } });
  menu.anchor = anchor;
  if (header) menu.append(el("div", { class: "menu-header", text: header }));
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item === "divider") {
        menu.append(el("div", { class: "menu-divider", attrs: { role: "separator" } }));
        continue;
      }
      const button = el("button", { class: `menu-item ${item.danger ? "danger" : ""}`.trim(), attrs: { type: "button", role: "menuitem" } });
      if (item.icon) button.append(icon(item.icon, "menu-icon"));
      button.append(el("span", { class: "menu-label", text: item.label }));
      if (item.detail) button.append(el("span", { class: "menu-detail", text: item.detail }));
      if (item.disabled) button.disabled = true;
      button.addEventListener("click", () => {
        closeMenus();
        item.onSelect?.();
      });
      menu.append(button);
    }
  } else menu.append(content);
  document.body.append(menu);
  openMenuElement = menu;
  anchor.setAttribute("aria-expanded", "true");
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = align === "end" ? rect.right - width : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = above ? rect.top - height - 6 : rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  if (top < 8) top = Math.min(rect.bottom + 6, window.innerHeight - height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector("input, button:not(:disabled)")?.focus();
  return menu;
}

document.addEventListener("pointerdown", (event) => {
  if (openMenuElement && !openMenuElement.contains(event.target) && !openMenuElement.anchor?.contains(event.target)) closeMenus();
});
document.addEventListener("keydown", (event) => {
  if (!openMenuElement) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenus();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const items = $$(".menu-item:not(:disabled), .emoji-cell", openMenuElement);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next].focus();
    event.preventDefault();
  }
});

// ---------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------

/** Slack-style confirmation modal; resolves true when confirmed. `preview` is an optional element shown above the text. */
export function confirmDialog(title, text, okLabel = "Confirm", { danger = false, preview } = {}) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  const host = $("#confirm-preview");
  host.replaceChildren();
  host.hidden = !preview;
  if (preview) host.append(preview);
  const ok = $("#confirm-ok");
  ok.textContent = okLabel;
  ok.classList.toggle("danger", danger);
  ok.classList.toggle("primary", !danger);
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true }));
}

// ---------------------------------------------------------------------------------------------
// Time (virtual epoch seconds rendered in the acting member's timezone, never the browser clock)
// ---------------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_S = 86_400;

export const tsSeconds = (ts) => Number(String(ts).split(".")[0]);

/** Civil fields of a virtual instant shifted by the member's tz_offset (seconds). */
export function localParts(ts, tzOffset = 0) {
  const shifted = new Date((tsSeconds(ts) + tzOffset) * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    dayIndex: Math.floor((tsSeconds(ts) + tzOffset) / DAY_S),
  };
}

export function ordinal(day) {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th";
  return `${day}${suffix}`;
}

/** "9:30 AM" */
export function clockTime(ts, tzOffset = 0) {
  const { hours, minutes } = localParts(ts, tzOffset);
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

/** Day-divider label the way the client shows it: Today, Yesterday, a weekday within the week, else "Mon, Sep 8th". */
export function dayLabel(ts, nowTs, tzOffset = 0) {
  const parts = localParts(ts, tzOffset);
  const today = localParts(nowTs, tzOffset);
  const diff = today.dayIndex - parts.dayIndex;
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff > 1 && diff < 7) return WEEKDAYS[parts.weekday];
  const base = `${WEEKDAYS[parts.weekday].slice(0, 3)}, ${MONTHS[parts.month]} ${ordinal(parts.day)}`;
  return parts.year === today.year ? base : `${MONTHS[parts.month]} ${ordinal(parts.day)}, ${parts.year}`;
}

/** Full timestamp for tooltips and search results: "Sep 8th, 2026 at 9:30 AM" */
export function fullDate(ts, tzOffset = 0) {
  const parts = localParts(ts, tzOffset);
  return `${MONTHS[parts.month]} ${ordinal(parts.day)}, ${parts.year} at ${clockTime(ts, tzOffset)}`;
}

/** "Created on September 8th, 2026" style date. */
export function longDate(ts, tzOffset = 0) {
  const parts = localParts(ts, tzOffset);
  return `${MONTHS_LONG[parts.month]} ${ordinal(parts.day)}, ${parts.year}`;
}

/** Relative label for "Last reply …": "just now", "5 minutes ago", "2 hours ago", "3 days ago", "1 month ago". */
export function relative(ts, nowTs) {
  const diff = Math.max(0, tsSeconds(nowTs) - tsSeconds(ts));
  const minutes = Math.round(diff / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** Search-result timestamp: "9:30 AM" today, else "Sep 8th" / "Sep 8th, 2025". */
export function shortDate(ts, nowTs, tzOffset = 0) {
  const parts = localParts(ts, tzOffset);
  const today = localParts(nowTs, tzOffset);
  if (parts.dayIndex === today.dayIndex) return clockTime(ts, tzOffset);
  return parts.year === today.year ? `${MONTHS[parts.month]} ${ordinal(parts.day)}` : `${MONTHS[parts.month]} ${ordinal(parts.day)}, ${parts.year}`;
}

// ---------------------------------------------------------------------------------------------
// Emoji (Unicode glyphs from the viewer's system font; unknown names stay as :name: text)
// ---------------------------------------------------------------------------------------------

// A prototype-less map looked up with Object.hasOwn: message text chooses the shortcode, so `:__proto__:` or
// `:constructor:` must miss and stay literal text instead of resolving to inherited members.
export const EMOJI = Object.assign(Object.create(null), {
  "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎", heart: "❤️", tada: "🎉", eyes: "👀", rocket: "🚀",
  white_check_mark: "✅", heavy_check_mark: "✔️", pray: "🙏", joy: "😂", fire: "🔥", wave: "👋", thinking_face: "🤔",
  100: "💯", palm_tree: "🌴", raised_hands: "🙌", clap: "👏", smile: "😄", grinning: "😀", slightly_smiling_face: "🙂",
  sweat_smile: "😅", sob: "😭", cry: "😢", laughing: "😆", wink: "😉", blush: "😊", heart_eyes: "😍", sunglasses: "😎",
  neutral_face: "😐", confused: "😕", scream: "😱", ok_hand: "👌", muscle: "💪", point_up: "☝️", handshake: "🤝",
  bulb: "💡", warning: "⚠️", x: "❌", star: "⭐", sparkles: "✨", zap: "⚡", boom: "💥", coffee: "☕", pizza: "🍕",
  beers: "🍻", cake: "🎂", bug: "🐛", ship: "🚢", package: "📦", memo: "📝", calendar: "📅", chart_with_upwards_trend: "📈",
  hourglass: "⌛", alarm_clock: "⏰", lock: "🔒", key: "🔑", wrench: "🔧", hammer: "🔨", gear: "⚙️", rotating_light: "🚨",
  white_circle: "⚪", large_green_circle: "🟢", red_circle: "🔴", spiral_calendar_pad: "🗓️", speech_balloon: "💬",
  eyes_left: "👀", partying_face: "🥳", hugging_face: "🤗", face_with_monocle: "🧐", saluting_face: "🫡", heavy_plus_sign: "➕",
});
/** The glyph for a shortcode, or undefined when the name is not a known emoji (never an inherited member). */
export const emojiGlyph = (name) => (Object.hasOwn(EMOJI, name) ? EMOJI[name] : undefined);
export const QUICK_REACTIONS = ["white_check_mark", "eyes", "raised_hands"];
export const PICKER_EMOJI = [
  "+1", "heart", "tada", "eyes", "rocket", "white_check_mark", "pray", "joy", "fire", "wave", "thinking_face", "100",
  "raised_hands", "clap", "smile", "sweat_smile", "sob", "laughing", "ok_hand", "muscle", "bulb", "warning", "x", "star",
  "sparkles", "zap", "coffee", "pizza", "beers", "cake", "bug", "ship", "package", "memo", "calendar", "rotating_light",
  "partying_face", "saluting_face", "heavy_check_mark", "speech_balloon",
];
export const emoji = (name) => emojiGlyph(name) ?? `:${name}:`;
export const emojiLabel = (name) => name.replaceAll("_", " ");

// ---------------------------------------------------------------------------------------------
// Message text → safe DOM (mrkdwn subset: *bold* _italic_ ~strike~ `code` ```pre```, <@U…>, <#C…|name>, <url|label>, :emoji:)
// ---------------------------------------------------------------------------------------------

const TOKEN = /```([\s\S]*?)```|`([^`\n]+)`|<@([A-Z0-9]+)(?:\|[^>]*)?>|<#([A-Z0-9]+)(?:\|([^>]*))?>|<(https?:\/\/[^|>]+)(?:\|([^>]*))?>|<!([a-z]+)(?:\|[^>]*)?>|(https?:\/\/[^\s<>]+)|:([a-z0-9_+-]+):/g;
const STYLE = /(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|(?<![\w~])~([^~\n]+)~(?![\w~])/g;

/**
 * Render message text into `target` using text nodes and styled spans only. `resolve` maps user ids to handles and
 * channel ids to names; mention pills call `onMention(userId)` / `onChannel(channelId)` when clicked.
 */
export function renderText(target, text, { resolve, onMention, onChannel } = {}) {
  target.replaceChildren();
  const source = String(text ?? "");
  let last = 0;
  for (const match of source.matchAll(TOKEN)) {
    if (match.index > last) appendStyled(target, source.slice(last, match.index));
    const [whole, pre, code, userId, channelId, channelName, url, urlLabel, special, bareUrl, shortcode] = match;
    if (pre !== undefined) target.append(el("pre", { class: "msg-pre", text: pre.replace(/^\n/, "").replace(/\n$/, "") }));
    else if (code !== undefined) target.append(el("code", { class: "msg-code", text: code }));
    else if (userId !== undefined) {
      const handle = resolve?.user?.(userId);
      const pill = el("button", { class: "mention", text: `@${handle ?? userId}`, attrs: { type: "button" } });
      if (onMention) pill.addEventListener("click", () => onMention(userId));
      target.append(pill);
    } else if (channelId !== undefined) {
      const name = channelName || resolve?.channel?.(channelId) || channelId;
      const pill = el("button", { class: "channel-link", text: `#${name}`, attrs: { type: "button" } });
      if (onChannel) pill.addEventListener("click", () => onChannel(channelId));
      target.append(pill);
    } else if (url !== undefined) target.append(el("span", { class: "msg-link", text: urlLabel || url, title: url }));
    else if (special !== undefined) target.append(el("span", { class: "mention", text: `@${special}` }));
    else if (bareUrl !== undefined) target.append(el("span", { class: "msg-link", text: bareUrl, title: bareUrl }));
    else if (shortcode !== undefined) target.append(emojiGlyph(shortcode) === undefined ? whole : el("span", { class: "msg-emoji", text: emojiGlyph(shortcode), title: `:${shortcode}:` }));
    last = match.index + whole.length;
  }
  if (last < source.length) appendStyled(target, source.slice(last));
}

function appendStyled(target, text) {
  let last = 0;
  for (const match of text.matchAll(STYLE)) {
    if (match.index > last) target.append(text.slice(last, match.index));
    const [whole, bold, italic, strike] = match;
    if (bold !== undefined) target.append(el("strong", { text: bold }));
    else if (italic !== undefined) target.append(el("em", { text: italic }));
    else target.append(el("s", { text: strike }));
    last = match.index + whole.length;
  }
  if (last < text.length) target.append(text.slice(last));
}

/** Plain one-line preview of a message (mentions resolved, shortcodes kept), for sidebar/search/dialog previews. */
export function plainText(text, resolve) {
  return String(text ?? "")
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${resolve?.user?.(id) ?? id}`)
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, name) => `#${name || resolve?.channel?.(id) || id}`)
    .replace(/<(https?:\/\/[^|>]+)(?:\|([^>]*))?>/g, (_, url, label) => label || url)
    .replace(/:([a-z0-9_+-]+):/g, (whole, name) => emojiGlyph(name) ?? whole)
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------------------------
// Avatars: rounded-square initials on a per-user deterministic colour (the client's placeholder avatars)
// ---------------------------------------------------------------------------------------------

const AVATAR_COLORS = ["#4A154B", "#E01E5A", "#36C5F0", "#2EB67D", "#ECB22E", "#1264A3", "#7C3085", "#DE4E2B"];
export function avatarColor(seed) {
  let hash = 0;
  for (const character of String(seed)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Letter avatar; `size` is a class (sm 20 px, md 24 px, lg 36 px, xl 72 px, xxl 192 px). */
export function avatar(user, size = "lg") {
  const name = user?.real_name || user?.name || user?.id || "?";
  const element = el("span", { class: `avatar ${size}`, text: name.trim().charAt(0).toUpperCase(), attrs: { "aria-hidden": "true" } });
  element.style.background = avatarColor(user?.id ?? name);
  return element;
}

// ---------------------------------------------------------------------------------------------
// Per-viewer conveniences (never authority over records)
// ---------------------------------------------------------------------------------------------

export function readPreference(name, fallback) {
  try {
    return sessionStorage.getItem(`slack-tool:${name}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePreference(name, value) {
  try {
    sessionStorage.setItem(`slack-tool:${name}`, value);
  } catch {
    /* storage blocked: the convenience simply does not persist */
  }
}

// ---------------------------------------------------------------------------------------------
// World revision polling
// ---------------------------------------------------------------------------------------------

/** Poll the world revision and refresh when something changed (agent activity, reset, other tabs). */
export function watchWorld(refresh, mayRefresh = () => true, onContext) {
  let revision;
  let checking = false;
  const check = async () => {
    if (checking || pending > 0 || document.visibilityState !== "visible") return;
    checking = true;
    try {
      const context = await getContext();
      onContext?.(context);
      const stamp = JSON.stringify(context.revision);
      if (revision !== stamp) {
        const first = revision === undefined;
        revision = stamp;
        if (first || mayRefresh()) await refresh(first);
      }
    } catch (error) {
      toast(error?.message ?? "The local environment is unavailable.", { error: true });
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), 2000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  void check();
}
