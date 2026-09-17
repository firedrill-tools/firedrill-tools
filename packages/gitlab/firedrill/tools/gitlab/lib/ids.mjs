// Row ids, counters, bounds, offset/keyset pagination and virtual-time helpers. Every function is pure or reads
// context.state; nothing keeps module-level mutable state.
import { decodeCursor, encodeCursor } from "./cursor.mjs";

/** The framework caps state row ids at 512 characters. */
export const MAX_ROW_ID = 512;

/** Default bounds. `meta/limits` may lower (never raise) any of them. Exceeding a bound fails UNPROCESSABLE. */
export const BOUNDS = Object.freeze({
  users: 500,
  projects: 500,
  members_per_project: 1_000,
  labels_per_project: 500,
  branches_per_project: 1_000,
  commits_per_project: 5_000,
  issues_per_project: 10_000,
  merge_requests_per_project: 10_000,
  notes_per_noteable: 10_000,
  files_per_tree: 500,
  file_bytes: 262_144,
  actions_per_commit: 100,
  ancestor_walk: 2_000,
});

const BOUND_LABELS = Object.freeze({
  users: "users",
  projects: "projects",
  members_per_project: "members per project",
  labels_per_project: "labels per project",
  branches_per_project: "branches per project",
  commits_per_project: "commits per project",
  issues_per_project: "issues per project",
  merge_requests_per_project: "merge requests per project",
  notes_per_noteable: "notes per issue or merge request",
  files_per_tree: "files per tree",
  file_bytes: "file size in bytes",
  actions_per_commit: "actions per commit",
  ancestor_walk: "commit history walk",
});

const SCAN_STEP = 500;

/**
 * The Firedrill HTTP layer refuses any response over 1 MiB. Pages stop filling before their items would pass this
 * many JSON bytes, and composite single responses over it fail UNPROCESSABLE instead.
 */
export const RESPONSE_BYTE_BUDGET = 900_000;

/** UTF-8 byte length of a value's JSON encoding (what the response body will carry). */
export function jsonBytes(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return 0;
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Fails UNPROCESSABLE when a composite single response would exceed the response byte budget. */
export function ensureResponseFits(context, value, hint) {
  if (jsonBytes(value) > RESPONSE_BYTE_BUDGET) {
    return fail(
      context,
      "UNPROCESSABLE",
      `422 Unprocessable Entity - response exceeds the supported size of ${RESPONSE_BYTE_BUDGET} bytes; ${hint}`,
    );
  }
  return value;
}

export function fitsRowId(rowId) {
  return typeof rowId === "string" && rowId.length > 0 && rowId.length <= MAX_ROW_ID;
}

/** Own-property lookup on a map keyed by caller input; inherited members never match. */
export function ownValue(map, key) {
  return map !== null && typeof map === "object" && typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key)
    ? map[key]
    : undefined;
}

/** A null-prototype copy of a flat map, so assigning any key is an ordinary own write. */
export function nullMap(source) {
  const map = Object.create(null);
  if (source !== null && typeof source === "object") {
    for (const key of Object.keys(source)) map[key] = source[key];
  }
  return map;
}

/** Plain-object copy of a null-prototype map (for returning or storing). */
export function plainMap(source) {
  const out = {};
  for (const key of Object.keys(source).sort()) {
    Object.defineProperty(out, key, { value: source[key], enumerable: true, writable: true, configurable: true });
  }
  return out;
}

export function fail(context, code, message, details) {
  return context.fail(details === undefined ? { code, message } : { code, message, details });
}

/** GitLab 400 envelopes: `error` → {"error":m}, `message` → {"message":m}, `messages` → {"message":[m]}, `fields` → {"message":{field:[m]}}. */
export function badRequest(context, message, shape = "message", field) {
  return fail(context, "BAD_REQUEST", message, field === undefined ? { shape } : { shape, field });
}

export function limit(context, key) {
  const fallback = BOUNDS[key];
  const stored = context.state.get("meta", "limits");
  const override = stored === null ? undefined : ownValue(stored, key);
  return Number.isInteger(override) && override >= 1 && override < fallback ? override : fallback;
}

export function tooLarge(context, key, bound) {
  return fail(context, "UNPROCESSABLE", `422 Unprocessable Entity - ${BOUND_LABELS[key]} exceeds the supported bound of ${bound}`);
}

export const pad = (number, width) => String(number).padStart(width, "0");
export const userRowId = (id) => `u${pad(id, 8)}`;
export const projectRowId = (id) => `p${pad(id, 6)}`;
export const memberRowId = (projectId, userId) => `${projectRowId(projectId)}:${userRowId(userId)}`;
export const labelRowId = (projectId, name) => `${projectRowId(projectId)}:${String(name).toLowerCase()}`;
export const branchRowId = (projectId, name) => `${projectRowId(projectId)}:${name}`;
export const commitRowId = (projectId, sha) => `${projectRowId(projectId)}@${sha}`;
export const issueRowId = (projectId, iid) => `${projectRowId(projectId)}#${pad(iid, 6)}`;
export const mergeRequestRowId = (projectId, iid) => `${projectRowId(projectId)}!${pad(iid, 6)}`;
export const noteRowId = (noteableRowId, id) => `${noteableRowId}:n${pad(id, 10)}`;

/**
 * Every row whose id starts with `prefix`, through bounded scans. More than `limit(key)` rows fails UNPROCESSABLE
 * instead of returning a truncated list.
 */
export function prefixRows(context, namespace, prefix, key) {
  const bound = limit(context, key);
  const rows = [];
  let after = prefix;
  for (;;) {
    const batch = context.state.scan(namespace, { afterRowId: after, limit: SCAN_STEP });
    for (const record of batch) {
      if (!record.rowId.startsWith(prefix)) return rows;
      after = record.rowId;
      rows.push(record.value);
      if (rows.length > bound) return tooLarge(context, key, bound);
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

/** Every row of a namespace in row-id order, bounded by `limit(key)`. */
export function allRows(context, namespace, key) {
  const bound = limit(context, key);
  const rows = [];
  let after;
  for (;;) {
    const batch = context.state.scan(namespace, { ...(after === undefined ? {} : { afterRowId: after }), limit: SCAN_STEP });
    for (const record of batch) {
      after = record.rowId;
      rows.push(record.value);
      if (rows.length > bound) return tooLarge(context, key, bound);
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

// ---------------------------------------------------------------------------------------------
// Virtual time
// ---------------------------------------------------------------------------------------------

/** ISO-8601 with milliseconds and Z, GitLab style (`2026-09-15T09:00:00.000Z`). */
export function isoFromUs(us) {
  return new Date(Math.floor(us / 1_000)).toISOString();
}

export function isoNow(context) {
  return isoFromUs(context.clock.nowUs());
}

export function todayUtc(context) {
  return isoNow(context).slice(0, 10);
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?([Zz]|[+-]\d{2}(?::?\d{2})?)?$/;

/** ISO-8601 date or date-time → epoch ms; zone-less values are UTC; impossible dates are rejected (no Date.parse). */
export function parseDate(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return undefined;
  const match = TIMESTAMP.exec(value);
  if (match === null) return undefined;
  const [, y, mo, d, h = "00", mi = "00", sec = "00", fraction = "", zone = "Z"] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(sec);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return undefined;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, Number(`${fraction}000`.slice(0, 3)));
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  let offsetMinutes = 0;
  if (zone !== "Z" && zone !== "z") {
    const digits = zone.slice(1).replace(":", "");
    const zh = Number(digits.slice(0, 2));
    const zm = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (zh > 23 || zm > 59) return undefined;
    offsetMinutes = (zone[0] === "-" ? -1 : 1) * (zh * 60 + zm);
  }
  return utc - offsetMinutes * 60_000;
}

/** Strict calendar date `YYYY-MM-DD` (GitLab `due_date`). */
export function isCalendarDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && parseDate(value) !== undefined;
}

export function timestampMs(value) {
  const ms = parseDate(value);
  return ms === undefined ? Number.NaN : ms;
}

// ---------------------------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------------------------

const DEFAULT_COUNTERS = Object.freeze({
  next_user_id: 100,
  next_issue_id: 41_001,
  next_merge_request_id: 52_001,
  next_note_id: 910_001,
  next_label_id: 7_001,
  commit_sequence: 1,
});

/** Returns the counter value and stores value + 1 (the row is created with documented defaults when missing). */
export function nextCounter(context, key) {
  const stored = context.state.get("meta", "counters");
  const row = { ...DEFAULT_COUNTERS, ...(stored ?? {}) };
  const value = row[key];
  row[key] = value + 1;
  context.state.put("meta", "counters", row);
  return value;
}

export function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** True when a query-derived string carries U+FFFD (the framework's replacement for malformed percent-encoding). */
export function hasReplacement(value) {
  return typeof value === "string" && value.includes("�");
}

// ---------------------------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------------------------

/** Integer-like caller value (JSON integer or decimal string) → number; undefined when absent; NaN when invalid. */
function intish(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isInteger(value) ? value : Number.NaN;
  if (typeof value === "string" && /^-?[0-9]{1,9}$/.test(value)) return Number(value);
  return Number.NaN;
}

/**
 * Offset (`page`/`per_page`, GitLab REST) or keyset (`first`/`after`, GitLab MCP) parameters. Values are clamped like
 * GitLab (per_page > 100 → 100; ≤ 0 → default); non-integers fail BAD_REQUEST `{"error":"<name> is invalid"}`.
 */
export function pageParams(context, input) {
  const page = intish(input.page);
  const perPage = intish(input.per_page);
  const first = intish(input.first);
  if (Number.isNaN(page)) return badRequest(context, "page is invalid", "error");
  if (Number.isNaN(perPage)) return badRequest(context, "per_page is invalid", "error");
  if (Number.isNaN(first)) return badRequest(context, "first is invalid", "error");
  if (input.after !== undefined && typeof input.after !== "string") return badRequest(context, "after is invalid", "error");
  const keyset = first !== undefined || input.after !== undefined;
  if (keyset && (page !== undefined || perPage !== undefined)) {
    return badRequest(context, "first/after cannot be combined with page/per_page", "error");
  }
  if (keyset) return { mode: "keyset", first: first === undefined || first <= 0 ? 20 : Math.min(first, 100), after: input.after };
  return {
    mode: "offset",
    page: page === undefined || page <= 0 ? 1 : page,
    perPage: perPage === undefined || perPage <= 0 ? 20 : Math.min(perPage, 100),
  };
}

/**
 * One page of `items`. `scope` is `{ kind, projectId }` for cursors; `keyOf(item)` returns the stable key a cursor
 * points after. Offset pages report totals unless `totals: false` (commit lists, like GitLab).
 *
 * Pages are sized by count and by bytes: `sizeOf(item)` (default: the item's JSON bytes; pass the size of the rendered
 * view when items are mapped afterwards) is summed and a page stops before it would pass RESPONSE_BYTE_BUDGET, always
 * holding at least one item. Offset page numbers follow those byte-aware boundaries, so `next_page`, `total_pages` and
 * the `link` header always point at real pages and no item is skipped.
 */
export function paginate(context, items, params, scope, keyOf, options = {}) {
  const totals = options.totals !== false;
  const sizeOf = options.sizeOf ?? jsonBytes;
  const sizes = new Map();
  const size = (index) => {
    let value = sizes.get(index);
    if (value === undefined) {
      value = sizeOf(items[index]) + 1;
      sizes.set(index, value);
    }
    return value;
  };
  /** End index (exclusive) of a page starting at `start` holding at most `count` items. */
  const pageEnd = (start, count) => {
    let end = start;
    let bytes = 0;
    while (end < items.length && end - start < count) {
      const next = size(end);
      if (end > start && bytes + next > RESPONSE_BYTE_BUDGET) break;
      bytes += next;
      end += 1;
    }
    return end;
  };
  if (params.mode === "keyset") {
    let start = 0;
    if (params.after !== undefined) {
      const key = decodeCursor(params.after, scope.kind, scope.projectId);
      const index = key === undefined ? -1 : items.findIndex((item) => keyOf(item) === key);
      if (index < 0) return badRequest(context, "after is invalid", "error");
      start = index + 1;
    }
    const end = pageEnd(start, params.first);
    const slice = items.slice(start, end);
    return {
      items: slice,
      page_info: {
        has_next_page: end < items.length,
        end_cursor: slice.length === 0 ? null : encodeCursor(scope.kind, scope.projectId, keyOf(slice[slice.length - 1])),
      },
    };
  }
  const { page, perPage } = params;
  const starts = [];
  for (let start = 0; start < items.length && (totals || starts.length <= page); ) {
    starts.push(start);
    start = pageEnd(start, perPage);
  }
  const slice = page <= starts.length ? items.slice(starts[page - 1], page < starts.length ? starts[page] : pageEnd(starts[page - 1], perPage)) : [];
  const hasNext = page < starts.length;
  const pageInfo = {
    page,
    per_page: perPage,
    next_page: hasNext ? page + 1 : null,
    prev_page: page > 1 ? page - 1 : null,
  };
  if (totals) {
    pageInfo.total = items.length;
    pageInfo.total_pages = Math.max(1, starts.length);
  }
  return {
    items: slice,
    page: pageInfo,
    page_info: {
      has_next_page: hasNext,
      end_cursor: slice.length === 0 ? null : encodeCursor(scope.kind, scope.projectId, keyOf(slice[slice.length - 1])),
    },
  };
}
