// Generic list/get/create/update/remove engine shared by every connection-scoped resource. A resource spec supplies
// the namespace, category, permission slug, object type, searchable fields, list filters, body specs and hooks;
// everything else (identity rules, paging, projection, events, bounds) is computed here from `context.state`.
import { CRM, checkReferences, detachAll, syncAssociations } from "../lib/assoc.mjs";
import { badRequest, notFound, scanBoundExceeded } from "../lib/errors.mjs";
import { emitCreated, emitDeleted, emitUpdated } from "../lib/events.mjs";
import { requireConnection, resolveWorkspace } from "../lib/identity.mjs";
import { finishPage, matchesQuery, parseFields, parseListParams, project, sortRows, updatedSince } from "../lib/query.mjs";
import { deleteRow, getRow, nextId, putRow, scanBound, scanConnection } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";
import { bodyOf, validateBody } from "../lib/validate.mjs";
import { isHex24, jsonEqual } from "../lib/util.mjs";

const ADDRESSING = ["connection_id", "id", "__request_error"];

export function open(input, context, spec, mode) {
  const workspace = resolveWorkspace(input, context);
  const connection = requireConnection(context, workspace, input.connection_id, spec.category, `${spec.permission}_${mode}`);
  return { workspace, connection };
}

export function requireId(context, spec, connectionId, id) {
  if (!isHex24(id)) badRequest(context, `Invalid ${spec.label.toLowerCase()} id`);
  const row = getRow(context, spec.namespace, connectionId, id);
  if (row === null) notFound(context, `${spec.label} not found`);
  return row;
}

/** Rows of one connection, in creation order, after the bounded scan. */
export function rowsOf(context, workspace, spec, connectionId) {
  return scanConnection(context, spec.namespace, connectionId, scanBound(workspace));
}

/** Top-level fields whose stored value differs between two rows. */
export function changedFields(before, after) {
  const out = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "updated_at") continue;
    if (!jsonEqual(before[key], after[key])) out.push(key);
  }
  return out;
}

export function makeResource(spec) {
  const hidden = spec.hidden ?? [];
  const isCrm = Object.hasOwn(CRM, spec.namespace);

  const list = (input, context) => {
    const { workspace, connection } = open(input, context, spec, "read");
    const params = parseListParams(input, context);
    const fields = parseFields(input, context);
    const filter = spec.filter(input, context, connection, workspace);
    const rows = rowsOf(context, workspace, spec, connection.id).filter(
      (row) => updatedSince(row, params.updatedGteUs) && matchesQuery(row, params.query, spec.searchFields) && filter(row),
    );
    sortRows(rows, params.sort, params.order, spec.nameField ?? "name");
    const page = finishPage(context, rows, params, fields, hidden);
    return spec.present ? page.map((item) => spec.present(item, context, workspace)) : page;
  };

  const get = (input, context) => {
    const { workspace, connection } = open(input, context, spec, "read");
    const fields = parseFields(input, context);
    const row = requireId(context, spec, connection.id, input.id);
    const item = project(row, fields, hidden);
    return spec.present ? spec.present(item, context, workspace) : item;
  };

  const create = (input, context) => {
    const { workspace, connection } = open(input, context, spec, "write");
    const fields = validateBody(context, bodyOf(input, ADDRESSING), spec.bodySpecs);
    const prepared = spec.prepareCreate(context, connection, fields, workspace);
    if (isCrm) checkReferences(context, connection.id, spec.namespace, prepared);
    // The namespace must stay within the per-connection bound after this write.
    const bound = scanBound(workspace);
    const existing = rowsOf(context, workspace, spec, connection.id);
    if (existing.length >= bound) scanBoundExceeded(context, spec.namespace, bound);
    const now = nowIso(context);
    const id = nextId(context);
    const row = { ...spec.defaults(), ...prepared, connection_id: connection.id, id, created_at: now, updated_at: now };
    putRow(context, spec.namespace, row);
    if (isCrm) syncAssociations(context, connection, spec.namespace, row, null);
    if (spec.afterCreate) spec.afterCreate(context, connection, row);
    emitCreated(context, connection, spec.objectType, id);
    return project(row, null, hidden);
  };

  const update = (input, context) => {
    const { workspace, connection } = open(input, context, spec, "write");
    const existing = requireId(context, spec, connection.id, input.id);
    const fields = validateBody(context, bodyOf(input, ADDRESSING), spec.updateSpecs ?? spec.bodySpecs);
    const merged = spec.prepareUpdate(context, connection, existing, fields, workspace);
    if (isCrm) checkReferences(context, connection.id, spec.namespace, merged);
    const changed = changedFields(existing, merged);
    if (changed.length === 0) return project(existing, null, hidden);
    const row = { ...merged, connection_id: connection.id, id: existing.id, created_at: existing.created_at, updated_at: nowIso(context) };
    putRow(context, spec.namespace, row);
    if (isCrm) syncAssociations(context, connection, spec.namespace, row, existing);
    emitUpdated(context, connection, spec.objectType, row.id, changed);
    return project(row, null, hidden);
  };

  const remove = (input, context) => {
    const { workspace, connection } = open(input, context, spec, "write");
    const existing = requireId(context, spec, connection.id, input.id);
    if (spec.beforeRemove) spec.beforeRemove(context, connection, existing, workspace);
    if (isCrm) detachAll(context, connection, spec.namespace, existing);
    deleteRow(context, spec.namespace, connection.id, existing.id);
    emitDeleted(context, connection, spec.objectType, existing.id);
    return {};
  };

  return { list, get, create, update, remove };
}
