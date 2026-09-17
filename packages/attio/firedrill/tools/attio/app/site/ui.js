// DOM, Tool-client and interaction helpers shared by every screen of the CRM app.
import { getContext, invoke } from "/_firedrill/client.js";
import { icon } from "./icons.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Create an element. Text always goes through textContent; attributes through setAttribute. */
export function el(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.class) element.className = options.class;
  if (options.text !== undefined && options.text !== null) element.textContent = String(options.text);
  if (options.title !== undefined) element.title = options.title;
  if (options.attrs) for (const [name, value] of Object.entries(options.attrs)) if (value !== undefined && value !== null && value !== false) element.setAttribute(name, value === true ? "" : String(value));
  if (options.on) for (const [name, handler] of Object.entries(options.on)) element.addEventListener(name, handler);
  for (const child of Array.isArray(children) ? children : [children]) if (child !== undefined && child !== null && child !== false) element.append(child);
  return element;
}

export function button(label, options = {}) {
  const b = el("button", { class: `at-btn ${options.class ?? ""}`.trim(), title: options.title, attrs: { type: "button", "aria-label": options.ariaLabel, disabled: options.disabled } });
  if (options.icon) b.append(icon(options.icon));
  if (label) b.append(el("span", { text: label }));
  if (options.caret) b.append(icon("chevronDown", "at-caret"));
  if (options.onClick) b.addEventListener("click", options.onClick);
  return b;
}

export function iconButton(name, label, onClick, className = "") {
  const b = el("button", { class: `at-icon-btn ${className}`.trim(), title: label, attrs: { type: "button", "aria-label": label } }, icon(name));
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

// ------------------------------------------------------------------------------------------------------------
// Tool calls

export class ToolError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
  get denied() {
    return this.status === "denied" || this.is("UNAUTHORIZED");
  }
  is(code) {
    return this.code === code || String(this.code).endsWith(`.${code}`);
  }
}

/** Invoke one operation; throws ToolError for every non-ok outcome. Writes pass an idempotency key. */
export async function call(operationId, args = {}, idempotencyKey) {
  const result = await invoke(operationId, args, idempotencyKey ? { idempotencyKey } : {});
  if (result.outcome.status !== "ok") {
    const error = result.outcome.error ?? {};
    throw new ToolError(result.outcome.status, error.code ?? result.outcome.status, error.message ?? `The request was ${result.outcome.status}.`);
  }
  return result.outcome.value;
}

export const newKey = () => crypto.randomUUID();

export function describe(error) {
  if (error instanceof ToolError) {
    if (error.status === "denied") return "You don't have permission to do this in this workspace.";
    if (error.is("RATE_LIMITED")) return "Rate limit exceeded, please try again later.";
    if (error.is("SERVICE_UNAVAILABLE")) return "Attio is temporarily unavailable. Nothing was changed on your side; please retry.";
    return error.message;
  }
  return error?.message ?? "Something went wrong.";
}

// ------------------------------------------------------------------------------------------------------------
// One write at a time (prevents duplicate submissions)

let pending = 0;
export const isPending = () => pending > 0;

export async function action(task, { onError } = {}) {
  if (pending > 0) return undefined;
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

// ------------------------------------------------------------------------------------------------------------
// Toasts (bottom-right, like the web app)

export function toast(text, { error = false, timeout = 5000 } = {}) {
  const host = $("#toasts");
  const item = el("div", { class: `at-toast${error ? " error" : ""}`, attrs: { role: error ? "alert" : "status" } }, [icon(error ? "alert" : "circleCheck"), el("span", { text })]);
  const close = iconButton("x", "Dismiss", () => item.remove(), "small");
  item.append(close);
  host.append(item);
  setTimeout(() => item.remove(), timeout);
}

// ------------------------------------------------------------------------------------------------------------
// Popovers

let openPopover;
export function closePopover() {
  if (!openPopover) return;
  const { element, anchor, onClose } = openPopover;
  openPopover = undefined;
  element.remove();
  anchor?.setAttribute?.("aria-expanded", "false");
  onClose?.();
  if (anchor?.isConnected && (document.activeElement === document.body || !document.activeElement)) anchor.focus();
}
export const popoverOpen = () => openPopover !== undefined;

/** Anchor a popover below `anchor`. `content` is an element; returns the popover element. */
export function popover(anchor, content, { align = "start", className = "", width, onClose } = {}) {
  closePopover();
  const element = el("div", { class: `at-popover ${className}`.trim() }, content);
  if (width) element.style.width = `${width}px`;
  document.body.append(element);
  openPopover = { element, anchor, onClose };
  anchor.setAttribute("aria-expanded", "true");
  const rect = anchor.getBoundingClientRect();
  const w = element.offsetWidth;
  const h = element.offsetHeight;
  let left = align === "end" ? rect.right - w : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = rect.bottom + 4;
  if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 4);
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.querySelector("input, textarea, select, button:not(:disabled)")?.focus();
  return element;
}

/** Menu items: { label, icon?, danger?, disabled?, checked?, hint?, onSelect } or "divider" or { header }. */
export function menu(anchor, items, options = {}) {
  const list = el("div", { class: "at-menu", attrs: { role: "menu" } });
  for (const item of items) {
    if (item === "divider") {
      list.append(el("div", { class: "at-menu-divider", attrs: { role: "separator" } }));
      continue;
    }
    if (item.header) {
      list.append(el("div", { class: "at-menu-header", text: item.header }));
      continue;
    }
    const row = el("button", { class: `at-menu-item${item.danger ? " danger" : ""}`, attrs: { type: "button", role: item.checked === undefined ? "menuitem" : "menuitemcheckbox", "aria-checked": item.checked === undefined ? undefined : String(item.checked), disabled: item.disabled } });
    if (item.leading) row.append(item.leading);
    else if (item.icon) row.append(icon(item.icon));
    row.append(el("span", { class: "at-menu-label", text: item.label }));
    if (item.hint) row.append(el("span", { class: "at-menu-hint", text: item.hint }));
    if (item.checked) row.append(icon("check", "at-menu-check"));
    row.addEventListener("click", () => {
      if (item.notSimulated) return notSimulated(anchor, item.label, item.notSimulated);
      if (!item.keepOpen) closePopover();
      item.onSelect?.();
    });
    list.append(row);
  }
  return popover(anchor, list, options);
}

document.addEventListener("pointerdown", (event) => {
  if (openPopover && !openPopover.element.contains(event.target) && !openPopover.anchor?.contains?.(event.target)) closePopover();
});
document.addEventListener("keydown", (event) => {
  if (!openPopover) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePopover();
  } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && openPopover.element.querySelector(".at-menu")) {
    const items = $$(".at-menu-item:not(:disabled)", openPopover.element);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement);
    items[event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length].focus();
    event.preventDefault();
  }
}, true);

/** Controls from the real product that this Tool does not model: an honest panel, nothing written. */
export function notSimulated(anchor, name, detail) {
  const box = el("div", { class: "at-ns", attrs: { role: "dialog", "aria-label": `${name} is not simulated` } }, [
    el("div", { class: "at-ns-head" }, [icon("sparkle"), el("strong", { text: name })]),
    el("p", { class: "at-ns-lead", text: "Not simulated by this Tool." }),
    detail ? el("p", { text: detail }) : null,
  ]);
  const ok = button("Got it", { class: "small", onClick: () => closePopover() });
  box.append(el("div", { class: "at-ns-actions" }, ok));
  popover(anchor, box, { align: anchor.getBoundingClientRect().left > window.innerWidth / 2 ? "end" : "start", width: 280 });
  ok.focus();
}

// ------------------------------------------------------------------------------------------------------------
// Dialogs

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

/** Generic modal: `render(body, foot, close)` fills it. Returns a promise resolved on close. */
export function openModal({ title, iconElement, render, wide = false }) {
  const dialog = $("#modal");
  dialog.classList.toggle("wide", wide);
  $("#modal-title").textContent = title;
  $("#modal-icon").replaceChildren(iconElement ?? "");
  const body = $("#modal-body");
  const foot = $("#modal-foot");
  body.replaceChildren();
  foot.replaceChildren();
  const close = () => dialog.close();
  $("#modal-close").onclick = close;
  render(body, foot, close);
  dialog.showModal();
  body.querySelector("input, textarea, select")?.focus();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(), { once: true }));
}
export const modalOpen = () => $("#modal").open || $("#confirm-dialog").open || $("#palette").open;

// ------------------------------------------------------------------------------------------------------------
// World revision polling

export function watchWorld(refresh, mayRefresh) {
  let revision;
  let checking = false;
  const check = async () => {
    if (checking || pending > 0 || document.visibilityState !== "visible") return;
    checking = true;
    try {
      const context = await getContext();
      const stamp = JSON.stringify(context.revision);
      if (revision !== stamp && (revision === undefined || mayRefresh())) {
        const first = revision === undefined;
        revision = stamp;
        await refresh(first, context);
      }
    } catch (error) {
      toast(error?.message ?? "The local environment is unavailable.", { error: true });
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), 2000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  return check;
}

// ------------------------------------------------------------------------------------------------------------
// Preferences (per viewer; never authoritative)

export function readPreference(name, fallback) {
  try {
    return localStorage.getItem(`attio-tool:${name}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePreference(name, value) {
  try {
    localStorage.setItem(`attio-tool:${name}`, value);
  } catch {
    /* storage unavailable: the preference simply does not persist */
  }
}
