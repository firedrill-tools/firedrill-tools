// DOM, Firedrill-client and interaction helpers for the Gmail Tool app.
import { getContext, invoke } from "/_firedrill/client.js";
import { icon } from "./icons.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Create an element. `options`: { class, text, title, attrs: {…}, children: [...] }. Text always goes through textContent. */
export function el(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.class) element.className = options.class;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.title !== undefined) element.title = options.title;
  if (options.attrs) for (const [name, value] of Object.entries(options.attrs)) if (value !== undefined && value !== null) element.setAttribute(name, String(value));
  for (const child of Array.isArray(children) ? children : [children]) if (child !== undefined && child !== null && child !== false) element.append(child);
  return element;
}

/** Round icon button (40 px) with an accessible name and a Gmail-style tooltip title. */
export function iconButton(name, label, options = {}) {
  const button = el("button", { class: `icon-btn ${options.class ?? ""}`.trim(), title: options.tooltip === false ? undefined : label, attrs: { type: "button", "aria-label": label } });
  button.append(icon(name, options.iconClass));
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

export function describe(error) {
  if (error instanceof ToolError) {
    if (error.denied) return "You don't have permission for this action in this mailbox.";
    if (error.is("BACKEND_ERROR")) return "Oops… the mailbox is temporarily unavailable (503). Try again in a moment.";
    if (error.is("RATE_LIMITED")) return "Sending is rate-limited right now (429). Nothing was sent; try again later.";
    if (error.is("INVALID_PAGE_TOKEN")) return "That page is no longer available.";
    return error.message;
  }
  return error?.message ?? "Something went wrong. Refresh and try again.";
}

// ---------------------------------------------------------------------------------------------
// One user action at a time
// ---------------------------------------------------------------------------------------------

let pending = 0;
const busyListeners = new Set();
export const isPending = () => pending > 0;
export function onBusy(listener) {
  busyListeners.add(listener);
}
function setBusy(delta) {
  pending += delta;
  document.documentElement.toggleAttribute("data-busy", pending > 0);
  for (const listener of busyListeners) listener(pending > 0);
}

/** Run a user action; a second action is ignored while one is in flight so a write cannot be submitted twice. */
export async function action(task, { exclusive = true, onError } = {}) {
  if (exclusive && pending > 0) return undefined;
  setBusy(1);
  try {
    return await task();
  } catch (error) {
    if (onError) onError(error);
    else snackbar(describe(error), { error: true });
    return undefined;
  } finally {
    setBusy(-1);
  }
}

// ---------------------------------------------------------------------------------------------
// Snackbar (bottom-left toast with optional Undo)
// ---------------------------------------------------------------------------------------------

let snackbarTimer;
export function snackbar(text, { actionLabel, onAction, timeout = 6000, error = false } = {}) {
  const host = $("#snackbar");
  const label = $("#snackbar-text");
  const button = $("#snackbar-action");
  label.textContent = text;
  host.dataset.error = String(error);
  button.hidden = !actionLabel;
  button.textContent = actionLabel ?? "";
  button.onclick = () => {
    hideSnackbar();
    if (onAction) void action(onAction);
  };
  host.hidden = false;
  clearTimeout(snackbarTimer);
  snackbarTimer = setTimeout(hideSnackbar, timeout);
}
export function hideSnackbar() {
  clearTimeout(snackbarTimer);
  $("#snackbar").hidden = true;
}

// ---------------------------------------------------------------------------------------------
// Popover menus
// ---------------------------------------------------------------------------------------------

let openMenuElement;
export function closeMenus() {
  if (openMenuElement) {
    const anchor = openMenuElement.anchor;
    openMenuElement.remove();
    openMenuElement = undefined;
    if (anchor?.isConnected) {
      anchor.setAttribute("aria-expanded", "false");
      if (!document.activeElement || document.activeElement === document.body) anchor.focus();
    }
  }
}

/**
 * Open a Gmail-style menu below `anchor`. `content` is either an array of items
 * ({ label, icon?, checked?, disabled?, onSelect, keepOpen? } or "divider") or a prebuilt element.
 */
export function openMenu(anchor, content, { align = "start", className = "", header } = {}) {
  closeMenus();
  const menu = el("div", { class: `gm-menu ${className}`.trim(), attrs: { role: "menu" } });
  menu.anchor = anchor;
  if (header) menu.append(el("div", { class: "gm-menu-header", text: header }));
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item === "divider") {
        menu.append(el("div", { class: "gm-menu-divider", attrs: { role: "separator" } }));
        continue;
      }
      const button = el("button", { class: "gm-menu-item", attrs: { type: "button", role: item.checked === undefined ? "menuitem" : "menuitemcheckbox", "aria-checked": item.checked === undefined ? undefined : String(item.checked) } });
      if (item.checked !== undefined) button.append(icon(item.checked ? "check_box" : "check_box_blank", "menu-check"));
      else if (item.icon) button.append(icon(item.icon, "menu-icon"));
      else button.append(el("span", { class: "menu-icon" }));
      button.append(el("span", { class: "gm-menu-label", text: item.label }));
      if (item.swatch) {
        const swatch = el("span", { class: "gm-menu-swatch" });
        swatch.style.background = item.swatch;
        button.append(swatch);
      }
      if (item.disabled) button.disabled = true;
      if (item.notSimulated) {
        button.classList.add("gm-menu-ns");
        button.title = "Not simulated by this Tool";
      }
      button.addEventListener("click", () => {
        if (item.notSimulated) {
          notSimulated(anchor, item.label, item.notSimulated);
          return;
        }
        if (!item.keepOpen) closeMenus();
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
  let top = rect.bottom + 4;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  const first = menu.querySelector("input, button:not(:disabled)");
  first?.focus();
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
    const items = $$(".gm-menu-item:not(:disabled)", openMenuElement);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next].focus();
    event.preventDefault();
  }
});

/**
 * Controls that exist in Gmail but are outside this Tool's model open a short, honest panel instead of pretending to
 * work. Nothing is written. `name` is the control's own label; `detail` says what is missing.
 */
export function notSimulated(anchor, name, detail) {
  const box = el("div", { class: "gm-ns", attrs: { role: "dialog", "aria-label": `${name} is not simulated` } });
  const head = el("div", { class: "gm-ns-head" });
  head.append(icon("info", "gm-ns-icon"), el("h2", { text: name }));
  box.append(head);
  box.append(el("p", { class: "gm-ns-lead", text: "Not simulated by this Tool." }));
  if (detail) box.append(el("p", { text: detail }));
  const actions = el("div", { class: "gm-dialog-actions" });
  const ok = el("button", { class: "gm-text-btn", text: "Got it", attrs: { type: "button" } });
  ok.addEventListener("click", () => closeMenus());
  actions.append(ok);
  box.append(actions);
  const rect = anchor.getBoundingClientRect();
  openMenu(anchor, box, { align: rect.left > window.innerWidth / 2 ? "end" : "start", className: "gm-popover gm-popover-ns" });
  ok.focus();
}

// ---------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------

/** Gmail-style confirmation: title, one sentence, text buttons. Resolves true when confirmed. */
export function confirmDialog(title, text, okLabel = "OK", { danger = false } = {}) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  const ok = $("#confirm-ok");
  ok.textContent = okLabel;
  ok.classList.toggle("danger", danger);
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true }));
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

// Dates render in UTC, the zone the search operators (after:/before:) use, so the same world shows the same times on
// every machine regardless of the browser's time zone.
const ZONE = "UTC";
const sameDay = (a, b) => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();

/**
 * Conversation-list date: "2:02 PM" today, "Sep 11" this year, "9/11/25" otherwise. "Today" is the world's virtual
 * now passed in by the caller; without one the absolute date is shown (the browser clock is never consulted).
 */
export function listDate(internalDate, nowMs) {
  const date = new Date(Number(internalDate));
  if (nowMs === undefined) return date.toLocaleDateString("en-US", { timeZone: ZONE, month: "short", day: "numeric", year: "numeric" });
  const now = new Date(nowMs);
  if (sameDay(date, now)) return date.toLocaleTimeString("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit" });
  if (date.getUTCFullYear() === now.getUTCFullYear()) return date.toLocaleDateString("en-US", { timeZone: ZONE, month: "short", day: "numeric" });
  return date.toLocaleDateString("en-US", { timeZone: ZONE, month: "numeric", day: "numeric", year: "2-digit" });
}

/** Message header date: "Sep 11, 2026, 2:02 PM (3 days ago)" relative to the world's virtual now. */
export function fullDate(internalDate, nowMs) {
  const ms = Number(internalDate);
  const date = new Date(ms);
  const absolute = date.toLocaleString("en-US", { timeZone: ZONE, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  return nowMs === undefined ? absolute : `${absolute} (${relativeTime(ms, nowMs)})`;
}

export function relativeTime(ms, nowMs) {
  const diff = nowMs - ms;
  const minutes = Math.round(diff / 60000);
  if (Math.abs(minutes) < 1) return "just now";
  if (minutes < 0) return "in the future";
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

export function longDate(internalDate) {
  return new Date(Number(internalDate)).toLocaleString("en-US", { timeZone: ZONE, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const AVATAR_COLORS = ["#1e88e5", "#d81b60", "#8e24aa", "#43a047", "#f4511e", "#00897b", "#3949ab", "#6d4c41", "#e53935", "#039be5", "#7cb342", "#fb8c00", "#5e35b1", "#00acc1"];
export function avatarColor(seed) {
  let hash = 0;
  for (const character of String(seed)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** 40 px letter avatar the way the conversation view shows senders. */
export function avatar(name, address, size = "") {
  const element = el("span", { class: `gm-avatar ${size}`.trim(), text: (name || address || "?").trim().charAt(0).toUpperCase(), attrs: { "aria-hidden": "true" } });
  element.style.background = avatarColor(address || name);
  return element;
}

export function splitAddresses(value) {
  return value
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .map((item) => {
      const angle = /<([^>]+)>/.exec(item);
      return angle ? angle[1].trim() : item;
    })
    .filter(Boolean);
}

/** HTML-only message parts are shown as text: parse into an inert document and read its text. Nothing is injected. */
export function htmlToText(html) {
  try {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    for (const node of parsed.querySelectorAll("script, style, head")) node.remove();
    for (const br of parsed.querySelectorAll("br")) br.replaceWith("\n");
    for (const block of parsed.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote")) block.append("\n");
    return (parsed.body?.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "(this HTML part could not be shown as text)";
  }
}

export function decodeBase64Url(text) {
  try {
    const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "="));
    return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return "(binary content)";
  }
}

// ---------------------------------------------------------------------------------------------
// Per-viewer preferences (density, page size) — a convenience, never authority over records
// ---------------------------------------------------------------------------------------------

export function readPreference(name, fallback) {
  try {
    return localStorage.getItem(`gmail-tool:${name}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePreference(name, value) {
  try {
    localStorage.setItem(`gmail-tool:${name}`, value);
  } catch {
    /* private mode or blocked storage: the setting simply does not persist */
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
      snackbar(error?.message ?? "The local environment is unavailable.", { error: true });
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), 2000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  void check();
}
