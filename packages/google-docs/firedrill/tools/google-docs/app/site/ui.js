// DOM, Firedrill-client and interaction helpers for the Google Docs Tool app.
// Every string that comes from the world is written with textContent; nothing is ever parsed as HTML.
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
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value === undefined || value === null || value === false) continue;
      element.setAttribute(name, value === true ? "" : String(value));
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null || child === false) continue;
    element.append(child);
  }
  return element;
}

export function iconButton(name, label, options = {}) {
  const button = el("button", {
    class: `icon-btn ${options.class ?? ""}`.trim(),
    title: options.tooltip === false ? undefined : label,
    attrs: { type: "button", "aria-label": label, ...(options.attrs ?? {}) },
  });
  button.append(icon(name));
  if (options.onClick) button.addEventListener("click", options.onClick);
  return button;
}

export function button(kind, label, options = {}) {
  const node = el("button", { class: `${kind} ${options.class ?? ""}`.trim(), attrs: { type: "button", ...(options.attrs ?? {}) } });
  if (options.icon) node.append(icon(options.icon));
  node.append(el("span", { text: label }));
  if (options.onClick) node.addEventListener("click", options.onClick);
  return node;
}

// ---------------------------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------------------------

export class ToolError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = String(code ?? status);
  }
  get denied() {
    return this.status === "denied";
  }
  is(code) {
    return this.code === `tool.${code}` || this.code === code;
  }
}

let pending = 0;
function busy(delta) {
  pending = Math.max(0, pending + delta);
  const bar = document.getElementById("progress");
  if (bar) bar.hidden = pending === 0;
}

/** Invoke one Tool operation. Throws ToolError for every non-ok outcome so callers handle one shape. */
export async function call(operationId, args = {}, idempotencyKey) {
  busy(1);
  try {
    const result = await invoke(operationId, args, idempotencyKey ? { idempotencyKey } : {});
    if (result.outcome.status !== "ok") {
      const error = result.outcome.error ?? {};
      throw new ToolError(result.outcome.status, error.code ?? result.outcome.status, error.message ?? `The call was ${result.outcome.status}.`);
    }
    return result.outcome.value;
  } finally {
    busy(-1);
  }
}

export const newKey = () => crypto.randomUUID();
export { getContext };

/** Google's own wording for the errors this Tool declares, so the app never invents a message. */
export function describe(error) {
  if (error instanceof ToolError) {
    if (error.denied) return "This actor is not granted that operation in the Firedrill world.";
    if (error.is("PERMISSION_DENIED")) return "You need access. Ask the owner for permission to make this change.";
    if (error.is("NOT_FOUND")) return "The document was not found. It may have been deleted, or you may not have access.";
    if (error.is("RATE_LIMITED")) return "Too many requests. Nothing was changed — try again in about 30 seconds.";
    if (error.is("BACKEND_ERROR")) return "Internal error encountered. Nothing was changed — try again in a moment.";
    if (error.is("UNAVAILABLE")) return "The service is currently unavailable. The edit may or may not have been saved — reload before retrying.";
    if (error.is("FAILED_PRECONDITION")) return error.message;
    if (error.is("INVALID_ARGUMENT")) return error.message;
    if (error.is("INVALID_SHARING_REQUEST")) return error.message;
    if (error.is("NOT_EXPORTABLE")) return "This file cannot be exported in that format.";
    if (error.is("INVALID_PAGE_TOKEN")) return "That page of results expired. Reloading from the first page.";
    return error.message;
  }
  return error?.message ?? "Something went wrong.";
}

// ---------------------------------------------------------------------------------------------
// Time — never the browser clock. `serverTime` comes from about.get (world virtual time).
// ---------------------------------------------------------------------------------------------

const clock = { nowMs: null };
export function setServerTime(rfc3339) {
  const value = Date.parse(rfc3339);
  if (Number.isFinite(value)) clock.nowMs = value;
}
/** True once about.get has told us the world's virtual time. The browser clock is never used. */
export const haveServerTime = () => clock.nowMs !== null;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function parts(ms) {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(),
    hours: d.getUTCHours(), minutes: d.getUTCMinutes(),
  };
}
const pad = (n) => String(n).padStart(2, "0");

function clockText(p) {
  const hour = p.hours % 12 === 0 ? 12 : p.hours % 12;
  return `${hour}:${pad(p.minutes)} ${p.hours < 12 ? "AM" : "PM"}`;
}

/** Drive's "Last opened by me" column format. */
export function listDate(iso) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const p = parts(ms);
  if (clock.nowMs === null) return `${MONTHS[p.month]} ${p.day}, ${p.year}`;
  const now = parts(clock.nowMs);
  const sameDay = now.year === p.year && now.month === p.month && now.day === p.day;
  if (sameDay) return clockText(p);
  if (now.year === p.year) return `${MONTHS[p.month]} ${p.day}`;
  return `${MONTHS[p.month]} ${p.day}, ${p.year}`;
}

/** Docs' "Last edit was …" and comment timestamps. */
export function relative(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (clock.nowMs === null) {
    const absolute = parts(ms);
    return `on ${MONTHS[absolute.month]} ${absolute.day}, ${absolute.year}`;
  }
  const seconds = Math.round((clock.nowMs - ms) / 1000);
  if (seconds < -60) {
    // The world clock is behind this record (for example a fresh world left at virtualTimeUs 0).
    const absolute = parts(ms);
    return `on ${MONTHS[absolute.month]} ${absolute.day}, ${absolute.year}`;
  }
  if (seconds < 45) return "seconds ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const p = parts(ms);
  return `${MONTHS[p.month]} ${p.day}, ${p.year}`;
}

/** Version-history heading: "September 12, 2026, 4:40 PM". */
export function fullDate(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const p = parts(ms);
  return `${MONTHS_LONG[p.month]} ${p.day}, ${p.year}, ${clockText(p)}`;
}

// ---------------------------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------------------------

export function initials(name, email) {
  const source = (name ?? "").trim() || (email ?? "").trim();
  if (!source) return "?";
  const words = source.split(/[\s@._-]+/).filter(Boolean);
  return (words[0]?.[0] ?? "?").toUpperCase();
}

export function avatarClass(email) {
  let hash = 0;
  for (const ch of String(email ?? "")) hash = (hash * 31 + ch.codePointAt(0)) % 997;
  return `c${(hash % 6) + 1}`;
}

export function avatar(user, small = false) {
  const node = el("span", {
    class: `avatar ${small ? "small " : ""}${avatarClass(user?.emailAddress)}`,
    text: initials(user?.displayName, user?.emailAddress),
    attrs: { "aria-hidden": "true" },
  });
  return node;
}

// ---------------------------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------------------------

let openMenu = null;

/** Close any open menu (and any open submenu) and clear the owner's aria-expanded. */
export function closeMenu() {
  if (!openMenu) return;
  const layer = document.getElementById("menu-layer");
  layer.hidden = true;
  layer.replaceChildren();
  openMenu.owner?.setAttribute?.("aria-expanded", "false");
  openMenu = null;
}

function buildMenu(items, close) {
  const menu = el("div", { class: "menu", attrs: { role: "menu" } });
  for (const item of items) {
    if (!item) continue;
    if (item.divider) { menu.append(el("div", { class: "menu-divider" })); continue; }
    if (item.header) { menu.append(el("div", { class: "menu-label", text: item.header })); continue; }
    const row = el("button", {
      class: `menu-row${item.checked ? " checked" : ""}`,
      attrs: { type: "button", role: "menuitem", disabled: item.disabled === true, title: item.title },
    });
    row.append(el("span", { class: "leading" }, item.checked ? icon("done") : item.icon ? icon(item.icon) : null));
    row.append(el("span", { class: item.styleClass ?? "", text: item.label }));
    if (item.submenu) row.append(el("span", { class: "shortcut" }, icon("chevron_right")));
    else if (item.shortcut) row.append(el("span", { class: "shortcut", text: item.shortcut }));
    if (!item.disabled && item.submenu) {
      const open = () => {
        const layer = document.getElementById("menu-layer");
        for (const extra of [...layer.children].slice(1)) extra.remove();
        const child = buildMenu(typeof item.submenu === "function" ? item.submenu() : item.submenu, close);
        layer.append(child);
        const box = row.getBoundingClientRect();
        const width = Math.min(340, Math.max(200, child.offsetWidth));
        const left = Math.min(box.right - 4, window.innerWidth - width - 8);
        const top = Math.min(box.top - 8, window.innerHeight - child.offsetHeight - 8);
        child.style.left = `${Math.round(Math.max(8, left))}px`;
        child.style.top = `${Math.round(Math.max(8, top))}px`;
      };
      row.addEventListener("click", open);
      row.addEventListener("mouseenter", open);
    } else if (!item.disabled && item.onSelect) {
      row.addEventListener("click", () => { close(); item.onSelect(); });
    } else if (!item.disabled) {
      row.addEventListener("mouseenter", () => {
        const layer = document.getElementById("menu-layer");
        for (const extra of [...layer.children].slice(1)) extra.remove();
      });
    }
    menu.append(row);
  }
  return menu;
}

/**
 * Open a menu anchored to `owner`.
 * items: { label, icon?, shortcut?, disabled?, checked?, styleClass?, divider?, header?, submenu?, onSelect? }
 */
export function openMenuFor(owner, items, options = {}) {
  const wasOpen = openMenu?.owner === owner;
  closeMenu();
  if (wasOpen) return;
  const layer = document.getElementById("menu-layer");
  const menu = buildMenu(items, closeMenu);
  layer.replaceChildren(menu);
  layer.hidden = false;

  const box = owner.getBoundingClientRect();
  const width = Math.min(340, Math.max(200, menu.offsetWidth));
  let left = options.align === "right" ? box.right - width : box.left;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  const belowSpace = window.innerHeight - box.bottom - 8;
  const height = menu.offsetHeight;
  const top = height > belowSpace && box.top > height ? Math.max(8, box.top - height - 4) : box.bottom + 4;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  owner.setAttribute?.("aria-expanded", "true");
  openMenu = { owner };
  menu.querySelector(".menu-row:not(:disabled)")?.focus?.();
}

/** True while a menu is open — the editor uses it to keep its selection highlighted. */
export const menuIsOpen = () => openMenu !== null;

document.addEventListener("pointerdown", (event) => {
  if (!openMenu) return;
  const layer = document.getElementById("menu-layer");
  if (layer.hidden) return;
  if ([...layer.children].some((menu) => menu.contains(event.target))) return;
  if (openMenu.owner?.contains?.(event.target)) return;
  closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});

// ---------------------------------------------------------------------------------------------
// Dialog and snackbar
// ---------------------------------------------------------------------------------------------

/** Open the shared dialog. `render(body, closeWith)` fills it; `actions(closeWith)` returns buttons. */
export function openDialog({ title, render, actions, onClose, width }) {
  const dialog = document.getElementById("dialog");
  const body = document.getElementById("dialog-body");
  const bar = document.getElementById("dialog-actions");
  document.getElementById("dialog-title").textContent = title;
  body.replaceChildren();
  bar.replaceChildren();
  dialog.style.width = width ? `${width}px` : "";
  let result;
  const closeWith = (value) => { result = value; dialog.close(); };
  render?.(body, closeWith);
  for (const node of actions?.(closeWith) ?? []) bar.append(node);
  dialog.addEventListener("close", () => { onClose?.(result); }, { once: true });
  if (!dialog.open) dialog.showModal();
  body.querySelector("input, textarea, select, button")?.focus();
  return closeWith;
}

export function confirmDialog({ title, text, confirmLabel = "OK", danger = false }) {
  return new Promise((resolve) => {
    openDialog({
      title,
      render: (body) => body.append(el("p", { text })),
      actions: (closeWith) => [
        button("text-btn", "Cancel", { onClick: () => closeWith(false) }),
        button("filled-btn", confirmLabel, { class: danger ? "danger" : "", onClick: () => closeWith(true) }),
      ],
      onClose: (value) => resolve(value === true),
    });
  });
}

let snackTimer;
export function snack(text, action) {
  const bar = document.getElementById("snackbar");
  document.getElementById("snackbar-text").textContent = text;
  const actionButton = document.getElementById("snackbar-action");
  actionButton.replaceChildren(document.createTextNode(action?.label ?? ""));
  actionButton.hidden = !action;
  actionButton.onclick = action ? () => { bar.hidden = true; action.onSelect(); } : null;
  bar.hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => { bar.hidden = true; }, action ? 9000 : 5000);
}

export function placeholder(iconName, title, text, action) {
  const node = el("div", { class: "placeholder" });
  const glyph = icon(iconName);
  glyph.setAttribute("width", "48");
  glyph.setAttribute("height", "48");
  node.append(glyph, el("h3", { text: title }), el("p", { text }));
  if (action) node.append(el("div", {}, button("text-btn", action.label, { onClick: action.onSelect })));
  return node;
}

export function skeletonRows(count = 5) {
  const wrap = el("div", {});
  for (let index = 0; index < count; index += 1) {
    wrap.append(el("div", { class: "skeleton-row" }, [
      el("span", { class: "skeleton-box icon" }),
      el("span", { class: "skeleton-box title" }),
      el("span", { class: "skeleton-box meta" }),
    ]));
  }
  return wrap;
}
