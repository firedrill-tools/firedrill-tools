// Shared helpers: safe DOM building, operation calls, dialogs, toasts, virtual-time formatting and revision watching.
import { getContext, invoke } from "/_firedrill/client.js";
import { icon } from "./icons.js";

export const $ = (selector, root = document) => root.querySelector(selector);

/** el("div", { class, text, attrs, on }, children) — record text only ever goes through textContent. */
export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value === false || value === undefined || value === null) continue;
    node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const [type, listener] of Object.entries(options.on ?? {})) node.addEventListener(type, listener);
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function button(label, { variant = "secondary", iconName, onClick, attrs = {}, size = "" } = {}) {
  const node = el("button", { class: `btn btn-${variant} ${size}`.trim(), attrs: { type: "button", ...attrs }, on: onClick ? { click: onClick } : {} });
  if (iconName) node.append(icon(iconName, 14));
  if (label) node.append(el("span", { text: label }));
  return node;
}

export class ToolError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = String(code ?? "").replace(/^tool\./, "");
  }
  get denied() { return this.status === "denied" || this.status === "permission_denied" || this.code === "PERMISSION_DENIED"; }
}

export async function call(operationId, args = {}, idempotencyKey) {
  const result = await invoke(operationId, args, idempotencyKey ? { idempotencyKey } : {});
  const outcome = result?.outcome ?? {};
  if (outcome.status !== "ok") {
    const error = outcome.error ?? {};
    throw new ToolError(outcome.status, error.code ?? outcome.status, error.message ?? `The request was ${outcome.status}.`);
  }
  return outcome.value;
}

/** A mutation: fresh idempotency key per user action; callers reuse `run.key` only to retry the same action. */
export function mutate(operationId, args = {}) {
  const idempotencyKey = crypto.randomUUID();
  return call(operationId, { ...args, idempotencyKey }, idempotencyKey);
}

export function describe(error) {
  if (error instanceof ToolError) {
    if (error.denied) return "You don't have permission to perform this action with the current actor.";
    if (error.code === "RATE_LIMIT_EXCEEDED") return "Too many requests. Please slow down and try again in a second.";
    if (error.code === "RESTRICTED_API_KEY") return "This API key is restricted to only send emails.";
    if (error.code === "INVALID_API_KEY") return "API key is invalid.";
    if (error.code === "APPLICATION_ERROR") return "An unexpected error occurred. Please try again.";
    return error.message;
  }
  return error?.message ?? "Something went wrong.";
}

// ---- toasts --------------------------------------------------------------------------------
export function toast(text, { error = false } = {}) {
  const host = $("#toasts");
  const node = el("div", { class: `toast${error ? " toast-error" : ""}`, attrs: { role: error ? "alert" : "status" } }, [icon(error ? "alert" : "check", 14), el("span", { text })]);
  host.append(node);
  setTimeout(() => node.remove(), 5000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast("Copy is not available in this browser", { error: true });
  }
}

export function copyButton(text, label = "Copy") {
  const node = el("button", { class: "icon-btn copy", attrs: { type: "button", "aria-label": label, title: label }, on: { click: (event) => { event.stopPropagation(); void copyText(text); } } });
  node.append(icon("copy", 14));
  return node;
}

// ---- dialogs -------------------------------------------------------------------------------
/** Opens a modal. `build(close)` returns the body nodes; resolves with the value passed to close(). */
export function modal(title, build, { description, wide = false } = {}) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const titleId = `dlg-${crypto.randomUUID()}`;
    const overlay = el("div", { class: "overlay" });
    const box = el("div", { class: `dialog${wide ? " dialog-wide" : ""}`, attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId } });
    const close = (value) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
      resolve(value);
    };
    const onKey = (event) => { if (event.key === "Escape") { event.preventDefault(); close(undefined); } };
    const head = el("div", { class: "dialog-head" }, [el("h2", { text: title, attrs: { id: titleId } })]);
    const x = el("button", { class: "icon-btn", attrs: { type: "button", "aria-label": "Close", title: "Close" }, on: { click: () => close(undefined) } });
    x.append(icon("x", 16));
    head.append(x);
    box.append(head);
    if (description) box.append(el("p", { class: "dialog-desc", text: description }));
    box.append(...[].concat(build(close)));
    overlay.append(box);
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(undefined); });
    document.addEventListener("keydown", onKey, true);
    $("#dialogs").append(overlay);
    (box.querySelector("input, select, textarea, .btn-primary, .btn-danger") ?? x).focus();
  });
}

export function confirmDialog(title, text, okLabel, { danger = true } = {}) {
  return modal(title, (close) => [
    el("p", { class: "dialog-text", text }),
    el("div", { class: "dialog-actions" }, [
      button("Cancel", { onClick: () => close(false) }),
      button(okLabel, { variant: danger ? "danger" : "primary", onClick: () => close(true) }),
    ]),
  ]);
}

export function field(labelText, control, hint) {
  const id = control.id || `f-${crypto.randomUUID()}`;
  control.id = id;
  return el("div", { class: "field" }, [el("label", { text: labelText, attrs: { for: id } }), control, hint ? el("p", { class: "hint", text: hint }) : null]);
}

// ---- virtual time (never the browser clock) -------------------------------------------------
export const clock = { nowMs: 0, set(iso) { const ms = Date.parse(iso); if (Number.isFinite(ms)) this.nowMs = ms; } };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parse(value) {
  if (typeof value !== "string" || value.length === 0) return NaN;
  // Resend timestamps carry an offset ("+00"); zone-less text is treated as UTC.
  const text = /(Z|[+-]\d\d(:?\d\d)?)$/.test(value) ? value.replace(/([+-]\d\d)$/, "$1:00") : `${value}Z`;
  return Date.parse(text.replace(" ", "T"));
}

export function relative(value) {
  const ms = parse(value);
  if (!Number.isFinite(ms)) return "—";
  const diff = clock.nowMs - ms;
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  let text;
  if (s < 45) text = "less than a minute";
  else if (s < 90) text = "1 minute";
  else if (s < 2700) text = `${Math.round(s / 60)} minutes`;
  else if (s < 5400) text = "about 1 hour";
  else if (s < 86400) text = `about ${Math.round(s / 3600)} hours`;
  else if (s < 172800) text = "1 day";
  else if (s < 2592000) text = `${Math.round(s / 86400)} days`;
  else if (s < 5184000) text = "about 1 month";
  else if (s < 31536000) text = `${Math.round(s / 2592000)} months`;
  else text = `about ${Math.round(s / 31536000)} years`;
  return future ? `in ${text}` : `${text} ago`;
}

export function formatDate(value, { time = true } = {}) {
  const ms = parse(value);
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${d.getUTCFullYear() !== new Date(clock.nowMs).getUTCFullYear() ? `, ${d.getUTCFullYear()}` : ""}`;
  if (!time) return day;
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day}, ${((h + 11) % 12) + 1}:${m} ${h < 12 ? "AM" : "PM"} UTC`;
}

export function timeCell(value) {
  return el("time", { text: relative(value), attrs: { datetime: value ?? "", title: formatDate(value) } });
}

// ---- badges ----------------------------------------------------------------------------------
const TONES = {
  delivered: "green", verified: "green", subscribed: "green", full_access: "gray", sending_access: "gray",
  bounced: "red", failed: "red", complained: "red", temporary_failure: "amber", suppressed: "red",
  scheduled: "blue", queued: "gray", sent: "gray", canceled: "gray", not_started: "gray", pending: "amber",
  temporary_failure_domain: "amber", unsubscribed: "gray", opened: "green", clicked: "green", delivery_delayed: "amber",
};
export const labelFor = (value) => {
  const text = String(value ?? "unknown").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};
export function badge(value, text) {
  return el("span", { class: `badge tone-${TONES[value] ?? "gray"}`, text: text ?? labelFor(value) });
}

// ---- states ----------------------------------------------------------------------------------
export function emptyState(title, text, action) {
  return el("div", { class: "empty" }, [el("h3", { text: title }), text ? el("p", { text }) : null, action ?? null]);
}

export function errorState(error, retry) {
  const denied = error instanceof ToolError && (error.denied || error.code === "RESTRICTED_API_KEY" || error.code === "INVALID_API_KEY");
  const box = el("div", { class: `callout ${denied ? "callout-warn" : "callout-error"}`, attrs: { role: "alert" } }, [
    icon(denied ? "lock" : "alert", 16),
    el("div", {}, [el("strong", { text: denied ? "Access denied" : "Something went wrong" }), el("p", { text: describe(error) })]),
  ]);
  if (retry) box.append(button("Try again", { size: "sm", iconName: "refresh", onClick: retry }));
  return box;
}

export function skeletonRows(columns, rows = 8) {
  const body = el("tbody", { attrs: { "aria-busy": "true" } });
  for (let r = 0; r < rows; r += 1) {
    body.append(el("tr", { class: "skeleton" }, Array.from({ length: columns }, () => el("td", {}, [el("span", { class: "sk" })]))));
  }
  return body;
}

export function notSimulated(name, detail) {
  return modal(name, (close) => [
    el("p", { class: "dialog-text", text: detail ?? `${name} is part of the dashboard but is not simulated by this Tool. Nothing here reads or changes the synthetic team.` }),
    el("div", { class: "dialog-actions" }, [button("Close", { variant: "primary", onClick: () => close() })]),
  ]);
}

// ---- world revision --------------------------------------------------------------------------
let busy = 0;
export async function guard(task) {
  busy += 1;
  try { return await task(); } finally { busy -= 1; }
}

/** Polls getContext(); calls refresh() when the revision moves and no action or open dialog would be disturbed. */
export function watchWorld(refresh) {
  let stamp;
  let checking = false;
  const check = async () => {
    if (checking || busy > 0 || document.visibilityState !== "visible") return;
    checking = true;
    try {
      const context = await getContext();
      const next = JSON.stringify(context.revision);
      if (stamp !== next) {
        const first = stamp === undefined;
        stamp = next;
        if (!first && !$("#dialogs").hasChildNodes()) await refresh();
      }
    } catch {
      // The local environment went away; the next successful poll resumes.
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), 2000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  void check();
}
