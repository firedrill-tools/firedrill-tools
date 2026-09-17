// Shared handler plumbing: declared failures, calling-key resolution, bounded scans, ids, money and byte budgets.
// Everything reads `context.state`; there is no module-level mutable state.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = "0123456789abcdef";
const DEFAULT_MAX_SCAN = 5000;
const DEFAULT_MAX_BYTES = 900_000;
const CHUNK = 500;
const RETRYABLE = new Set(["RATE_LIMIT_RATE_LIMIT_EXCEEDED", "INTERNAL_UNCLASSIFIED_ERROR", "INTERNAL_FAILED_CREATE_API_KEY"]);

/** Stop with a declared Waterfall error. `detail` becomes the wire `error[]` list (defaults to `[message]`). */
export function fail(context, code, message, detail) {
  const options = { code, message, retryable: RETRYABLE.has(code) };
  if (detail !== undefined) options.details = { error: detail };
  return context.fail(options);
}

/** Clip caller text quoted in an error message. */
export function clip(value, max = 200) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Lowercased UUID or `null` when the text is not a UUID. Length is bounded before the regex runs. */
export function normalizeUuid(value) {
  if (typeof value !== "string" || value.length !== 36) return null;
  const lower = value.toLowerCase();
  return UUID_RE.test(lower) ? lower : null;
}

/** A fresh lowercase UUID v4 drawn from the world's seeded random source. */
export function newUuid(context) {
  let digits = "";
  for (let draw = 0; draw < 2; draw += 1) {
    let word = context.random.nextU64();
    for (let nibble = 0; nibble < 16; nibble += 1) {
      digits += HEX[Number(word & 15n)];
      word >>= 4n;
    }
  }
  const variant = HEX[8 + (parseInt(digits[16], 16) & 3)];
  return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-4${digits.slice(13, 16)}-${variant}${digits.slice(17, 20)}-${digits.slice(20, 32)}`;
}

export function account(context) {
  const row = context.state.get("meta", "account");
  if (row === null) fail(context, "INTERNAL_UNCLASSIFIED_ERROR", "Internal server error");
  return row;
}

export function limits(context) {
  const row = context.state.get("meta", "limits");
  const scan = row !== null && Number.isInteger(row.max_scan_rows) && row.max_scan_rows >= 1 && row.max_scan_rows <= 10000 ? row.max_scan_rows : DEFAULT_MAX_SCAN;
  const bytes = row !== null && Number.isInteger(row.max_response_bytes) && row.max_response_bytes >= 65536 && row.max_response_bytes <= 1_000_000
    ? row.max_response_bytes
    : DEFAULT_MAX_BYTES;
  return { maxScanRows: scan, maxResponseBytes: bytes };
}

/**
 * Resolve the calling Waterfall key: actor attribute `waterfallApiKey` when present, otherwise the seeded master key.
 * An unknown or inactive key fails AUTH_BAD_API_KEY; `options.master` demands the master key; `options.billable`
 * demands a positive prepaid balance.
 */
export function resolveKey(context, options = {}) {
  const attributes = context.actor.attributes ?? {};
  const claimed = Object.hasOwn(attributes, "waterfallApiKey") ? attributes.waterfallApiKey : undefined;
  const acct = account(context);
  const keyId = claimed === undefined ? acct.master_api_key : normalizeUuid(claimed);
  const key = keyId === null ? null : context.state.get("api-keys", keyId);
  if (key === null || key.active !== true) fail(context, "AUTH_BAD_API_KEY", "Bad api key");
  if (options.master === true && key.master !== true) {
    fail(context, "AUTH_NEED_MASTER_API_KEY", "This endpoint requires a master api key");
  }
  if (options.billable === true && acct.balance_remaining_micros <= 0) {
    fail(context, "QUOTA_ACCOUNT_OVER_QUOTA", "Your account is over its quota. Please contact your account manager to discuss an upgrade.");
  }
  return { key, account: acct };
}

/**
 * Every row of `namespace` (or only rows whose id starts with `prefix`), in row-id order. Exceeding the configured
 * bound fails INTERNAL_UNCLASSIFIED_ERROR instead of returning a truncated list.
 */
export function scanAll(context, namespace, prefix) {
  const bound = limits(context).maxScanRows;
  const rows = [];
  let after = prefix;
  for (;;) {
    const chunk = context.state.scan(namespace, after === undefined ? { limit: CHUNK } : { afterRowId: after, limit: CHUNK });
    for (const record of chunk) {
      if (prefix !== undefined && !record.rowId.startsWith(prefix)) return rows;
      if (rows.length >= bound) fail(context, "INTERNAL_UNCLASSIFIED_ERROR", `state exceeds the supported bound of ${bound} rows`);
      rows.push(record);
    }
    if (chunk.length < CHUNK) return rows;
    after = chunk[chunk.length - 1].rowId;
  }
}

/** UTF-8 byte length of a string, computed from code points (no Buffer in behavior modules). */
export function utf8Length(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** UTF-8 byte size of a value's JSON encoding. */
export function jsonBytes(value) {
  return utf8Length(JSON.stringify(value));
}

/** Fail INTERNAL_UNCLASSIFIED_ERROR when a response body would exceed the byte budget (checked before any write). */
export function assertResponseSize(context, value) {
  const budget = limits(context).maxResponseBytes;
  if (jsonBytes(value) > budget) {
    fail(context, "INTERNAL_UNCLASSIFIED_ERROR", `response exceeds the supported size of ${budget} bytes`);
  }
}

/** Micro-USD → USD number, exact for the six-decimal values stored. */
export function usd(micros) {
  return Number((micros / 1_000_000).toFixed(6));
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
