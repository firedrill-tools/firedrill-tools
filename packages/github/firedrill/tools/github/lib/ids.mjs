// Row ids, counters, bounded scans and virtual-time formatting. Every function here is pure or reads
// context.state; nothing keeps module-level state.

export const SCAN_STEP = 500;
export const SCAN_CAP = 10_000;
export const ANCESTOR_CAP = 1_000;

export const PERMISSION_RANK = Object.freeze(Object.assign(Object.create(null), { read: 1, triage: 2, write: 3, maintain: 4, admin: 5 }));

/** The framework caps state row ids at 512 characters; longer ids built from caller input can never exist. */
export const MAX_ROW_ID = 512;

export function fitsRowId(rowId) {
  return typeof rowId === "string" && rowId.length > 0 && rowId.length <= MAX_ROW_ID;
}

/**
 * Own-property lookup for maps keyed by caller input (tree paths, names). A plain `object[key]` returns inherited
 * members for `__proto__`, `constructor`, `toString`, …; this returns undefined for anything the map does not own.
 */
export function ownValue(map, key) {
  return map !== null && typeof map === "object" && typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** A null-prototype copy of a flat map, so assigning any caller key (including `__proto__`) is an ordinary own write. */
export function nullMap(source) {
  const map = Object.create(null);
  if (source !== null && typeof source === "object") {
    for (const key of Object.keys(source)) map[key] = source[key];
  }
  return map;
}

export function fail(context, code, message, details) {
  return context.fail(details === undefined ? { code, message } : { code, message, details });
}

export function tooLarge(context) {
  return fail(context, "VALIDATION_FAILED", "Repository is too large for this Tool");
}

export function repoKey(owner, repo) {
  return `${String(owner).toLowerCase()}/${String(repo).toLowerCase()}`;
}

export function padNumber(number) {
  return String(number).padStart(5, "0");
}

export function padId(id) {
  return String(id).padStart(10, "0");
}

export function issueRowId(key, number) {
  return `${key}#${padNumber(number)}`;
}

export function commentRowId(key, number, id) {
  return `${key}#${padNumber(number)}:${padId(id)}`;
}

export function reviewRowId(key, number, id) {
  return `${key}#${padNumber(number)}:${padId(id)}`;
}

export function branchRowId(key, name) {
  return `${key}:${name}`;
}

export function commitRowId(key, sha) {
  return `${key}@${sha}`;
}

export function labelRowId(key, name) {
  return `${key}:${String(name).toLowerCase()}`;
}

export function collaboratorRowId(key, login) {
  return `${key}:${String(login).toLowerCase()}`;
}

/** Every row whose id starts with `prefix`, through bounded scans; fails when the cap is reached. */
export function prefixRows(context, namespace, prefix) {
  const rows = [];
  let after = prefix;
  for (;;) {
    const batch = context.state.scan(namespace, { afterRowId: after, limit: SCAN_STEP });
    if (batch.length === 0) return rows;
    for (const record of batch) {
      if (!record.rowId.startsWith(prefix)) return rows;
      after = record.rowId;
      rows.push(record.value);
      if (rows.length >= SCAN_CAP) return tooLarge(context);
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

/** Every row of a namespace in row-id order (bounded). */
export function allRows(context, namespace) {
  const rows = [];
  let after;
  for (;;) {
    const batch = context.state.scan(namespace, {
      ...(after === undefined ? {} : { afterRowId: after }),
      limit: SCAN_STEP,
    });
    if (batch.length === 0) return rows;
    for (const record of batch) {
      after = record.rowId;
      rows.push(record.value);
      if (rows.length >= SCAN_CAP) return tooLarge(context);
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

/** ISO-8601 seconds precision, GitHub style (`2026-09-14T09:00:00Z`). */
export function isoNow(context) {
  return isoFromUs(context.clock.nowUs());
}

export function isoFromUs(us) {
  return new Date(Math.floor(us / 1_000)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?([Zz]|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * ISO-8601 date or date-time → epoch milliseconds, independent of the host time zone: a value without a zone
 * designator is read as UTC. Returns undefined for anything else (no `Date.parse`, whose zone-less handling
 * depends on the machine).
 */
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

/** Stored timestamp → epoch ms (same host-independent rules); NaN when the stored value is not a timestamp. */
export function timestampMs(value) {
  const ms = parseDate(value);
  return ms === undefined ? Number.NaN : ms;
}

const DEFAULT_COUNTERS = {
  next_id: 7_100_001,
  next_comment_id: 8_100_001,
  next_review_id: 8_200_001,
  commit_sequence: 1,
};

export function counters(context) {
  const stored = context.state.get("meta", "counters");
  return stored === null ? { ...DEFAULT_COUNTERS } : { ...stored };
}

export function saveCounters(context, value) {
  context.state.put("meta", "counters", value);
}

export function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Page-based slice; GitHub defaults per_page 30. */
export function paginate(items, page, perPage) {
  const size = perPage ?? 30;
  const current = page ?? 1;
  const start = (current - 1) * size;
  return { items: items.slice(start, start + size), total: items.length, page: current, perPage: size };
}
