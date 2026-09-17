// Account Reporter v2 (key and account usage over a month or a custom interval, balance, master-only prices) and
// API-key management (list, create, modify; master key only).
import { clip, fail, normalizeUuid, newUuid, resolveKey, scanAll, usd } from "../lib/core.mjs";
import { USAGE_COUNTERS } from "../lib/jobs.mjs";
import { addMonths, civilFromDays, dateOfUs, daysFromCivil, daysInMonth, formatDate, monthOfDays, monthStartDays, parseDate, parseMonth } from "../lib/time.mjs";
import { optionalString, rejectExtraFields } from "../lib/validate.mjs";

const ACCOUNT_FIELDS = new Set(["month", "start_date", "end_date"]);
const CREATE_FIELDS = new Set(["notes", "per_interval", "missing_body"]);
const MODIFY_FIELDS = new Set(["api_key", "notes", "active", "per_interval", "missing_body"]);

const bad = (context, detail) => fail(context, "VALIDATION_BAD_REQUEST", "Bad request", [detail]);

/** `[startDays, endDays)` of the requested reporting interval, validated against virtual today. */
function interval(context, input) {
  const todayDays = Math.floor(context.clock.nowUs() / 86_400_000_000);
  const thisMonth = monthOfDays(todayDays);
  const month = optionalString(context, input, "month", 7);
  const startText = optionalString(context, input, "start_date", 10);
  const endText = optionalString(context, input, "end_date", 10);
  if (month !== null && (startText !== null || endText !== null)) bad(context, "request: Value error, month cannot be combined with start_date and end_date");
  if ((startText === null) !== (endText === null)) bad(context, "request: Value error, start_date and end_date must be provided together");
  if (month !== null) {
    const parsed = parseMonth(month);
    if (parsed === null) bad(context, `month: Input should be a valid month in the format YYYY-MM (got ${clip(month, 20)})`);
    const start = monthStartDays(parsed);
    if (start > monthStartDays(thisMonth)) bad(context, "month: Month cannot be in the future");
    if (start < monthStartDays(addMonths(thisMonth, -12))) bad(context, "month: Month cannot be more than 12 months in the past");
    return [start, monthStartDays(addMonths(parsed, 1))];
  }
  if (startText !== null) {
    const start = parseDate(startText);
    const end = parseDate(endText);
    if (start === null) bad(context, "start_date: Input should be a valid date in the format YYYY-MM-DD");
    if (end === null) bad(context, "end_date: Input should be a valid date in the format YYYY-MM-DD");
    if (end <= start) bad(context, "request: Value error, end_date must be after start_date");
    const civil = civilFromDays(start);
    const plus = addMonths({ year: civil.year, month: civil.month }, 12);
    const limit = daysFromCivil(plus.year, plus.month, Math.min(civil.day, daysInMonth(plus.year, plus.month)));
    if (end > limit) bad(context, "request: Value error, the interval cannot exceed 12 months");
    if (start > todayDays) bad(context, "request: Value error, start_date cannot be after today");
    if (start < todayDays - 366) bad(context, "request: Value error, start_date cannot be more than 12 months in the past");
    return [start, end];
  }
  return [monthStartDays(thisMonth), monthStartDays(addMonths(thisMonth, 1))];
}

function sumUsage(rows, startDays, endDays) {
  const totals = {};
  for (const field of USAGE_COUNTERS) totals[field] = 0;
  for (const { value } of rows) {
    const day = parseDate(value.day);
    if (day === null || day < startDays || day >= endDays) continue;
    for (const field of USAGE_COUNTERS) totals[field] += value[field];
  }
  return { ...totals, start_date: formatDate(startDays), end_date: formatDate(endDays) };
}

export function accountGet(input, context) {
  const { key, account } = resolveKey(context);
  rejectExtraFields(context, input, ACCOUNT_FIELDS);
  const [startDays, endDays] = interval(context, input);
  const allRows = scanAll(context, "usage");
  const keyRows = allRows.filter((record) => record.value.api_key === key.api_key);
  const result = {
    key_usage: sumUsage(keyRows, startDays, endDays),
    account_usage: sumUsage(allRows, startDays, endDays),
    balance_remaining_usd: usd(account.balance_remaining_micros),
    server_date: dateOfUs(context.clock.nowUs()),
  };
  if (key.master === true) {
    const price = {};
    for (const [name, micros] of Object.entries(account.price_micros)) price[name] = usd(micros);
    result.price = price;
  }
  return result;
}

function keyWire(row) {
  return { api_key: row.api_key, active: row.active, notes: row.notes, master: row.master, per_interval: row.per_interval, interval_seconds: row.interval_seconds };
}

export function apiKeysList(input, context) {
  resolveKey(context, { master: true });
  rejectExtraFields(context, input, new Set());
  const rows = scanAll(context, "api-keys").map((record) => record.value);
  rows.sort((a, b) => (a.master !== b.master ? (a.master ? -1 : 1) : a.created_at_us - b.created_at_us || (a.api_key < b.api_key ? -1 : 1)));
  return { api_keys: rows.map(keyWire) };
}

function perInterval(context, input, master, fallback) {
  if (!Object.hasOwn(input, "per_interval") || input.per_interval === null) return fallback;
  const value = input.per_interval;
  if (typeof value !== "number" || !Number.isInteger(value)) bad(context, "per_interval: Input should be a valid integer");
  if (value < 1) bad(context, "per_interval: Input should be greater than or equal to 1");
  if (value > 100000) bad(context, "per_interval: Input should be less than or equal to 100000");
  if (value > master.per_interval) fail(context, "VALIDATION_SUBKEY_RATE_EXCEEDS_MASTER", `Sub-key rate limit ${value} exceeds the master key limit of ${master.per_interval}`);
  return value;
}

export function apiKeysCreate(input, context) {
  const { key } = resolveKey(context, { master: true });
  if (input.missing_body === true) fail(context, "VALIDATION_MISSING_BODY", "Missing body");
  rejectExtraFields(context, input, CREATE_FIELDS);
  if (!Object.hasOwn(input, "notes") || input.notes === null) bad(context, "notes: Field required");
  const notes = optionalString(context, input, "notes", 250);
  const rate = perInterval(context, input, key, 50);
  const row = { api_key: newUuid(context), active: true, notes, master: false, per_interval: rate, interval_seconds: 60, created_at_us: context.clock.nowUs() };
  context.state.put("api-keys", row.api_key, row);
  context.events.emit("api-key.created", { api_key: row.api_key, notes, per_interval: rate, created_by: key.api_key });
  return keyWire(row);
}

export function apiKeysModify(input, context) {
  const { key } = resolveKey(context, { master: true });
  if (input.missing_body === true) fail(context, "VALIDATION_MISSING_BODY", "Missing body");
  rejectExtraFields(context, input, MODIFY_FIELDS);
  if (!Object.hasOwn(input, "api_key") || input.api_key === null) bad(context, "api_key: Field required");
  const id = normalizeUuid(input.api_key);
  if (id === null) bad(context, `api_key: Input should be a valid UUID (got ${clip(input.api_key, 60)})`);
  if (!Object.hasOwn(input, "notes") || input.notes === null) bad(context, "notes: Field required");
  const notes = optionalString(context, input, "notes", 250);
  if (typeof input.active !== "boolean") bad(context, Object.hasOwn(input, "active") && input.active !== null ? "active: Input should be a valid boolean" : "active: Field required");
  const row = context.state.get("api-keys", id);
  if (row === null) fail(context, "NOT_FOUND_API_KEY_NOT_FOUND", `Api key ${id} not found`);
  if (row.master === true) fail(context, "VALIDATION_CANNOT_EDIT_MASTER_API_KEY", "The master api key cannot be edited");
  const rate = perInterval(context, input, key, row.per_interval);
  const updated = { ...row, notes, active: input.active, per_interval: rate };
  // Only rewrite the row when something changed (every write counts toward the world's mutation budget).
  const changed = row.notes !== notes || row.active !== input.active || row.per_interval !== rate;
  if (changed) context.state.put("api-keys", id, updated);
  return { api_key: id, active: updated.active, notes, master: false, per_interval: rate };
}
