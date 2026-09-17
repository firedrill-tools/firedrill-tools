// Safe DOM helpers, operation calls, formatting, toasts, dialogs and menus. Record text only ever goes through textContent.
import { getContext, invoke } from "/_firedrill/client.js";
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
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
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
      const e = result.outcome.error ?? {};
      throw new ToolError(result.outcome.status, e.code ?? result.outcome.status, e.message ?? `The request was ${result.outcome.status}.`, e.details);
    }
    return result.outcome.value;
  } finally {
    pending -= 1;
  }
}
export const newKey = () => crypto.randomUUID();

export function isAccessDenied(error) {
  return error instanceof ToolError && (error.denied || error.is("FORBIDDEN") || error.is("UNAUTHORIZED"));
}
export function describe(error) {
  if (!(error instanceof ToolError)) return error?.message ?? "Something went wrong. Try again.";
  if (error.denied) return "This Firedrill actor is not granted this Xero operation.";
  if (error.is("RATE_LIMITED")) return "Xero is receiving too many requests right now. Wait a moment, then try again.";
  if (error.is("SERVICE_UNAVAILABLE")) return "Xero is temporarily unavailable. Nothing was saved; try again shortly.";
  if (error.status === "invalid") return `Invalid request: ${error.message}`;
  return error.message;
}

// ---- formatting: calendar dates from world time only, never the browser clock ----
const nzd = new Intl.NumberFormat("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const amount = (n) => nzd.format(Number(n) || 0);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-15" or "2026-09-15T00:00:00" → "15 Sep 2026" (Xero's day-month-year display). */
export function dmy(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
}
/** Xero wire date "/Date(1789423200000+0000)/" → "2026-09-14" (UTC calendar date). */
export function wireDate(value) {
  const m = /^\/Date\((-?\d+)/.exec(String(value ?? ""));
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : "";
}
export function dayNum(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : NaN;
}
export function addDays(date, days) {
  const n = dayNum(date);
  return Number.isNaN(n) ? date : new Date((n + days) * 86400000).toISOString().slice(0, 10);
}
/** Quote a string literal for the where grammar. */
export const lit = (text) => `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// ---- toast and banners ----
let toastTimer;
export function toast(message, { error = false, action } = {}) {
  const host = $("#toast");
  const children = [icon(error ? "alert" : "check", 18), el("span", { text: message })];
  if (action) children.push(el("button", { type: "button", text: action.label, onclick: () => { host.hidden = true; action.run(); } }));
  host.replaceChildren(...children);
  host.className = `toast ${error ? "error" : "success"}`;
  host.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.hidden = true; }, error ? 9000 : 4000);
}
export function banner(kind, title, detail, extra) {
  return el("div", { class: `banner ${kind}`, role: kind === "error" ? "alert" : "status" }, [
    icon(kind === "info" ? "info" : kind === "warn" ? "lock" : "alert"),
    el("div", {}, [el("div", { class: "banner-title", text: title }), detail ? el("div", { class: "banner-detail", text: detail }) : null, extra ?? null]),
  ]);
}
export function errorBanner(error, title = "Something went wrong") {
  if (isAccessDenied(error)) return banner("warn", "You don't have permission to view this", describe(error));
  return banner("error", title, describe(error));
}
export function skeletonRows(cols, rows = 6) {
  return Array.from({ length: rows }, () => el("tr", { class: "sk-row" }, Array.from({ length: cols }, () => el("td", {}, el("div", { class: "skeleton" })))));
}
