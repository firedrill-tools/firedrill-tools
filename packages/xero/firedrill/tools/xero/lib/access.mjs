// Per-call session: organisation, tenant and OAuth scope checks, cached bounded scans, Xero error helpers, events.
import { clockOf } from "./dates.mjs";
import { clip, hasOwn, isGuid } from "./util.mjs";

export const ALL_SCOPES = Object.freeze([
  "accounting.settings",
  "accounting.settings.read",
  "accounting.contacts",
  "accounting.contacts.read",
  "accounting.transactions",
  "accounting.transactions.read",
]);

export const DEFAULT_SCAN_BOUND = 5000;
export const VALIDATION_MESSAGE = "A validation exception occurred";
export const NOT_FOUND_MESSAGE = "The resource you're looking for cannot be found";

function scopesOf(attributes) {
  if (!hasOwn(attributes, "scopes") || typeof attributes.scopes !== "string") return new Set(ALL_SCOPES);
  const set = new Set();
  for (const word of attributes.scopes.split(" ")) if (word.length > 0 && word.length <= 64) set.add(word);
  return set;
}

export function scanBound(context) {
  const limits = context.state.get("meta", "limits");
  const value = limits === null ? undefined : limits.maxScanRows;
  return Number.isInteger(value) && value >= 1 && value <= 10000 ? value : DEFAULT_SCAN_BOUND;
}

/** Raise helpers; each maps to one declared error code. */
function failures(context) {
  const fail = (code, text, details) => {
    const message = typeof text === "string" && text.length > 0 ? text : code;
    return context.fail(details === undefined ? { code, message } : { code, message, details });
  };
  return {
    forbidden: (detail) => fail("FORBIDDEN", "AuthorizationUnsuccessful", { detail: clip(detail, 300) }),
    unauthorized: (detail) => fail("UNAUTHORIZED", "AuthorizationUnsuccessful", { detail: clip(detail, 300) }),
    notFound: (detail = NOT_FOUND_MESSAGE) => fail("NOT_FOUND", clip(detail, 300)),
    parse: (message) => fail("QUERY_PARSE_EXCEPTION", clip(message, 500)),
    postData: (message) => fail("POST_DATA_INVALID", clip(message, 300)),
    bound: (message) => fail("STATE_BOUND_EXCEEDED", clip(message, 300)),
    /** One ValidationException element (a small projection, never an object created in this call). */
    validation: (messages, element = {}) =>
      fail("VALIDATION_EXCEPTION", VALIDATION_MESSAGE, {
        Elements: [{ ...element, ValidationErrors: (Array.isArray(messages) ? messages : [messages]).slice(0, 20).map((m) => ({ Message: clip(m, 500) })) }],
      }),
  };
}

/**
 * Open a session. family: "settings" | "contacts" | "transactions"; mode: "read" | "write".
 * Order: organisation present → actor tenant claim → xero-tenant-id header (REST routes) → scopes.
 */
export function open(context, input, family, mode) {
  const f = failures(context);
  const org = context.state.get("organisation", "organisation");
  if (org === null) return f.forbidden("This Firedrill world has no Xero organisation, so no tenant connection exists.");
  const attributes = context.actor.attributes ?? {};
  if (hasOwn(attributes, "xeroTenantId") && attributes.xeroTenantId !== org.tenantId) {
    return f.forbidden("The token is not connected to this organisation (xeroTenantId).");
  }
  if (hasOwn(input, "tenantId")) {
    const header = input.tenantId;
    if (typeof header !== "string" || header.length === 0) return f.forbidden("The xero-tenant-id header is missing.");
    if (!isGuid(header) || header.toLowerCase() !== org.tenantId) return f.forbidden("The xero-tenant-id header does not name a connected tenant.");
  }
  const scopes = scopesOf(attributes);
  const writeScope = `accounting.${family}`;
  const allowed = mode === "write" ? scopes.has(writeScope) : scopes.has(writeScope) || scopes.has(`${writeScope}.read`);
  if (!allowed) return f.unauthorized(`The token lacks the ${mode === "write" ? writeScope : `${writeScope}.read`} scope.`);
  return createSession(context, org, f);
}

function createSession(context, org, f) {
  const clock = clockOf(context);
  const bound = scanBound(context);
  const caches = new Map();
  const s = {
    context,
    org,
    clock,
    bound,
    ...f,
    get(namespace, rowId) {
      if (typeof rowId !== "string" || rowId.length === 0 || rowId.length > 512) return null;
      const cache = caches.get(namespace);
      if (cache !== undefined) return cache.get(rowId) ?? null;
      return context.state.get(namespace, rowId);
    },
    /** Every row of a namespace in row-id order as a Map; fails STATE_BOUND_EXCEEDED instead of truncating. */
    rows(namespace) {
      const cached = caches.get(namespace);
      if (cached !== undefined) return cached;
      const map = new Map();
      let after;
      for (;;) {
        const limit = Math.min(1000, bound + 1);
        const page = context.state.scan(namespace, after === undefined ? { limit } : { afterRowId: after, limit });
        for (const record of page) {
          map.set(record.rowId, record.value);
          if (map.size > bound) return f.bound(`State exceeds the supported bound of ${bound} rows for ${namespace}.`);
        }
        if (page.length < limit) break;
        after = page[page.length - 1].rowId;
      }
      caches.set(namespace, map);
      return map;
    },
    put(namespace, rowId, value) {
      context.state.put(namespace, rowId, value);
      const cache = caches.get(namespace);
      if (cache !== undefined) cache.set(rowId, value);
    },
    emit(eventId, resource, id, eventType, extra = {}) {
      context.events.emit(eventId, {
        resourceUrl: `/api.xro/2.0/${resource}/${id}`,
        resourceId: id,
        eventDateUtc: clock.iso,
        eventType,
        eventCategory: resource === "Invoices" ? "INVOICE" : "CONTACT",
        tenantId: org.tenantId,
        tenantType: "ORGANISATION",
        ...extra,
      });
    },
    envelope(extra) {
      return { Status: "OK", ProviderName: "Firedrill", DateTimeUTC: clock.wire, ...extra };
    },
  };
  return s;
}

/** Row lookups by GUID for projections (no scans). */
export const lookupsOf = (s) => ({
  contact: (id) => s.get("contacts", id),
  invoice: (id) => s.get("invoices", id),
  account: (id) => s.get("accounts", id),
  payment: (id) => s.get("payments", id),
});

/** ValidationException with several elements (summarizeErrors=true batches). */
export function failElements(s, elements) {
  return s.context.fail({
    code: "VALIDATION_EXCEPTION",
    message: VALIDATION_MESSAGE,
    details: { Elements: elements.slice(0, 50) },
  });
}

/** Normalise a save body into elements: { Key: [...] }, a single object, or a POST_DATA_INVALID failure. */
export function elementsOf(s, input, key, max = 50) {
  if (typeof input.bodyProblem === "string") return s.postData(input.bodyProblem.length > 0 ? input.bodyProblem : "Invalid Json data");
  const body = input.body;
  let elements;
  if (body !== null && typeof body === "object" && !Array.isArray(body) && Object.hasOwn(body, key)) elements = body[key];
  else if (body !== null && typeof body === "object" && !Array.isArray(body)) elements = [body];
  else return s.postData("Invalid Json data");
  if (!Array.isArray(elements) || elements.some((e) => e === null || typeof e !== "object" || Array.isArray(e))) return s.postData("Invalid Json data");
  if (elements.length === 0) s.validation(`At least one ${key.slice(0, -1)} is required`);
  if (elements.length > max) s.validation(`A maximum of ${max} ${key} can be saved in one request`);
  return elements;
}
