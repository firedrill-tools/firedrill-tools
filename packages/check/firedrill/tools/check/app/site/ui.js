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
  return el("button", {
    class: `btn btn-${kind}${options.small ? " btn-sm" : ""}`,
    title: options.title,
    attrs: { type: options.type ?? "button", disabled: options.disabled, "aria-label": options.label ?? (label ? undefined : options.title) },
    on: options.onClick ? { click: options.onClick } : {},
  }, children);
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
  /** Check reports the offending field as `field` (or `field_path` on per-item errors). */
  get field() {
    const d = this.details;
    if (typeof d.field === "string") return d.field;
    if (typeof d.field_path === "string") return d.field_path;
    const first = Array.isArray(d.input_errors) ? d.input_errors[0] : undefined;
    return first && typeof first.field_path === "string" ? first.field_path : undefined;
  }
  get denied() {
    return this.status === "denied" || this.is("PERMISSION_DENIED");
  }
}

let pending = 0;
/** Set once the Tool has answered a write with Check's permission_denied (a read-only key). */
export const access = { readOnly: false };
export async function call(operationId, args = {}, idempotencyKey) {
  pending += 1;
  try {
    const result = await invoke(operationId, args, idempotencyKey ? { idempotencyKey } : {});
    const outcome = result.outcome;
    if (outcome.status !== "ok") {
      const error = outcome.error ?? {};
      const failure = new ToolError(outcome.status, error.code ?? outcome.status, error.message ?? `The request was ${outcome.status}.`, error.details);
      if (failure.denied && !access.readOnly) {
        access.readOnly = true;
        window.dispatchEvent(new CustomEvent("check:read-only"));
      }
      throw failure;
    }
    return outcome.value;
  } finally {
    pending -= 1;
  }
}
export const newKey = () => crypto.randomUUID();

export function describe(error) {
  if (!(error instanceof ToolError)) return error?.message ?? "Something went wrong.";
  if (error.status === "denied") return "This actor has no grant for that operation in the current world.";
  if (error.is("PERMISSION_DENIED")) return "This API key is read-only. Ask for a key with full access to make changes.";
  if (error.is("AUTHENTICATION_ERROR")) return "The API key is not valid for this environment.";
  if (error.is("THROTTLED")) return "Too many requests. Wait a moment, then try again.";
  if (error.is("PREVIEW_SUPERSEDED")) return "The payroll changed since it was previewed. Preview it again before approving.";
  if (error.is("SERVICE_UNAVAILABLE")) return `${error.message} The result may be unknown: refresh before retrying.`;
  if (error.is("INTERNAL_ERROR")) return `${error.message} The result may be unknown: refresh before retrying.`;
  return error.field ? `${error.message} (${error.field})` : error.message;
}

export function toast(message, { error = false, timeout = 5000, actionLabel, onAction } = {}) {
  const host = $("#toasts");
  const node = el("div", { class: `toast${error ? " toast-error" : ""}`, attrs: { role: error ? "alert" : "status" } }, [
    el("span", { class: "toast-icon" }, icon(error ? "warn" : "check")),
    el("span", { class: "toast-text", text: message }),
  ]);
  if (actionLabel) node.append(btn(actionLabel, "link", { onClick: () => { node.remove(); onAction?.(); } }));
  node.append(el("button", { class: "toast-close", attrs: { type: "button", "aria-label": "Dismiss" }, on: { click: () => node.remove() } }, icon("close")));
  host.append(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
}

export function openModal({ title, subtitle, body, actions = [], wide = false, onClose }) {
  const previous = document.activeElement;
  const titleId = `m-${Math.random().toString(36).slice(2)}`;
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); previous?.focus?.(); onClose?.(); };
  const onKey = (event) => { if (event.key === "Escape") close(); };
  const dialog = el("div", { class: `modal${wide ? " modal-wide" : ""}`, attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId } }, [
    el("div", { class: "modal-head" }, [
      el("div", {}, [el("h2", { text: title, attrs: { id: titleId } }), subtitle ? el("p", { class: "modal-sub", text: subtitle }) : null]),
      el("button", { class: "icon-btn", attrs: { type: "button", "aria-label": "Close" }, on: { click: close } }, icon("close")),
    ]),
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
    const cancel = btn("Cancel", "secondary", { onClick: () => modal.close() });
    const ok = btn(okLabel, danger ? "danger" : "primary", { onClick: () => { finish(true); modal.close(); } });
    const modal = openModal({ title, body: typeof message === "string" ? el("p", { text: message }) : message, actions: [cancel, ok], onClose: () => finish(false) });
  });
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
