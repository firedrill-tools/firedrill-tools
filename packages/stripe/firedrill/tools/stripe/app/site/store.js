// Shared app state, hash routing and page registry. Pages register themselves; app.js boots the shell.
import { $, call } from "./ui.js";

export const app = {
  /** The Tool's `dashboard.context` value: account, virtual `now`, mode, permission levels. */
  context: undefined,
  connection: undefined,
  route: { page: "home", id: undefined, params: {} },
  pages: {},
  /** Bounded client-side indexes (status tabs, search) keyed by operation+args; cleared when the world revision moves. */
  cache: new Map(),
  revisionStamp: undefined,
  /** Set by a page while a form is being edited so a revision refresh does not discard typed values. */
  editing: 0,
  /** Elements to re-render when the world changes. */
  refresh: undefined,
};

/** World virtual "now" in Unix seconds — the app never reads the browser clock for dates. */
export const now = () => app.context?.now;

export function registerPage(name, render) {
  app.pages[name] = render;
}

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = hash;
}

/** `#/payments/pi_x?tab=refunded` → { page: "payments", id: "pi_x", params: { tab: "refunded" } }. */
export function parseRoute(hash) {
  const raw = (hash ?? "").replace(/^#\/?/, "");
  const [pathPart, queryPart = ""] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(queryPart).entries());
  const page = segments[0] || "home";
  const id = segments[1];
  const sub = segments[2];
  return { page, id, sub, params };
}

export function routeHash(page, id, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== "" && value !== null)).toString();
  return `#/${page}${id ? `/${id}` : ""}${query ? `?${query}` : ""}`;
}

/** Permission level of the calling key for a resource group ("none" | "read" | "write"). */
export function level(group) {
  return app.context?.permissions?.[group] ?? "write";
}
export function canRead(group) {
  return level(group) !== "none";
}
export function canWrite(group) {
  return level(group) === "write";
}

/** Route id prefixes to their pages. */
export const PREFIX_PAGES = Object.freeze({ pi: "payments", cus: "customers", in: "invoices", sub: "subscriptions", prod: "products", ch: "charges", re: "refunds", price: "prices", pm: "payment_methods", ii: "invoice_items" });

/** Re-read the dashboard context (account, now, permissions). */
export async function loadContext() {
  app.context = await call("dashboard.context", {});
  return app.context;
}

/** Bounded walk over a list operation, cached until the world revision changes. Returns { items, complete }. */
export async function indexAll(operation, args = {}, { max = 1000, pageSize = 100 } = {}) {
  const cacheKey = `${operation}:${JSON.stringify(args)}`;
  const hit = app.cache.get(cacheKey);
  if (hit) return hit;
  const items = [];
  let after;
  let complete = true;
  for (;;) {
    const page = await call(operation, { ...args, limit: pageSize, ...(after === undefined ? {} : { starting_after: after }) });
    items.push(...page.data);
    if (!page.has_more) break;
    if (items.length >= max) {
      complete = false;
      break;
    }
    after = page.data[page.data.length - 1].id;
  }
  const value = { items, complete };
  app.cache.set(cacheKey, value);
  return value;
}

export function invalidateCache() {
  app.cache.clear();
}

export function setTitle(title) {
  document.title = `${title} – Stripe Dashboard (synthetic)`;
}

export const pageHost = () => $("#page");
