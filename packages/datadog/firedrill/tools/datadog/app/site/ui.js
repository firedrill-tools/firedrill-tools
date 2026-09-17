// Shared DOM, operation and time helpers for the Datadog Tool app. Record text is always rendered with
// textContent; operations go through the runtime client; "now" is the world's virtual clock, never the browser's.
import { getContext, invoke } from "/_firedrill/client.js";

export const $ = (sel, root = document) => root.querySelector(sel);

/** el("div.cls1.cls2", { attrs }, ...children) — children may be strings (as text), nodes, arrays or null. */
export function el(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = String(value);
    else if (key === "on") for (const [ev, fn] of Object.entries(value)) node.addEventListener(ev, fn);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") node.style.cssText = String(value); // CSSOM, allowed by the app CSP (style attributes are not)
    else if (key === "value") node.value = value;
    else if (key === "checked") node.checked = Boolean(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  append(node, children);
  return node;
}
export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

export class ToolError extends Error {
  constructor(outcome) {
    const error = outcome?.error ?? {};
    super(error.message ?? `Operation ${outcome?.status ?? "failed"}`);
    this.status = outcome?.status ?? "failed";
    this.code = String(error.code ?? outcome?.status ?? "UNKNOWN");
    this.retryable = Boolean(error.retryable);
  }
  get denied() { return /FORBIDDEN|denied|permission/i.test(`${this.code} ${this.status}`); }
}

/** Call an operation; resolves with the value or throws ToolError. Mutations pass { mutate: true }. */
export async function call(operation, args = {}, { mutate = false, key } = {}) {
  const options = mutate ? { idempotencyKey: key ?? crypto.randomUUID() } : undefined;
  let result;
  try {
    result = await invoke(operation, args, options);
  } catch (error) {
    throw new ToolError({ status: "transport_error", error: { code: "TRANSPORT", message: String(error?.message ?? error) } });
  }
  const outcome = result?.outcome;
  if (outcome?.status === "ok") return outcome.value;
  throw new ToolError(outcome);
}

export function describeError(error) {
  if (error instanceof ToolError) {
    if (error.denied) return `You don't have permission to do this. ${error.message}`;
    if (/SERVICE_UNAVAILABLE/.test(error.code)) return `${error.message} The request may still have been applied; check the list before retrying.`;
    if (/RATE_LIMITED/.test(error.code)) return `Rate limited: ${error.message}`;
    return error.message;
  }
  return String(error?.message ?? error);
}

// ---------------------------------------------------------------- world clock
export const world = { nowSec: 0, context: null, org: null, revision: undefined };
export function setOrg(org) { world.org = org; world.nowSec = org.now_sec; }
export const canWrite = (area) => Boolean(world.org?.permissions?.[`${area}_write`]);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
/** "Sep 15, 13:54:00" (UTC, explicit) */
export function fmtDate(sec, { seconds = true, year = false } = {}) {
  if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return "—";
  const d = new Date(Number(sec) * 1000);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ""}`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year ? `, ${d.getUTCFullYear()}` : ""}, ${time}`;
}
export const isoToSec = (iso) => (typeof iso === "string" && /Z$|[+-]\d\d:\d\d$/.test(iso) ? Math.floor(Date.parse(iso) / 1000) : null);
export function fmtAgo(sec) {
  if (sec === null || sec === undefined) return "—";
  const diff = world.nowSec - Number(sec);
  if (diff < 0) return "in the future";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
export function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
export function fmtNumber(v, precision = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return Number.isInteger(v) ? String(v) : v.toFixed(precision);
}

// ---------------------------------------------------------------- revision watch
export function watchWorld(onChange) {
  const tick = async () => {
    try {
      const ctx = await getContext();
      world.context = ctx;
      if (world.revision !== undefined && ctx.revision !== world.revision) { world.revision = ctx.revision; onChange(); }
      world.revision = ctx.revision;
    } catch { /* keep polling */ }
  };
  void tick();
  return setInterval(tick, 2000);
}
export { getContext };
