// Workspace connections: list with env/categories/external_xref filters, get, create (a synthetic, already-authorised
// connection), merge update and remove with a cascade over every data namespace of the connection.
import { badRequest, forbidden, notFound, scanBoundExceeded } from "../lib/errors.mjs";
import { emitDeleted } from "../lib/events.mjs";
import { connectionScope, inScope, loadConnection, resolveWorkspace } from "../lib/identity.mjs";
import { finishPage, parseListParams, project, sortRows, textFilter, updatedSince } from "../lib/query.mjs";
import { deleteRow, nextId, scanAll, scanBound, scanConnection } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";
import { bodyOf, checkValue, enumOf, str, strArray, validateBody } from "../lib/validate.mjs";
import { CATEGORIES, PERMISSIONS } from "../lib/enums.mjs";
import { isPlainObject, titleCase } from "../lib/util.mjs";

const ENVIRONMENTS = ["Production", "Sandbox"];
const DATA_NAMESPACES = { contacts: "crm_contact", companies: "crm_company", deals: "crm_deal", pipelines: null, channels: null, messages: "messaging_message" };
const AUTH_SPECS = { name: str(256), emails: strArray(8, 320), user_id: str(256) };

const CREATE_SPECS = {
  integration_type: str(64, { nullable: false, min: 1, pattern: /^[a-z][a-z0-9_-]*$/ }),
  permissions: strArray(64, 64),
  categories: strArray(35, 32),
  external_xref: str(256),
  environment: enumOf(ENVIRONMENTS),
  auth: { kind: "auth" },
  // Read-only members of the Connection schema are accepted and ignored, as the provider ignores them.
  integration_name: str(256),
  is_paused: { kind: "ignored" },
  last_healthy_at: { kind: "ignored" },
  last_unhealthy_at: { kind: "ignored" },
  last_unhealthy_code: { kind: "ignored" },
};

const IGNORED = new Set(["integration_name", "is_paused", "last_healthy_at", "last_unhealthy_at", "last_unhealthy_code"]);

function checkAuth(context, value) {
  if (value === undefined || value === null) return { name: null, emails: [], user_id: null };
  if (!isPlainObject(value)) badRequest(context, "Invalid value for auth: must be an object");
  const out = validateBody(context, value, AUTH_SPECS);
  for (const email of out.emails ?? []) if (!email.includes("@")) badRequest(context, "Invalid value for auth.emails: entries must be e-mail addresses");
  return { name: out.name ?? null, emails: out.emails ?? [], user_id: out.user_id ?? null };
}

function checkEnums(context, fields) {
  for (const category of fields.categories ?? []) if (!CATEGORIES.includes(category)) badRequest(context, `Invalid value for categories: ${category.slice(0, 60)} is not a supported category`);
  for (const permission of fields.permissions ?? []) if (!PERMISSIONS.includes(permission)) badRequest(context, `Invalid value for permissions: ${permission.slice(0, 60)} is not a supported permission`);
}

/** Every permission's category prefix (crm_ -> crm, messaging_ -> messaging) must be one of the connection's categories. */
function checkPermissionCategories(context, permissions, categories) {
  for (const permission of permissions) {
    const category = permission.split("_")[0];
    if (!categories.includes(category)) badRequest(context, `Permission ${permission} requires the ${category} category`);
  }
}

function validateConnectionBody(context, body) {
  const fields = {};
  for (const key of Object.keys(body)) {
    if (["id", "workspace_id", "created_at", "updated_at", "__request_error"].includes(key)) continue;
    if (!Object.hasOwn(CREATE_SPECS, key)) badRequest(context, `Unknown field "${key.slice(0, 80)}"`);
    if (IGNORED.has(key)) continue;
    fields[key] = key === "auth" ? checkAuth(context, body[key]) : checkValue(context, key, CREATE_SPECS[key], body[key]);
  }
  checkEnums(context, fields);
  return fields;
}

const listFilter = (input, context) => {
  const env = input.env === undefined || input.env === null ? "Production" : input.env;
  if (!ENVIRONMENTS.includes(env)) badRequest(context, "env must be Production or Sandbox");
  const external = textFilter(input, context, "external_xref");
  let categories = [];
  if (input.categories !== undefined && input.categories !== null) {
    const parts = Array.isArray(input.categories) ? input.categories : typeof input.categories === "string" ? [input.categories] : null;
    if (parts === null) badRequest(context, "categories must be a comma-separated list");
    for (const part of parts) {
      if (typeof part !== "string") badRequest(context, "categories must be a comma-separated list");
      for (const name of part.split(",")) if (name.trim().length > 0) categories.push(name.trim());
    }
    if (categories.length > 35) badRequest(context, "categories lists too many values");
    for (const category of categories) if (!CATEGORIES.includes(category)) badRequest(context, `categories: ${category.slice(0, 60)} is not a supported category`);
  }
  return (row) => row.environment === env && (external === null || row.external_xref === external) && categories.every((category) => row.categories.includes(category));
};

export const connections = {
  list(input, context) {
    const workspace = resolveWorkspace(input, context);
    const params = parseListParams(input, context);
    const filter = listFilter(input, context);
    const scope = connectionScope(context);
    const rows = scanAll(context, "connections", scanBound(workspace)).filter(
      (row) => row.workspace_id === workspace.id && inScope(scope, row.id) && updatedSince(row, params.updatedGteUs) && filter(row),
    );
    sortRows(rows, params.sort, params.order, "integration_name");
    return finishPage(context, rows, params, null);
  },
  get(input, context) {
    const workspace = resolveWorkspace(input, context);
    return project(loadConnection(context, workspace, input.id), null);
  },
  create(input, context) {
    const workspace = resolveWorkspace(input, context);
    if (connectionScope(context) !== null) forbidden(context, "Connection-scoped tokens cannot create connections");
    const fields = validateConnectionBody(context, bodyOf(input, ["__request_error"]));
    if (typeof fields.integration_type !== "string") badRequest(context, "integration_type is required");
    const categories = fields.categories ?? [];
    if (categories.length === 0) badRequest(context, "categories must list at least one category");
    const permissions = fields.permissions ?? [];
    checkPermissionCategories(context, permissions, categories);
    const existing = scanAll(context, "connections", scanBound(workspace)).filter((row) => row.workspace_id === workspace.id);
    const bound = scanBound(workspace);
    if (existing.length >= bound) scanBoundExceeded(context, "connections", bound);
    const now = nowIso(context);
    const row = {
      id: nextId(context), workspace_id: workspace.id, integration_type: fields.integration_type, integration_name: titleCase(fields.integration_type),
      external_xref: fields.external_xref ?? null, permissions, categories, auth: fields.auth ?? { name: null, emails: [], user_id: null },
      is_paused: false, environment: fields.environment ?? "Production", last_healthy_at: now, last_unhealthy_at: null, last_unhealthy_code: null,
      created_at: now, updated_at: now,
    };
    context.state.put("connections", row.id, row);
    return row;
  },
  update(input, context) {
    const workspace = resolveWorkspace(input, context);
    const existing = loadConnection(context, workspace, input.id);
    const fields = validateConnectionBody(context, bodyOf(input, ["id", "__request_error"]));
    const merged = { ...existing };
    for (const key of ["permissions", "external_xref", "environment", "auth"]) if (Object.hasOwn(fields, key) && fields[key] !== null) merged[key] = fields[key];
    if (Object.hasOwn(fields, "external_xref") && fields.external_xref === null) merged.external_xref = null;
    if (Object.hasOwn(fields, "integration_type") || Object.hasOwn(fields, "categories")) badRequest(context, "integration_type and categories cannot be changed after creation");
    checkPermissionCategories(context, merged.permissions, merged.categories);
    merged.updated_at = nowIso(context);
    context.state.put("connections", merged.id, merged);
    return merged;
  },
  remove(input, context) {
    const workspace = resolveWorkspace(input, context);
    const existing = loadConnection(context, workspace, input.id);
    const bound = scanBound(workspace);
    // Read every namespace first so the cascade either completes or refuses without half-deleting.
    const cascade = Object.keys(DATA_NAMESPACES).map((namespace) => [namespace, scanConnection(context, namespace, existing.id, bound)]);
    for (const [namespace, rows] of cascade) {
      for (const row of rows) {
        deleteRow(context, namespace, existing.id, row.id);
        if (DATA_NAMESPACES[namespace] !== null) emitDeleted(context, existing, DATA_NAMESPACES[namespace], row.id);
      }
    }
    context.state.delete("connections", existing.id);
    return {};
  },
};
