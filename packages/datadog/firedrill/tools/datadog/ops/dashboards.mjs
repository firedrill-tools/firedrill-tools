// Dashboards v1 (minimal): list, get, create, update (full replace), delete (soft).
import { bad, boolArg, caller, checkBudget, forbidden, isAdmin, isoMillis, limitExceeded, limits, notFound, nowUs, present, requireInt, scanAll, utf8Bytes } from "../lib/core.mjs";
import { nextId } from "../lib/events-store.mjs";
import { ROLES } from "../lib/core.mjs";
import { text } from "../lib/text.mjs";
import { normalizeWidgets, renderWidget } from "../lib/widgets.mjs";

const DASHBOARD_ID = /^[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/;
const BODY_KEYS = ["title", "layout_type", "widgets", "description", "reflow_type", "template_variables", "tags", "notify_list", "restricted_roles", "is_read_only"];

function slug(title) {
  let out = "";
  for (const ch of title.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) out += ch;
    else if (!out.endsWith("-")) out += "-";
  }
  return out.replace(/^-+|-+$/g, "").slice(0, 60) || "dashboard";
}

export function loadDashboard(context, raw) {
  const row = typeof raw === "string" && DASHBOARD_ID.test(raw) ? context.state.get("dashboards", raw) : null;
  if (row === null || row.deletedUs !== null) notFound(context, "Dashboard not found");
  return row;
}

function assertEditable(context, user, row) {
  if (row.restrictedRoles !== null && row.restrictedRoles.length > 0 && !isAdmin(user) && !row.restrictedRoles.includes(user.role)) {
    forbidden(context, "Forbidden: this dashboard is restricted to specific roles");
  }
  if (row.isReadOnly && !isAdmin(user) && row.authorHandle !== user.handle) forbidden(context, "Forbidden: this dashboard is read-only");
}

function stringList(context, raw, name, max, maxLen) {
  if (!present(raw)) return [];
  if (!Array.isArray(raw) || raw.length > max || raw.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > maxLen || entry.includes("�"))) {
    bad(context, `Invalid parameter: ${name} must be an array of at most ${max} strings`);
  }
  return [...raw];
}

function buildBody(context, input, user) {
  for (const key of Object.keys(input)) if (key !== "dashboard_id" && !BODY_KEYS.includes(key)) bad(context, `Invalid parameter: ${key} is not supported`);
  const title = text(context, input.title, "title", { required: true, min: 1, max: 500, trim: true });
  if (title.length === 0) bad(context, "Invalid parameter: title must not be empty");
  if (!["ordered", "free"].includes(input.layout_type)) bad(context, "Invalid parameter: layout_type must be ordered or free");
  const layoutType = input.layout_type;
  let reflowType = null;
  if (present(input.reflow_type)) {
    if (layoutType !== "ordered") bad(context, "Invalid parameter: reflow_type is only valid on ordered layouts");
    if (!["auto", "fixed"].includes(input.reflow_type)) bad(context, "Invalid parameter: reflow_type must be auto or fixed");
    reflowType = input.reflow_type;
  }
  if (present(input.template_variables) && (!Array.isArray(input.template_variables) || input.template_variables.length > 20)) {
    bad(context, "Invalid parameter: template_variables accepts at most 20 entries");
  }
  const templateVariables = (input.template_variables ?? []).map((variable) => {
    if (typeof variable !== "object" || variable === null || Array.isArray(variable) || typeof variable.name !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(variable.name)) {
      bad(context, "Invalid parameter: template_variables entries need a name of letters, digits, _ or -");
    }
    return { name: variable.name, prefix: text(context, variable.prefix, "template_variables.prefix", { max: 100 }), available_values: stringList(context, variable.available_values, "available_values", 100, 200), defaults: stringList(context, variable.defaults, "defaults", 20, 200) };
  });
  const names = templateVariables.map((variable) => variable.name);
  if (new Set(names).size !== names.length) bad(context, "Invalid parameter: template variable names must be unique");
  const tags = stringList(context, input.tags, "tags", 5, 200);
  if (tags.some((tag) => !tag.startsWith("team:") || tag.length < 6)) bad(context, "Invalid parameter: dashboard tags must use the team: key");
  const notifyList = stringList(context, input.notify_list, "notify_list", 20, 254);
  let restrictedRoles = null;
  if (present(input.restricted_roles)) {
    if (!Array.isArray(input.restricted_roles) || input.restricted_roles.some((role) => !ROLES.includes(role))) bad(context, "Invalid parameter: restricted_roles must list Datadog role names");
    restrictedRoles = ROLES.filter((role) => input.restricted_roles.includes(role));
    if (restrictedRoles.length > 0 && !isAdmin(user) && !restrictedRoles.includes(user.role)) bad(context, "Invalid parameter: restricted_roles must include your own role");
  }
  const readOnly = boolArg(input.is_read_only);
  if (readOnly === undefined || typeof input.is_read_only === "string") bad(context, "Invalid parameter: is_read_only must be a boolean");
  const description = text(context, input.description, "description", { max: 10000 });
  const widgets = normalizeWidgets(context, input.widgets, layoutType, names, () => nextId(context, "widget"));
  return { title, description, layoutType, reflowType, widgets, templateVariables, tags, notifyList, restrictedRoles, isReadOnly: readOnly === true };
}

export function renderDashboard(context, row) {
  const author = context.state.get("users", row.authorHandle);
  const out = {
    id: row.id, title: row.title, description: row.description, layout_type: row.layoutType, widgets: row.widgets.map(renderWidget),
    template_variables: row.templateVariables, tags: row.tags, notify_list: row.notifyList, restricted_roles: row.restrictedRoles,
    is_read_only: row.isReadOnly, author_handle: row.authorHandle, author_name: author?.name ?? null, created_at: isoMillis(row.createdUs),
    modified_at: isoMillis(row.modifiedUs), url: `/dashboard/${row.id}/${slug(row.title)}`,
  };
  if (row.layoutType === "ordered") out.reflow_type = row.reflowType ?? "auto";
  return out;
}

function store(context, row) {
  const bound = limits(context).maxDashboardBytes;
  if (utf8Bytes(JSON.stringify(row)) > bound) limitExceeded(context, `dashboard exceeds the supported size of ${bound} bytes`);
  context.state.put("dashboards", row.id, row);
  return renderDashboard(context, row);
}

export function dashboardsList(input, context) {
  caller(context);
  const shared = boolArg(input["filter[shared]"]);
  const deleted = boolArg(input["filter[deleted]"]);
  if (shared === undefined || deleted === undefined) bad(context, "Invalid parameter: filter[shared] and filter[deleted] must be true or false");
  const count = requireInt(context, input.count, "count", 1, 1000, 100);
  const start = requireInt(context, input.start, "start", 0, 1_000_000, 0);
  const query = text(context, input.query, "query", { max: 200, noFffd: true });
  const needle = query === null ? null : query.toLowerCase();
  const rows = scanAll(context, "dashboards").map((record) => record.value)
    .filter((row) => (deleted === true ? row.deletedUs !== null : row.deletedUs === null) && shared !== true
      && (needle === null || row.title.toLowerCase().includes(needle)));
  rows.sort((a, b) => b.modifiedUs - a.modifiedUs || (a.id < b.id ? -1 : 1));
  const dashboards = rows.slice(start, start + count).map((row) => ({
    id: row.id, title: row.title, description: row.description, layout_type: row.layoutType, url: `/dashboard/${row.id}/${slug(row.title)}`,
    is_read_only: row.isReadOnly, created_at: isoMillis(row.createdUs), modified_at: isoMillis(row.modifiedUs), author_handle: row.authorHandle,
    deleted_at: row.deletedUs === null ? null : isoMillis(row.deletedUs),
  }));
  return checkBudget(context, { dashboards, total_rows: rows.length });
}

export function dashboardsGet(input, context) {
  caller(context);
  return renderDashboard(context, loadDashboard(context, input.dashboard_id));
}

export function dashboardsCreate(input, context) {
  const user = caller(context, { write: true });
  const body = buildBody(context, input, user);
  let id = null;
  for (let attempt = 0; attempt < 5 && id === null; attempt += 1) {
    let candidate = "";
    for (let i = 0; i < 9; i += 1) candidate += `${"abcdefghijklmnopqrstuvwxyz0123456789"[context.random.nextInteger(0, 36)]}${i === 2 || i === 5 ? "-" : ""}`;
    if (context.state.get("dashboards", candidate) === null) id = candidate;
  }
  if (id === null) limitExceeded(context, "could not allocate a dashboard id");
  const now = nowUs(context);
  return store(context, { id, ...body, authorHandle: user.handle, createdUs: now, modifiedUs: now, deletedUs: null });
}

export function dashboardsUpdate(input, context) {
  const user = caller(context, { write: true });
  const row = loadDashboard(context, input.dashboard_id);
  assertEditable(context, user, row);
  const body = buildBody(context, input, user);
  return store(context, { ...row, ...body, modifiedUs: nowUs(context) });
}

export function dashboardsDelete(input, context) {
  const user = caller(context, { write: true });
  const row = loadDashboard(context, input.dashboard_id);
  assertEditable(context, user, row);
  context.state.put("dashboards", row.id, { ...row, deletedUs: nowUs(context) });
  return { deleted_dashboard_id: row.id };
}
