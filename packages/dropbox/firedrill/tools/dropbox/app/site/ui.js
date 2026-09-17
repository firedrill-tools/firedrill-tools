// DOM, Firedrill-client and formatting helpers for the Dropbox Tool app. Record text only ever goes through textContent.
import { invoke } from "/_firedrill/client.js";
import { icon } from "./icons.js";

export const $ = (selector, root = document) => root.querySelector(selector);

/** Create an element. options: { class, text, title, attrs }. */
export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title !== undefined) node.title = options.title;
  if (options.attrs) for (const [k, v] of Object.entries(options.attrs)) if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : String(v));
  for (const child of Array.isArray(children) ? children : [children]) if (child !== undefined && child !== null && child !== false) node.append(child);
  return node;
}

export function button(label, { kind = "secondary", iconName, onClick, attrs = {}, className = "" } = {}) {
  const node = el("button", { class: `db-btn db-btn-${kind} ${className}`.trim(), attrs: { type: "button", ...attrs } });
  if (iconName) node.append(icon(iconName));
  if (label) node.append(el("span", { text: label }));
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

export function iconButton(name, label, { onClick, attrs = {}, className = "" } = {}) {
  const node = el("button", { class: `db-icon-btn ${className}`.trim(), title: label, attrs: { type: "button", "aria-label": label, ...attrs } });
  node.append(icon(name));
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

// ---------------------------------------------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------------------------------------------

export class ToolError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
  get denied() {
    return this.status === "denied";
  }
  is(code) {
    return this.code === code || this.code === `tool.${code}` || String(this.code).endsWith(`.${code}`);
  }
}

export async function call(operationId, args = {}, idempotencyKey) {
  const result = await invoke(operationId, args, idempotencyKey ? { idempotencyKey } : {});
  if (result.outcome.status !== "ok") {
    const error = result.outcome.error ?? {};
    throw new ToolError(result.outcome.status, error.code ?? result.outcome.status, error.message ?? `The operation was ${result.outcome.status}.`);
  }
  return result.outcome.value;
}

export const newKey = () => crypto.randomUUID();

/** Dropbox's own wording for the errors this Tool declares. */
export function describe(error) {
  if (!(error instanceof ToolError)) return error?.message ?? "Something went wrong. Try again.";
  if (error.denied) return "You don't have permission to do that with this account.";
  const map = [
    ["RATE_LIMITED", "Too many requests. Try again in a moment."],
    ["TOO_MANY_WRITE_OPERATIONS", "Too many changes at once. Try again in a moment."],
    ["INTERNAL_ERROR", "Something went wrong. Refresh to check whether the change was saved."],
    ["INSUFFICIENT_SPACE", "You're out of Dropbox space. Delete files or get more space to continue."],
    ["MISSING_SCOPE", "This app doesn't have the permission needed for that."],
    ["INVALID_ACCESS_TOKEN", "Your session has ended. Sign in again."],
    ["NOT_FOUND", "This file was deleted or moved."],
    ["CANT_MOVE_FOLDER_INTO_ITSELF", "You can't move a folder into itself."],
    ["DISALLOWED_NAME", "That name isn't allowed. Try a different name."],
    ["MALFORMED_PATH", "That name contains characters Dropbox doesn't allow."],
    ["SHARED_LINK_ALREADY_EXISTS", "A link for this item already exists."],
    ["TOO_MANY_FILES", "This account holds more items than this view can load."],
    ["PAYLOAD_TOO_LARGE", "That file is too large to upload here."],
  ];
  for (const [code, text] of map) if (error.is(code)) return text;
  if (error.is("CONFLICT")) return "An item with that name already exists in this location.";
  if (error.status === "invalid") return `Invalid input: ${error.message}`;
  return error.message;
}

// ---------------------------------------------------------------------------------------------------------------
// One mutation at a time, progress bar, toast
// ---------------------------------------------------------------------------------------------------------------

let pending = 0;
export const isBusy = () => pending > 0;
export async function action(task, { onError } = {}) {
  if (pending > 0) return undefined;
  pending += 1;
  $("#loading").hidden = false;
  try {
    return await task();
  } catch (error) {
    if (onError) onError(error);
    else toast(describe(error), { error: true });
    return undefined;
  } finally {
    pending -= 1;
    $("#loading").hidden = pending === 0;
  }
}

let toastTimer;
export function toast(text, { actionLabel, onAction, error = false, timeout = 6000 } = {}) {
  const host = $("#toast");
  $("#toast-text").textContent = text;
  host.dataset.error = String(error);
  const act = $("#toast-action");
  act.hidden = !actionLabel;
  act.textContent = actionLabel ?? "";
  act.onclick = () => {
    host.hidden = true;
    onAction?.();
  };
  $("#toast-close").onclick = () => (host.hidden = true);
  host.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (host.hidden = true), timeout);
}

// ---------------------------------------------------------------------------------------------------------------
// Formatting (all dates relative to the world's server_time, never the browser clock)
// ---------------------------------------------------------------------------------------------------------------

let serverNowMs = 0;
export const setServerTime = (iso) => (serverNowMs = Date.parse(iso) || 0);
export const serverNow = () => serverNowMs;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

/** "9/14/2026 3:00 pm" style with UTC components, as Dropbox's Modified column shows it. */
export function formatDate(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "--";
  const d = new Date(ms);
  const h = d.getUTCHours();
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h % 12 || 12}:${pad(d.getUTCMinutes())} ${h < 12 ? "am" : "pm"}`;
}

export function relativeDate(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || !serverNowMs) return formatDate(iso);
  const minutes = Math.floor((serverNowMs - ms) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export const monthLabel = (iso) => {
  const d = new Date(Date.parse(iso));
  return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getUTCMonth()] + ` ${d.getUTCFullYear()}`;
};

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "--";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} ${units[unit]}`;
}

const CATEGORIES = { image: ["jpg", "jpeg", "png", "gif", "bmp", "svg", "webp", "heic", "tif", "tiff", "ico"], pdf: ["pdf"], spreadsheet: ["csv", "xls", "xlsx", "ods", "numbers", "tsv"], presentation: ["ppt", "pptx", "key", "odp"], audio: ["mp3", "wav", "aac", "flac", "m4a", "ogg"], video: ["mp4", "mov", "avi", "mkv", "webm", "m4v"], document: ["txt", "md", "doc", "docx", "rtf", "odt", "pages", "html", "htm", "json", "xml", "log"] };
export const extensionOf = (name) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
export function kindOf(entry) {
  if (entry[".tag"] === "folder") return "folder";
  const ext = extensionOf(entry.name);
  for (const [kind, list] of Object.entries(CATEGORIES)) if (list.includes(ext)) return kind;
  return "others";
}
export const parentOf = (path) => (path.lastIndexOf("/") <= 0 ? "" : path.slice(0, path.lastIndexOf("/")));
