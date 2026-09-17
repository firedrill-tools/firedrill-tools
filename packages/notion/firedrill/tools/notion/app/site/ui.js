// DOM, Firedrill-client and interaction helpers for the Notion Tool app. Every record string goes through
// textContent; nothing on this page is authoritative — records are re-read after writes and when the world revision moves.
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

export function iconButton(name, label, options = {}) {
  const button = el("button", { class: `icon-btn ${options.class ?? ""}`.trim(), title: options.tooltip === false ? undefined : label, attrs: { type: "button", "aria-label": label } });
  button.append(icon(name));
  if (options.onClick) button.addEventListener("click", options.onClick);
  return button;
}

export function textButton(label, options = {}) {
  const button = el("button", { class: `btn ${options.class ?? ""}`.trim(), attrs: { type: "button" } });
  if (options.icon) button.append(icon(options.icon));
  button.append(el("span", { text: label }));
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

/** Human wording for a failed call, in the product's tone. */
export function describe(error) {
  if (error instanceof ToolError) {
    if (error.denied) return "You don't have permission to do that in this workspace.";
    if (error.is("RESTRICTED_RESOURCE")) return `This integration can't do that: ${error.message}`;
    if (error.is("OBJECT_NOT_FOUND")) return "This page doesn't exist or isn't shared with the integration.";
    if (error.is("RATE_LIMITED")) return "You're being rate limited. Try again in a few seconds.";
    if (error.is("SERVICE_UNAVAILABLE")) return "Notion is unavailable right now. Nothing was saved — try again later.";
    if (error.is("CONFLICT_ERROR")) return "Conflict occurred while saving. The page was reloaded — check before retrying.";
    if (error.is("UNAUTHORIZED")) return "The integration token is not valid for this workspace.";
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

/** Run a user action; a second exclusive action is ignored while one is in flight so a write cannot be submitted twice. */
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
// Snackbar (bottom-left toast, the product's dark pill)
// ---------------------------------------------------------------------------------------------

let snackbarTimer;
export function snackbar(text, { actionLabel, onAction, timeout = 6000, error = false } = {}) {
  const host = $("#snackbar");
  $("#snackbar-text").textContent = text;
  const button = $("#snackbar-action");
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
// Popovers (menus, pickers) — one open at a time, anchored below or beside an element
// ---------------------------------------------------------------------------------------------

let openPopover;
export function closePopovers() {
  if (!openPopover) return;
  const { element, anchor, onClose } = openPopover;
  openPopover = undefined;
  element.remove();
  if (anchor?.isConnected) anchor.setAttribute("aria-expanded", "false");
  onClose?.();
}
export const popoverOpen = () => openPopover !== undefined;

/**
 * Open a popover next to `anchor`. `content` is an element or an array of menu items
 * ({ label, icon?, description?, danger?, disabled?, checked?, onSelect, keepOpen? } | "divider" | { header }).
 */
export function openPopover_(anchor, content, { align = "start", side = "bottom", className = "", width, onClose, focusFirst = true } = {}) {
  closePopovers();
  const element = el("div", { class: `popover ${className}`.trim(), attrs: { role: Array.isArray(content) ? "menu" : "dialog" } });
  if (width) element.style.width = `${width}px`;
  if (Array.isArray(content)) element.append(menuList(content));
  else element.append(content);
  $("#popover-host").append(element);
  openPopover = { element, anchor, onClose };
  anchor.setAttribute("aria-expanded", "true");
  position(element, anchor, align, side);
  if (focusFirst) {
    const first = element.querySelector("input, textarea, [contenteditable], button:not(:disabled)");
    first?.focus();
  }
  return element;
}
export { openPopover_ as openPopover };

export function menuList(items) {
  const list = el("div", { class: "menu" });
  for (const item of items) {
    if (item === "divider") {
      list.append(el("div", { class: "menu-divider", attrs: { role: "separator" } }));
      continue;
    }
    if (item.header !== undefined) {
      list.append(el("div", { class: "menu-header", text: item.header }));
      continue;
    }
    const button = el("button", { class: `menu-item ${item.danger ? "danger" : ""} ${item.checked ? "checked" : ""}`.trim(), attrs: { type: "button", role: item.checked === undefined ? "menuitem" : "menuitemcheckbox", "aria-checked": item.checked === undefined ? undefined : String(item.checked) } });
    if (item.icon) button.append(icon(item.icon, "menu-icon"));
    else if (item.emoji !== undefined) button.append(el("span", { class: "menu-emoji", text: item.emoji }));
    else if (item.swatch) {
      const swatch = el("span", { class: "menu-swatch" });
      swatch.dataset.color = item.swatch;
      button.append(swatch);
    }
    const labels = el("span", { class: "menu-labels" }, [el("span", { class: "menu-label", text: item.label }), item.description ? el("span", { class: "menu-description", text: item.description }) : null]);
    button.append(labels);
    if (item.checked) button.append(icon("check", "menu-check"));
    if (item.shortcut) button.append(el("span", { class: "menu-shortcut", text: item.shortcut }));
    if (item.disabled) button.disabled = true;
    button.addEventListener("click", () => {
      if (!item.keepOpen) closePopovers();
      item.onSelect?.();
    });
    list.append(button);
  }
  return list;
}

function position(element, anchor, align, side) {
  const rect = anchor.getBoundingClientRect();
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  let left;
  let top;
  if (side === "right") {
    left = rect.right + 6;
    top = rect.top;
  } else {
    left = align === "end" ? rect.right - width : rect.left;
    top = rect.bottom + 4;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  if (top + height > window.innerHeight - 8) top = Math.max(8, side === "right" ? window.innerHeight - height - 8 : rect.top - height - 4);
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

document.addEventListener("pointerdown", (event) => {
  if (openPopover && !openPopover.element.contains(event.target) && !openPopover.anchor?.contains(event.target)) closePopovers();
});
document.addEventListener("keydown", (event) => {
  if (!openPopover) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closePopovers();
  } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !(event.target instanceof HTMLTextAreaElement)) {
    const items = $$(".menu-item:not(:disabled), .picker-item:not(:disabled)", openPopover.element);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next].focus();
    event.preventDefault();
  }
});

// ---------------------------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------------------------

export function confirmDialog(title, text, okLabel = "Delete", { danger = true } = {}) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  const ok = $("#confirm-ok");
  ok.textContent = okLabel;
  ok.classList.toggle("danger", danger);
  ok.classList.toggle("primary", !danger);
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true }));
}

// ---------------------------------------------------------------------------------------------
// Dates — "today" is always the world's virtual now, never the browser clock
// ---------------------------------------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const utcDay = (date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

/** Property date value: "September 18, 2026" (date only) or with a time; ranges join with →. */
export function propertyDate(value) {
  if (!value || !value.start) return "";
  const format = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const base = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
    return iso.length > 10 ? `${base} ${time(date)}` : base;
  };
  return value.end ? `${format(value.start)} → ${format(value.end)}` : format(value.start);
}

function time(date) {
  const hours = date.getUTCHours();
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${((hours + 11) % 12) + 1}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
}

/** Compact stamp for lists: "9:00 AM" today, "Sep 12" this year, "Mar 3, 2025" otherwise. */
export function shortDate(iso, nowMs) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const short = `${MONTHS[date.getUTCMonth()].slice(0, 3)} ${date.getUTCDate()}`;
  if (nowMs === undefined) return `${short}, ${date.getUTCFullYear()}`;
  const now = new Date(nowMs);
  if (utcDay(date) === utcDay(now)) return time(date);
  if (date.getUTCFullYear() === now.getUTCFullYear()) return short;
  return `${short}, ${date.getUTCFullYear()}`;
}

/** "Edited 2 hours ago" style relative time against the virtual now. */
export function relativeTime(iso, nowMs) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || nowMs === undefined) return shortDate(iso, nowMs);
  const minutes = Math.round((nowMs - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  return shortDate(iso, nowMs);
}

/** Greeting for the Home tab from the virtual hour. */
export function greeting(nowMs) {
  const hours = new Date(nowMs).getUTCHours();
  if (hours < 12) return "Good morning";
  if (hours < 18) return "Good afternoon";
  return "Good evening";
}

/** Long form with weekday, for the Home tab header. */
export function longDate(nowMs) {
  const date = new Date(nowMs);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `${days[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

const AVATAR_COLORS = ["#d44c47", "#cb912f", "#448361", "#337ea9", "#9065b0", "#c14c8a", "#9f6b53", "#787774"];
export function avatarColor(seed) {
  let hash = 0;
  for (const character of String(seed)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Round letter avatar the way the product shows people without a photo. */
export function avatar(user, size = "") {
  const name = user?.name ?? "?";
  const element = el("span", { class: `avatar ${size}`.trim(), text: name.trim().charAt(0).toUpperCase() || "?", attrs: { "aria-hidden": "true" } });
  element.style.background = avatarColor(user?.id ?? name);
  return element;
}

// ---------------------------------------------------------------------------------------------
// Per-viewer preferences (sidebar width, last tab) — a convenience, never authority over records
// ---------------------------------------------------------------------------------------------

export function readPreference(name, fallback) {
  try {
    return localStorage.getItem(`notion-tool:${name}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePreference(name, value) {
  try {
    localStorage.setItem(`notion-tool:${name}`, value);
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

/** True while the viewer is typing somewhere that a re-render would disturb. */
export function isEditing() {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  if (active.isContentEditable) return true;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return !active.closest("#search-dialog");
  return popoverOpen();
}

/** A control that exists in the product's chrome but is outside this Tool's scope: a short explanatory panel. */
export function notSimulated(anchor, title, text, { align = "start", side = "bottom" } = {}) {
  const box = el("div", { class: "not-simulated", attrs: { "aria-label": title } });
  box.append(el("div", { class: "panel-head plain" }, [el("span", { class: "panel-title", text: title })]));
  box.append(el("p", { class: "panel-note", text: text ?? "Not simulated by this Tool." }));
  box.append(el("p", { class: "not-simulated-tag", text: "Not simulated by this Tool" }));
  return openPopover_(anchor, box, { width: 300, align, side, className: "sidebar-panel", focusFirst: false });
}

/** Icon button for a control outside the Tool's scope (renders in place with hover and tooltip). */
export function unsimulatedButton(name, label, text, options = {}) {
  const button = iconButton(name, label, { class: `unsimulated ${options.class ?? ""}`.trim() });
  button.addEventListener("click", (event) => notSimulated(event.currentTarget, label, text, options));
  return button;
}
