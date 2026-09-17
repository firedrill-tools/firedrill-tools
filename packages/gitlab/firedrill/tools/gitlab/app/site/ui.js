// DOM, Firedrill-client and interaction helpers for the GitLab Tool app (Pajamas-style building blocks).
// Every record string is rendered through textContent; nothing here parses HTML.
import { getContext, invoke } from "/_firedrill/client.js";
import { icon } from "./icons.js";

export { icon };
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Create an element. options: { class, text, title, href, attrs }. Text always goes through textContent. */
export function el(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.class) element.className = options.class;
  if (options.text !== undefined && options.text !== null) element.textContent = String(options.text);
  if (options.title !== undefined) element.title = options.title;
  if (options.href !== undefined) element.setAttribute("href", options.href);
  if (options.attrs) for (const [name, value] of Object.entries(options.attrs)) if (value !== undefined && value !== null && value !== false) element.setAttribute(name, value === true ? "" : String(value));
  for (const child of Array.isArray(children) ? children : [children]) if (child !== undefined && child !== null && child !== false) element.append(child);
  return element;
}

export function clear(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
  return element;
}

/** Pajamas GlButton. variant: default | confirm | danger | dashed | link | tertiary; size: md | sm. */
export function button(label, { variant = "default", size = "md", icon: iconName, trailingIcon, onClick, type = "button", disabled = false, class: extra = "", title, ariaLabel, selected = false } = {}) {
  const element = el("button", { class: `gl-button btn-${variant} btn-${size} ${label ? "" : "btn-icon"} ${selected ? "selected" : ""} ${extra}`.replace(/\s+/g, " ").trim(), title, attrs: { type, "aria-label": ariaLabel ?? (label ? undefined : title) } });
  if (iconName) element.append(icon(iconName, "gl-button-icon"));
  if (label) element.append(el("span", { class: "gl-button-text", text: label }));
  if (trailingIcon) element.append(icon(trailingIcon, "gl-button-icon trailing"));
  element.disabled = disabled;
  if (onClick) element.addEventListener("click", onClick);
  return element;
}

export function iconButton(name, label, { onClick, class: extra = "", variant = "tertiary", size = "md" } = {}) {
  return button("", { variant, size, icon: name, title: label, ariaLabel: label, onClick, class: extra });
}

export function link(text, href, className = "gl-link") {
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
    return this.code === code || String(this.code).endsWith(`.${code}`);
  }
}

/** Invoke one Tool operation; throws ToolError for every non-ok outcome. */
export async function call(operationId, args = {}, idempotencyKey) {
  const result = await invoke(operationId, args, idempotencyKey ? { idempotencyKey } : {});
  const outcome = result?.outcome ?? {};
  if (outcome.status !== "ok") {
    const error = outcome.error ?? {};
    throw new ToolError(outcome.status ?? "error", error.code ?? outcome.status ?? "error", error.message ?? `The request was ${outcome.status ?? "not completed"}.`, error.details);
  }
  return outcome.value;
}

/**
 * Up to maxPages pages of a paginated list (GitLab page/per_page). complete is false when more pages remain, so callers
 * can say the list was cut short instead of silently hiding the rest. Pages are byte-aware, so the cap is in pages.
 */
export async function pageUpTo(fetchPage, { perPage = 100, maxPages = 100 } = {}) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchPage({ page, per_page: perPage });
    items.push(...(result.items ?? []));
    const next = result.page?.next_page ?? (result.page_info?.has_next_page ? page + 1 : null);
    if (!next) return { items, complete: true };
  }
  return { items, complete: false };
}

/** Every item of a paginated list, so screens never silently stop at the first page; throws past maxPages. */
export async function pageAll(fetchPage, perPage = 100, maxPages = 100) {
  const { items, complete } = await pageUpTo(fetchPage, { perPage, maxPages });
  if (complete) return items;
  throw new ToolError("error", "TOO_MANY_PAGES", `The list has more than ${maxPages} pages of results; narrow the filter.`);
}

export const newKey = () => crypto.randomUUID();

/** Human sentence for an error, using GitLab's own wording where it has one. */
export function describe(error) {
  if (error instanceof ToolError) {
    if (error.denied) return "You don't have permission to do that. Ask a Firedrill administrator to grant this operation to your actor.";
    if (error.is("UNAUTHORIZED")) return "401 Unauthorized. Your session is no longer valid.";
    if (error.is("RATE_LIMITED")) return `${error.message || "Retry later"} (rate limited).`;
    if (error.status === "invalid") return `Invalid request: ${error.message}`;
    return error.message;
  }
  return error?.message ?? "Something went wrong. Refresh the page and try again.";
}

// ---------------------------------------------------------------------------------------------
// One mutation at a time
// ---------------------------------------------------------------------------------------------

let pending = 0;
export const isPending = () => pending > 0;
function setBusy(delta) {
  pending += delta;
  document.documentElement.toggleAttribute("data-busy", pending > 0);
}

/** Run a user action; a second action is ignored while one is in flight so a write cannot be submitted twice. */
export async function action(task, { onError } = {}) {
  if (pending > 0) return undefined;
  setBusy(1);
  try {
    return await task();
  } catch (error) {
    if (onError) onError(error);
    else toast(describe(error), "danger");
    return undefined;
  } finally {
    setBusy(-1);
  }
}

// ---------------------------------------------------------------------------------------------
// Alerts and toasts (GlAlert / GlToast)
// ---------------------------------------------------------------------------------------------

/** GlAlert element. variant: info | success | warning | danger | tip. */
export function alert(text, variant = "info", { title, dismissible = false, actions = [] } = {}) {
  const iconName = { info: "information-o", success: "check-circle", warning: "warning", danger: "error", tip: "bulb" }[variant] ?? "information-o";
  const box = el("div", { class: `gl-alert gl-alert-${variant}`, attrs: { role: variant === "danger" ? "alert" : "status" } });
  box.append(icon(iconName === "error" ? "warning" : iconName, "gl-alert-icon"));
  const content = el("div", { class: "gl-alert-content" });
  if (title) content.append(el("h2", { class: "gl-alert-title", text: title }));
  content.append(el("div", { class: "gl-alert-body", text }));
  if (actions.length) content.append(el("div", { class: "gl-alert-actions" }, actions));
  box.append(content);
  if (dismissible) box.append(iconButton("close", "Dismiss", { class: "gl-alert-dismiss", size: "sm", onClick: () => box.remove() }));
  return box;
}

let toastTimer;
export function toast(text, variant = "default") {
  const host = $("#toasts");
  clear(host);
  const item = el("div", { class: `gl-toast ${variant === "danger" ? "gl-toast-danger" : ""}`, attrs: { role: variant === "danger" ? "alert" : "status" } }, [el("span", { text })]);
  const close = iconButton("close", "Dismiss", { size: "sm", class: "gl-toast-close", onClick: () => clear(host) });
  item.append(close);
  host.append(item);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => clear(host), variant === "danger" ? 9000 : 5000);
}

// ---------------------------------------------------------------------------------------------
// Dropdowns (GlDisclosureDropdown / GlCollapsibleListbox)
// ---------------------------------------------------------------------------------------------

let openOverlay;
export function closeMenus() {
  if (!openOverlay) return;
  const overlay = openOverlay;
  openOverlay = undefined;
  overlay.onClose?.();
  overlay.remove();
  if (overlay.anchor?.isConnected) {
    overlay.anchor.setAttribute("aria-expanded", "false");
    if (!document.activeElement || document.activeElement === document.body) overlay.anchor.focus();
  }
}

function place(overlay, anchor, align) {
  const rect = anchor.getBoundingClientRect();
  const width = overlay.offsetWidth;
  const height = overlay.offsetHeight;
  let left = align === "end" ? rect.right - width : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = rect.bottom + 4;
  if (top + height > window.innerHeight - 8 && rect.top - height - 4 > 8) top = rect.top - height - 4;
  overlay.style.left = `${left + window.scrollX}px`;
  overlay.style.top = `${top + window.scrollY}px`;
}

/**
 * Disclosure menu. items: { label, description?, icon?, danger?, disabled?, checked?, count?, onSelect } | "divider" | { header }.
 */
export function openMenu(anchor, items, { align = "start", width, title } = {}) {
  closeMenus();
  const overlay = el("div", { class: "gl-dropdown-panel", attrs: { role: "menu" } });
  overlay.anchor = anchor;
  if (width) overlay.style.width = `${width}px`;
  if (title) overlay.append(el("div", { class: "gl-dropdown-title", text: title }));
  const list = el("ul", { class: "gl-dropdown-list" });
  for (const item of items) {
    if (item === "divider") {
      list.append(el("li", { class: "gl-dropdown-divider", attrs: { role: "separator" } }));
      continue;
    }
    if (item.header) {
      list.append(el("li", { class: "gl-dropdown-section-header", text: item.header }));
      continue;
    }
    const li = el("li", { attrs: { role: "none" } });
    const entry = el("button", { class: `gl-dropdown-item ${item.danger ? "danger" : ""}`.trim(), attrs: { type: "button", role: item.checked === undefined ? "menuitem" : "menuitemradio", "aria-checked": item.checked === undefined ? undefined : String(item.checked) } });
    if (item.checked !== undefined) entry.append(icon("check", `gl-dropdown-check ${item.checked ? "" : "invisible"}`));
    else if (item.icon) entry.append(icon(item.icon, "gl-dropdown-item-icon"));
    const text = el("span", { class: "gl-dropdown-item-text" }, [el("span", { class: "gl-dropdown-item-label", text: item.label })]);
    if (item.description) text.append(el("span", { class: "gl-dropdown-item-description", text: item.description }));
    entry.append(text);
    if (item.count !== undefined) entry.append(el("span", { class: "gl-badge badge-neutral badge-sm", text: String(item.count) }));
    entry.disabled = Boolean(item.disabled);
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
 * Searchable listbox (labels, assignees, branches). options: [{ id, label, description?, swatch?, avatar?, selected }].
 * Multi-select applies on close (GitLab applies sidebar label/assignee edits when the dropdown closes).
 */
export function openListbox(anchor, { title, placeholder = "Search", options, multiple = false, onApply, onSelect, align = "start", emptyText = "No matching results", footer, width = 300 }) {
  closeMenus();
  const overlay = el("div", { class: "gl-dropdown-panel gl-listbox", attrs: { role: "dialog", "aria-label": title } });
  overlay.anchor = anchor;
  overlay.style.width = `${width}px`;
  const selected = new Set(options.filter((option) => option.selected).map((option) => option.id));
  const initial = [...selected].sort().join("\u0000");
  if (title) overlay.append(el("div", { class: "gl-dropdown-title" }, [el("span", { text: title }), iconButton("close", "Close", { size: "sm", onClick: closeMenus })]));
  const search = el("div", { class: "gl-search-box" }, [icon("search", "gl-search-box-icon")]);
  const input = el("input", { class: "gl-search-box-input", attrs: { type: "search", placeholder, "aria-label": placeholder, autocomplete: "off" } });
  search.append(input);
  const list = el("ul", { class: "gl-dropdown-list", attrs: { role: "listbox", "aria-multiselectable": String(multiple) } });
  const render = () => {
    clear(list);
    const term = input.value.trim().toLowerCase();
    const visible = options.filter((option) => !term || option.label.toLowerCase().includes(term) || (option.description ?? "").toLowerCase().includes(term));
    if (visible.length === 0) list.append(el("li", { class: "gl-dropdown-empty", text: emptyText }));
    for (const option of visible) {
      const entry = el("li", { class: "gl-dropdown-item gl-listbox-item", attrs: { role: "option", tabindex: "0", "aria-selected": String(selected.has(option.id)) } });
      entry.append(icon("check", `gl-dropdown-check ${selected.has(option.id) ? "" : "invisible"}`));
      if (option.swatch) {
        const swatch = el("span", { class: "dropdown-label-box" });
        swatch.style.backgroundColor = option.swatch;
        entry.append(swatch);
      }
      if (option.avatar) entry.append(option.avatar);
      const text = el("span", { class: "gl-dropdown-item-text" }, [el("span", { class: "gl-dropdown-item-label", text: option.label })]);
      if (option.description) text.append(el("span", { class: "gl-dropdown-item-description", text: option.description }));
      entry.append(text);
      const choose = () => {
        if (multiple) {
          if (selected.has(option.id)) selected.delete(option.id);
          else selected.add(option.id);
          render();
          list.querySelector(`[data-id="${CSS.escape(String(option.id))}"]`)?.focus();
        } else {
          selected.clear();
          selected.add(option.id);
          closeMenus();
          onSelect?.(option.id);
        }
      };
      entry.dataset.id = String(option.id);
      entry.addEventListener("click", choose);
      entry.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choose();
        }
      });
      list.append(entry);
    }
  };
  input.addEventListener("input", render);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const first = list.querySelector(".gl-listbox-item");
      if (first) {
        event.preventDefault();
        first.click();
      }
    }
  });
  render();
  overlay.append(search, list);
  if (footer) overlay.append(el("div", { class: "gl-dropdown-footer" }, [footer]));
  overlay.onClose = () => {
    if (multiple && onApply && [...selected].sort().join("\u0000") !== initial) onApply([...selected]);
  };
  document.body.append(overlay);
  openOverlay = overlay;
  anchor.setAttribute("aria-expanded", "true");
  place(overlay, anchor, align);
  input.focus();
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
    const items = $$(".gl-dropdown-item:not(:disabled)", openOverlay);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next].focus();
    event.preventDefault();
  }
});

// ---------------------------------------------------------------------------------------------
// Modals (GlModal)
// ---------------------------------------------------------------------------------------------

/** Confirmation modal. Resolves true when confirmed. */
export function confirmModal(title, text, okLabel = "OK", { danger = false } = {}) {
  const dialog = $("#confirm-modal");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  const ok = $("#confirm-ok");
  ok.querySelector(".gl-button-text").textContent = okLabel;
  ok.className = `gl-button btn-md ${danger ? "btn-danger" : "btn-confirm"}`;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true }));
}

/** Generic modal host: build(body, close, footer). Resolves with the value passed to close(). */
export function openModal(title, build, { size = "md" } = {}) {
  const dialog = $("#form-modal");
  dialog.className = `gl-modal modal-${size}`;
  $("#form-modal-title").textContent = title;
  const body = clear($("#form-modal-body"));
  const footer = clear($("#form-modal-footer"));
  let resolved = false;
  return new Promise((resolve) => {
    const close = (value) => {
      if (resolved) return;
      resolved = true;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    build(body, close, footer);
    footer.hidden = footer.childNodes.length === 0;
    dialog.addEventListener("close", () => close(undefined), { once: true });
    $("#form-modal-close").onclick = () => close(undefined);
    dialog.showModal();
    body.querySelector("input, textarea, select, button")?.focus();
  });
}

// ---------------------------------------------------------------------------------------------
// Time (world virtual time, UTC only)
// ---------------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
let worldNowMs;

/** "Now" is the world's virtual time from users.get → server_time, never the browser clock. */
export function setWorldNow(iso) {
  const ms = parseTimestamp(iso);
  worldNowMs = Number.isNaN(ms) ? undefined : ms;
}
export const worldNow = () => worldNowMs;

/** ISO timestamp → epoch ms; a value without a zone designator is read as UTC. */
export function parseTimestamp(iso) {
  if (typeof iso !== "string") return Number.NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return Date.parse(`${iso}T00:00:00Z`);
  const zoned = /([Zz]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  return Date.parse(zoned);
}

/** GitLab's timeago wording: "just now", "5 minutes ago", "3 days ago", "2 weeks ago", "1 month ago", "1 year ago". */
export function timeAgo(iso, nowMs = worldNowMs) {
  const ms = parseTimestamp(iso);
  if (Number.isNaN(ms)) return "";
  if (nowMs === undefined) return formatDate(iso);
  const seconds = Math.round((nowMs - ms) / 1000);
  if (seconds < 0) {
    const ahead = -seconds;
    if (ahead < 60) return "in a moment";
    return `in ${unit(ahead)}`;
  }
  if (seconds < 45) return "just now";
  return `${unit(seconds)} ago`;
}
function unit(seconds) {
  const plural = (count, name) => `${count} ${name}${count === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(Math.max(1, minutes), "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 7) return plural(days, "day");
  if (days < 30) return plural(Math.round(days / 7), "week");
  if (days < 365) return plural(Math.max(1, Math.round(days / 30)), "month");
  return plural(Math.round(days / 365), "year");
}

/** "Sep 15, 2026" in UTC. */
export function formatDate(iso) {
  const ms = parseTimestamp(iso);
  if (Number.isNaN(ms)) return "";
  const date = new Date(ms);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** Tooltip form GitLab shows on hover: "September 15, 2026 at 9:00:00 AM UTC". */
export function fullDate(iso) {
  const ms = parseTimestamp(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "UTC", timeZoneName: "short" });
}

export function timeElement(iso, className = "") {
  return el("time", { class: `js-timeago ${className}`.trim(), text: timeAgo(iso), title: fullDate(iso), attrs: { datetime: iso } });
}

export function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(2)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MiB`;
}

export function plural(count, noun, pluralNoun = `${noun}s`) {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

// ---------------------------------------------------------------------------------------------
// Avatars: GitLab identicons (letter on one of seven pastel backgrounds chosen by id)
// ---------------------------------------------------------------------------------------------

const IDENTICON = [
  ["#fcf1ef", "#8f2110"],
  ["#f4f0ff", "#583cac"],
  ["#f1f1ff", "#3f47ac"],
  ["#e9f3fc", "#0e4d8d"],
  ["#ecf4ee", "#24663b"],
  ["#fdf1dd", "#8f4700"],
  ["#ececef", "#535158"],
];
export function identiconColors(seed) {
  const number = typeof seed === "number" ? seed : [...String(seed)].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return IDENTICON[Math.abs(number) % IDENTICON.length];
}

/** User avatar (round) — user is { id, username, name } or a string. */
export function avatar(user, size = 24, { square = false } = {}) {
  const name = typeof user === "string" ? user : (user?.name ?? user?.username ?? "?");
  const seed = typeof user === "string" ? user : (user?.id ?? name);
  const [bg, fg] = identiconColors(seed);
  const element = el("span", { class: `gl-avatar gl-avatar-identicon gl-avatar-s${size} ${square ? "gl-avatar-square" : "gl-avatar-circle"}`, text: name.trim().charAt(0).toUpperCase() || "?", attrs: { role: "img", "aria-label": typeof user === "string" ? user : `${name}'s avatar` } });
  element.style.backgroundColor = bg;
  element.style.color = fg;
  return element;
}

/** Project/group avatar tile (rounded square) with the first letter of the name. */
export function projectAvatar(project, size = 32) {
  return avatar({ id: project?.id ?? 0, name: project?.name ?? "?" }, size, { square: true });
}

// ---------------------------------------------------------------------------------------------
// Labels (GlLabel, including scoped `key::value` labels)
// ---------------------------------------------------------------------------------------------

export function textColorFor(hex) {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!value) return "#1f1e24";
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value[1].slice(offset, offset + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1f1e24" : "#ffffff";
}

/** label: { name, color, text_color?, description? } (a bare name renders in GitLab's default label colour). */
export function labelPill(label, { onRemove, href } = {}) {
  const data = typeof label === "string" ? { name: label, color: "#6699cc" } : label;
  const color = data.color ?? "#6699cc";
  const scoped = data.name.includes("::");
  const pill = el(href ? "a" : "span", { class: `gl-label ${scoped ? "gl-label-scoped" : ""}`.trim(), title: data.description ?? "", href });
  pill.style.setProperty("--label-background-color", color);
  pill.style.setProperty("--label-inset-border", `inset 0 0 0 2px ${color}`);
  if (scoped) {
    const index = data.name.lastIndexOf("::");
    const key = el("span", { class: "gl-label-text", text: data.name.slice(0, index) });
    key.style.color = textColorFor(color);
    pill.append(key, el("span", { class: "gl-label-text-scoped", text: data.name.slice(index + 2) }));
  } else {
    const text = el("span", { class: "gl-label-text", text: data.name });
    text.style.color = textColorFor(color);
    pill.append(text);
  }
  if (onRemove) {
    const remove = el("button", { class: "gl-label-close", attrs: { type: "button", "aria-label": `Remove label ${data.name}` } }, [icon("close", "", 12)]);
    remove.style.color = scoped ? "#1f1e24" : textColorFor(color);
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onRemove();
    });
    pill.append(remove);
  }
  return pill;
}

// ---------------------------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------------------------

export function badge(text, variant = "neutral", { icon: iconName, size = "md", title } = {}) {
  const element = el("span", { class: `gl-badge badge-${variant} badge-${size}`, title });
  if (iconName) element.append(icon(iconName, "gl-badge-icon", 14));
  if (text) element.append(el("span", { class: "gl-badge-content", text }));
  return element;
}

// ---------------------------------------------------------------------------------------------
// Minimal GitLab Flavored Markdown, built with DOM nodes only
// ---------------------------------------------------------------------------------------------

function inline(text, { refHref, labelFor } = {}) {
  const fragment = document.createDocumentFragment();
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(_[^_\s][^_]*_|\*[^*\s][^*]*\*)|(~"[^"]+"|~[\w:.-]+)|((?<![\w/])[#!]\d+)|(@[\w.-]+[\w])/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) fragment.append(text.slice(last, match.index));
    const token = match[0];
    if (match[1]) fragment.append(el("code", { text: token.slice(1, -1) }));
    else if (match[2]) fragment.append(el("strong", { text: token.slice(2, -2) }));
    else if (match[3]) fragment.append(el("em", { text: token.slice(1, -1) }));
    else if (match[4]) {
      const name = token.startsWith('~"') ? token.slice(2, -1) : token.slice(1);
      const known = labelFor?.(name);
      fragment.append(known ? labelPill(known) : el("span", { class: "gfm gfm-label", text: name }));
    }
    else if (match[5]) {
      const href = refHref?.(token[0], Number(token.slice(1)));
      fragment.append(href ? el("a", { class: "gfm gfm-issue", text: token, href }) : el("span", { class: "gfm gfm-issue", text: token }));
    } else fragment.append(el("span", { class: "gfm gfm-project_member", text: token }));
    last = match.index + token.length;
  }
  if (last < text.length) fragment.append(text.slice(last));
  return fragment;
}

/** Render Markdown-ish text into `.md` (headings, paragraphs, lists, task lists, fenced code, quotes, inline marks). */
export function markdown(text, options = {}) {
  const root = el("div", { class: "md" });
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      const p = el("p", { attrs: { dir: "auto" } });
      paragraph.forEach((line, index) => {
        if (index > 0) p.append(el("br"));
        p.append(inline(line, options));
      });
      root.append(p);
    }
    paragraph = [];
  };
  const flushList = () => {
    if (list) root.append(list.element);
    list = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```/.test(line)) {
      flushParagraph();
      flushList();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      root.append(el("pre", { class: "code highlight" }, [el("code", { text: code.join("\n") })]));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      root.append(el(`h${heading[1].length}`, {}, [inline(heading[2], options)]));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      root.append(el("blockquote", {}, [el("p", {}, [inline(quote[1], options)])]));
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const ordered = /^\s*\d+\./.test(line);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, element: el(ordered ? "ol" : "ul") };
      }
      const task = /^\[( |x)\]\s+(.*)$/i.exec(item[1]);
      if (task) {
        list.element.classList.add("task-list");
        const li = el("li", { class: "task-list-item" });
        const box = el("input", { class: "task-list-item-checkbox", attrs: { type: "checkbox", disabled: true } });
        box.checked = task[1].toLowerCase() === "x";
        li.append(box, " ", inline(task[2], options));
        list.element.append(li);
      } else list.element.append(el("li", {}, [inline(item[1], options)]));
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return root;
}

// ---------------------------------------------------------------------------------------------
// Per-viewer preferences (convenience only, never authority)
// ---------------------------------------------------------------------------------------------

export function readPreference(name, fallback) {
  try {
    return localStorage.getItem(`gitlab-tool:${name}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePreference(name, value) {
  try {
    localStorage.setItem(`gitlab-tool:${name}`, value);
  } catch {
    /* storage blocked: the preference does not persist */
  }
}

export async function copyText(text, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} to clipboard`);
  } catch {
    toast("Copy failed. Select the text and copy it manually.", "danger");
  }
}

// ---------------------------------------------------------------------------------------------
// World revision polling
// ---------------------------------------------------------------------------------------------

/** Poll getContext().revision and refresh when the world changed (agent activity, reset, other tabs). */
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
        if (first || mayRefresh()) {
          revision = stamp;
          await refresh(first);
        }
      }
    } catch (error) {
      toast(error?.message ?? "The local environment is unavailable.", "danger");
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), 2000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  return check();
}

export { getContext };
