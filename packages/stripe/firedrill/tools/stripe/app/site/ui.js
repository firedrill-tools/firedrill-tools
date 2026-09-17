// DOM, Firedrill-client, formatting and interaction helpers for the Stripe Tool app. Every piece of record text
// is rendered through textContent; nothing here keeps authoritative data.
import { getContext, invoke } from "/_firedrill/client.js";
import { icon } from "./icons.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Create an element. `options`: { class, text, title, attrs: {…}, on: {event: handler} }. */
export function el(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.class) element.className = options.class;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.title !== undefined) element.title = options.title;
  if (options.attrs) for (const [name, value] of Object.entries(options.attrs)) if (value !== undefined && value !== null && value !== false) element.setAttribute(name, value === true ? "" : String(value));
  if (options.on) for (const [event, handler] of Object.entries(options.on)) element.addEventListener(event, handler);
  for (const child of Array.isArray(children) ? children : [children]) if (child !== undefined && child !== null && child !== false) element.append(child);
  return element;
}

export const text = (value) => document.createTextNode(String(value));

/** Internal link (hash route). */
export function link(href, label, options = {}) {
  return el("a", { class: `link ${options.class ?? ""}`.trim(), text: label, attrs: { href }, title: options.title });
}

/**
 * Stripe-style button. `kind`: primary | secondary | danger | ghost | link. `options`: { icon, iconAfter, size, class, title, disabled, onClick }.
 */
export function button(label, kind = "secondary", options = {}) {
  const element = el("button", { class: `btn btn-${kind} ${options.size ? `btn-${options.size}` : ""} ${options.class ?? ""}`.trim(), title: options.title, attrs: { type: options.type ?? "button", "aria-label": options.ariaLabel } });
  if (options.icon) element.append(icon(options.icon, "btn-icon"));
  if (label !== undefined && label !== null && label !== "") element.append(el("span", { class: "btn-label", text: label }));
  if (options.iconAfter) element.append(icon(options.iconAfter, "btn-icon btn-icon-after"));
  if (options.disabled) element.disabled = true;
  if (options.onClick) element.addEventListener("click", options.onClick);
  return element;
}

export function iconButton(name, label, options = {}) {
  return button(undefined, options.kind ?? "ghost", { ...options, icon: name, ariaLabel: label, title: options.title ?? label, class: `btn-icon-only ${options.class ?? ""}`.trim() });
}

// ---------------------------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------------------------

export class ToolError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details ?? {};
  }
  get denied() {
    return this.status === "denied";
  }
  is(code) {
    return this.code === `tool.${code}` || this.code === code;
  }
  /** Stripe's `error.code` (`resource_missing`, `card_declined`, …) when the Tool provided one. */
  get stripeCode() {
    return typeof this.details.code === "string" ? this.details.code : undefined;
  }
  get param() {
    return typeof this.details.param === "string" ? this.details.param : undefined;
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

export const key = () => crypto.randomUUID();

export function describe(error) {
  if (error instanceof ToolError) {
    if (error.denied) return "Your key is not granted this operation in this Firedrill world.";
    if (error.is("PERMISSION_DENIED")) return error.message;
    if (error.is("API_ERROR")) return "Stripe is temporarily unavailable (503). Nothing was changed; try again in a moment.";
    if (error.is("RATE_LIMITED")) return "Too many requests (429). Wait a moment and try again.";
    if (error.status === "invalid") return `Invalid request: ${error.message}`;
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
    else toast(describe(error), { error: true });
    return undefined;
  } finally {
    setBusy(-1);
  }
}

// ---------------------------------------------------------------------------------------------
// Toasts (bottom-centre, dark, the Dashboard's notification style)
// ---------------------------------------------------------------------------------------------

let toastTimer;
export function toast(message, { error = false, timeout = 5000, actionLabel, onAction } = {}) {
  const host = $("#toast");
  host.replaceChildren(icon(error ? "alert-circle" : "check-circle", "toast-icon"), el("span", { class: "toast-text", text: message }));
  if (actionLabel) {
    host.append(
      button(actionLabel, "link", {
        class: "toast-action",
        onClick: () => {
          hideToast();
          if (onAction) void action(onAction);
        },
      }),
    );
  }
  host.dataset.error = String(error);
  host.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, timeout);
}
export function hideToast() {
  clearTimeout(toastTimer);
  const host = $("#toast");
  if (host) host.hidden = true;
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
 * Open a Dashboard-style menu below `anchor`. `content` is an array of items
 * ({ label, icon?, danger?, disabled?, description?, onSelect }, "divider", or { header }) or a prebuilt element.
 */
export function openMenu(anchor, content, { align = "start", className = "", width } = {}) {
  closeMenus();
  const menu = el("div", { class: `menu ${className}`.trim(), attrs: { role: "menu" } });
  menu.anchor = anchor;
  if (width) menu.style.width = `${width}px`;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item === "divider") {
        menu.append(el("div", { class: "menu-divider", attrs: { role: "separator" } }));
        continue;
      }
      if (item.header !== undefined) {
        menu.append(el("div", { class: "menu-header", text: item.header }));
        continue;
      }
      const entry = el("button", { class: `menu-item ${item.danger ? "danger" : ""}`.trim(), attrs: { type: "button", role: "menuitem" } });
      if (item.icon) entry.append(icon(item.icon, "menu-icon"));
      const labels = el("span", { class: "menu-labels" }, [el("span", { class: "menu-label", text: item.label })]);
      if (item.description) labels.append(el("span", { class: "menu-description", text: item.description }));
      entry.append(labels);
      if (item.shortcut) entry.append(el("kbd", { class: "menu-kbd", text: item.shortcut }));
      if (item.disabled) entry.disabled = true;
      entry.addEventListener("click", () => {
        closeMenus();
        item.onSelect?.();
      });
      menu.append(entry);
    }
  } else menu.append(content);
  document.body.append(menu);
  openMenuElement = menu;
  anchor.setAttribute("aria-expanded", "true");
  const rect = anchor.getBoundingClientRect();
  const menuWidth = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = align === "end" ? rect.right - menuWidth : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
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
    const items = $$(".menu-item:not(:disabled)", openMenuElement);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next].focus();
    event.preventDefault();
  }
});

// ---------------------------------------------------------------------------------------------
// Modal dialogs
// ---------------------------------------------------------------------------------------------

/**
 * Open a modal. `options`: { title, body (element), footer (elements) | actions: [{label, kind, onClick, submit}], size, onClose }.
 * Returns { dialog, close, setError, form }.
 */
export function openModal({ title, body, actions = [], size = "", onClose, describedBy }) {
  const dialog = el("dialog", { class: `modal ${size}`.trim(), attrs: { "aria-labelledby": "modal-title" } });
  const form = el("form", { class: "modal-form", attrs: { method: "dialog", novalidate: true } });
  const header = el("header", { class: "modal-header" }, [el("h2", { class: "modal-title", text: title, attrs: { id: "modal-title" } }), iconButton("close", "Close", { onClick: () => close("cancel") })]);
  const bodyHost = el("div", { class: "modal-body" }, body);
  if (describedBy) bodyHost.prepend(el("p", { class: "modal-lede", text: describedBy }));
  const errorHost = el("div", { class: "form-error", attrs: { role: "alert" } });
  errorHost.hidden = true;
  const footer = el("footer", { class: "modal-footer" });
  let primary;
  for (const item of actions) {
    const control = button(item.label, item.kind ?? "secondary", { icon: item.icon, danger: item.danger, disabled: item.disabled, type: item.submit ? "submit" : "button" });
    if (item.submit) primary = control;
    if (!item.submit) control.addEventListener("click", () => (item.onClick ? item.onClick(api) : close("cancel")));
    footer.append(control);
  }
  bodyHost.append(errorHost);
  form.append(header, bodyHost, footer);
  dialog.append(form);
  document.body.append(dialog);
  let result = "cancel";
  const close = (value = "cancel") => {
    result = value;
    if (dialog.open) dialog.close();
  };
  const api = {
    dialog,
    form,
    close,
    primary,
    setError(message) {
      errorHost.textContent = message ?? "";
      errorHost.hidden = !message;
    },
    setBusy(flag) {
      if (primary) {
        primary.disabled = flag;
        primary.classList.toggle("is-busy", flag);
      }
    },
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const submitAction = actions.find((item) => item.submit);
    if (submitAction?.onClick) void submitAction.onClick(api);
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close("cancel");
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose?.(result);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close("cancel");
  });
  dialog.showModal();
  const first = form.querySelector("input:not([type=hidden]), select, textarea, button.btn-primary, button.btn-danger");
  first?.focus();
  return api;
}

/** Confirmation: title, one sentence, buttons. Resolves true when confirmed. */
export function confirmDialog(title, message, okLabel = "Confirm", { danger = false } = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      size: "modal-sm",
      body: [el("p", { class: "modal-text", text: message })],
      actions: [
        { label: "Cancel" },
        { label: okLabel, kind: danger ? "danger" : "primary", submit: true, onClick: (api) => api.close("ok") },
      ],
      onClose: (result) => resolve(result === "ok"),
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------

let idCounter = 0;
/** Deterministic unique DOM id (a counter, never random). */
export function nextId(prefix = "f") {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

const LABELABLE = "input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select, textarea";

/**
 * Labelled field. `control` is an input/select/textarea, or a composite (amount + currency, customer combobox,
 * payment-method radio list). A native control is linked with `for`; a composite's first text control is linked
 * with `for` and the composite itself becomes a labelled group (radiogroup for radio lists).
 */
export function field(label, control, { hint, optional = false, inline = false, id } = {}) {
  const native = control.matches?.(LABELABLE) ? control : undefined;
  const hasRadios = !native && Boolean(control.querySelector?.("input[type=radio]"));
  const inner = native ?? (hasRadios ? undefined : control.querySelector?.(LABELABLE));
  const target = native ?? inner ?? control;
  const controlId = id || target.id || nextId("f");
  target.id = controlId;
  const labelId = `${controlId}-label`;
  const labelElement = el("label", { class: "field-label", attrs: { id: labelId, for: native || inner ? controlId : undefined } }, [text(label)]);
  if (optional) labelElement.append(el("span", { class: "field-optional", text: "Optional" }));
  if (!native) {
    if (!control.getAttribute("role")) control.setAttribute("role", hasRadios ? "radiogroup" : "group");
    control.setAttribute("aria-labelledby", labelId);
  }
  const wrapper = el("div", { class: `field ${inline ? "field-inline" : ""}`.trim() });
  wrapper.append(labelElement, control);
  const describedBy = [];
  if (hint) {
    const hintId = `${controlId}-hint`;
    wrapper.append(el("p", { class: "field-hint", text: hint, attrs: { id: hintId } }));
    describedBy.push(hintId);
  }
  const errorId = `${controlId}-error`;
  const error = el("p", { class: "field-error", attrs: { id: errorId } });
  error.hidden = true;
  wrapper.append(error);
  const setDescribedBy = (withError) => {
    const ids = withError ? [...describedBy, errorId] : describedBy;
    if (ids.length > 0) target.setAttribute("aria-describedby", ids.join(" "));
    else target.removeAttribute("aria-describedby");
  };
  setDescribedBy(false);
  wrapper.control = target;
  wrapper.setError = (message) => {
    error.textContent = message ?? "";
    error.hidden = !message;
    control.classList.toggle("is-invalid", Boolean(message));
    target.setAttribute("aria-invalid", message ? "true" : "false");
    setDescribedBy(Boolean(message));
  };
  return wrapper;
}

export function input(options = {}) {
  const element = el("input", { class: `input ${options.class ?? ""}`.trim(), attrs: { type: options.type ?? "text", placeholder: options.placeholder, name: options.name, autocomplete: "off", spellcheck: "false", inputmode: options.inputmode, maxlength: options.maxlength, min: options.min, max: options.max, step: options.step, required: options.required } });
  if (options.value !== undefined && options.value !== null) element.value = String(options.value);
  return element;
}

export function textarea(options = {}) {
  const element = el("textarea", { class: `input textarea ${options.class ?? ""}`.trim(), attrs: { placeholder: options.placeholder, name: options.name, rows: options.rows ?? 3, maxlength: options.maxlength } });
  if (options.value !== undefined && options.value !== null) element.value = String(options.value);
  return element;
}

/** `<select>` with `options` [{ value, label, disabled }] or plain strings. */
export function select(options, value, extra = {}) {
  const element = el("select", { class: `input select ${extra.class ?? ""}`.trim(), attrs: { name: extra.name } });
  for (const option of options) {
    const item = typeof option === "string" ? { value: option, label: option } : option;
    const node = el("option", { text: item.label, attrs: { value: item.value, disabled: item.disabled } });
    element.append(node);
  }
  if (value !== undefined && value !== null) element.value = String(value);
  return element;
}

export function checkbox(label, checked = false, extra = {}) {
  const box = el("input", { class: "checkbox", attrs: { type: "checkbox", name: extra.name } });
  box.checked = checked;
  const wrapper = el("label", { class: "check-field" }, [box, el("span", { class: "check-label", text: label })]);
  if (extra.hint) wrapper.append(el("span", { class: "check-hint", text: extra.hint }));
  wrapper.input = box;
  return wrapper;
}

/** Radio group; `items` [{ value, label, description }]. */
export function radioGroup(name, items, value) {
  const group = el("div", { class: "radio-group", attrs: { role: "radiogroup" } });
  for (const item of items) {
    const radio = el("input", { class: "radio", attrs: { type: "radio", name, value: item.value } });
    radio.checked = item.value === value;
    const label = el("label", { class: "radio-field" }, [radio, el("span", { class: "radio-labels" }, [el("span", { class: "radio-label", text: item.label }), item.description ? el("span", { class: "radio-description", text: item.description }) : null])]);
    group.append(label);
  }
  group.value = () => group.querySelector("input:checked")?.value;
  return group;
}

/** Apply a Tool error to a form: field-level when the error names a `param`, otherwise on the summary. */
export function applyFormError(error, fields, api) {
  const message = describe(error);
  const param = error instanceof ToolError ? error.param : undefined;
  const base = param ? param.replace(/\[.*$/, "") : undefined;
  if (base && fields[base]) {
    fields[base].setError(message);
    fields[base].querySelector("input, select, textarea")?.focus();
    api?.setError(undefined);
  } else api?.setError(message);
}

// ---------------------------------------------------------------------------------------------
// Formatting (money, dates from the world's virtual clock, ids)
// ---------------------------------------------------------------------------------------------

const ZERO_DECIMAL = new Set(["jpy"]);
const SYMBOLS = { usd: "$", eur: "€", gbp: "£", cad: "CA$", aud: "A$", chf: "CHF ", sek: "kr ", nok: "kr ", dkk: "kr ", jpy: "¥", nzd: "NZ$", sgd: "S$" };
export const CURRENCIES = Object.freeze(["usd", "eur", "gbp", "cad", "aud", "chf", "sek", "nok", "dkk", "jpy", "nzd", "sgd"]);

export function decimals(currency) {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

/** `$1,890.00`, `-€15.00`, `¥500`. */
export function money(amount, currency = "usd") {
  const symbol = SYMBOLS[currency] ?? `${currency.toUpperCase()} `;
  const places = decimals(currency);
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  const major = places === 0 ? absolute : Math.floor(absolute / 100);
  const minor = places === 0 ? "" : `.${String(absolute % 100).padStart(2, "0")}`;
  return `${sign}${symbol}${major.toLocaleString("en-US")}${minor}`;
}

/** Amount cell: "$1,890.00" + a muted "USD". */
export function moneyCell(amount, currency, options = {}) {
  return el("span", { class: `money ${options.class ?? ""}`.trim() }, [el("span", { class: "money-value", text: money(amount, currency) }), el("span", { class: "money-currency", text: currency.toUpperCase() })]);
}

/** Parse a decimal amount typed by the user into minor units; undefined when not a valid number. */
export function parseAmount(textValue, currency) {
  const cleaned = String(textValue ?? "").replace(/[,\s]/g, "");
  if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned)) return undefined;
  const places = decimals(currency);
  const [whole, fraction = ""] = cleaned.split(".");
  if (places === 0) return fraction.length > 0 && Number(fraction) !== 0 ? undefined : Number(whole);
  return Number(whole) * 100 + (whole.startsWith("-") ? -1 : 1) * Number(fraction.padEnd(2, "0"));
}

/** Minor units → editable decimal string ("18.90"). */
export function amountString(amount, currency) {
  return decimals(currency) === 0 ? String(amount) : (amount / 100).toFixed(2);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function utc(seconds) {
  const date = new Date(seconds * 1000);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate(), h: date.getUTCHours(), min: date.getUTCMinutes() };
}

function clock(parts) {
  const hour12 = parts.h % 12 === 0 ? 12 : parts.h % 12;
  return `${hour12}:${String(parts.min).padStart(2, "0")} ${parts.h < 12 ? "AM" : "PM"}`;
}

/** List date the way the Dashboard shows it: "Sep 14, 9:00 AM" this year, "Sep 14, 2025, 9:00 AM" otherwise. Rendered in UTC so a replay is identical anywhere. */
export function dateTime(seconds, nowSeconds) {
  if (typeof seconds !== "number") return "—";
  const parts = utc(seconds);
  const sameYear = nowSeconds !== undefined && utc(nowSeconds).y === parts.y;
  return `${MONTHS[parts.m]} ${parts.d}${sameYear ? "" : `, ${parts.y}`}, ${clock(parts)}`;
}

export function dateOnly(seconds, nowSeconds) {
  if (typeof seconds !== "number") return "—";
  const parts = utc(seconds);
  const sameYear = nowSeconds !== undefined && utc(nowSeconds).y === parts.y;
  return `${MONTHS[parts.m]} ${parts.d}${sameYear ? "" : `, ${parts.y}`}`;
}

export function fullDate(seconds) {
  if (typeof seconds !== "number") return "—";
  const parts = utc(seconds);
  return `${MONTHS[parts.m]} ${parts.d}, ${parts.y}, ${clock(parts)} UTC`;
}

/** "in 3 days" / "2 hours ago" relative to the world's virtual now. */
export function relative(seconds, nowSeconds) {
  const diff = seconds - nowSeconds;
  const abs = Math.abs(diff);
  const unit = abs < 3600 ? [Math.max(1, Math.round(abs / 60)), "minute"] : abs < 86400 ? [Math.round(abs / 3600), "hour"] : abs < 86400 * 31 ? [Math.round(abs / 86400), "day"] : abs < 86400 * 365 ? [Math.round(abs / (86400 * 30)), "month"] : [Math.round(abs / (86400 * 365)), "year"];
  const label = `${unit[0]} ${unit[1]}${unit[0] === 1 ? "" : "s"}`;
  return diff >= 0 ? `in ${label}` : `${label} ago`;
}

/** Unix seconds → "2026-09-14" for date inputs; and back. */
export function isoDay(seconds) {
  const parts = utc(seconds);
  return `${parts.y}-${String(parts.m + 1).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
}
export function fromIsoDay(value, hour = 9) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return undefined;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour) / 1000);
}

export function capitalize(value) {
  const stringValue = String(value ?? "");
  return stringValue.charAt(0).toUpperCase() + stringValue.slice(1);
}

export function humanize(value) {
  return capitalize(String(value ?? "").replace(/_/g, " "));
}

const BRANDS = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", jcb: "JCB", diners: "Diners Club", unionpay: "UnionPay" };
export function brandName(brand) {
  return BRANDS[brand] ?? capitalize(brand ?? "Card");
}

/** "Visa •••• 4242" the way the Dashboard labels a card. */
export function cardLabel(method) {
  const card = method?.card;
  if (!card) return method?.type ? humanize(method.type) : "—";
  return `${brandName(card.brand)} •••• ${card.last4}`;
}

/** Card row: a brand chip plus "•••• 4242". */
export function cardChip(method, options = {}) {
  const card = method?.card;
  const wrapper = el("span", { class: `card-chip ${options.class ?? ""}`.trim() });
  if (!card) {
    wrapper.append(icon("card", "card-brand-icon"), el("span", { text: method?.type ? humanize(method.type) : "—" }));
    return wrapper;
  }
  wrapper.append(el("span", { class: `card-brand card-brand-${card.brand}`, text: brandName(card.brand).replace("American Express", "Amex") }), el("span", { class: "card-last4", text: `•••• ${card.last4}` }));
  if (options.expiry) wrapper.append(el("span", { class: "card-expiry", text: `Expires ${String(card.exp_month).padStart(2, "0")}/${card.exp_year}` }));
  return wrapper;
}

/** Copy to clipboard with a toast; never throws. */
export async function copyText(value, label = "Copied") {
  try {
    await navigator.clipboard.writeText(value);
    toast(label);
  } catch {
    toast("Could not access the clipboard", { error: true });
  }
}

/** A monospaced id with a copy affordance. */
export function idChip(id) {
  return el("span", { class: "id-chip" }, [
    el("code", { class: "id-code", text: id }),
    iconButton("copy", `Copy ${id}`, { size: "xs", class: "id-copy", onClick: () => void copyText(id, "Copied to clipboard") }),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Status badges (Sail colours: green / red / yellow / blue / gray)
// ---------------------------------------------------------------------------------------------

export function badge(label, tone = "gray", glyph) {
  const element = el("span", { class: `badge badge-${tone}`, text: label });
  if (glyph) element.append(icon(glyph, "badge-icon"));
  return element;
}

/** PaymentIntent display status ("Succeeded", "Refunded", "Uncaptured", …) given the intent and its latest charge. */
export function intentStatus(intent, charge) {
  const refunded = charge && charge.amount_refunded > 0 && charge.status === "succeeded";
  if (intent.status === "succeeded" && refunded) {
    return charge.refunded || charge.amount_refunded >= charge.amount_captured ? { label: "Refunded", tone: "gray", icon: "arrow-return", key: "refunded" } : { label: "Partial refund", tone: "gray", icon: "arrow-return", key: "refunded" };
  }
  switch (intent.status) {
    case "succeeded":
      return { label: "Succeeded", tone: "green", icon: "check-circle", key: "succeeded" };
    case "requires_capture":
      return { label: "Uncaptured", tone: "yellow", icon: "clock", key: "uncaptured" };
    case "canceled":
      return { label: "Canceled", tone: "gray", icon: "minus-circle", key: "canceled" };
    case "processing":
      return { label: "Processing", tone: "gray", icon: "clock", key: "incomplete" };
    case "requires_payment_method":
      return intent.last_payment_error ? { label: "Failed", tone: "red", icon: "x-circle", key: "failed" } : { label: "Incomplete", tone: "gray", icon: "clock", key: "incomplete" };
    default:
      return { label: "Incomplete", tone: "gray", icon: "clock", key: "incomplete" };
  }
}

export function invoiceStatus(invoice, nowSeconds) {
  switch (invoice.status) {
    case "draft":
      return { label: "Draft", tone: "gray", icon: "edit", key: "draft" };
    case "open":
      return typeof invoice.due_date === "number" && invoice.due_date < nowSeconds ? { label: "Past due", tone: "yellow", icon: "alert-circle", key: "past_due" } : { label: "Open", tone: "blue", icon: "clock", key: "open" };
    case "paid":
      return { label: "Paid", tone: "green", icon: "check-circle", key: "paid" };
    case "void":
      return { label: "Void", tone: "gray", icon: "minus-circle", key: "void" };
    case "uncollectible":
      return { label: "Uncollectible", tone: "red", icon: "x-circle", key: "uncollectible" };
    default:
      return { label: humanize(invoice.status), tone: "gray", key: invoice.status };
  }
}

export function subscriptionStatus(subscription, nowSeconds) {
  if (subscription.cancel_at_period_end && subscription.status !== "canceled") return { label: `Cancels ${dateOnly(subscription.cancel_at, nowSeconds)}`, tone: "gray", icon: "clock", key: "cancels" };
  switch (subscription.status) {
    case "active":
      return { label: "Active", tone: "green", icon: "check-circle", key: "active" };
    case "trialing":
      return { label: "Trialing", tone: "blue", icon: "clock", key: "trialing" };
    case "past_due":
      return { label: "Past due", tone: "yellow", icon: "alert-circle", key: "past_due" };
    case "canceled":
      return { label: "Canceled", tone: "gray", icon: "minus-circle", key: "canceled" };
    case "incomplete":
      return { label: "Incomplete", tone: "yellow", icon: "clock", key: "incomplete" };
    case "incomplete_expired":
      return { label: "Incomplete expired", tone: "gray", icon: "x-circle", key: "incomplete_expired" };
    case "unpaid":
      return { label: "Unpaid", tone: "red", icon: "x-circle", key: "unpaid" };
    case "paused":
      return { label: "Paused", tone: "gray", icon: "clock", key: "paused" };
    default:
      return { label: humanize(subscription.status), tone: "gray", key: subscription.status };
  }
}

export function refundStatus(refund) {
  switch (refund.status) {
    case "succeeded":
      return { label: "Succeeded", tone: "green", icon: "check-circle" };
    case "pending":
      return { label: "Pending", tone: "gray", icon: "clock" };
    case "failed":
      return { label: "Failed", tone: "red", icon: "x-circle" };
    case "canceled":
      return { label: "Canceled", tone: "gray", icon: "minus-circle" };
    default:
      return { label: humanize(refund.status), tone: "gray" };
  }
}

export function statusBadge(status) {
  return badge(status.label, status.tone, status.icon);
}

/** Price summary: "$29.00 / month", "$189.00", "$4.00 every 2 weeks". */
export function priceLabel(price) {
  if (!price) return "—";
  const base = money(price.unit_amount ?? 0, price.currency);
  const recurring = price.recurring;
  if (!recurring) return base;
  const count = recurring.interval_count ?? 1;
  return count === 1 ? `${base} / ${recurring.interval}` : `${base} every ${count} ${recurring.interval}s`;
}

export function intervalLabel(recurring) {
  if (!recurring) return "One time";
  const count = recurring.interval_count ?? 1;
  return count === 1 ? capitalize(`${recurring.interval}ly`).replace("Dayly", "Daily") : `Every ${count} ${recurring.interval}s`;
}

/** Letter avatar (customer initials) in the Dashboard's muted style. */
export function avatar(name, seed = "", size = "") {
  const initials = String(name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
  const element = el("span", { class: `avatar ${size}`.trim(), text: initials || "?", attrs: { "aria-hidden": "true" } });
  let hash = 0;
  for (const character of String(seed || name)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  element.dataset.tone = String(hash % 6);
  return element;
}

// ---------------------------------------------------------------------------------------------
// Per-viewer preferences (never authority over records)
// ---------------------------------------------------------------------------------------------

export function readPreference(name, fallback) {
  try {
    return localStorage.getItem(`stripe-tool:${name}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePreference(name, value) {
  try {
    localStorage.setItem(`stripe-tool:${name}`, value);
  } catch {
    /* blocked storage: the preference just does not persist */
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

export { getContext };
