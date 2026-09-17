// Shared app state: the signed-in NetSuite session (account, role, world clock), list paging over the
// record collections, status vocabulary and hash routing.
import { call, dayNum } from "./ui.js";

export const app = {
  pages: Object.create(null),
  session: null,
  sessionError: null,
  today: "",
  dirty: false,
  recent: [],
};

/** session.get carries the account, the role's permission levels and the account server time (world time). */
export async function loadSession() {
  try {
    const value = await call("session.get", {});
    app.session = value;
    app.today = String(value.accountDate ?? "").slice(0, 10);
    app.sessionError = null;
  } catch (error) {
    app.session = null;
    app.sessionError = error;
  }
  return app.session;
}

/** Permission level of the signed-in role, "none" when the session could not be read. */
export function level(permission) {
  const entry = (app.session?.role?.permissions ?? []).find((p) => p.name === permission);
  return entry ? entry.level : "none";
}
const RANK = ["none", "view", "create", "edit", "full"];
export const can = (permission, minimum = "view") => RANK.indexOf(level(permission)) >= RANK.indexOf(minimum);

/** One page of a NetSuite record collection: items carry only links and id, so ids are fetched then expanded. */
export async function listIds(operationId, { q, limit = 25, offset = 0 } = {}) {
  const args = { limit, offset };
  if (q !== undefined && q !== "") args.q = q;
  const value = await call(operationId, args);
  return {
    ids: (value.items ?? []).map((item) => item.id),
    count: value.count ?? 0,
    offset: value.offset ?? offset,
    hasMore: value.hasMore === true,
    totalResults: value.totalResults ?? 0,
  };
}
/** Expand a page of ids into records with the matching singular read. */
export async function expand(operationId, ids, extra = {}) {
  return Promise.all(ids.map((id) => call(operationId, { recordId: id, ...extra })));
}
/** A page of full records for a collection: { rows, page } in one call site. */
export async function listPage(listOperation, getOperation, options = {}) {
  const page = await listIds(listOperation, options);
  const rows = await expand(getOperation, page.ids, options.expand === true ? { expandSubResources: true } : {});
  return { rows, page };
}

export const PAGE_SIZES = [10, 25, 50];

// ---- status vocabulary (refName values projected by the Tool) ----
export function statusClass(refName) {
  const name = String(refName ?? "");
  if (name === "Paid In Full" || name === "Billed" || name === "Deposited") return "paid";
  if (name === "Pending Approval") return "pending";
  if (name.startsWith("Pending Billing") || name === "Partially Fulfilled" || name === "Pending Fulfillment") return "billing";
  if (name === "Voided") return "void";
  if (name === "Closed") return "closed";
  return "open";
}
export const isOverdue = (invoice, today = app.today) =>
  String(invoice?.status?.refName) === "Open"
  && Number(invoice?.amountRemaining) > 0
  && !Number.isNaN(dayNum(invoice?.dueDate))
  && dayNum(invoice.dueDate) < dayNum(today);

/** Remember a visited record for the Recent Records menu (in-memory, per app session). */
export function remember(entry) {
  app.recent = [entry, ...app.recent.filter((item) => item.href !== entry.href)].slice(0, 10);
}

// ---- routing ----
export function parseRoute(hash = location.hash) {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return ""; }
  });
  return { page: parts[0] || "home", id: parts[1], sub: parts[2], params: new URLSearchParams(query) };
}
export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = hash;
}
export function register(name, render) { app.pages[name] = render; }
