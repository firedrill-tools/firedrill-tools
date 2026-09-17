// Incidents v2 (JSON:API): lookup by UUID or public id, field parsing and the IncidentData rendering.
import { bad, boolArg, isoMillis, notFound, nowUs, pad, present, scanAll } from "./core.mjs";
import { text } from "./text.mjs";

export const STATES = ["active", "stable", "resolved"];
export const SEVERITIES = ["UNKNOWN", "SEV-1", "SEV-2", "SEV-3", "SEV-4", "SEV-5"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

export const publicRowId = (publicId) => pad(publicId, 9);

export function loadIncident(context, raw) {
  let row = null;
  if (typeof raw === "string" && UUID.test(raw)) row = context.state.get("incidents", raw);
  else if (typeof raw === "string" && /^[1-9][0-9]{0,8}$/.test(raw)) {
    const ref = context.state.get("incident-public-ids", publicRowId(Number(raw)));
    row = ref === null ? null : context.state.get("incidents", ref.incidentId);
  }
  if (row === null) notFound(context, "Incident not found");
  return row;
}

export function newUuid(context) {
  let hex = "";
  for (let i = 0; i < 32; i += 1) hex += "0123456789abcdef"[context.random.nextInteger(0, 16)];
  const variant = "89ab"[context.random.nextInteger(0, 4)];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function userByUuid(context, uuid) {
  if (typeof uuid !== "string" || !UUID.test(uuid)) return null;
  return scanAll(context, "users").map((record) => record.value).find((user) => user.uuid === uuid) ?? null;
}

/** ISO-8601 with an explicit zone → microseconds; zone-less or impossible dates fail. */
export function parseIso(context, raw, name) {
  if (raw === null) return null;
  const match = typeof raw === "string" ? ISO.exec(raw) : null;
  const ms = match === null ? NaN : Date.parse(raw);
  if (match === null || !Number.isFinite(ms) || Number(match[2]) > 12 || Number(match[3]) > 31 || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) {
    bad(context, `Invalid parameter: ${name} must be an ISO-8601 timestamp with a time zone`);
  }
  if (ms < 0 || ms > 32_503_680_000_000) bad(context, `Invalid parameter: ${name} must be between 1970 and 3000`);
  const check = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (check.getUTCDate() !== Number(match[3])) bad(context, `Invalid parameter: ${name} is not a valid date`);
  return ms * 1000;
}

/** `fields: { state: { type: "dropdown", value }, severity: {…} }` → `{ state?, severity? }`. */
export function parseFields(context, raw) {
  if (!present(raw)) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) bad(context, "Invalid parameter: fields must be an object");
  const out = {};
  for (const key of Object.keys(raw)) {
    if (key !== "state" && key !== "severity") bad(context, `Invalid parameter: fields.${key} is not supported by this Tool`);
    const field = raw[key];
    const allowed = key === "state" ? STATES : SEVERITIES;
    if (typeof field !== "object" || field === null || Array.isArray(field) || (present(field.type) && field.type !== "dropdown") || !allowed.includes(field.value)) {
      bad(context, `Invalid parameter: fields.${key}.value must be one of ${allowed.join(", ")}`);
    }
    out[key] = field.value;
  }
  return out;
}

export function parseImpacted(context, raw, fallback) {
  const value = boolArg(raw);
  if (value === undefined || typeof raw === "string") bad(context, "Invalid parameter: customer_impacted must be a boolean");
  return value === null ? fallback : value;
}

export function parseHandles(context, raw) {
  if (!present(raw)) return [];
  if (!Array.isArray(raw) || raw.length > 20) bad(context, "Invalid parameter: notification_handles accepts at most 20 entries");
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) bad(context, "Invalid parameter: notification_handles entries must be objects");
    const handle = text(context, entry.handle, "notification_handles.handle", { required: true, min: 1, max: 254 });
    return { handle, display_name: text(context, entry.display_name, "notification_handles.display_name", { max: 100 }) ?? handle };
  });
}

/** `relationships.commander_user.data` → user row, `null` (unassigned) or `undefined` when absent. */
export function parseCommander(context, relationships) {
  if (!present(relationships)) return undefined;
  if (typeof relationships !== "object" || Array.isArray(relationships)) bad(context, "Invalid parameter: relationships must be an object");
  for (const key of Object.keys(relationships)) if (key !== "commander_user") bad(context, `Invalid parameter: relationships.${key} is not supported`);
  if (!Object.hasOwn(relationships, "commander_user")) return undefined;
  const data = relationships.commander_user?.data;
  if (data === null) return null;
  if (typeof data !== "object" || data === undefined || Array.isArray(data) || data.type !== "users") bad(context, "Invalid parameter: commander_user.data must be a users relationship");
  const user = userByUuid(context, data.id);
  if (user === null) notFound(context, "User not found");
  return user;
}

const userRef = (context, handle) => {
  const user = handle === null ? null : context.state.get("users", handle);
  return { data: user === null ? null : { type: "users", id: user.uuid } };
};

export function renderIncident(context, row) {
  const now = nowUs(context);
  const impactEnd = row.customerImpactEndUs ?? (row.customerImpacted ? now : null);
  return {
    id: row.id,
    type: "incidents",
    attributes: {
      public_id: row.publicId, title: row.title, customer_impacted: row.customerImpacted, customer_impact_scope: row.customerImpactScope,
      customer_impact_start: row.customerImpactStartUs === null ? null : isoMillis(row.customerImpactStartUs),
      customer_impact_end: row.customerImpactEndUs === null ? null : isoMillis(row.customerImpactEndUs),
      customer_impact_duration: row.customerImpactStartUs === null || impactEnd === null ? 0 : Math.max(0, Math.floor((impactEnd - row.customerImpactStartUs) / 1_000_000)),
      created: isoMillis(row.createdUs), modified: isoMillis(row.modifiedUs), detected: isoMillis(row.detectedUs),
      resolved: row.resolvedUs === null ? null : isoMillis(row.resolvedUs),
      time_to_resolve: row.resolvedUs === null ? null : Math.max(0, Math.floor((row.resolvedUs - row.createdUs) / 1_000_000)),
      severity: row.severity, state: row.state,
      fields: { state: { type: "dropdown", value: row.state }, severity: { type: "dropdown", value: row.severity } },
      is_test: row.isTest, notification_handles: row.notificationHandles, visibility: "organization",
    },
    relationships: {
      commander_user: userRef(context, row.commanderHandle), created_by_user: userRef(context, row.createdByHandle),
      last_modified_by_user: userRef(context, row.lastModifiedByHandle),
    },
  };
}

/** JSON:API `included` users for a set of incident rows (ordered by first reference). */
export function includedUsers(context, rows) {
  const handles = [];
  for (const row of rows) for (const handle of [row.commanderHandle, row.createdByHandle, row.lastModifiedByHandle]) {
    if (handle !== null && !handles.includes(handle)) handles.push(handle);
  }
  return handles.map((handle) => context.state.get("users", handle)).filter((user) => user !== null).map((user) => ({
    type: "users", id: user.uuid, attributes: { uuid: user.uuid, handle: user.handle, email: user.handle, name: user.name, disabled: user.disabled },
  }));
}
