// DOM, Firedrill-client and interaction helpers shared by the Sheets home screen and the spreadsheet editor.
import { getContext, invoke } from "/_firedrill/client.js";
import { icon } from "./icons.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Create an element. options: { class, text, title, attrs }. Record text always goes through textContent. */
export function el(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.class) element.className = options.class;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.title !== undefined) element.title = options.title;
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value !== undefined && value !== null && value !== false) element.setAttribute(name, value === true ? "" : String(value));
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== undefined && child !== null && child !== false) element.append(child);
  }
  return element;
}

export function iconButton(name, label, { onClick, className = "", attrs = {}, tooltip = true } = {}) {
  const button = el("button", { class: `icon-btn ${className}`.trim(), title: tooltip ? label : undefined, attrs: { type: "button", "aria-label": label, ...attrs } });
  button.append(icon(name));
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

export function button(label, { onClick, className = "text-btn", type = "button", attrs = {} } = {}) {
  const element = el("button", { class: className, text: label, attrs: { type, ...attrs } });
  if (onClick) element.addEventListener("click", onClick);
  return element;
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

/** Invoke one Tool operation; every non-ok outcome throws a ToolError. Mutations pass an idempotency key. */
export async function call(operationId, args = {}, idempotencyKey) {
  const result = await invoke(operationId, args, idempotencyKey ? { idempotencyKey } : {});
  if (result.outcome.status !== "ok") {
    const error = result.outcome.error ?? {};
    throw new ToolError(result.outcome.status, error.code ?? result.outcome.status, error.message ?? `The operation was ${result.outcome.status}.`);
  }
  return result.outcome.value;
}

export const newKey = () => crypto.randomUUID();

/** Sheets' own wording for the outcomes this Tool can return. */
export function describe(error) {
  if (error instanceof ToolError) {
    if (error.denied) return "You don't have permission to do that with this account.";
    if (error.is("RATE_LIMITED")) return "Too many requests right now. Your change wasn't saved — try again in a moment.";
    if (error.is("UNAVAILABLE")) return "Google Sheets is temporarily unavailable. Your change wasn't saved — try again in a moment.";
    if (error.is("PERMISSION_DENIED")) return "You need edit access to make this change.";
    if (error.is("NOT_FOUND")) return "This item no longer exists, or you don't have access to it.";
    if (error.status === "invalid") return `Invalid input: ${error.message}`;
    return error.message;
  }
  return error?.message ?? "Something went wrong. Reload and try again.";
}

// ---------------------------------------------------------------------------------------------
// One user action at a time
// ---------------------------------------------------------------------------------------------

let pending = 0;
export const isPending = () => pending > 0;
function setBusy(delta) {
  pending += delta;
  document.documentElement.toggleAttribute("data-busy", pending > 0);
  for (const bar of $$(".progress")) bar.hidden = pending === 0;
}

/** Run a user action; while an exclusive action is in flight a second one is ignored, so a write is never sent twice. */
export async function action(task, { exclusive = true, onError } = {}) {
  if (exclusive && pending > 0) return undefined;
  setBusy(1);
  try {
    return await task();
  } catch (error) {
    if (onError) onError(error);
    else toast(describe(error), { error: true });
    return undefined;
  } finally {
    setBusy(-1);
  }
}

// ---------------------------------------------------------------------------------------------
// Toast (bottom-left snackbar)
// ---------------------------------------------------------------------------------------------

let toastTimer;
export function toast(text, { actionLabel, onAction, timeout = 6000, error = false } = {}) {
  const host = $("#toast");
  $("#toast-text").textContent = text;
  host.dataset.error = String(error);
  const actionButton = $("#toast-action");
  actionButton.hidden = !actionLabel;
  actionButton.textContent = actionLabel ?? "";
  actionButton.onclick = () => {
    hideToast();
    if (onAction) void action(onAction);
  };
  host.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, timeout);
}
export function hideToast() {
  clearTimeout(toastTimer);
  const host = $("#toast");
  if (host) host.hidden = true;
}
$("#toast-close")?.addEventListener("click", hideToast);

// ---------------------------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------------------------

const menuStack = [];
export const menuOpen = () => menuStack.length > 0;

export function closeMenus(depth = 0) {
  while (menuStack.length > depth) {
    const menu = menuStack.pop();
    menu.remove();
    if (menu.anchor?.isConnected) menu.anchor.setAttribute("aria-expanded", "false");
    menu.onClose?.();
  }
}

/**
 * Open a Sheets-style menu. items: { label, icon?, checked?, shortcut?, disabled?, hint?, submenu?: () => items,
 * swatches?, onSelect } | "divider" | { heading }. Options: { anchor, point, align, className, onClose, depth }.
 */
export function openMenu(anchor, items, { point, align = "start", className = "", onClose, depth = 0, below = true } = {}) {
  closeMenus(depth);
  const menu = el("div", { class: `menu ${className}`.trim(), attrs: { role: "menu" } });
  menu.anchor = anchor;
  menu.onClose = onClose;
  for (const item of items) {
    if (item === "divider") {
      menu.append(el("div", { class: "menu-divider", attrs: { role: "separator" } }));
      continue;
    }
    if (item.heading) {
      menu.append(el("div", { class: "menu-heading", text: item.heading }));
      continue;
    }
    if (item.element) {
      menu.append(item.element);
      continue;
    }
    const row = el("button", {
      class: "menu-item",
      attrs: { type: "button", role: item.checked !== undefined ? "menuitemcheckbox" : "menuitem", "aria-checked": item.checked === undefined ? undefined : String(item.checked), "aria-haspopup": item.submenu ? "menu" : undefined },
    });
    if (item.checked !== undefined) row.append(icon(item.checked ? "check" : "", "menu-icon"));
    else row.append(icon(item.icon ?? "", "menu-icon"));
    row.append(el("span", { class: "menu-label", text: item.label }));
    if (item.shortcut) row.append(el("span", { class: "menu-shortcut", text: item.shortcut }));
    if (item.hint) row.append(el("span", { class: "menu-hint", text: item.hint }));
    if (item.submenu) row.append(icon("chevron_right", "menu-arrow"));
    if (item.disabled) {
      row.disabled = true;
      if (item.title) row.title = item.title;
    }
    const openSub = () => {
      const rect = row.getBoundingClientRect();
      openMenu(row, item.submenu(), { point: { x: rect.right - 4, y: rect.top - 8 }, depth: depth + 1, className });
    };
    if (item.submenu) {
      row.addEventListener("mouseenter", () => {
        if (!row.disabled) openSub();
      });
    } else {
      row.addEventListener("mouseenter", () => closeMenus(depth + 1));
    }
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      if (item.submenu) {
        openSub();
        menuStack.at(-1)?.querySelector("button:not(:disabled)")?.focus();
        return;
      }
      closeMenus();
      item.onSelect?.();
    });
    menu.append(row);
  }
  document.body.append(menu);
  menuStack.push(menu);
  anchor?.setAttribute?.("aria-expanded", "true");
  const rect = point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = align === "end" ? rect.right - width : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = point ? rect.top : below ? rect.bottom + 2 : rect.top - height - 2;
  if (top + height > window.innerHeight - 8) top = Math.max(8, (point ? rect.top : rect.top) - height - 2);
  if (top < 8) top = 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  if (depth === 0) menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  return menu;
}

document.addEventListener("pointerdown", (event) => {
  if (menuStack.length === 0) return;
  if (menuStack.some((menu) => menu.contains(event.target))) return;
  if (menuStack[0].anchor?.contains?.(event.target)) return;
  closeMenus();
});
document.addEventListener(
  "keydown",
  (event) => {
    if (menuStack.length === 0) return;
    const menu = menuStack.at(-1);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const anchor = menuStack[0].anchor;
      closeMenus();
      anchor?.focus?.();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const rows = $$("button:not(:disabled)", menu);
      if (rows.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const index = rows.indexOf(document.activeElement);
      rows[event.key === "ArrowDown" ? (index + 1) % rows.length : (index - 1 + rows.length) % rows.length].focus();
    } else if (event.key === "ArrowLeft" && menuStack.length > 1) {
      event.preventDefault();
      event.stopPropagation();
      const parent = menu.anchor;
      closeMenus(menuStack.length - 1);
      parent?.focus?.();
    } else if (event.key === "ArrowRight" && document.activeElement?.getAttribute("aria-haspopup") === "menu") {
      event.preventDefault();
      event.stopPropagation();
      document.activeElement.click();
    }
  },
  true,
);

// ---------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------

export const dialogOpen = () => Boolean($("#modal")?.open || $("#confirm")?.open);

/** Confirmation dialog; resolves true when the user confirms. */
export function confirmDialog(title, text, { okLabel = "OK", danger = false } = {}) {
  const dialog = $("#confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  const actions = $("#confirm-actions");
  actions.replaceChildren(
    el("button", { class: "text-btn", text: "Cancel", attrs: { type: "submit", value: "cancel" } }),
    el("button", { class: `filled-btn ${danger ? "danger" : ""}`.trim(), text: okLabel, attrs: { type: "submit", value: "ok" } }),
  );
  return new Promise((resolve) => {
    dialog.returnValue = "cancel";
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    dialog.showModal();
    actions.lastElementChild.focus();
  });
}

/** Open the shared modal: { title, body, actions, className, onClose }. Returns { close }. */
export function openModal({ title, body, actions = [], className = "", onClose }) {
  const dialog = $("#modal");
  if (dialog.open) dialog.close();
  dialog.className = `dialog ${className}`.trim();
  $("#modal-title").textContent = title ?? "";
  $("#modal-title").hidden = !title;
  $("#modal-body").replaceChildren(body ?? "");
  $("#modal-actions").replaceChildren(...actions);
  $("#modal-actions").hidden = actions.length === 0;
  const handler = () => {
    dialog.removeEventListener("close", handler);
    onClose?.();
  };
  dialog.addEventListener("close", handler);
  dialog.showModal();
  return { close: () => dialog.open && dialog.close(), dialog };
}
export function closeModal() {
  const dialog = $("#modal");
  if (dialog?.open) dialog.close();
}

// ---------------------------------------------------------------------------------------------
// Preferences (per viewer, never authority over records)
// ---------------------------------------------------------------------------------------------

export function readPreference(name, fallback) {
  try {
    return localStorage.getItem(`google-sheets-tool:${name}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePreference(name, value) {
  try {
    localStorage.setItem(`google-sheets-tool:${name}`, value);
  } catch {
    /* storage blocked: the preference does not persist */
  }
}

// ---------------------------------------------------------------------------------------------
// World revision polling
// ---------------------------------------------------------------------------------------------

/**
 * Poll getContext().revision; when it changes (agent activity, reset, another tab) call refresh(). A change seen
 * while the user has unsaved input stays pending until mayRefresh() allows it, so open editors are never clobbered.
 */
export function watchWorld(refresh, mayRefresh = () => true) {
  let revision;
  let checking = false;
  const check = async () => {
    if (checking || pending > 0 || document.visibilityState !== "visible") return;
    checking = true;
    try {
      const context = await getContext();
      const stamp = JSON.stringify(context.revision ?? null);
      if (revision === undefined) revision = stamp;
      else if (revision !== stamp && mayRefresh()) {
        revision = stamp;
        await refresh();
      }
    } catch (error) {
      toast(error?.message ?? "The local Firedrill environment is unavailable.", { error: true });
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), 2000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  void check();
  return { markSeen: () => void getContext().then((context) => (revision = JSON.stringify(context.revision ?? null))).catch(() => {}) };
}

// ---------------------------------------------------------------------------------------------
// People and time
// ---------------------------------------------------------------------------------------------

const AVATAR_COLORS = ["#1e88e5", "#d81b60", "#8e24aa", "#43a047", "#f4511e", "#00897b", "#3949ab", "#6d4c41", "#e53935", "#039be5", "#7cb342", "#fb8c00"];
export function avatarColor(seed) {
  let hash = 0;
  for (const character of String(seed)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
export function avatar(name, address, className = "") {
  const element = el("span", { class: `avatar ${className}`.trim(), text: (name || address || "?").trim().charAt(0).toUpperCase(), attrs: { "aria-hidden": "true" } });
  element.style.background = avatarColor(address || name || "?");
  return element;
}

// All dates render in UTC with an explicit locale, relative to the world's virtual time (about.get serverTime),
// so the same world renders identically on any machine and any day.
const TIME = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const FULL_DATE = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
const DAY_MS = 86400000;
const dayOf = (ms) => Math.floor(ms / DAY_MS);

export function parseTime(value) {
  if (typeof value !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** "9:12 AM" today, "Sep 12" this year, "Sep 12, 2025" otherwise — the Sheets home list style. */
export function listDate(value, nowMs) {
  const ms = parseTime(value);
  if (ms === undefined) return "—";
  if (nowMs !== undefined && dayOf(ms) === dayOf(nowMs)) return TIME.format(ms);
  if (nowMs !== undefined && new Date(ms).getUTCFullYear() === new Date(nowMs).getUTCFullYear()) return MONTH_DAY.format(ms);
  return FULL_DATE.format(ms);
}
export const fullDate = (value) => {
  const ms = parseTime(value);
  return ms === undefined ? "—" : `${FULL_DATE.format(ms)}, ${TIME.format(ms)} UTC`;
};

/** Group label relative to virtual now: Today / Yesterday / Previous 7 days / Previous 30 days / Earlier. */
export function recencyGroup(value, nowMs) {
  const ms = parseTime(value);
  if (ms === undefined || nowMs === undefined) return "Earlier";
  const days = dayOf(nowMs) - dayOf(ms);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  if (days <= 30) return "Previous 30 days";
  return "Earlier";
}

/** "3 minutes ago", "2 days ago" relative to virtual now. */
export function ago(value, nowMs) {
  const ms = parseTime(value);
  if (ms === undefined || nowMs === undefined) return "";
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  const unit = (count, word) => `${count} ${word}${count === 1 ? "" : "s"} ago`;
  if (seconds < 60) return "seconds ago";
  if (seconds < 3600) return unit(Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return unit(Math.floor(seconds / 3600), "hour");
  if (seconds < 86400 * 30) return unit(Math.floor(seconds / 86400), "day");
  return `on ${FULL_DATE.format(ms)}`;
}
