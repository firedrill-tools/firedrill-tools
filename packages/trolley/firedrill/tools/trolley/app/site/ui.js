// DOM helpers, operation calls, toasts, modals and formatting. All record text goes through textContent.
import { getContext, invoke } from "/_firedrill/client.js";
import { icon } from "./icons.js";

export const $ = (selector, root = document) => root.querySelector(selector);

export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  if (options.title) node.title = options.title;
  if (options.attrs) for (const [name, value] of Object.entries(options.attrs)) if (value !== undefined && value !== null && value !== false) node.setAttribute(name, value === true ? "" : String(value));
  if (options.on) for (const [event, handler] of Object.entries(options.on)) node.addEventListener(event, handler);
  for (const child of Array.isArray(children) ? children : [children]) if (child !== undefined && child !== null && child !== false) node.append(child);
  return node;
}

export function btn(label, kind = "secondary", options = {}) {
  const children = [];
  if (options.icon) children.push(icon(options.icon));
  if (label) children.push(el("span", { text: label }));
  return el("button", { class: `btn btn-${kind}${options.small ? " btn-sm" : ""}`, title: options.title, attrs: { type: "button", disabled: options.disabled, "aria-label": options.label }, on: options.onClick ? { click: options.onClick } : {} }, children);
}

export class ToolError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details ?? {};
  }
  is(code) {
    return this.code === code || this.code === `tool.${code}` || String(this.code).endsWith(`.${code}`);
  }
  get field() {
    return typeof this.details.field === "string" ? this.details.field : undefined;
  }
  get denied() {
    return this.status === "denied" || this.is("NOT_AUTHORIZED");
  }
}

let pending = 0;
export async function call(operationId, args = {}, idempotencyKey) {
  pending += 1;
  try {
    const result = await invoke(operationId, args, idempotencyKey ? { idempotencyKey } : {});
    const outcome = result.outcome;
    if (outcome.status !== "ok") {
      const error = outcome.error ?? {};
      throw new ToolError(outcome.status, error.code ?? outcome.status, error.message ?? `The request was ${outcome.status}.`, error.details);
    }
    return outcome.value;
  } finally {
    pending -= 1;
  }
}
export const newKey = () => crypto.randomUUID();

export function describe(error) {
  if (!(error instanceof ToolError)) return error?.message ?? "Something went wrong.";
  if (error.status === "denied") return "Your API key is not permitted to do this (not_authorized).";
  if (error.is("NOT_AUTHORIZED")) return "This key has read-only access. Ask an administrator for full access.";
  if (error.is("INVALID_API_KEY")) return "API key is invalid for this merchant.";
  if (error.is("RATE_LIMIT_EXCEEDED")) return "Too many requests. Wait a moment, then try again.";
  if (error.is("INTERNAL_SERVER_ERROR")) return `${error.message} The result may be unknown: refresh before retrying.`;
  return error.field ? `${error.message} (${error.field})` : error.message;
}

export function toast(message, { error = false, timeout = 5000, actionLabel, onAction } = {}) {
  const host = $("#toasts");
  const node = el("div", { class: `toast${error ? " toast-error" : ""}`, attrs: { role: error ? "alert" : "status" } }, [
    el("span", { class: "toast-icon" }, icon(error ? "info" : "check")),
    el("span", { class: "toast-text", text: message }),
  ]);
  if (actionLabel) node.append(btn(actionLabel, "link", { onClick: () => { node.remove(); onAction?.(); } }));
  node.append(el("button", { class: "toast-close", attrs: { type: "button", "aria-label": "Dismiss" }, on: { click: () => node.remove() } }, icon("close")));
  host.append(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
}

export function openModal({ title, body, actions = [], wide = false, onClose }) {
  const previous = document.activeElement;
  const titleId = `m-${Math.random().toString(36).slice(2)}`;
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); previous?.focus?.(); onClose?.(); };
  const onKey = (event) => { if (event.key === "Escape") close(); };
  const dialog = el("div", { class: `modal${wide ? " modal-wide" : ""}`, attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId } }, [
    el("div", { class: "modal-head" }, [el("h2", { text: title, attrs: { id: titleId } }), el("button", { class: "icon-btn", attrs: { type: "button", "aria-label": "Close" }, on: { click: close } }, icon("close"))]),
    el("div", { class: "modal-body" }, body),
    actions.length ? el("div", { class: "modal-foot" }, actions) : null,
  ]);
  const overlay = el("div", { class: "overlay", on: { mousedown: (event) => { if (event.target === overlay) close(); } } }, dialog);
  document.body.append(overlay);
  document.addEventListener("keydown", onKey);
  queueMicrotask(() => (dialog.querySelector("input, select, textarea, .btn-primary") ?? dialog).focus?.());
  return { close, dialog };
}

export function confirmDialog(title, message, okLabel = "Confirm", { danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const cancel = btn("Cancel", "secondary", { onClick: () => { modal.close(); } });
    const ok = btn(okLabel, danger ? "danger" : "primary", { onClick: () => { finish(true); modal.close(); } });
    const modal = openModal({ title, body: typeof message === "string" ? el("p", { text: message }) : message, actions: [cancel, ok], onClose: () => finish(false) });
  });
}

let fieldSeq = 0;
export function field(label, control, { hint, full = false } = {}) {
  fieldSeq += 1;
  const id = `fld-${fieldSeq}`;
  control.id = id;
  return el("div", { class: `field${full ? " field-full" : ""}`, attrs: { "data-field": control.name || undefined } }, [
    el("label", { text: label, attrs: { for: id } }),
    control,
    hint ? el("div", { class: "field-hint", text: hint }) : null,
    el("div", { class: "field-error", attrs: { "aria-live": "polite" } }),
  ]);
}
export function input(name, value = "", attrs = {}) {
  return el("input", { class: "input", attrs: { name, value: value ?? "", type: "text", ...attrs } });
}
export function select(name, options, value) {
  const node = el("select", { class: "input", attrs: { name } }, options.map(([v, label]) => el("option", { text: label, attrs: { value: v, selected: v === value } })));
  return node;
}
export function showFieldError(form, error) {
  for (const slot of form.querySelectorAll(".field-error")) slot.textContent = "";
  const name = error instanceof ToolError ? error.field : undefined;
  const leaf = name?.split(/[.[\]]/).filter(Boolean).pop();
  const target = name && (form.querySelector(`[data-field="${CSS.escape(name)}"] .field-error`) ?? (leaf && form.querySelector(`[data-field="${CSS.escape(leaf)}"] .field-error`)));
  if (target) target.textContent = error.message;
  return Boolean(target);
}

const SYMBOL = { USD: "$", CAD: "CA$", EUR: "€", GBP: "£", AUD: "A$", MXN: "MX$" };
export function money(amount, currency = "USD") {
  if (amount === "" || amount === null || amount === undefined) return "—";
  const [whole, frac = "00"] = String(amount).replace("-", "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = String(amount).startsWith("-") ? "-" : "";
  return `${sign}${Object.hasOwn(SYMBOL, currency) ? SYMBOL[currency] : ""}${grouped}.${frac.padEnd(2, "0").slice(0, 2)}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function date(iso, withTime = false) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  return withTime ? `${base} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC` : base;
}
const LABELS = { paypal: "PayPal", ach: "ACH", sepa: "SEPA", "bank-transfer": "Bank transfer", paymentrails: "Trolley" };
export const human = (value) => (Object.hasOwn(LABELS, String(value)) ? LABELS[value] : String(value ?? "").replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase()));

const TONES = { active: "green", processed: "green", complete: "green", verified: "green", primary: "blue", open: "blue", pending: "amber", processing: "amber", incomplete: "amber", review: "amber", failed: "red", blocked: "red", suspended: "red", disabled: "grey", archived: "grey" };
export function pill(status) {
  const tone = Object.hasOwn(TONES, status) ? TONES[status] : "grey";
  return el("span", { class: `pill pill-${tone}`, text: human(status) });
}
export function initials(name) {
  return String(name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "?";
}

export function watchWorld(refresh, mayRefresh) {
  let revision;
  const check = async () => {
    if (pending > 0 || document.visibilityState !== "visible") return;
    try {
      const context = await getContext();
      const stamp = JSON.stringify(context.revision);
      if (revision !== undefined && stamp !== revision && mayRefresh()) { revision = stamp; await refresh(); }
      revision = stamp;
    } catch (error) {
      toast(error?.message ?? "The local environment is unavailable.", { error: true });
    }
  };
  setInterval(() => void check(), 2000);
  void check();
}
export { getContext };
