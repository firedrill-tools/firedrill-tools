// Cursor paging helpers and the selected-company scope shared by the Console screens.
// Every list follows the Tool's `next` cursor to the end; a scan that would exceed PAGE_CAP pages stops
// and reports `complete: false`, which each screen surfaces through `truncationNote()` rather than dropping rows quietly.
import { call, el } from "./ui.js";
import { icon } from "./icons.js";

export const state = {
  company: undefined,   // selected company id
  companies: [],        // every company the key can reach (all pages)
  now: undefined,       // world time (ISO) from companies.list.server_time
  actorId: "actor",
  editing: 0,
};

const PAGE_CAP = 40;

/** Largest `limit` each list operation accepts, mirroring the Tool's own bounds. */
const MAX_LIMIT = Object.assign(Object.create(null), {
  "companies.list": 25,
  "workplaces.list": 500,
  "employees.list": 100,
  "earning_rates.list": 500,
  "pay_schedules.list": 25,
  "payrolls.list": 25,
  "payroll_items.list": 500,
});
const capLimit = (operationId, wanted) =>
  Math.max(1, Math.min(wanted, Object.hasOwn(MAX_LIMIT, operationId) ? MAX_LIMIT[operationId] : 25));

/** Follow `next` cursors until the list is exhausted or `cap` pages were read. */
export async function listAll(operationId, args = {}, { limit: wanted = 100, cap = PAGE_CAP } = {}) {
  const limit = capLimit(operationId, wanted);
  const rows = [];
  let cursor;
  let pages = 0;
  for (;;) {
    const page = await call(operationId, { ...args, limit, ...(cursor ? { cursor } : {}) });
    for (const row of page.results ?? []) rows.push(row);
    pages += 1;
    cursor = page.next ?? undefined;
    if (!cursor) return { rows, complete: true, serverTime: page.server_time };
    if (pages >= cap) return { rows, complete: false, serverTime: page.server_time };
  }
}

/** One page, for tables that page in the UI. Returns `{ rows, next, previous }`. */
export async function listPage(operationId, args = {}, cursor, wanted = 25) {
  const limit = capLimit(operationId, wanted);
  const page = await call(operationId, { ...args, limit, ...(cursor ? { cursor } : {}) });
  return { rows: page.results ?? [], next: page.next ?? null, previous: page.previous ?? null, serverTime: page.server_time };
}

/** Refresh the company list and world clock; keeps the current selection when still reachable. */
export async function refreshCompanies() {
  const { rows, complete, serverTime } = await listAll("companies.list", { active: true }, { limit: 100 });
  state.companies = rows;
  state.companiesComplete = complete;
  if (typeof serverTime === "string") state.now = serverTime;
  if (!rows.some((c) => c.id === state.company)) state.company = rows[0]?.id;
  return rows;
}
export const selectedCompany = () => state.companies.find((c) => c.id === state.company);
export const companyName = (id) => {
  const company = state.companies.find((c) => c.id === id);
  return company ? (company.trade_name || company.legal_name) : id ?? "—";
};

/** Simple in-request caches so a screen never rescans the same namespace per row. */
export async function loadEmployees(company) {
  const { rows, complete } = await listAll("employees.list", company ? { company } : {}, { limit: 100 });
  return { rows, complete, byId: new Map(rows.map((r) => [r.id, r])) };
}
export async function loadWorkplaces(company) {
  const { rows, complete } = await listAll("workplaces.list", company ? { company } : {}, { limit: 100 });
  return { rows, complete, byId: new Map(rows.map((r) => [r.id, r])) };
}
export async function loadSchedules(company) {
  const { rows, complete } = await listAll("pay_schedules.list", company ? { company } : {}, { limit: 100 });
  return { rows, complete, byId: new Map(rows.map((r) => [r.id, r])) };
}

export function skeletonCard(rowCount = 5) {
  const rows = [];
  for (let index = 0; index < rowCount; index += 1) {
    rows.push(el("div", { class: `skeleton skeleton-w${(index % 5) + 1}` }));
  }
  return el("div", { class: "card" }, el("div", { class: "rows-skeleton", attrs: { "aria-busy": "true", "aria-label": "Loading" } }, rows));
}
export function emptyState(title, message, action) {
  return el("div", { class: "card" }, el("div", { class: "state" }, [
    el("h3", { text: title }),
    el("p", { text: message }),
    action ?? null,
  ]));
}
export function banner(kind, message, extra) {
  return el("div", { class: `banner banner-${kind}` }, [
    icon(kind === "error" ? "warn" : kind === "warn" ? "warn" : kind === "ok" ? "check" : "info"),
    el("span", { class: "spacer", text: message }),
    extra ?? null,
  ]);
}
export function truncationNote(complete, noun) {
  return complete ? null : banner("warn", `Showing the first ${PAGE_CAP} pages of ${noun}. Narrow the filters to see the rest.`);
}
