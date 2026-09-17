// Source and destination connectors: list, create, get, update, delete, plus source connection checks.
import { MASK, connectorView, isSecretKey, normaliseConfig, requiredKeys } from "../lib/connectors.mjs";
import { Issues, notFound, requestProblem } from "../lib/errors.mjs";
import { limits, nextSeq, usableId, uuid } from "../lib/ids.mjs";
import { workspaceOf } from "../lib/identity.mjs";
import { isRunning, jobPhase, nowIso } from "../lib/jobs-derive.mjs";
import { scanAll, scanPrefix } from "../lib/store.mjs";
import { withinBudget } from "../lib/pages.mjs";
import { mangled, parseEnum, parseString } from "../lib/validate.mjs";

const KEY_RE = /^[a-z0-9](-?[a-z0-9])*$/;

/** The connector row of `namespace` with this id in the caller's workspace, or NOT_FOUND. */
export function findConnector(context, namespace, id, workspace, label) {
  if (!usableId(id) || mangled(id)) notFound(context, `${label} not found`);
  const row = context.state.get(namespace, id);
  if (row === null || row.workspace_id !== workspace) notFound(context, `${label} not found`);
  return row;
}

/** Validates `config` for `type`; masked secrets keep the stored value. Adds issues; returns the config or null. */
function validateConfig(value, type, loc, issues, stored) {
  const result = normaliseConfig(value, loc);
  if (result.issues !== undefined) {
    for (const [where, message] of result.issues) issues.add(where, message);
    return null;
  }
  const config = result.config;
  if (stored !== null) for (const key of Object.keys(config)) if (config[key] === MASK && isSecretKey(key) && Object.hasOwn(stored, key)) config[key] = stored[key];
  for (const key of requiredKeys(type)) if (typeof config[key] !== "string" || config[key].length === 0) issues.add(`${loc}.${key}`, "Field required");
  return config;
}

/** True when a SCHEDULED or IN_PROGRESS job of the workspace runs a workflow that references this connector. */
function inUseByRunningJob(context, workspace, idField, id) {
  const bound = limits(context).jobs;
  const now = context.clock.nowUs();
  const workflows = new Map();
  for (const job of scanAll(context, "jobs", bound)) {
    if (job.workspace_id !== workspace || !isRunning(jobPhase(job, now))) continue;
    if (!workflows.has(job.workflow_id)) workflows.set(job.workflow_id, context.state.get("workflows", job.workflow_id));
    const workflow = workflows.get(job.workflow_id);
    if (workflow !== null && workflow[idField] === id) return true;
  }
  return false;
}

export function connectorOps({ namespace, idField, types, typeFilter, label }) {
  const find = (context, id, workspace) => findConnector(context, namespace, id, workspace, label);
  const all = (context, workspace) => scanAll(context, namespace, limits(context).connectors).filter((row) => row.workspace_id === workspace);

  const list = (input, context) => {
    const workspace = workspaceOf(context);
    requestProblem(input, context);
    const issues = new Issues();
    const type = parseEnum(input[typeFilter], `query.${typeFilter}`, issues, types, null);
    issues.raise(context);
    const rows = all(context, workspace)
      .filter((row) => type === null || row.type === type)
      .sort((a, b) => a.seq - b.seq)
      .map(connectorView);
    return withinBudget(context, rows, `The list of ${rows.length} ${label.toLowerCase()}s`, `filter by ${typeFilter} or delete unused ${label.toLowerCase()}s`);
  };

  const create = (input, context) => {
    const workspace = workspaceOf(context);
    requestProblem(input, context);
    const issues = new Issues();
    const name = parseString(input.name, "body.name", issues, { required: true, min: 1, max: 200 });
    const type = input.type === undefined || input.type === null ? (issues.add("body.type", "Field required"), null) : parseEnum(input.type, "body.type", issues, types, null);
    const key = parseString(input.key, "body.key", issues, { max: 63 });
    if (key !== null && !KEY_RE.test(key)) issues.add("body.key", "String should match pattern '^[a-z0-9](-?[a-z0-9])*$'");
    if (input.config === undefined || input.config === null) issues.add("body.config", "Field required");
    const config = type !== null && input.config !== undefined && input.config !== null ? validateConfig(input.config, type, "body.config", issues, null) : null;
    issues.raise(context);
    if (key !== null && all(context, workspace).some((row) => row.key === key)) issues.add("body.key", "Connector key already exists in this workspace").raise(context);
    const row = { id: uuid(context), workspace_id: workspace, seq: nextSeq(context), name, type, config, key, created_at: nowIso(context), updated_at: null };
    context.state.put(namespace, row.id, row);
    return connectorView(row);
  };

  const get = (input, context) => connectorView(find(context, input[idField], workspaceOf(context)));

  const update = (input, context) => {
    const workspace = workspaceOf(context);
    requestProblem(input, context);
    const row = find(context, input[idField], workspace);
    const issues = new Issues();
    const name = parseString(input.name, "body.name", issues, { min: 1, max: 200 });
    if (input.type !== undefined && input.type !== null) {
      const type = parseEnum(input.type, "body.type", issues, types, null);
      if (type !== null && type !== row.type) issues.add("body.type", "Connector type cannot be changed");
    }
    const config = input.config !== undefined && input.config !== null ? validateConfig(input.config, row.type, "body.config", issues, row.config) : null;
    issues.raise(context);
    const next = { ...row, name: name ?? row.name, config: config ?? row.config, updated_at: nowIso(context) };
    context.state.put(namespace, row.id, next);
    return connectorView(next);
  };

  const remove = (input, context) => {
    const workspace = workspaceOf(context);
    const row = find(context, input[idField], workspace);
    if (inUseByRunningJob(context, workspace, idField, row.id)) new Issues().add("body", `${label} is in use by a running job`).raise(context);
    if (namespace === "sources") {
      for (const file of scanPrefix(context, "source-files", `${row.id}:`, limits(context).files_per_source)) context.state.delete("source-files", `${row.id}:${file.file_id}`);
      context.state.delete("connection-checks", row.id);
    }
    context.state.delete(namespace, row.id);
    return {};
  };

  const checkConnection = (input, context) => {
    const row = find(context, input[idField], workspaceOf(context));
    const missing = requiredKeys(row.type).find((key) => typeof row.config[key] !== "string" || row.config[key].length === 0);
    const check = { source_id: row.id, status: missing === undefined ? "SUCCESS" : "FAILURE", reason: missing === undefined ? null : `Missing required configuration key: ${missing}`, created_at: nowIso(context) };
    context.state.put("connection-checks", row.id, check);
    return { status: check.status, reason: check.reason, created_at: check.created_at };
  };

  const getConnectionCheck = (input, context) => {
    const row = find(context, input[idField], workspaceOf(context));
    const check = context.state.get("connection-checks", row.id);
    if (check === null) notFound(context, "No connection check found");
    return { status: check.status, reason: check.reason, created_at: check.created_at };
  };

  return { list, create, get, update, remove, checkConnection, getConnectionCheck };
}
