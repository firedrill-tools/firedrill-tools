// Shared handler plumbing: declared failures, API-key resolution, bounded scans and id generation.
// Everything reads and writes `context.state`; no module-level mutable state.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = "0123456789abcdef";
const DEFAULT_MAX_SCAN = 5000;
const CHUNK = 500;

export function fail(context, code, message) {
  return context.fail({ code, message, retryable: code === "RATE_LIMIT_EXCEEDED" || code === "APPLICATION_ERROR" });
}

/** Lowercased UUID or `null` when the text is not a UUID. Input length is bounded before the regex. */
export function normalizeUuid(value) {
  if (typeof value !== "string" || value.length !== 36) return null;
  const lower = value.toLowerCase();
  return UUID_RE.test(lower) ? lower : null;
}

export function requireUuid(context, value, name = "id") {
  const id = normalizeUuid(value);
  if (id === null) fail(context, "INVALID_PARAMETER", `The \`${name}\` must be a valid UUID.`);
  return id;
}

export function team(context) {
  const row = context.state.get("meta", "team");
  if (row === null) fail(context, "APPLICATION_ERROR", "The team record is missing from state.");
  return row;
}

/**
 * Resolve the calling API key. `resendApiKeyId` absent → the team's default key; present but unknown → INVALID_API_KEY.
 * `options.send` marks operations a sending_access key may call.
 */
export function resolveKey(context, options = {}) {
  const attributes = context.actor.attributes ?? {};
  const claimed = Object.hasOwn(attributes, "resendApiKeyId") ? attributes.resendApiKeyId : undefined;
  const teamRow = team(context);
  const keyId = claimed === undefined ? teamRow.defaultApiKeyId : normalizeUuid(claimed);
  const key = keyId === null ? null : context.state.get("api-keys", keyId);
  if (key === null) fail(context, "INVALID_API_KEY", "API key is invalid");
  if (key.permission !== "full_access" && options.send !== true) {
    fail(context, "RESTRICTED_API_KEY", "This API key is restricted to only send emails");
  }
  return { key, team: teamRow };
}

export function checkIdempotencyKey(context, input) {
  if (!Object.hasOwn(input, "idempotencyKey")) return;
  const value = input.idempotencyKey;
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    fail(context, "INVALID_IDEMPOTENCY_KEY", "Idempotency key must be between 1-256 characters");
  }
}

function maxScanRows(context) {
  const limits = context.state.get("meta", "limits");
  const value = limits === null ? DEFAULT_MAX_SCAN : limits.maxScanRows;
  return Number.isInteger(value) && value >= 1 && value <= 10000 ? value : DEFAULT_MAX_SCAN;
}

/**
 * Every row of `namespace` (or only rows whose id starts with `prefix`), in row-id order. Exceeding the configured
 * bound fails APPLICATION_ERROR instead of returning a truncated list.
 */
export function scanAll(context, namespace, prefix) {
  const bound = maxScanRows(context);
  const rows = [];
  let after = prefix;
  for (;;) {
    const chunk = context.state.scan(namespace, after === undefined ? { limit: CHUNK } : { afterRowId: after, limit: CHUNK });
    for (const record of chunk) {
      if (prefix !== undefined && !record.rowId.startsWith(prefix)) return rows;
      if (rows.length >= bound) {
        fail(context, "APPLICATION_ERROR", `state exceeds the supported bound of ${bound} rows`);
      }
      rows.push(record);
    }
    if (chunk.length < CHUNK) return rows;
    after = chunk[chunk.length - 1].rowId;
  }
}

function randomHex(context, count) {
  let out = "";
  for (let i = 0; i < count; i += 1) out += HEX[context.random.nextInteger(0, 16)];
  return out;
}

/**
 * New UUID v4 whose first 8 hex digits hold a descending sequence, so row-id order is newest first.
 * `counter` is the field of `meta/counters` to advance.
 */
export function newId(context, counter) {
  const counters = context.state.get("meta", "counters") ?? { emails: 0, domains: 0, apiKeys: 0, segments: 0, contacts: 0 };
  const seq = (counters[counter] ?? 0) + 1;
  context.state.put("meta", "counters", { ...counters, [counter]: seq });
  const prefix = (0xffffffff - seq).toString(16).padStart(8, "0");
  const variant = "89ab"[context.random.nextInteger(0, 4)];
  return `${prefix}-${randomHex(context, 4)}-4${randomHex(context, 3)}-${variant}${randomHex(context, 3)}-${randomHex(context, 12)}`;
}

export function randomChars(context, alphabet, count) {
  let out = "";
  for (let i = 0; i < count; i += 1) out += alphabet[context.random.nextInteger(0, alphabet.length)];
  return out;
}

export function hasReservedKey(object) {
  return Object.keys(object).some((key) => key === "__proto__" || key === "constructor" || key === "prototype");
}
