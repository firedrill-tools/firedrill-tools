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
  is(code) { return this.code === code || this.code === `tool.${code}` || this.code.endsWith(`.${code}`); }
  get qboCode() { return this.details.qboCode; }
  get element() { return typeof this.details.element === "string" ? this.details.element : ""; }
  get detail() { return typeof this.details.detail === "string" ? this.details.detail : this.message; }
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
  return error instanceof ToolError && (error.denied || error.is("AUTHORIZATION_FAILED") || error.is("AUTHENTICATION_FAILED"));
}
export function describe(error) {
  if (!(error instanceof ToolError)) return error?.message ?? "Something went wrong. Try again.";
  if (error.denied) return "This Firedrill actor is not granted this QuickBooks operation.";
  if (error.is("THROTTLE_EXCEEDED")) return "QuickBooks is receiving too many requests right now. Wait a moment, then try again.";
  if (error.status === "invalid") return `Invalid request: ${error.message}`;
  return error.detail || error.message;
}

// ---- formatting (all dates are calendar strings from the company clock, never the browser clock) ----
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const plain = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (n) => usd.format(Number(n) || 0);
export const amount = (n) => plain.format(Number(n) || 0);
export function mdY(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
}
export function dayNum(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : NaN;
}
export function addDays(date, days) {
  const n = dayNum(date);
  if (Number.isNaN(n)) return date;
  return new Date((n + days) * 86400000).toISOString().slice(0, 10);
}
export const quote = (text) => `'${String(text).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

// ---- toast ----
let toastTimer;
export function toast(message, { error = false, action } = {}) {
  const host = $("#toast");
  const children = [el("span", { text: message })];
  if (action) children.push(el("button", { type: "button", text: action.label, onclick: () => { host.hidden = true; action.run(); } }));
  host.replaceChildren(...children);
  host.className = `toast ${error ? "error" : "success"}`;
  host.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.hidden = true; }, error ? 9000 : 4000);
}

export function banner(kind, title, detail, extra) {
  return el("div", { class: `banner ${kind}`, role: kind === "error" ? "alert" : "status" }, [
    icon(kind === "info" ? "info" : "alert"),
    el("div", {}, [el("div", { class: "banner-title", text: title }), detail ? el("div", { class: "banner-detail", text: detail }) : null, extra ?? null]),
  ]);
}
export function errorBanner(error, title = "Something's not right") {
  if (isAccessDenied(error)) return banner("warn", "You don't have access to this", describe(error));
  const code = error instanceof ToolError && error.qboCode ? ` (Error ${error.qboCode})` : "";
  return banner("error", title + code, describe(error));
}
export function loadingRows(cols, rows = 6) {
  return Array.from({ length: rows }, () => el("tr", {}, Array.from({ length: cols }, () => el("td", {}, el("div", { class: "skeleton" })))));
}

// ---- dialogs, menus, not-simulated panel ----
let dialogSeq = 0;
export function dialog({ title, body, actions = [], wide = false, onClose }) {
  const root = $("#overlay-root");
  const previous = document.activeElement;
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); onClose?.(); previous?.focus?.(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const titleId = `dlg-title-${(dialogSeq += 1)}`;
  const box = el("div", { class: `dialog${wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-labelledby": titleId }, [
    el("div", { class: "dialog-head" }, [el("h2", { id: titleId, text: title }), el("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close"))]),
    el("div", { class: "dialog-body" }, body),
    actions.length ? el("div", { class: "dialog-foot" }, actions.map((a) => el("button", { type: "button", class: `btn ${a.kind ?? ""}`, text: a.label, onclick: () => a.run(close) }))) : null,
  ]);
  const wrap = el("div", { class: "scrim", onclick: (e) => { if (e.target === wrap) close(); } }, box);
  root.append(wrap);
  document.addEventListener("keydown", onKey);
  (box.querySelector(".dialog-foot .btn") ?? box.querySelector("button"))?.focus();
  return { close, box };
}
export function confirmDialog(title, message, confirmLabel, kind = "primary") {
  return new Promise((resolve) => {
    let answered = false;
    dialog({
      title, body: el("p", { text: message }),
      onClose: () => { if (!answered) resolve(false); },
      actions: [
        { label: "Cancel", run: (close) => { answered = true; resolve(false); close(); } },
        { label: confirmLabel, kind, run: (close) => { answered = true; resolve(true); close(); } },
      ],
    });
  });
}
export function notSimulated(feature) {
  dialog({
    title: feature,
    body: [el("p", { text: `${feature} is part of QuickBooks Online but is not simulated by this Firedrill Tool.` }),
      el("p", { class: "muted", text: "This Tool models customers, products and services, invoices, payments, the chart of accounts and company info." })],
    actions: [{ label: "OK", kind: "primary", run: (close) => close() }],
  });
}
let openMenuState;
export function closeMenu() { openMenuState?.(); openMenuState = undefined; }
export function openMenu(anchor, items, { className = "" } = {}) {
  closeMenu();
  const pop = el("div", { class: `menu-pop ${className}`, role: "menu" });
  for (const it of items) {
    pop.append(el("button", { type: "button", class: "mi", role: "menuitem", text: it.label, disabled: it.disabled, title: it.title, onclick: () => { closeMenu(); it.run(); } }));
  }
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8))}px`;
  anchor.setAttribute("aria-expanded", "true");
  const away = (e) => { if (!pop.contains(e.target) && e.target !== anchor) closeMenu(); };
  const key = (e) => { if (e.key === "Escape") { closeMenu(); anchor.focus(); } };
  setTimeout(() => document.addEventListener("click", away), 0);
  document.addEventListener("keydown", key);
  openMenuState = () => { pop.remove(); anchor.setAttribute("aria-expanded", "false"); document.removeEventListener("click", away); document.removeEventListener("keydown", key); };
  pop.querySelector(".mi:not(:disabled)")?.focus();
  return pop;
}

export function watchWorld(refresh, mayRefresh = () => true) {
  let revision;
  const check = async () => {
    if (pending > 0 || document.visibilityState !== "visible") return;
    try {
      const context = await getContext();
      const stamp = JSON.stringify(context.revision);
      if (revision === undefined) { revision = stamp; return; }
      if (stamp !== revision && mayRefresh()) { revision = stamp; await refresh(); }
    } catch { /* environment closed; keep the page as is */ }
  };
  setInterval(check, 2000);
  return check;
}
