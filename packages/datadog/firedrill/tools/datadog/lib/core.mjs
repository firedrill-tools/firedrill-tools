// Shared deterministic helpers: declared failures, identity and role checks, bounded scans, time rendering and
// defensive coercion of caller values. No module state, no wall clock, no host time zone.

export const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const ROLES = ["Datadog Admin Role", "Datadog Standard Role", "Datadog Read Only Role"];
const DEFAULT_LIMITS = { maxScanRows: 5000, maxGroupsPerMonitor: 100, maxSeriesPerQuery: 100, maxDashboardBytes: 800_000 };

export function fail(context, code, message) {
  return context.fail({ code, message });
}

export const bad = (context, message) => fail(context, "BAD_REQUEST", message);
export const notFound = (context, message) => fail(context, "NOT_FOUND", message);
export const forbidden = (context, message = "Forbidden") => fail(context, "FORBIDDEN", message);
export const limitExceeded = (context, message) => fail(context, "LIMIT_EXCEEDED", message);

export function limits(context) {
  const row = context.state.get("meta", "limits");
  return row === null ? { ...DEFAULT_LIMITS } : { ...DEFAULT_LIMITS, ...row };
}

export function nowUs(context) {
  return context.clock.nowUs();
}

export const nowSec = (context) => Math.floor(context.clock.nowUs() / 1_000_000);

/** Every row of a namespace (optionally under `prefix`), failing instead of truncating past the scan bound. */
export function scanAll(context, namespace, { prefix, max } = {}) {
  const bound = max ?? limits(context).maxScanRows;
  const rows = [];
  let after = prefix;
  for (;;) {
    const page = context.state.scan(namespace, after === undefined ? { limit: 500 } : { afterRowId: after, limit: 500 });
    for (const record of page) {
      if (prefix !== undefined && !record.rowId.startsWith(prefix)) return rows;
      rows.push(record);
      if (rows.length > bound) {
        limitExceeded(context, `state exceeds the supported bound of ${bound} rows in ${namespace}`);
      }
    }
    if (page.length < 500) return rows;
    after = page[page.length - 1].rowId;
  }
}

/** Resolve the calling Datadog user from `datadogUserHandle`, falling back to the organization's default user. */
export function caller(context, { write = false } = {}) {
  const attributes = context.actor.attributes ?? {};
  let handle = Object.hasOwn(attributes, "datadogUserHandle") ? attributes.datadogUserHandle : undefined;
  if (handle === undefined || handle === null) {
    const org = context.state.get("meta", "org");
    handle = org === null ? undefined : org.defaultUserHandle;
  }
  if (typeof handle !== "string" || handle.length === 0 || handle.length > 254) forbidden(context);
  const user = context.state.get("users", handle.toLowerCase());
  if (user === null || user.disabled === true) forbidden(context);
  if (write && user.role === "Datadog Read Only Role") {
    forbidden(context, "Forbidden: user does not have the required permission");
  }
  return user;
}

export const isAdmin = (user) => user.role === "Datadog Admin Role";

export function pad(value, width) {
  return String(value).padStart(width, "0");
}

/** `2026-09-15T14:00:00.000000+00:00` (monitors). */
export function isoMicros(us) {
  const ms = Math.floor(us / 1000);
  const micros = pad(((us % 1_000_000) + 1_000_000) % 1_000_000, 6);
  return `${new Date(ms).toISOString().slice(0, 19)}.${micros}+00:00`;
}

/** `2026-09-15T14:00:00.000Z` (dashboards, incidents, org context). */
export function isoMillis(us) {
  return new Date(Math.floor(us / 1000)).toISOString();
}

export function utf8Bytes(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export const RESPONSE_BUDGET = 900_000;

export function checkBudget(context, value) {
  if (utf8Bytes(JSON.stringify(value)) > RESPONSE_BUDGET) {
    limitExceeded(context, "Response too large; narrow the time range or page size");
  }
  return value;
}

export const present = (value) => value !== undefined && value !== null;

/** Integer from a number or a decimal string; `null` when absent; `undefined` when malformed or out of range. */
export function intArg(raw, min, max) {
  if (!present(raw)) return null;
  let value = raw;
  if (typeof raw === "string") value = /^-?[0-9]{1,16}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return undefined;
  return value;
}

export function requireInt(context, raw, name, min, max, fallback) {
  const value = intArg(raw, min, max);
  if (value === undefined) bad(context, `Invalid parameter: ${name} must be an integer between ${min} and ${max}`);
  if (value === null) {
    if (fallback === undefined) bad(context, `Missing required parameter: ${name}`);
    return fallback;
  }
  return value;
}

/** `true`/`false` from a boolean or string; `null` when absent; `undefined` when malformed. */
export function boolArg(raw) {
  if (!present(raw)) return null;
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

export function requireBool(context, raw, name, fallback) {
  const value = boolArg(raw);
  if (value === undefined) bad(context, `Invalid parameter: ${name} must be a boolean`);
  return value === null ? fallback : value;
}
