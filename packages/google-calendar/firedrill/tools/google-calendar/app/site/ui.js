// DOM, Firedrill-client and interaction helpers for the Google Calendar Tool app.
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

/** Round icon button (40 px) with an accessible name and a tooltip title. */
export function iconButton(name, label, options = {}) {
  const button = el("button", { class: `icon-btn ${options.class ?? ""}`.trim(), title: options.tooltip === false ? undefined : label, attrs: { type: "button", "aria-label": label, ...(options.attrs ?? {}) } });
  button.append(icon(name, options.iconClass));
  if (options.onClick) button.addEventListener("click", options.onClick);
  return button;
}

export function textButton(label, options = {}) {
  const button = el("button", { class: `gc-text-btn ${options.class ?? ""}`.trim(), text: label, attrs: { type: options.type ?? "button", ...(options.attrs ?? {}) } });
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
    if (error.denied) return "You don't have permission to do that with this account.";
    if (error.is("BACKEND_ERROR")) return "Google Calendar is temporarily unavailable (500). Nothing was changed; try again in a moment.";
    if (error.is("RATE_LIMITED")) return "Couldn't save changes: too many requests (rate limited). Nothing was changed; try again later.";
    if (error.is("REQUIRED_ACCESS_LEVEL")) return "You don't have the required access to this calendar.";
    if (error.is("FORBIDDEN_FOR_NON_ORGANIZER")) return "Only the organiser can change that; guests can update their response, colour and notifications.";
    if (error.is("GONE")) return "This event was deleted.";
    if (error.is("NOT_FOUND")) return "This event is no longer on the calendar.";
    if (error.is("CONDITION_NOT_MET")) return "Someone changed this event in the meantime. Reload it and try again.";
    if (error.is("TIME_RANGE_EMPTY")) return "The end must be after the start.";
    if (error.is("INVALID_PAGE_TOKEN")) return "That page is no longer available.";
    if (error.status === "invalid") return `Invalid input: ${error.message}`;
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
// Snackbar (bottom-left toast with an optional action)
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
 * Open a Material-style menu below `anchor`. `content` is either an array of items
 * ({ label, icon?, checked?, radio?, disabled?, swatch?, hint?, onSelect, keepOpen? } or "divider") or a prebuilt element.
 */
export function openMenu(anchor, content, { align = "start", className = "", header } = {}) {
  closeMenus();
  const menu = el("div", { class: `gc-menu ${className}`.trim(), attrs: { role: "menu" } });
  menu.anchor = anchor;
  if (header) menu.append(el("div", { class: "gc-menu-header", text: header }));
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item === "divider") {
        menu.append(el("div", { class: "gc-menu-divider", attrs: { role: "separator" } }));
        continue;
      }
      const role = item.checked !== undefined ? "menuitemcheckbox" : item.radio !== undefined ? "menuitemradio" : "menuitem";
      const button = el("button", { class: `gc-menu-item ${item.radio ? "is-selected" : ""}`.trim(), attrs: { type: "button", role, "aria-checked": item.checked ?? item.radio } });
      if (item.checked !== undefined) button.append(icon(item.checked ? "check_box" : "check_box_blank", "menu-check"));
      else if (item.radio !== undefined) button.append(item.radio ? icon("check", "menu-check") : el("span", { class: "menu-icon" }));
      else if (item.icon) button.append(icon(item.icon, "menu-icon"));
      else button.append(el("span", { class: "menu-icon" }));
      if (item.swatch) {
        const swatch = el("span", { class: "gc-menu-swatch" });
        swatch.style.background = item.swatch;
        button.append(swatch);
      }
      button.append(el("span", { class: "gc-menu-label", text: item.label }));
      if (item.hint) button.append(el("span", { class: "gc-menu-hint", text: item.hint }));
      if (item.disabled) button.disabled = true;
      button.addEventListener("click", () => {
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
    const items = $$("button:not(:disabled)", openMenuElement);
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next].focus();
  }
});

// ---------------------------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------------------------

/** Material confirm dialog; resolves with the value of the chosen button ("cancel" when dismissed). `choices` override OK. */
export function confirmDialog(title, text, { okLabel = "OK", choices } = {}) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  const actions = $("#confirm-actions");
  actions.replaceChildren();
  const list = choices ?? [{ value: "ok", label: okLabel }];
  actions.append(el("button", { class: "gc-text-btn", text: "Cancel", attrs: { type: "submit", value: "cancel" } }));
  for (const choice of list) actions.append(el("button", { class: "gc-text-btn gc-text-btn-primary", text: choice.label, attrs: { type: "submit", value: choice.value } }));
  return new Promise((resolve) => {
    dialog.returnValue = "cancel";
    dialog.addEventListener("close", () => resolve(dialog.returnValue || "cancel"), { once: true });
    dialog.showModal();
    actions.lastElementChild?.focus();
  });
}

// ---------------------------------------------------------------------------------------------
// Per-viewer preferences — a convenience, never authority over records
// ---------------------------------------------------------------------------------------------

export function readPreference(name, fallback) {
  try {
    return localStorage.getItem(`google-calendar-tool:${name}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePreference(name, value) {
  try {
    localStorage.setItem(`google-calendar-tool:${name}`, value);
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
        // A change noticed while a form is open is left pending: the revision is only recorded once refreshed.
        if (first || mayRefresh()) {
          revision = stamp;
          await refresh(first);
        }
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

const AVATAR_COLORS = ["#1e88e5", "#d81b60", "#8e24aa", "#43a047", "#f4511e", "#00897b", "#3949ab", "#6d4c41", "#e53935", "#039be5", "#7cb342", "#fb8c00", "#5e35b1", "#00acc1"];
export function avatarColor(seed) {
  let hash = 0;
  for (const character of String(seed)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Letter avatar the way the guest list shows people. */
export function avatar(name, address, size = "") {
  const element = el("span", { class: `gc-avatar ${size}`.trim(), text: (name || address || "?").trim().charAt(0).toUpperCase(), attrs: { "aria-hidden": "true" } });
  element.style.background = avatarColor(address || name);
  return element;
}
