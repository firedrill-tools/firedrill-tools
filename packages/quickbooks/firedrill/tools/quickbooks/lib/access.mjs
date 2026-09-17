// Caller identity, QuickBooks user-role model and the per-operation session (clock, caches, id counters, events).
import { DEFAULT_OFFSET_MINUTES, clockOf, fail, isId, padId, scanAll, scanBound, toCents } from "./common.mjs";

const ROLES = new Set(["company_admin", "standard_limited_customers", "reports_only"]);
const LIMITED = new Set([
  "company.read",
  "query",
  "customers.read",
  "customers.write",
  "invoices.read",
  "invoices.write",
  "payments.read",
  "payments.write",
  "items.read",
]);

export const NOT_FOUND_DETAIL =
  "Object Not Found : Something you're trying to use has been made inactive or deleted. Check the fields with accounts, customers, items, vendors or employees.";

/**
 * Open a session for one operation call. Order: company present → actor realm claim → actor role → path/argument
 * realm → role capability. Actors without attributes act as the company admin of the seeded realm.
 */
export function open(context, input, capability) {
  const company = context.state.get("company", "company");
  const offset = company !== null && Number.isInteger(company.utcOffsetMinutes) ? company.utcOffsetMinutes : DEFAULT_OFFSET_MINUTES;
  const clock = clockOf(context, offset);
  if (company === null) {
    return fail(context, "AUTHENTICATION_FAILED", "This Firedrill world has no QuickBooks company, so no token can be valid for it.", "", clock);
  }
  const attributes = context.actor.attributes ?? {};
  if (Object.hasOwn(attributes, "realmId") && attributes.realmId !== company.realmId) {
    return fail(context, "AUTHENTICATION_FAILED", "Token is not valid for this company: the realmId it was issued for does not match.", "", clock);
  }
  let role = "company_admin";
  if (Object.hasOwn(attributes, "role")) {
    if (typeof attributes.role !== "string" || !ROLES.has(attributes.role)) {
      return fail(context, "AUTHENTICATION_FAILED", "Token carries an unknown QuickBooks user role.", "", clock);
    }
    role = attributes.role;
  }
  if (input.realmId !== undefined && input.realmId !== company.realmId) {
    return fail(context, "AUTHORIZATION_FAILED", "The application is not authorized to access the requested company (realmId).", "", clock);
  }
  const session = createSession(context, company, clock, role);
  session.permit(capability);
  return session;
}

function createSession(context, company, clock, role) {
  const cache = new Map();
  const bound = scanBound(context);
  const s = {
    context,
    memo: new Map(),
    company,
    clock,
    role,
    realmId: company.realmId,
    fail: (code, detail, element = "") => fail(context, code, detail, element, clock),
    permit(capability) {
      if (role === "company_admin") return;
      if (role === "standard_limited_customers" && LIMITED.has(capability)) return;
      if (role === "reports_only" && capability === "company.read") return;
      s.fail("AUTHORIZATION_FAILED", `Your QuickBooks user role (${role}) does not allow this request (${capability}).`);
    },
    get(namespace, id) {
      return isId(id) ? context.state.get(namespace, padId(id)) : null;
    },
    rows(namespace) {
      if (!cache.has(namespace)) cache.set(namespace, scanAll(context, namespace, bound, clock));
      return cache.get(namespace);
    },
    put(namespace, row) {
      context.state.put(namespace, padId(row.Id), row);
      invalidate(namespace);
    },
    remove(namespace, id) {
      context.state.delete(namespace, padId(id));
      invalidate(namespace);
    },
    emit(eventId, name, id, operation) {
      context.events.emit(eventId, { realmId: company.realmId, name, id, operation, lastUpdated: clock.meta });
    },
    /** Next free id for an entity counter; skips ids already present (consumer-authored rows). */
    nextId(key, namespace) {
      const counters = context.state.get("meta", "counters") ?? {};
      let next = Number.isInteger(counters[key]) && counters[key] >= 1 ? counters[key] : 1;
      for (let guard = 0; context.state.get(namespace, padId(next)) !== null; guard += 1) {
        if (guard >= bound) s.fail("STATE_BOUND_EXCEEDED", `No free ${key} id within the supported bound of ${bound} rows.`);
        next += 1;
      }
      if (next > 9_999_999_999) s.fail("BUSINESS_VALIDATION", `The ${key} id space is exhausted.`);
      context.state.put("meta", "counters", { ...defaultCounters(), ...counters, [key]: next + 1 });
      return String(next);
    },
    setCounter(key, value) {
      const counters = context.state.get("meta", "counters") ?? {};
      context.state.put("meta", "counters", { ...defaultCounters(), ...counters, [key]: value });
    },
    counter(key) {
      const counters = context.state.get("meta", "counters") ?? {};
      return Number.isInteger(counters[key]) && counters[key] >= 1 ? counters[key] : 1;
    },
    /** Map invoice id → { cents, paymentIds[] } from non-voided payment lines. */
    applied() {
      if (!cache.has("#applied")) {
        const map = new Map();
        for (const payment of s.rows("payments")) {
          for (const line of payment.Line) {
            const invoiceId = line.LinkedTxn[0].TxnId;
            const entry = map.get(invoiceId) ?? { cents: 0, paymentIds: [] };
            entry.cents += toCents(line.Amount) ?? 0;
            if (!entry.paymentIds.includes(payment.Id)) entry.paymentIds.push(payment.Id);
            map.set(invoiceId, entry);
          }
        }
        cache.set("#applied", map);
      }
      return cache.get("#applied");
    },
    /** Map customer id → open balance cents (Σ invoice Balance). */
    balances() {
      if (!cache.has("#balances")) {
        const map = new Map();
        for (const invoice of s.rows("invoices")) {
          const id = invoice.CustomerRef.value;
          map.set(id, (map.get(id) ?? 0) + (toCents(invoice.Balance) ?? 0));
        }
        cache.set("#balances", map);
      }
      return cache.get("#balances");
    },
  };
  function invalidate(namespace) {
    cache.delete(namespace);
    if (namespace === "payments") cache.delete("#applied");
    if (namespace === "invoices") cache.delete("#balances");
  }
  return s;
}

export function defaultCounters() {
  return { customer: 1, item: 1, invoice: 1, payment: 1, docNumber: 1001 };
}

/** Load an entity row by caller id, or fail OBJECT_NOT_FOUND (ids are validated before any lookup). */
export function load(s, namespace, id, element = "Id") {
  const row = s.get(namespace, id);
  if (row === null) s.fail("OBJECT_NOT_FOUND", NOT_FOUND_DETAIL, element);
  return row;
}

export function staleCheck(s, row, syncToken) {
  if (syncToken !== row.SyncToken) {
    s.fail(
      "STALE_OBJECT",
      "Stale Object Error : You and another user were working on this at the same time. The other user finished before you did, so your work was not saved.",
      "SyncToken",
    );
  }
}

export function bumpToken(row) {
  const n = Number(row.SyncToken);
  return String(Number.isSafeInteger(n) ? n + 1 : 1);
}
