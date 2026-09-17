// DOM, Tool-call, time and toast helpers for the LinkedIn Tool app. Record text only ever reaches the DOM via textContent.
import { invoke } from "/_firedrill/client.js";
import { icon } from "./icons.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Create an element. options: { class, text, title, attrs, on: {event: handler} }. */
export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  if (options.title) node.title = options.title;
  if (options.attrs) for (const [name, value] of Object.entries(options.attrs)) if (value !== undefined && value !== null && value !== false) node.setAttribute(name, value === true ? "" : String(value));
  if (options.on) for (const [name, handler] of Object.entries(options.on)) node.addEventListener(name, handler);
  for (const child of Array.isArray(children) ? children : [children]) if (child !== undefined && child !== null && child !== false) node.append(child);
  return node;
}

export function iconButton(name, label, onClick, className = "") {
  return el("button", { class: `icon-btn ${className}`.trim(), title: label, attrs: { type: "button", "aria-label": label }, on: onClick ? { click: onClick } : undefined }, icon(name));
}

// ---- Tool calls ------------------------------------------------------------------------------

export class ToolError extends Error {
  constructor(status, code, message, retryable) {
    super(message);
    this.status = status;
    this.code = String(code ?? status).replace(/^tool\./, "");
    this.retryable = Boolean(retryable);
  }
  get denied() { return this.status === "denied" || this.code === "ACCESS_DENIED"; }
}

let writeListener = () => {};
export const onWrite = (listener) => { writeListener = listener; };

/** Invoke one operation; resolves the value or throws ToolError. Mutations pass an idempotency key. */
export async function call(operationId, args = {}, idempotencyKey) {
  let result;
  try {
    result = await invoke(operationId, args, idempotencyKey ? { idempotencyKey } : {});
  } catch (error) {
    throw new ToolError("transport", "NETWORK", "Couldn't reach the service. Check that the environment is still running.");
  }
  const outcome = result?.outcome ?? {};
  if (idempotencyKey) writeListener();
  if (outcome.status !== "ok") {
    const error = outcome.error ?? {};
    throw new ToolError(outcome.status, error.code, error.message ?? `The request was ${outcome.status}.`, error.retryable);
  }
  return outcome.value;
}

export const newKey = () => crypto.randomUUID();

/** LinkedIn-style wording for an operation failure. */
export function describe(error) {
  if (!(error instanceof ToolError)) return "Something went wrong. Please try again.";
  if (error.status === "denied") return "You don't have access to do that with this account.";
  switch (error.code) {
    case "INVALID_ACCESS_TOKEN": return "Your session has expired. Sign in again to continue.";
    case "ACCESS_DENIED": return "You don't have permission to do that.";
    case "TOO_MANY_REQUESTS": return "You're commenting too fast. Please wait a moment and try again.";
    case "SERVICE_UNAVAILABLE": return "Reactions are temporarily unavailable. Please try again later.";
    case "NOT_FOUND": return "This content isn't available.";
    case "INTERNAL_SERVER_ERROR": return "Something went wrong on our end. Please try again.";
    default: return error.message || "Something went wrong. Please try again.";
  }
}

// ---- Time (world virtual time only, UTC) -----------------------------------------------------

let serverNowMs = 0;
export const setServerNow = (ms) => { if (Number.isFinite(ms)) serverNowMs = ms; };
export const serverNow = () => serverNowMs;

/** "now", "5m", "2h", "3d", "1w", "4mo", "1yr" as the feed renders them. */
export function relativeTime(ms) {
  const diff = Math.max(0, serverNowMs - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}yr`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function longDate(ms) {
  const date = new Date(ms);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

// ---- Avatars ---------------------------------------------------------------------------------

const AVATAR_COLOURS = ["#0a66c2", "#057642", "#915907", "#8f5849", "#5f4b8b", "#b24020", "#0e7470", "#56687a"];
export function avatar(name, seed, size = 48, organization = false) {
  const text = String(name ?? "?").trim();
  const initials = organization
    ? text.slice(0, 1).toUpperCase()
    : text.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => [...part][0]?.toUpperCase() ?? "").join("");
  let hash = 0;
  for (const char of String(seed ?? text)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  const node = el("span", { class: `avatar avatar--${size}${organization ? " avatar--org" : ""}`, text: initials || "?", attrs: { "aria-hidden": "true" } });
  node.style.setProperty("--avatar-bg", AVATAR_COLOURS[hash % AVATAR_COLOURS.length]);
  return node;
}

// ---- Toast -----------------------------------------------------------------------------------

let toastTimer;
export function toast(text, { error = false, actionLabel, onAction, timeout = 6000 } = {}) {
  const host = $("#toast");
  $("#toast-text").textContent = text;
  const iconHost = $("#toast-icon");
  iconHost.replaceChildren(icon(error ? "alert" : "check"));
  host.dataset.error = String(error);
  const button = $("#toast-action");
  button.hidden = !actionLabel;
  button.textContent = actionLabel ?? "";
  button.onclick = () => { host.hidden = true; if (onAction) onAction(); };
  host.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.hidden = true; }, timeout);
}
export function initToast() {
  $("#toast-close").addEventListener("click", () => { $("#toast").hidden = true; });
}

/** Button spinner/disabled state around an async task; ignores re-entry. */
export async function busy(button, task) {
  if (button?.dataset.busy === "true") return undefined;
  if (button) { button.dataset.busy = "true"; button.disabled = true; }
  try { return await task(); }
  finally { if (button) { button.dataset.busy = "false"; button.disabled = false; } }
}
