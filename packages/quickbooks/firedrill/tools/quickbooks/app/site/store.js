// Shared app state: company + world clock, query helpers compiled to query.run, invoice status and routing.
import { getContext } from "/_firedrill/client.js";
import { call, dayNum } from "./ui.js";

export const app = { pages: Object.create(null), company: null, today: "", time: "", context: null, dirty: false };

export async function loadCompany() {
  const [context, info] = await Promise.all([getContext(), call("company-info.get", {})]);
  app.context = context;
  app.company = info.CompanyInfo;
  setClock(info.time);
  return info;
}
/** "2026-09-15T02:00:00-07:00" → today in the company's time zone (world virtual time, never the browser clock). */
export function setClock(time) {
  if (typeof time === "string" && /^\d{4}-\d{2}-\d{2}/.test(time)) { app.time = time; app.today = time.slice(0, 10); }
}

export const PAGE = 1000;
/** Run one query and return the entity array (and keep the clock fresh). */
export async function query(text) {
  const out = await call("query.run", { query: text });
  setClock(out.time);
  const r = out.QueryResponse ?? {};
  const key = Object.keys(r).find((k) => Array.isArray(r[k]));
  return key ? r[key] : [];
}
export async function count(text) {
  const out = await call("query.run", { query: text });
  setClock(out.time);
  return out.QueryResponse?.totalCount ?? 0;
}
/**
 * Every row of a query, paged with STARTPOSITION/MAXRESULTS. The service caps a page at 1000 rows and about 900 KB of JSON
 * and cuts a page before the first row that does not fit, so a short page is NOT the last page: paging continues from
 * STARTPOSITION + rows returned until a page comes back empty. A page that fails STATE_BOUND_EXCEEDED (a single row over
 * the bound) is retried with a halved page size down to 1, then thrown. Never truncates: past maxRows it throws.
 */
export async function queryAll(text, maxRows = 20000) {
  const rows = [];
  let size = PAGE;
  for (;;) {
    let batch;
    try {
      batch = await query(`${text} STARTPOSITION ${rows.length + 1} MAXRESULTS ${size}`);
    } catch (error) {
      if (size > 1 && typeof error?.is === "function" && error.is("STATE_BOUND_EXCEEDED")) { size = Math.max(1, Math.floor(size / 2)); continue; }
      throw error;
    }
    if (batch.length === 0) return rows;
    rows.push(...batch);
    if (rows.length >= maxRows) throw new Error(`More than ${maxRows} rows; narrow the filter.`);
  }
}

export function isVoided(inv) {
  return Number(inv.TotalAmt) === 0 && typeof inv.PrivateNote === "string" && inv.PrivateNote.startsWith("Voided");
}
/** QuickBooks invoice status label + tone, computed against the company's today. */
export function invoiceStatus(inv, today = app.today) {
  if (isVoided(inv)) return { key: "voided", label: "Voided", tone: "grey" };
  const balance = Number(inv.Balance);
  const total = Number(inv.TotalAmt);
  if (balance <= 0) {
    const deposited = inv.depositedTo === "bank";
    return deposited ? { key: "deposited", label: "Deposited", tone: "green" } : { key: "paid", label: "Paid", tone: "green" };
  }
  const days = dayNum(inv.DueDate) - dayNum(today);
  const partial = balance < total ? `Partially paid, ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(balance)} due` : "";
  if (days < 0) return { key: "overdue", label: `Overdue ${-days} day${days === -1 ? "" : "s"}`, sub: partial, tone: "orange" };
  if (days === 0) return { key: "due", label: "Due today", sub: partial, tone: "orange" };
  return { key: "open", label: `Due in ${days} day${days === 1 ? "" : "s"}`, sub: partial, tone: "grey", sent: inv.EmailStatus === "EmailSent" };
}

// ---- routing ----
export function parseRoute(hash = location.hash) {
  const [path, qs = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return ""; } });
  return { page: parts[0] || "home", id: parts[1], sub: parts[2], params: new URLSearchParams(qs) };
}
export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = hash;
}
export function register(name, render) { app.pages[name] = render; }
