// DOM, Firedrill-client and interaction helpers for the Documenso Tool app.
import { getContext, invoke } from "/_firedrill/client.js";
import { icon } from "./icons.js";

export const $ = (selector, root = document) => root.querySelector(selector);

/** Create an element. Text always goes through textContent; attributes through setAttribute. */
export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title !== undefined) node.title = options.title;
  if (options.attrs) for (const [name, value] of Object.entries(options.attrs)) if (value !== undefined && value !== null && value !== false) node.setAttribute(name, String(value));
  if (options.on) for (const [name, handler] of Object.entries(options.on)) node.addEventListener(name, handler);
  for (const child of Array.isArray(children) ? children : [children]) if (child !== undefined && child !== null && child !== false) node.append(child);
  return node;
}

/** shadcn-style button: variant default|outline|secondary|ghost|destructive, size default|sm|icon. */
export function button(label, { variant = "default", size = "", iconName, onClick, disabled, title, ariaLabel, cls = "" } = {}) {
  const node = el("button", { class: `btn btn-${variant} ${size ? `btn-${size}` : ""} ${cls}`.trim(), title, attrs: { type: "button", "aria-label": ariaLabel, disabled } });
  if (iconName) node.append(icon(iconName, label ? "btn-ic" : ""));
  if (label) node.append(document.createTextNode(label));
  if (onClick) node.addEventListener("click", onClick);
  return node;
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
    return this.status === "denied" || this.code === "UNAUTHORIZED" || this.code === "tool.UNAUTHORIZED";
  }
  is(code) {
    return this.code === code || this.code === `tool.${code}`;
  }
}

/** Invoke one operation; throws ToolError for every non-ok outcome. Mutations pass an idempotency key. */
export async function call(operationId, args = {}, idempotencyKey) {
  const result = await invoke(operationId, args, idempotencyKey ? { idempotencyKey } : {});
  if (result.outcome.status !== "ok") {
    const error = result.outcome.error ?? {};
    throw new ToolError(result.outcome.status, error.code ?? result.outcome.status, error.message ?? `The operation was ${result.outcome.status}.`);
  }
  return result.outcome.value;
}

export const newKey = () => crypto.randomUUID();

export function describe(error) {
  if (error instanceof ToolError) {
    if (error.status === "denied") return "You do not have permission to perform this action.";
    return error.message || "Something went wrong.";
  }
  return error?.message ?? "Something went wrong. Please try again.";
}

// ---------------------------------------------------------------------------------------------
// Busy tracking: one write at a time, and no refresh while a write is in flight
// ---------------------------------------------------------------------------------------------

let pending = 0;
export const isBusy = () => pending > 0;

export async function run(task, { onError } = {}) {
  if (pending > 0) return undefined;
  pending += 1;
  document.documentElement.toggleAttribute("data-busy", true);
  try {
    return await task();
  } catch (error) {
    if (onError) onError(error);
    else toast(describe(error), { variant: "destructive", title: "Something went wrong" });
    return undefined;
  } finally {
    pending -= 1;
    document.documentElement.toggleAttribute("data-busy", pending > 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Toasts (bottom-right, as the web app renders them)
// ---------------------------------------------------------------------------------------------

export function toast(description, { title, variant = "default", timeout = 5000 } = {}) {
  const host = $("#toasts");
  const node = el("div", { class: `toast toast-${variant}`, attrs: { role: variant === "destructive" ? "alert" : "status" } }, [
    title ? el("div", { class: "toast-title", text: title }) : null,
    el("div", { class: "toast-desc", text: description }),
  ]);
  const close = el("button", { class: "toast-close", attrs: { type: "button", "aria-label": "Close notification" } }, icon("x"));
  close.addEventListener("click", () => node.remove());
  node.append(close);
  host.append(node);
  setTimeout(() => node.remove(), timeout);
}

// ---------------------------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------------------------

export function tooltip(target, content, { side = "top" } = {}) {
  let tip;
  const show = () => {
    hide();
    tip = el("div", { class: `tooltip tooltip-${side}`, attrs: { role: "tooltip" } }, typeof content === "function" ? content() : content);
    document.body.append(tip);
    const r = target.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const top = side === "bottom" ? r.bottom + 8 : r.top - t.height - 8;
    tip.style.top = `${Math.max(8, top + window.scrollY)}px`;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2))}px`;
  };
  const hide = () => {
    tip?.remove();
    tip = undefined;
  };
  target.addEventListener("mouseenter", show);
  target.addEventListener("focus", show);
  target.addEventListener("mouseleave", hide);
  target.addEventListener("blur", hide);
  return target;
}
