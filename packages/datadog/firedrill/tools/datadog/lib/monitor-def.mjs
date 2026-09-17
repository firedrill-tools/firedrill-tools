// Monitor definition: validation of create/update bodies into the stored row shape, and Monitor JSON rendering.
import { bad, boolArg, intArg, isAdmin, isoMicros, notFound, pad, present, ROLES, RESERVED_KEYS } from "./core.mjs";
import { parseComposite, parseMonitorQuery } from "./mquery.mjs";
import { finiteNumber, object, rejectReadOnly, tagList, text } from "./text.mjs";

export const MONITOR_TYPES = ["metric alert", "query alert", "composite", "service check", "log alert", "event-v2 alert"];
export const EVALUATED = new Set(["metric alert", "query alert", "composite"]);
export const monitorRowId = (id) => pad(id, 12);
const READ_ONLY = ["id", "org_id", "overall_state", "overall_state_modified", "created", "created_at", "modified", "deleted", "creator", "state", "matching_downtimes", "multi"];
const OPTION_KEYS = ["thresholds", "notify_no_data", "no_data_timeframe", "renotify_interval", "evaluation_delay", "new_group_delay",
  "include_tags", "require_full_window", "notify_audit", "silenced", "escalation_message"];
const THRESHOLD_KEYS = [["critical", "critical"], ["warning", "warning"], ["critical_recovery", "criticalRecovery"], ["warning_recovery", "warningRecovery"], ["ok", "ok"]];

export function defaultOptions() {
  return {
    thresholds: { critical: null, warning: null, criticalRecovery: null, warningRecovery: null, ok: null },
    notifyNoData: false, noDataTimeframe: null, renotifyInterval: null, evaluationDelay: null, newGroupDelay: null,
    includeTags: true, requireFullWindow: false, notifyAudit: false, silenced: [], escalationMessage: "",
  };
}

function optionInt(context, raw, name, max) {
  const value = intArg(raw, 0, max);
  if (value === undefined) bad(context, `Invalid parameter: options.${name} must be an integer between 0 and ${max}`);
  return value;
}

function optionBool(context, raw, name, fallback) {
  const value = boolArg(raw);
  if (value === undefined || typeof raw === "string") {
    if (present(raw)) bad(context, `Invalid parameter: options.${name} must be a boolean`);
  }
  return value === null || value === undefined ? fallback : value;
}

function mergeOptions(context, raw, base) {
  const options = { ...base, thresholds: { ...base.thresholds } };
  const input = object(context, raw, "options");
  if (input === null) return options;
  for (const key of Object.keys(input)) if (!OPTION_KEYS.includes(key)) bad(context, `Invalid parameter: options.${key} is not supported by this Tool`);
  if (Object.hasOwn(input, "thresholds")) {
    const thresholds = object(context, input.thresholds, "options.thresholds", { required: true });
    for (const key of Object.keys(thresholds)) if (!THRESHOLD_KEYS.some(([wire]) => wire === key)) bad(context, `Invalid parameter: options.thresholds.${key} is not supported`);
    for (const [wire, name] of THRESHOLD_KEYS) {
      if (Object.hasOwn(thresholds, wire)) options.thresholds[name] = finiteNumber(context, thresholds[wire], `options.thresholds.${wire}`);
    }
  }
  if (Object.hasOwn(input, "notify_no_data")) options.notifyNoData = optionBool(context, input.notify_no_data, "notify_no_data", false);
  if (Object.hasOwn(input, "include_tags")) options.includeTags = optionBool(context, input.include_tags, "include_tags", true);
  if (Object.hasOwn(input, "require_full_window")) options.requireFullWindow = optionBool(context, input.require_full_window, "require_full_window", false);
  if (Object.hasOwn(input, "notify_audit")) options.notifyAudit = optionBool(context, input.notify_audit, "notify_audit", false);
  for (const [wire, name, max] of [["no_data_timeframe", "noDataTimeframe", 10080], ["renotify_interval", "renotifyInterval", 10080],
    ["evaluation_delay", "evaluationDelay", 86400], ["new_group_delay", "newGroupDelay", 86400]]) {
    if (Object.hasOwn(input, wire)) options[name] = optionInt(context, input[wire], wire, max);
  }
  if (Object.hasOwn(input, "escalation_message")) options.escalationMessage = text(context, input.escalation_message, "options.escalation_message", { max: 10000 }) ?? "";
  if (Object.hasOwn(input, "silenced")) options.silenced = silenced(context, input.silenced);
  return options;
}

function silenced(context, raw) {
  const input = object(context, raw, "options.silenced");
  if (input === null) return [];
  const keys = Object.keys(input);
  if (keys.length > 50) bad(context, "Invalid parameter: options.silenced accepts at most 50 scopes");
  return keys.sort().map((scope) => {
    const tagLike = scope.length <= 200 && scope.includes(":") && !/[\s,�]/.test(scope) && !RESERVED_KEYS.has(scope.split(":")[0]);
    if (scope !== "*" && !tagLike) bad(context, "Invalid parameter: options.silenced scopes must be \"*\" or a key:value tag");
    const until = intArg(input[scope], 0, 99_999_999_999);
    if (until === undefined) bad(context, "Invalid parameter: options.silenced values must be an epoch timestamp or null");
    return { scope, untilSec: until };
  });
}

function restrictedRoles(context, raw, user) {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > ROLES.length || raw.some((role) => typeof role !== "string" || !ROLES.includes(role))) {
    bad(context, `Invalid parameter: restricted_roles must list role names among ${ROLES.join(", ")}`);
  }
  const roles = ROLES.filter((role) => raw.includes(role));
  if (roles.length > 0 && !isAdmin(user) && !roles.includes(user.role)) {
    bad(context, "Invalid parameter: restricted_roles must include your own role");
  }
  return roles;
}

const beyond = (comparator, value, threshold) => (comparator === ">" ? value > threshold : comparator === ">=" ? value >= threshold
  : comparator === "<" ? value < threshold : comparator === "<=" ? value <= threshold : comparator === "==" ? value === threshold : value !== threshold);
export { beyond };

/** Validate the query for the type; returns the cached `parsed` summary stored on the row. */
function parseFor(context, type, query, options, selfId) {
  if (type === "metric alert" || type === "query alert") {
    const result = parseMonitorQuery(query);
    if (!result.ok) bad(context, result.message);
    const parsed = result.parsed;
    if (parsed.windowSec < 60 || parsed.windowSec > 604800) bad(context, "Invalid parameter: the evaluation window must be between last_1m and last_1w");
    const thresholds = options.thresholds;
    if (thresholds.critical === null) thresholds.critical = parsed.threshold;
    if (thresholds.critical !== parsed.threshold) {
      bad(context, `Alert threshold (${thresholds.critical}) does not match that used in the query (${parsed.threshold}).`);
    }
    if (thresholds.warning !== null && (parsed.comparator === "==" || parsed.comparator === "!=" || beyond(parsed.comparator, thresholds.warning, thresholds.critical) || thresholds.warning === thresholds.critical)) {
      bad(context, `Warning threshold (${thresholds.warning}) must be less severe than the alert threshold (${thresholds.critical}) with ${parsed.comparator}.`);
    }
    return { kind: "metric", metric: parsed.expr.metric, windowSec: parsed.windowSec, ids: [] };
  }
  if (type === "composite") {
    const result = parseComposite(query);
    if (!result.ok) bad(context, result.message);
    for (const id of result.parsed.ids) {
      if (id === selfId) bad(context, "Invalid parameter: a composite monitor cannot reference itself");
      const child = Number.isSafeInteger(id) ? context.state.get("monitors", monitorRowId(id)) : null;
      if (child === null) notFound(context, `Monitor ${id} not found`);
      if (child.type === "composite") bad(context, "Invalid parameter: composite monitors cannot reference other composite monitors");
    }
    return { kind: "composite", metric: null, windowSec: null, ids: result.parsed.ids };
  }
  return null;
}

/** Validate a create body (`existing === null`) or a partial update into row fields plus `parsed`. */
export function buildMonitor(context, input, existing, user) {
  rejectReadOnly(context, input, READ_ONLY);
  let type;
  if (existing === null) {
    if (!present(input.type)) bad(context, "Missing required parameter: type");
    if (typeof input.type !== "string" || !MONITOR_TYPES.includes(input.type)) bad(context, `Invalid parameter: type must be one of ${MONITOR_TYPES.join(", ")}`);
    type = input.type;
  } else {
    type = existing.type;
    if (present(input.type) && input.type !== existing.type) bad(context, "Invalid parameter: the type of an existing monitor cannot be changed");
  }
  const query = present(input.query) ? text(context, input.query, "query", { min: 1, max: 10000, noFffd: true }) : existing?.query;
  if (query === undefined) bad(context, "Missing required parameter: query");
  const name = present(input.name) ? text(context, input.name, "name", { min: 1, max: 1000, trim: true }) : existing?.name ?? query.slice(0, 1000);
  if (name.length === 0) bad(context, "Invalid parameter: name must not be empty");
  const message = Object.hasOwn(input, "message") ? text(context, input.message, "message", { max: 10000 }) ?? "" : existing?.message ?? "";
  const tags = Object.hasOwn(input, "tags") ? tagList(context, input.tags, "tags") : existing?.tags ?? [];
  let priority = existing?.priority ?? null;
  if (Object.hasOwn(input, "priority")) {
    priority = intArg(input.priority, 1, 5);
    if (priority === undefined) bad(context, "Invalid parameter: priority must be an integer between 1 and 5");
  }
  const roles = Object.hasOwn(input, "restricted_roles") ? restrictedRoles(context, input.restricted_roles, user) : existing?.restrictedRoles ?? null;
  const options = mergeOptions(context, input.options, existing?.options ?? defaultOptions());
  const parsed = parseFor(context, type, query, options, existing?.id);
  return { name, type, query, message, tags, priority, restrictedRoles: roles, options, parsed };
}

function renderOptions(options) {
  const t = options.thresholds;
  const thresholds = {};
  for (const [wire, name] of THRESHOLD_KEYS) if (t[name] !== null) thresholds[wire] = t[name];
  const silencedOut = {};
  for (const entry of options.silenced) silencedOut[entry.scope] = entry.untilSec;
  return {
    thresholds, notify_no_data: options.notifyNoData, no_data_timeframe: options.noDataTimeframe, renotify_interval: options.renotifyInterval,
    evaluation_delay: options.evaluationDelay, new_group_delay: options.newGroupDelay, include_tags: options.includeTags,
    require_full_window: options.requireFullWindow, notify_audit: options.notifyAudit, silenced: silencedOut, escalation_message: options.escalationMessage,
  };
}

export function renderMonitor(context, row, { groupStates = null, withDowntimes = false } = {}) {
  const creator = context.state.get("users", row.creatorHandle);
  const org = context.state.get("meta", "org");
  const monitor = {
    id: row.id, org_id: org?.orgId ?? 0, name: row.name, type: row.type, query: row.query, message: row.message, tags: row.tags,
    options: renderOptions(row.options), priority: row.priority, restricted_roles: row.restrictedRoles, multi: row.multi,
    created: isoMicros(row.createdUs), created_at: Math.floor(row.createdUs / 1000), modified: isoMicros(row.modifiedUs), deleted: null,
    creator: { email: row.creatorHandle, handle: row.creatorHandle, name: creator?.name ?? row.creatorHandle },
    overall_state: row.overallState, overall_state_modified: row.overallStateModifiedUs === null ? null : isoMicros(row.overallStateModifiedUs),
  };
  if (groupStates !== null) {
    const groups = {};
    for (const group of row.groups) {
      if (groupStates === "all" || groupStates.includes(group.status.toLowerCase())) {
        groups[group.name] = { name: group.name, status: group.status, last_triggered_ts: group.lastTriggeredSec, last_nodata_ts: group.lastNodataSec, last_resolved_ts: group.lastResolvedSec };
      }
    }
    monitor.state = { groups };
  }
  if (withDowntimes) monitor.matching_downtimes = [];
  return monitor;
}
