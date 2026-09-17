// Safe DOM helpers, operation calls, NetSuite formatting and banners. Record text only goes through textContent.
import { invoke } from "/_firedrill/client.js";
import { icon } from "./icons.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "value") node.value = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
export { icon };

export class ToolError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = String(code ?? status);
    this.details = details ?? {};
  }
  get denied() { return this.status === "denied"; }
  is(code) { return this.code === code || this.code.endsWith(`.${code}`); }
}

let pending = 0;
export const isPending = () => pending > 0;
export async function call(operationId, args = {}, idempotencyKey) {
  pending += 1;
  try {
    const result = await invoke(operationId, args, idempotencyKey ? { idempotencyKey } : {});
    if (result.outcome.status !== "ok") {
      const error = result.outcome.error ?? {};
      throw new ToolError(
        result.outcome.status,
        error.code ?? result.outcome.status,
        error.message ?? `The request was ${result.outcome.status}.`,
        error.details,
      );
    }
    return result.outcome.value;
  } finally {
    pending -= 1;
  }
}
export const newKey = () => crypto.randomUUID();

export function isDenied(error) {
  return error instanceof ToolError && (error.denied || error.is("INSUFFICIENT_PERMISSION") || error.is("INVALID_LOGIN"));
}
export function describe(error) {
  if (!(error instanceof ToolError)) return error?.message ?? "Something went wrong. Try again.";
  if (error.denied) return "This Firedrill actor is not granted this NetSuite operation.";
  if (error.is("CONCURRENCY_LIMIT_EXCEEDED")) return "Request limit exceeded. Wait a moment and try again.";
  if (error.is("RESULT_SET_TOO_LARGE")) return `${error.message} Narrow the filter and try again.`;
  return error.message;
}

// ---- formatting (calendar values come from world time through session.get, never the browser clock) ----
const MONEY = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (value, currency = "") => `${currency ? `${currency} ` : ""}${MONEY.format(Number(value) || 0)}`;
export const qty = (value) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(Number(value) || 0);
/** "2026-05-12" → "5/12/2026", the account's M/D/YYYY date format. */
export function mdy(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : "";
}
export function dayNum(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  return m ? Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000) : NaN;
}
export const addDays = (date, days) => {
  const n = dayNum(date);
  return Number.isNaN(n) ? date : new Date((n + days) * 86400000).toISOString().slice(0, 10);
};
export const dateOnly = (value) => String(value ?? "").slice(0, 10);
/** Quote a value for the NetSuite `q` record-filter grammar. */
export const lit = (text) => `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// ---- banners, toasts, skeletons ----
let toastTimer;
export function toast(message, { error = false } = {}) {
  const host = $("#toast");
  host.replaceChildren(icon(error ? "alert" : "check", 16), el("span", { text: message }));
  host.className = `toast ${error ? "error" : "success"}`;
  host.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.hidden = true; }, error ? 9000 : 4000);
}
export function banner(kind, title, detail, extra) {
  return el("div", { class: `banner ${kind}`, role: kind === "error" ? "alert" : "status" }, [
    icon(kind === "info" ? "info" : kind === "warn" ? "lock" : "alert", 17),
    el("div", {}, [
      el("div", { class: "banner-title", text: title }),
      detail ? el("div", { class: "banner-detail", text: detail }) : null,
      extra ?? null,
    ]),
  ]);
}
export function errorBanner(error, title = "This request could not be completed") {
  if (isDenied(error)) return banner("warn", "Permission Violation", describe(error));
  return banner("error", title, describe(error));
}
export function emptyState(title, detail) {
  return el("div", { class: "empty" }, [el("strong", { text: title }), detail ? el("div", { text: detail }) : null]);
}
export function skeletonRows(columns, rows = 8) {
  return Array.from({ length: rows }, () =>
    el("tr", { class: "sk-row" }, Array.from({ length: columns }, () => el("td", {}, el("div", { class: "skeleton" })))));
}
