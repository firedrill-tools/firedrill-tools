// Shared app state: organisation + world clock, paging helpers, invoice status vocabulary and routing.
import { call, dayNum } from "./ui.js";

export const app = { pages: Object.create(null), org: null, orgError: null, today: "", dirty: false };

/** The Tool dates the organisation with a fixed +12:00 offset; "today" comes from DateTimeUTC (world virtual time). */
const ORG_OFFSET_MS = 12 * 3600 * 1000;
export function setClock(envelope) {
  const m = /^\/Date\((-?\d+)/.exec(String(envelope?.DateTimeUTC ?? ""));
  if (m) app.today = new Date(Number(m[1]) + ORG_OFFSET_MS).toISOString().slice(0, 10);
}
export async function loadOrg() {
  try {
    const out = await call("organisation.get", {});
    setClock(out);
    app.org = out.Organisations?.[0] ?? null;
    app.orgError = null;
  } catch (error) {
    app.orgError = error;
  }
  return app.org;
}

/** One page of a list operation: { rows, pagination }. */
export async function listPage(operationId, key, args) {
  const out = await call(operationId, args);
  setClock(out);
  return { rows: out[key] ?? [], pagination: out.pagination ?? { page: 1, pageSize: (out[key] ?? []).length, pageCount: 1, itemCount: (out[key] ?? []).length } };
}
/** Every row of a paged list (100 per page, the Xero default). Throws past maxRows instead of truncating. */
const UNPAGED = new Set(["accounts.list", "tax-rates.list"]);
export async function listAll(operationId, key, args = {}, maxRows = 10000) {
  if (UNPAGED.has(operationId)) { const out = await call(operationId, args); setClock(out); return out[key] ?? []; } // Xero does not page these
  const rows = [];
  for (let page = 1; ; page += 1) {
    const { rows: batch, pagination } = await listPage(operationId, key, { ...args, page, pageSize: 100 });
    rows.push(...batch);
    if (page >= pagination.pageCount || batch.length === 0) return rows;
    if (rows.length >= maxRows) throw new Error(`More than ${maxRows} records match; narrow the search.`);
  }
}
/** itemCount of a filtered list without loading it. */
export async function countOf(operationId, key, args) {
  const { pagination } = await listPage(operationId, key, { ...args, page: 1, pageSize: 1, summaryOnly: true });
  return pagination.itemCount;
}

export const STATUS_LABEL = { DRAFT: "Draft", SUBMITTED: "Awaiting Approval", AUTHORISED: "Awaiting Payment", PAID: "Paid", VOIDED: "Voided", DELETED: "Deleted" };
export function statusLabel(inv) { return STATUS_LABEL[inv.Status] ?? inv.Status; }
export function isOverdue(inv, today = app.today) {
  const due = String(inv.DueDateString ?? "").slice(0, 10);
  return inv.Status === "AUTHORISED" && Number(inv.AmountDue) > 0 && due !== "" && dayNum(due) < dayNum(today);
}
export const dateOnly = (s) => String(s ?? "").slice(0, 10);

/** Document vocabulary per invoice type: sales invoices (ACCREC) and bills (ACCPAY). */
export const DOC = {
  ACCREC: { type: "ACCREC", route: "invoices", noun: "Invoice", plural: "Invoices", party: "To", newLabel: "New invoice", numberLabel: "Invoice number", section: "sales" },
  ACCPAY: { type: "ACCPAY", route: "bills", noun: "Bill", plural: "Bills to pay", party: "From", newLabel: "New bill", numberLabel: "Reference", section: "purchases" },
};

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
