// Row ids, bounded scans, counters, virtual-time formatting and the declared-error helpers.
// Every function is pure or reads context.state; nothing keeps module-level state.

const SCAN_STEP = 500;
const ID_PATTERN = /^[1-9][0-9]{0,9}$/;

/** Default site bounds; a consumer may lower or raise them on the `site` row (`limits`). */
export const DEFAULT_LIMITS = Object.freeze({
  maxUsers: 1000,
  maxProjects: 1000,
  maxMembersPerProject: 1000,
  maxBoards: 1000,
  maxSprints: 1000,
  maxIssues: 10000,
  maxCommentsPerIssue: 500,
});

/** Site metadata when the `site` row is absent (a consumer that replaced the starter data). */
export const DEFAULT_SITE = Object.freeze({
  cloudId: "00000000-0000-0000-0000-000000000000",
  name: "firedrill",
  baseUrl: "https://firedrill.jira.example",
  serverTitle: "Jira",
  timeZone: "UTC",
  locale: "en_US",
  defaultAssigneeType: "UNASSIGNED",
});

const CLIP = 200;

/** Caller text quoted into an error: at most about 200 characters, with an ellipsis when clipped. */
export function clip(value) {
  const text = String(value);
  return text.length > CLIP ? `${text.slice(0, CLIP)}…` : text;
}

/**
 * A caller-chosen error-map key, clipped like `clip` but kept distinct: keys longer than CLIP characters carry a
 * stable FNV-1a digest of the full key after the ellipsis, so two long keys that share a prefix never collapse
 * into one `errors` entry.
 */
export function clipKey(value) {
  const text = String(value);
  if (text.length <= CLIP) return text;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.slice(0, CLIP)}…#${hash.toString(16).padStart(8, "0")}`;
}

export function fail(context, code, message, details) {
  const bounded = typeof message === "string" && message.length > 1000 ? `${message.slice(0, 1000)}…` : message;
  return context.fail(details === undefined ? { code, message: bounded } : { code, message: bounded, details });
}

export function notFound(context, message) {
  return fail(context, "NOT_FOUND", message);
}

export function permissionDenied(context, message) {
  return fail(context, "PERMISSION_DENIED", message);
}

/**
 * Jira's validation envelope: `errorMessages` (free-form) and `errors` (field → message).
 * `fields` is an object of field errors; `messages` an array of general messages.
 */
export function validationError(context, fields, messages) {
  const errors = Object.create(null);
  for (const [key, value] of Object.entries(fields ?? {})) errors[clipKey(key)] = typeof value === "string" && value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
  const errorMessages = (messages ?? []).map((text) => (typeof text === "string" && text.length > 1000 ? `${text.slice(0, 1000)}…` : text));
  const first = errorMessages[0] ?? Object.values(errors)[0] ?? "Validation failed.";
  return fail(context, "VALIDATION_ERROR", first, { errorMessages, errors });
}

export function fieldError(context, field, message) {
  return validationError(context, { [field]: message }, []);
}

export function invalidJql(context, message) {
  return fail(context, "INVALID_JQL", message, { errorMessages: [message], errors: {} });
}

export function boundExceeded(context, namespace, bound) {
  return fail(context, "FAILED_PRECONDITION", `state exceeds the supported bound of ${String(bound)} rows for ${namespace}`);
}

export function isNumericId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function padId(id) {
  return String(id).padStart(10, "0");
}

export function commentRowId(issueId, commentId) {
  return `${padId(issueId)}/${padId(commentId)}`;
}

export function memberRowId(projectId, accountId) {
  return `${padId(projectId)}/${accountId}`;
}

/** The `site` row merged over the defaults (limits included). */
export function siteOf(context) {
  const stored = context.state.get("site", "site");
  const site = stored === null ? { ...DEFAULT_SITE } : { ...DEFAULT_SITE, ...stored };
  const limits = { ...DEFAULT_LIMITS, ...(typeof stored?.limits === "object" && stored.limits !== null ? stored.limits : {}) };
  return { ...site, limits };
}

/** Every row of a namespace in row-id order, failing when the site bound for it is exceeded. */
export function allRows(context, namespace, bound) {
  const rows = [];
  let after;
  for (;;) {
    const batch = context.state.scan(namespace, { ...(after === undefined ? {} : { afterRowId: after }), limit: SCAN_STEP });
    if (batch.length === 0) return rows;
    for (const record of batch) {
      after = record.rowId;
      rows.push(record.value);
      if (rows.length > bound) return boundExceeded(context, namespace, bound);
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

/** Every row whose id starts with `prefix` (in row-id order), failing beyond `bound` rows. */
export function prefixRows(context, namespace, prefix, bound) {
  const rows = [];
  let after = prefix;
  for (;;) {
    const batch = context.state.scan(namespace, { afterRowId: after, limit: SCAN_STEP });
    if (batch.length === 0) return rows;
    for (const record of batch) {
      if (!record.rowId.startsWith(prefix)) return rows;
      after = record.rowId;
      rows.push(record.value);
      if (rows.length > bound) return boundExceeded(context, namespace, bound);
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

/** Jira renders timestamps as `2026-09-14T09:00:00.000+0000` (this Tool always uses UTC). */
export function jiraTimestamp(ms) {
  return `${new Date(ms).toISOString().slice(0, 23)}+0000`;
}

export function nowMs(context) {
  return Math.floor(context.clock.nowUs() / 1000);
}

export function jiraNow(context) {
  return jiraTimestamp(nowMs(context));
}

/** Parses a stored Jira-format or ISO timestamp to epoch milliseconds (NaN when unparseable). */
export function parseTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return Number.NaN;
  return Date.parse(value.replace(/([+-])(\d{2})(\d{2})$/, "$1$2:$3"));
}

const DEFAULT_COUNTERS = Object.freeze({ nextIssueId: 10000, nextCommentId: 10000 });

export function counters(context) {
  const stored = context.state.get("meta", "counters");
  return stored === null ? { ...DEFAULT_COUNTERS } : { ...DEFAULT_COUNTERS, ...stored };
}

/** Next free issue id (skips ids that already exist, bounded probe) and advances the counter. */
export function nextIssueId(context) {
  const meta = counters(context);
  let id = meta.nextIssueId;
  for (let probe = 0; probe < 1000 && context.state.get("issues", padId(id)) !== null; probe += 1) id += 1;
  context.state.put("meta", "counters", { ...meta, nextIssueId: id + 1 });
  return String(id);
}

/** Next free comment id; comment rows are keyed by issue so uniqueness comes from the counter alone. */
export function nextCommentId(context) {
  const meta = counters(context);
  const id = meta.nextCommentId;
  context.state.put("meta", "counters", { ...meta, nextCommentId: id + 1 });
  return String(id);
}

export function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareFold(left, right) {
  return compareStrings(String(left).toLowerCase(), String(right).toLowerCase()) || compareStrings(String(left), String(right));
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
