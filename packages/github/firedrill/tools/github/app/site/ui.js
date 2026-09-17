// DOM, Firedrill-client and interaction helpers for the GitHub Tool app (Primer-style building blocks).
import { getContext, invoke } from "/_firedrill/client.js";
import { icon } from "./icons.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Create an element. `options`: { class, text, title, href, attrs: {…} }. Text always goes through textContent. */
export function el(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.class) element.className = options.class;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.title !== undefined) element.title = options.title;
  if (options.href !== undefined) element.setAttribute("href", options.href);
  if (options.attrs) for (const [name, value] of Object.entries(options.attrs)) if (value !== undefined && value !== null) element.setAttribute(name, String(value));
  for (const child of Array.isArray(children) ? children : [children]) if (child !== undefined && child !== null && child !== false) element.append(child);
  return element;
}

export function clear(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
  return element;
}

/** Primer button. variant: default | primary | danger | invisible | link; size: "" | sm | lg. */
export function button(label, { variant = "default", size = "", icon: iconName, trailingIcon, onClick, type = "button", disabled = false, class: extra = "", title, ariaLabel } = {}) {
  const element = el("button", { class: `btn btn-${variant} ${size ? `btn-${size}` : ""} ${extra}`.trim(), title, attrs: { type, "aria-label": ariaLabel } });
  if (iconName) element.append(icon(iconName, "btn-icon"));
  if (label !== undefined && label !== "") element.append(el("span", { class: "btn-label", text: label }));
  if (trailingIcon) element.append(icon(trailingIcon, "btn-trailing"));
  element.disabled = disabled;
  if (onClick) element.addEventListener("click", onClick);
  return element;
}

export function iconButton(name, label, { onClick, class: extra = "", size = 16 } = {}) {
  const element = el("button", { class: `btn btn-icon-only ${extra}`.trim(), title: label, attrs: { type: "button", "aria-label": label } });
  element.append(icon(name, "", size));
  if (onClick) element.addEventListener("click", onClick);
  return element;
}

export function link(text, href, className = "Link") {
  return el("a", { class: className, text, href });
}

// ---------------------------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------------------------

export class ToolError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
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
    throw new ToolError(result.outcome.status, error.code ?? result.outcome.status, error.message ?? `The operation was ${result.outcome.status}.`, error.details);
  }
  return result.outcome.value;
}

/**
 * Every item of a paginated list: `fetchPage({ page, perPage })` is called until a short page (or `total_count`)
 * ends the list, so screens never silently show only the first page.
 */
export async function pageAll(fetchPage, listKey, perPage = 100) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const result = await fetchPage({ page, perPage });
    const items = Array.isArray(result[listKey]) ? result[listKey] : [];
    all.push(...items);
    const total = typeof result.total_count === "number" ? result.total_count : undefined;
    // Pages are cut by bytes as well as count, so a short page is not the end: follow total_pages when present.
    const done = typeof result.total_pages === "number" ? page >= result.total_pages : items.length < perPage || (total !== undefined && all.length >= total);
    if (done || items.length === 0) return { ...result, [listKey]: all, total_count: total ?? all.length };
  }
}

export const key = () => crypto.randomUUID();

/** Human sentence for an error, in the words GitHub uses where it has them. */
export function describe(error) {
  if (error instanceof ToolError) {
    if (error.denied) return "You don't have permission to do that.";
    if (error.is("UNAUTHORIZED")) return "Bad credentials";
    if (error.is("RATE_LIMITED")) return error.message || "API rate limit exceeded. Try again later.";
    if (error.is("SERVICE_UNAVAILABLE")) return error.message || "Merging is currently unavailable.";
    if (error.status === "invalid") return `Validation failed: ${error.message}`;
    if (error.is("VALIDATION_FAILED")) {
      const detail = validationDetail(error);
      return detail ? `${error.message}: ${detail}` : error.message;
    }
    const detail = validationDetail(error);
    return detail ? `${error.message} (${detail})` : error.message;
  }
  return error?.message ?? "Something went wrong. Refresh and try again.";
}

/** First GitHub-style `errors[]` entry message from a 422 detail block, if present. */
export function validationDetail(error) {
  const list = error?.details?.errors;
  if (!Array.isArray(list) || list.length === 0) return "";
  const first = list[0];
  if (typeof first.message === "string" && first.message) return first.message;
  const parts = [first.resource, first.field, first.code].filter((part) => typeof part === "string");
  return parts.join(" ");
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
    else flash(describe(error), "error");
    return undefined;
  } finally {
    setBusy(-1);
  }
}

// ---------------------------------------------------------------------------------------------
// Flash banners (Primer .flash at the top of the content column)
// ---------------------------------------------------------------------------------------------

let flashTimer;
export function flash(text, kind = "default", { sticky = false, actionLabel, onAction } = {}) {
  const host = $("#flash");
  clear(host);
  const banner = el("div", { class: `flash flash-${kind}`, attrs: { role: kind === "error" ? "alert" : "status" } });
  banner.append(icon(kind === "error" ? "alert" : kind === "success" ? "check" : "info", "flash-icon"));
  banner.append(el("span", { class: "flash-text", text }));
  if (actionLabel) banner.append(button(actionLabel, { size: "sm", class: "flash-action", onClick: onAction }));
  banner.append(iconButton("x", "Dismiss", { class: "flash-close", onClick: hideFlash }));
  host.append(banner);
  host.hidden = false;
  clearTimeout(flashTimer);
  if (!sticky) flashTimer = setTimeout(hideFlash, 8000);
}
export function hideFlash() {
  clearTimeout(flashTimer);
  const host = $("#flash");
  clear(host);
  host.hidden = true;
}

// ---------------------------------------------------------------------------------------------
// Overlays: action menus and select panels (Primer ActionMenu / SelectPanel)
// ---------------------------------------------------------------------------------------------

let openOverlay;
export function closeMenus() {
  if (openOverlay) {
    const anchor = openOverlay.anchor;
    openOverlay.onClose?.();
    openOverlay.remove();
    openOverlay = undefined;
    if (anchor?.isConnected) {
      anchor.setAttribute("aria-expanded", "false");
      if (!document.activeElement || document.activeElement === document.body) anchor.focus();
    }
  }
}

function place(overlay, anchor, align) {
  const rect = anchor.getBoundingClientRect();
  const width = overlay.offsetWidth;
  const height = overlay.offsetHeight;
  let left = align === "end" ? rect.right - width : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = rect.bottom + 4;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
  overlay.style.left = `${left + window.scrollX}px`;
  overlay.style.top = `${top + window.scrollY}px`;
}

/**
 * ActionMenu: items are { label, description?, icon?, danger?, disabled?, checked?, onSelect } or "divider" or { header }.
 */
export function openMenu(anchor, items, { align = "start", width } = {}) {
  closeMenus();
  const overlay = el("div", { class: "overlay action-menu", attrs: { role: "menu" } });
  overlay.anchor = anchor;
  if (width) overlay.style.width = `${width}px`;
  const list = el("ul", { class: "action-list" });
  for (const item of items) {
    if (item === "divider") {
      list.append(el("li", { class: "action-list-divider", attrs: { role: "separator" } }));
      continue;
    }
    if (item.header) {
      list.append(el("li", { class: "action-list-header", text: item.header }));
      continue;
    }
    const li = el("li", { attrs: { role: "none" } });
    const entry = el("button", { class: `action-list-item ${item.danger ? "danger" : ""}`.trim(), attrs: { type: "button", role: item.checked === undefined ? "menuitem" : "menuitemradio", "aria-checked": item.checked === undefined ? undefined : String(item.checked) } });
    const lead = el("span", { class: "action-list-lead" });
    if (item.checked !== undefined) lead.append(icon("check", item.checked ? "" : "invisible"));
    else if (item.icon) lead.append(icon(item.icon));
    entry.append(lead);
    const text = el("span", { class: "action-list-text" }, [el("span", { class: "action-list-label", text: item.label })]);
    if (item.description) text.append(el("span", { class: "action-list-description", text: item.description }));
    entry.append(text);
    if (item.disabled) entry.disabled = true;
    entry.addEventListener("click", () => {
      closeMenus();
      item.onSelect?.();
    });
    li.append(entry);
    list.append(li);
  }
  overlay.append(list);
  document.body.append(overlay);
  openOverlay = overlay;
  anchor.setAttribute("aria-expanded", "true");
  place(overlay, anchor, align);
  overlay.querySelector("button:not(:disabled)")?.focus();
  return overlay;
}

/**
 * SelectPanel: a filterable list with checkboxes/radios. options: [{ id, label, description?, swatch?, avatar?, selected }].
 * onApply(selectedIds) runs when the panel closes (GitHub applies label/assignee changes on close).
 */
export function openSelectPanel(anchor, { title, placeholder = "Filter", options, multiple = true, onApply, onSelect, align = "start", emptyText = "No matches", footer }) {
  closeMenus();
  const overlay = el("div", { class: "overlay select-panel", attrs: { role: "dialog", "aria-label": title } });
  overlay.anchor = anchor;
  const selected = new Set(options.filter((option) => option.selected).map((option) => option.id));
  const head = el("div", { class: "select-panel-head" }, [el("span", { class: "select-panel-title", text: title }), iconButton("x", "Close", { onClick: closeMenus })]);
  const filter = el("input", { class: "form-control select-panel-filter", attrs: { type: "text", placeholder, "aria-label": placeholder, autocomplete: "off" } });
  const list = el("ul", { class: "action-list select-panel-list", attrs: { role: multiple ? "listbox" : "menu" } });
  const render = () => {
    clear(list);
    const term = filter.value.trim().toLowerCase();
    const visible = options.filter((option) => !term || option.label.toLowerCase().includes(term) || (option.description ?? "").toLowerCase().includes(term));
    if (visible.length === 0) list.append(el("li", { class: "action-list-empty", text: emptyText }));
    for (const option of visible) {
      const li = el("li", { attrs: { role: "none" } });
      const entry = el("button", { class: "action-list-item", attrs: { type: "button", role: multiple ? "option" : "menuitemradio", "aria-selected": String(selected.has(option.id)) } });
      const lead = el("span", { class: "action-list-lead" }, [icon("check", selected.has(option.id) ? "" : "invisible")]);
      entry.append(lead);
      if (option.swatch) {
        const swatch = el("span", { class: "label-swatch" });
        swatch.style.background = option.swatch;
        entry.append(swatch);
      }
      if (option.avatar) entry.append(option.avatar);
      const text = el("span", { class: "action-list-text" }, [el("span", { class: "action-list-label", text: option.label })]);
      if (option.description) text.append(el("span", { class: "action-list-description", text: option.description }));
      entry.append(text);
      entry.addEventListener("click", () => {
        if (multiple) {
          if (selected.has(option.id)) selected.delete(option.id);
          else selected.add(option.id);
          render();
        } else {
          selected.clear();
          selected.add(option.id);
          closeMenus();
          onSelect?.(option.id);
        }
      });
      li.append(entry);
      list.append(li);
    }
  };
  filter.addEventListener("input", render);
  render();
  overlay.append(head, el("div", { class: "select-panel-filter-wrap" }, [filter]), list);
  if (footer) overlay.append(el("div", { class: "select-panel-footer" }, [footer]));
  overlay.onClose = () => {
    if (multiple && onApply) onApply([...selected]);
  };
  document.body.append(overlay);
  openOverlay = overlay;
  anchor.setAttribute("aria-expanded", "true");
  place(overlay, anchor, align);
  filter.focus();
  return overlay;
}

document.addEventListener("pointerdown", (event) => {
  if (openOverlay && !openOverlay.contains(event.target) && !openOverlay.anchor?.contains(event.target)) closeMenus();
});
document.addEventListener("keydown", (event) => {
  if (!openOverlay) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenus();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const items = $$(".action-list-item:not(:disabled)", openOverlay);
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

/** Primer-style confirmation dialog. Resolves true when confirmed. */
export function confirmDialog(title, text, okLabel = "OK", { danger = false } = {}) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  const ok = $("#confirm-ok");
  ok.textContent = okLabel;
  ok.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true }));
}

/** Generic dialog host: `build(body, close)` fills the body; returns a promise resolved with the value passed to close(). */
export function openDialog(title, build, { wide = false } = {}) {
  const dialog = $("#form-dialog");
  dialog.classList.toggle("dialog-wide", wide);
  $("#form-dialog-title").textContent = title;
  const body = clear($("#form-dialog-body"));
  let resolved = false;
  return new Promise((resolve) => {
    const close = (value) => {
      if (resolved) return;
      resolved = true;
      dialog.close();
      resolve(value);
    };
    build(body, close);
    dialog.addEventListener("close", () => close(undefined), { once: true });
    $("#form-dialog-close").onclick = () => close(undefined);
    dialog.showModal();
    body.querySelector("input, textarea, select, button")?.focus();
  });
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Now" is the world's virtual time (from `users.get-authenticated` → `server_time`), never the browser clock, and
// every calendar field is read in UTC, so the same world renders identically on any machine and any day.
let worldNowMs;

/** Record the world's virtual time (ISO string from the Tool); invalid values leave it unknown. */
export function setWorldNow(iso) {
  const ms = parseTimestamp(iso);
  worldNowMs = Number.isNaN(ms) ? undefined : ms;
}

/** ISO timestamp → epoch ms; a value without a zone designator is read as UTC (never host-local). */
export function parseTimestamp(iso) {
  if (typeof iso !== "string") return Number.NaN;
  const zoned = /([Zz]|[+-]\d{2}:?\d{2})$/.test(iso) || !/T\d{2}:\d{2}/.test(iso) ? iso : `${iso}Z`;
  const text = /^\d{4}-\d{2}-\d{2}$/.test(zoned) ? `${zoned}T00:00:00Z` : zoned;
  return Date.parse(text);
}

function absoluteDay(ms, withYear) {
  const date = new Date(ms);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}${withYear ? `, ${date.getUTCFullYear()}` : ""}`;
}

/** GitHub's relative-time against world time: "now", "5 minutes ago", …, "on Aug 3", "on Aug 3, 2025". */
export function relativeTime(iso, nowMs = worldNowMs) {
  const ms = parseTimestamp(iso);
  if (Number.isNaN(ms)) return "";
  if (nowMs === undefined) return `on ${absoluteDay(ms, true)}`;
  const diff = nowMs - ms;
  // A timestamp after world time (e.g. data authored ahead of a world's clock) has no honest "ago": show the date.
  if (diff < 0) return `on ${absoluteDay(ms, true)}`;
  const seconds = Math.round(diff / 1000);
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (days < 30) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  return `on ${absoluteDay(ms, new Date(ms).getUTCFullYear() !== new Date(nowMs).getUTCFullYear())}`;
}

/** Same as relativeTime without the "on " prefix (for "Updated Aug 3" and commit rows). */
export function shortRelative(iso, nowMs = worldNowMs) {
  return relativeTime(iso, nowMs).replace(/^on /, "");
}

export function dayHeading(iso) {
  const ms = parseTimestamp(iso);
  return Number.isNaN(ms) ? "" : absoluteDay(ms, true);
}

export function fullDate(iso) {
  const ms = parseTimestamp(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
}

export function timeElement(iso, className = "") {
  return el("relative-time", { class: className, text: relativeTime(iso), title: fullDate(iso), attrs: { datetime: iso } });
}

export function formatBytes(size) {
  if (size < 1024) return `${size} Bytes`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function plural(count, noun, pluralNoun = `${noun}s`) {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

// ---------------------------------------------------------------------------------------------
// Avatars (records carry no image URLs; GitHub's default avatar is an identicon → deterministic tinted circle)
// ---------------------------------------------------------------------------------------------

const AVATAR_COLORS = ["#0969da", "#8250df", "#1a7f37", "#bf8700", "#cf222e", "#bc4c00", "#0550ae", "#6639ba", "#116329", "#953800"];
export function avatarColor(seed) {
  let hash = 0;
  for (const character of String(seed)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Square-rounded (org) or circular (user) avatar with the login's initial, sized 16/20/24/32/40. */
export function avatar(user, size = 20) {
  const login = typeof user === "string" ? user : (user?.login ?? "?");
  const type = typeof user === "string" ? "User" : (user?.type ?? "User");
  const element = el("span", { class: `avatar avatar-${size} ${type === "Organization" ? "avatar-org" : ""}`.trim(), text: login.charAt(0).toUpperCase(), title: login, attrs: { "aria-label": login, role: "img" } });
  element.style.background = avatarColor(login);
  return element;
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

function luminance(hex) {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!value) return 1;
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value[1].slice(offset, offset + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** GitHub IssueLabel: background = label colour, text black/white by luminance, subtle border. */
export function labelChip(label, { onRemove } = {}) {
  const color = `#${String(label.color ?? "ededed").replace(/^#/, "")}`;
  const chip = el("span", { class: "IssueLabel", text: label.name, title: label.description ?? "" });
  chip.style.background = color;
  chip.style.color = luminance(color) < 0.6 ? "#ffffff" : "#1f2328";
  chip.style.borderColor = luminance(color) > 0.9 ? "#d1d9e0" : "transparent";
  if (onRemove) {
    const remove = el("button", { class: "IssueLabel-remove", attrs: { type: "button", "aria-label": `Remove ${label.name}` } }, [icon("x")]);
    remove.addEventListener("click", onRemove);
    chip.append(remove);
  }
  return chip;
}

// ---------------------------------------------------------------------------------------------
// Minimal safe Markdown (headings, paragraphs, lists, fenced code, inline code/bold/italic/links as text)
// ---------------------------------------------------------------------------------------------

function inline(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(_[^_]+_|\*[^*]+\*)|(#\d+)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) fragment.append(text.slice(last, match.index));
    const token = match[0];
    if (match[1]) fragment.append(el("code", { text: token.slice(1, -1) }));
    else if (match[2]) fragment.append(el("strong", { text: token.slice(2, -2) }));
    else if (match[3]) fragment.append(el("em", { text: token.slice(1, -1) }));
    else fragment.append(el("span", { class: "issue-ref", text: token }));
    last = match.index + token.length;
  }
  if (last < text.length) fragment.append(text.slice(last));
  return fragment;
}

/** Render Markdown-ish text into a `.markdown-body` element using DOM construction only (no HTML parsing). */
export function markdown(text) {
  const root = el("div", { class: "markdown-body" });
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (paragraph.length > 0) root.append(el("p", {}, [inline(paragraph.join(" "))]));
    paragraph = [];
  };
  const flushList = () => {
    if (list) root.append(list.element);
    list = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^```/.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      root.append(el("pre", {}, [el("code", { text: code.join("\n") })]));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      root.append(el(`h${heading[1].length}`, {}, [inline(heading[2])]));
      continue;
    }
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const ordered = /^\s*\d+\./.test(line);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, element: el(ordered ? "ol" : "ul") };
      }
      const task = /^\[( |x)\]\s+(.*)$/i.exec(item[1]);
      if (task) {
        const li = el("li", { class: "task-list-item" });
        const box = el("input", { attrs: { type: "checkbox", disabled: "" } });
        box.checked = task[1].toLowerCase() === "x";
        li.append(box, " ", inline(task[2]));
        list.element.append(li);
      } else list.element.append(el("li", {}, [inline(item[1])]));
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    if (list) {
      flushList();
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  if (root.childNodes.length === 0) root.append(el("p", { class: "text-muted", text: "No description provided." }));
  return root;
}

// ---------------------------------------------------------------------------------------------
// Per-viewer preferences — convenience only, never authority over records
// ---------------------------------------------------------------------------------------------

export function readPreference(name, fallback) {
  try {
    return localStorage.getItem(`github-tool:${name}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePreference(name, value) {
  try {
    localStorage.setItem(`github-tool:${name}`, value);
  } catch {
    /* blocked storage: the setting simply does not persist */
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
      flash(error?.message ?? "The local environment is unavailable.", "error", { sticky: true });
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), 2000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  return check();
}

export { icon };
