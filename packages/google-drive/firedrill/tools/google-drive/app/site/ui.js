// DOM, Firedrill-client and interaction helpers for the Google Drive Tool app.
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
  const button = el("button", {
    class: `icon-btn ${options.class ?? ""}`.trim(),
    title: options.tooltip === false ? undefined : label,
    attrs: { type: "button", "aria-label": label, ...(options.attrs ?? {}) },
  });
  button.append(icon(name, options.iconClass));
  if (options.onClick) button.addEventListener("click", options.onClick);
  return button;
}

export function textButton(label, options = {}) {
  const button = el("button", { class: `gd-text-btn ${options.class ?? ""}`.trim(), text: label, attrs: { type: options.type ?? "button", ...(options.attrs ?? {}) } });
  if (options.onClick) button.addEventListener("click", options.onClick);
  return button;
}

export function filledButton(label, options = {}) {
  const button = el("button", { class: `gd-filled-btn ${options.class ?? ""}`.trim(), text: label, attrs: { type: options.type ?? "button", ...(options.attrs ?? {}) } });
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

/** Drive's own wording for the errors this Tool declares. */
export function describe(error) {
  if (error instanceof ToolError) {
    if (error.denied) return "You don't have access to do that with this account.";
    if (error.is("BACKEND_ERROR")) return "Drive is temporarily unavailable (500). Nothing was changed — try again in a moment.";
    if (error.is("RATE_LIMITED")) return "Couldn't complete the action: too many requests. Nothing was changed — try again in about 30 seconds.";
    if (error.is("SHARING_RATE_LIMITED")) return "You've exceeded your sharing quota. Try sharing this item again later.";
    if (error.is("STORAGE_QUOTA_EXCEEDED")) return "Not enough storage. Free up space in Drive and try again.";
    if (error.is("FORBIDDEN")) return "You need permission from the owner to do that.";
    if (error.is("NOT_FOUND")) return "This item no longer exists, or you don't have access to it.";
    if (error.is("NOT_EXPORTABLE")) return "This file can't be opened here. Download it instead.";
    if (error.is("INVALID_SHARING_REQUEST")) return `Couldn't share this item: ${error.message}`;
    if (error.is("INVALID_PAGE_TOKEN")) return "That page of results is no longer available. Refreshing.";
    if (error.is("FAILED_PRECONDITION")) return error.message;
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
  const bar = $("#loading");
  if (bar) bar.hidden = pending === 0;
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
// Snackbar (bottom-left toast with an optional action), the way Drive confirms moves and deletions
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
  const host = $("#snackbar");
  if (host) host.hidden = true;
}

// ---------------------------------------------------------------------------------------------
// Popover menus (the ⋮ row menu, the New menu, the filter chips)
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
export const menuOpen = () => openMenuElement !== undefined;

/**
 * Open a Material menu anchored to `anchor`. `content` is either an array of items
 * ({ label, icon?, iconImage?, checked?, radio?, disabled?, hint?, submenu?, onSelect, keepOpen? } or "divider")
 * or a prebuilt element.
 */
export function openMenu(anchor, content, { align = "start", className = "", header, point } = {}) {
  closeMenus();
  const menu = el("div", { class: `gd-menu ${className}`.trim(), attrs: { role: "menu" } });
  menu.anchor = anchor;
  if (header) menu.append(el("div", { class: "gd-menu-header", text: header }));
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item === "divider") {
        menu.append(el("div", { class: "gd-menu-divider", attrs: { role: "separator" } }));
        continue;
      }
      const role = item.checked !== undefined ? "menuitemcheckbox" : item.radio !== undefined ? "menuitemradio" : "menuitem";
      const button = el("button", { class: `gd-menu-item ${item.radio ? "is-selected" : ""}`.trim(), attrs: { type: "button", role, "aria-checked": item.checked ?? item.radio } });
      if (item.checked !== undefined) button.append(icon(item.checked ? "check" : "", "menu-icon"));
      else if (item.radio !== undefined) button.append(item.radio ? icon("check", "menu-icon") : el("span", { class: "menu-icon" }));
      else if (item.iconImage) button.append(el("img", { class: "menu-icon-img", attrs: { src: item.iconImage, alt: "", width: 20, height: 20 } }));
      else if (item.icon) button.append(icon(item.icon, "menu-icon"));
      else button.append(el("span", { class: "menu-icon" }));
      button.append(el("span", { class: "gd-menu-label", text: item.label }));
      if (item.hint) button.append(el("span", { class: "gd-menu-hint", text: item.hint }));
      if (item.submenu) button.append(icon("chevron_right", "gd-menu-arrow"));
      if (item.disabled) button.disabled = true;
      button.addEventListener("click", (event) => {
        if (item.submenu) {
          event.stopPropagation();
          const parentAnchor = anchor;
          closeMenus();
          openMenu(parentAnchor, item.submenu(), { align, className, point: { x: button.getBoundingClientRect().right, y: button.getBoundingClientRect().top } });
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
  const rect = point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = align === "end" ? rect.right - width : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = (point ? rect.top : rect.bottom) + 4;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector("button:not(:disabled)")?.focus();
  return menu;
}

document.addEventListener("pointerdown", (event) => {
  if (openMenuElement && !openMenuElement.contains(event.target) && !openMenuElement.anchor?.contains(event.target)) closeMenus();
});
document.addEventListener("keydown", (event) => {
  if (!openMenuElement) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
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
// Dialogs
// ---------------------------------------------------------------------------------------------

/** Material confirm dialog; resolves with the value of the chosen button ("cancel" when dismissed). */
export function confirmDialog(title, text, { okLabel = "OK", danger = false } = {}) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  const actions = $("#confirm-actions");
  actions.replaceChildren(
    el("button", { class: "gd-text-btn", text: "Cancel", attrs: { type: "submit", value: "cancel" } }),
    el("button", { class: `gd-filled-btn ${danger ? "is-danger" : ""}`.trim(), text: okLabel, attrs: { type: "submit", value: "ok" } }),
  );
  return new Promise((resolve) => {
    dialog.returnValue = "cancel";
    dialog.addEventListener("close", () => resolve(dialog.returnValue || "cancel"), { once: true });
    dialog.showModal();
    actions.lastElementChild?.focus();
  });
}

/** Open the shared modal shell with a title, body and action row. Returns { dialog, close }. */
export function openModal({ title, body, actions = [], className = "", onClose, labelledBy = "modal-title" } = {}) {
  const dialog = $("#modal");
  dialog.className = `gd-dialog gd-modal ${className}`.trim();
  dialog.setAttribute("aria-labelledby", labelledBy);
  $("#modal-title").textContent = title ?? "";
  $("#modal-title").hidden = !title;
  $("#modal-body").replaceChildren(body ?? "");
  const row = $("#modal-actions");
  row.replaceChildren(...actions);
  row.hidden = actions.length === 0;
  if (!dialog.open) dialog.showModal();
  const handler = () => {
    onClose?.();
    dialog.removeEventListener("close", handler);
  };
  dialog.addEventListener("close", handler);
  return { dialog, close: () => dialog.close() };
}
export const closeModal = () => {
  const dialog = $("#modal");
  if (dialog?.open) dialog.close();
};

// ---------------------------------------------------------------------------------------------
// Per-viewer preferences — a convenience, never authority over records
// ---------------------------------------------------------------------------------------------

export function readPreference(name, fallback) {
  try {
    return localStorage.getItem(`google-drive-tool:${name}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePreference(name, value) {
  try {
    localStorage.setItem(`google-drive-tool:${name}`, value);
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
        // A change noticed while a form is open stays pending: the revision is only recorded once refreshed.
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

const AVATAR_COLORS = ["#1e88e5", "#d81b60", "#8e24aa", "#43a047", "#f4511e", "#00897b", "#3949ab", "#6d4c41", "#e53935", "#039be5", "#7cb342", "#fb8c00"];
export function avatarColor(seed) {
  let hash = 0;
  for (const character of String(seed)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Letter avatar the way the sharing dialog and the Owner column show people. */
export function avatar(name, address, size = "") {
  const element = el("span", { class: `gd-avatar ${size}`.trim(), text: (name || address || "?").trim().charAt(0).toUpperCase(), attrs: { "aria-hidden": "true" } });
  element.style.background = avatarColor(address || name);
  return element;
}
