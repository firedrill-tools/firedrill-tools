// Monitors v1: list, get, create, update, delete (composite reference check, force), validate.
import { bad, boolArg, caller, checkBudget, forbidden, intArg, isAdmin, notFound, nowUs, present, requireInt, scanAll } from "../lib/core.mjs";
import { evaluateAndStore, reindex } from "../lib/evaluate.mjs";
import { nextId } from "../lib/events-store.mjs";
import { buildMonitor, monitorRowId, renderMonitor } from "../lib/monitor-def.mjs";
import { parseMonitorQuery } from "../lib/mquery.mjs";
import { csv, text } from "../lib/text.mjs";

const GROUP_STATES = ["all", "alert", "warn", "no data", "ok"];

export function groupStates(context, raw) {
  if (!present(raw)) return null;
  const parts = csv(context, raw, "group_states", { maxItems: 5 }).map((part) => part.toLowerCase());
  if (parts.some((part) => !GROUP_STATES.includes(part))) bad(context, "Invalid parameter: group_states must list all, alert, warn, no data or ok");
  return parts.includes("all") || parts.length === 0 ? "all" : parts;
}

export function monitorId(raw) {
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 1 ? raw : null;
  return typeof raw === "string" && /^[1-9][0-9]{0,15}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
}

export function loadMonitor(context, raw) {
  const id = monitorId(raw);
  const row = id === null ? null : context.state.get("monitors", monitorRowId(id));
  if (row === null) notFound(context, "Monitor not found");
  return row;
}

function assertEditable(context, user, row) {
  if (row.restrictedRoles !== null && row.restrictedRoles.length > 0 && !isAdmin(user) && !row.restrictedRoles.includes(user.role)) {
    forbidden(context, "Forbidden: this monitor is restricted to specific roles");
  }
}

const isMulti = (row) => (row.type === "metric alert" || row.type === "query alert") && row.query.includes(" by {");

function scopeTags(row) {
  if (row.type !== "metric alert" && row.type !== "query alert") return [];
  const parsed = parseMonitorQuery(row.query);
  return parsed.ok ? parsed.parsed.expr.scopeText.split(",").map((tag) => tag.trim()) : [];
}

export function monitorsList(input, context) {
  caller(context);
  const states = groupStates(context, input.group_states);
  const name = text(context, input.name, "name", { max: 1000, noFffd: true });
  const tags = csv(context, input.tags, "tags");
  const monitorTags = csv(context, input.monitor_tags, "monitor_tags");
  const withDowntimes = boolArg(input.with_downtimes);
  if (withDowntimes === undefined) bad(context, "Invalid parameter: with_downtimes must be a boolean");
  const idOffset = requireInt(context, input.id_offset, "id_offset", 0, Number.MAX_SAFE_INTEGER, 0);
  const page = requireInt(context, input.page, "page", 0, 1_000_000, -1);
  const pageSize = requireInt(context, input.page_size, "page_size", 1, 1000, 100);
  const needle = name === null ? null : name.toLowerCase();
  let rows = scanAll(context, "monitors").map((record) => record.value).filter((row) => row.id > idOffset
    && (needle === null || row.name.toLowerCase().includes(needle))
    && monitorTags.every((tag) => row.tags.includes(tag))
    && (tags.length === 0 || tags.every((tag) => scopeTags(row).includes(tag))));
  if (page >= 0) rows = rows.slice(page * pageSize, page * pageSize + pageSize);
  return checkBudget(context, rows.map((row) => renderMonitor(context, row, { groupStates: states, withDowntimes: withDowntimes === true })));
}

export function monitorsGet(input, context) {
  caller(context);
  const row = loadMonitor(context, input.monitor_id);
  const states = groupStates(context, input.group_states);
  const withDowntimes = boolArg(input.with_downtimes);
  if (withDowntimes === undefined) bad(context, "Invalid parameter: with_downtimes must be a boolean");
  return renderMonitor(context, row, { groupStates: states, withDowntimes: withDowntimes === true });
}

export function monitorsCreate(input, context) {
  const user = caller(context, { write: true });
  const fields = buildMonitor(context, input, null, user);
  const id = nextId(context, "monitor");
  const now = nowUs(context);
  const evaluated = fields.parsed !== null;
  const row = {
    id, ...fields, multi: false, createdUs: now, modifiedUs: now, creatorHandle: user.handle,
    overallState: evaluated ? "OK" : "No Data", overallStateModifiedUs: evaluated ? null : now, groups: [],
  };
  row.multi = isMulti(row);
  reindex(context, null, row);
  const stored = evaluateAndStore(context, row);
  return renderMonitor(context, stored);
}

export function monitorsUpdate(input, context) {
  const user = caller(context, { write: true });
  const row = loadMonitor(context, input.monitor_id);
  assertEditable(context, user, row);
  const body = { ...input };
  delete body.monitor_id;
  const fields = buildMonitor(context, body, row, user);
  const next = { ...row, ...fields, modifiedUs: nowUs(context) };
  next.multi = isMulti(next);
  reindex(context, row, next);
  const stored = evaluateAndStore(context, next, new Set(), { pruneMissing: next.query !== row.query });
  return renderMonitor(context, stored);
}

export function monitorsDelete(input, context) {
  const user = caller(context, { write: true });
  const row = loadMonitor(context, input.monitor_id);
  assertEditable(context, user, row);
  const force = boolArg(input.force);
  if (force === undefined) bad(context, "Invalid parameter: force must be true or false");
  const refs = scanAll(context, "composite-refs", { prefix: `${monitorRowId(row.id)}/` });
  if (refs.length > 0 && force !== true) bad(context, `monitor [${row.id},] is referenced in composite monitors or SLOs`);
  reindex(context, row, null);
  for (const ref of refs) context.state.delete("composite-refs", ref.rowId);
  context.state.delete("monitors", monitorRowId(row.id));
  for (const ref of refs) {
    const composite = context.state.get("monitors", monitorRowId(ref.value.compositeId));
    if (composite !== null) evaluateAndStore(context, composite);
  }
  return { deleted_monitor_id: row.id };
}

export function monitorsValidate(input, context) {
  const user = caller(context);
  buildMonitor(context, input, null, user);
  return {};
}
