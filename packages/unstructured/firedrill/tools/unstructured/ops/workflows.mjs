// Workflows: list, create, get, update, delete and run (which creates a job from the source's files).
import { Issues, notFound, requestProblem } from "../lib/errors.mjs";
import { limits, nextSeq, usableId, uuid } from "../lib/ids.mjs";
import { workspaceOf } from "../lib/identity.mjs";
import { isRunning, jobPhase, jobView, nowIso } from "../lib/jobs-derive.mjs";
import { pageOf } from "../lib/pages.mjs";
import { partitionFile } from "../lib/partition/index.mjs";
import { scanAll, scanPrefix } from "../lib/store.mjs";
import { clip, utf8Length } from "../lib/util.mjs";
import { mangled, parseBool, parseEnum, parseInteger, parseString } from "../lib/validate.mjs";
import { findConnector } from "./connectors.mjs";
import { defaultNodes, nodeOptions, validateNodes } from "./nodes.mjs";
import { checkFiles } from "./partition.mjs";

export const SCHEDULES = ["every 15 minutes", "every hour", "every 2 hours", "every 4 hours", "every 6 hours", "every 8 hours", "every 10 hours", "every 12 hours", "daily", "weekly", "monthly"];
const STATUSES = ["active", "inactive", "paused"];
const SORT_BY = ["id", "name", "created_at", "updated_at", "status"];
const UNSUPPORTED_FILTERS = ["show_only_soft_deleted", "show_recommender_workflows", "dag_node_configuration_id", "created_since", "created_before"];
const UNSUPPORTED_FIELDS = ["template_id", "source_ids", "destination_ids", "skip_preflight"];
const KEY_RE = /^[a-z0-9](-?[a-z0-9])*$/;
const RUNTIME_BUDGET = 900 * 1024;

export const workflowView = (row) => ({
  id: row.id, name: row.name, workflow_type: row.workflow_type, source_id: row.source_id, destination_id: row.destination_id, status: row.status,
  schedule: row.schedule, workflow_nodes: row.workflow_nodes, reprocess_all: row.reprocess_all, created_at: row.created_at, updated_at: row.updated_at,
  sources: row.source_id === null ? [] : [row.source_id], destinations: row.destination_id === null ? [] : [row.destination_id], key: row.key,
});

export function findWorkflow(context, id, workspace) {
  if (!usableId(id) || mangled(id)) notFound(context, "Workflow not found");
  const row = context.state.get("workflows", id);
  if (row === null || row.workspace_id !== workspace) notFound(context, "Workflow not found");
  return row;
}

function connectorRef(input, field, namespace, label, workspace, context, issues) {
  const value = input[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return (issues.add(`body.${field}`, "Input should be a valid string"), null);
  const row = usableId(value) && !mangled(value) ? context.state.get(namespace, value) : null;
  if (row === null || row.workspace_id !== workspace) issues.add(`body.${field}`, `${label} not found`);
  return value;
}

function commonFields(input, context, workspace, issues, existing) {
  for (const field of UNSUPPORTED_FIELDS) if (input[field] !== undefined) issues.add(`body.${field}`, `${field} is not supported by this Tool`);
  const out = {};
  out.name = parseString(input.name, "body.name", issues, { required: existing === null, min: 1, max: 200 });
  out.source_id = Object.hasOwn(input, "source_id") ? connectorRef(input, "source_id", "sources", "Source connector", workspace, context, issues) : existing?.source_id ?? null;
  out.destination_id = Object.hasOwn(input, "destination_id") ? connectorRef(input, "destination_id", "destinations", "Destination connector", workspace, context, issues) : existing?.destination_id ?? null;
  out.schedule = Object.hasOwn(input, "schedule") ? parseEnum(input.schedule, "body.schedule", issues, SCHEDULES, null) : existing?.schedule ?? null;
  out.reprocess_all = parseBool(input.reprocess_all, "body.reprocess_all", issues, existing?.reprocess_all ?? false);
  const type = input.workflow_type === undefined || input.workflow_type === null ? existing?.workflow_type ?? null : parseEnum(input.workflow_type, "body.workflow_type", issues, ["auto", "custom"], null);
  if (type === null && existing === null) issues.add("body.workflow_type", "Field required");
  out.workflow_type = type;
  if (type === "custom" && (existing === null || input.workflow_nodes !== undefined)) out.workflow_nodes = validateNodes(input.workflow_nodes, "body.workflow_nodes", issues, context);
  else if (type === "auto") out.workflow_nodes = existing === null || existing.workflow_type !== "auto" ? defaultNodes(context) : existing.workflow_nodes;
  else out.workflow_nodes = existing?.workflow_nodes ?? [];
  return out;
}

export const list = (input, context) => {
  const workspace = workspaceOf(context);
  requestProblem(input, context);
  const issues = new Issues();
  for (const filter of UNSUPPORTED_FILTERS) if (input[filter] !== undefined) issues.add(`query.${filter}`, `${filter} is not supported by this Tool`);
  const status = parseEnum(input.status, "query.status", issues, STATUSES, null);
  const page = parseInteger(input.page, "query.page", issues, 1, { min: 1, max: 1000000 });
  const pageSize = parseInteger(input.page_size, "query.page_size", issues, 20, { min: 1, max: 100 });
  const sortBy = parseEnum(input.sort_by, "query.sort_by", issues, SORT_BY, "id");
  const direction = parseEnum(input.sort_direction, "query.sort_direction", issues, ["asc", "desc"], "asc");
  for (const field of ["source_id", "destination_id", "name"]) if (input[field] !== undefined && (typeof input[field] !== "string" || mangled(input[field]))) issues.add(`query.${field}`, "Input should be a valid string");
  issues.raise(context);
  const rows = scanAll(context, "workflows", limits(context).workflows).filter(
    (row) => row.workspace_id === workspace && (status === null || row.status === status) && (input.source_id === undefined || row.source_id === input.source_id) && (input.destination_id === undefined || row.destination_id === input.destination_id) && (input.name === undefined || row.name === input.name),
  );
  const sign = direction === "desc" ? -1 : 1;
  rows.sort((a, b) => {
    const left = a[sortBy] ?? "";
    const right = b[sortBy] ?? "";
    if (left < right) return -sign;
    if (left > right) return sign;
    return (a.seq - b.seq) * sign;
  });
  return pageOf(context, rows.map(workflowView), (page - 1) * pageSize, pageSize);
};

export const create = (input, context) => {
  const workspace = workspaceOf(context);
  requestProblem(input, context);
  const issues = new Issues();
  const fields = commonFields(input, context, workspace, issues, null);
  const key = parseString(input.key, "body.key", issues, { max: 63 });
  if (key !== null && !KEY_RE.test(key)) issues.add("body.key", "String should match pattern '^[a-z0-9](-?[a-z0-9])*$'");
  issues.raise(context);
  if (key !== null && scanAll(context, "workflows", limits(context).workflows).some((row) => row.workspace_id === workspace && row.key === key)) issues.add("body.key", "Workflow key already exists in this workspace").raise(context);
  const row = { id: uuid(context), workspace_id: workspace, seq: nextSeq(context), ...fields, status: "active", key, created_at: nowIso(context), updated_at: null };
  context.state.put("workflows", row.id, row);
  return workflowView(row);
};

export const get = (input, context) => workflowView(findWorkflow(context, input.workflow_id, workspaceOf(context)));

export const update = (input, context) => {
  const workspace = workspaceOf(context);
  requestProblem(input, context);
  const row = findWorkflow(context, input.workflow_id, workspace);
  const issues = new Issues();
  const fields = commonFields(input, context, workspace, issues, row);
  const status = parseEnum(input.status, "body.status", issues, STATUSES, row.status);
  issues.raise(context);
  const next = { ...row, ...fields, name: fields.name ?? row.name, status, updated_at: nowIso(context) };
  context.state.put("workflows", row.id, next);
  return workflowView(next);
};

export const remove = (input, context) => {
  const workspace = workspaceOf(context);
  const row = findWorkflow(context, input.workflow_id, workspace);
  const now = context.clock.nowUs();
  if (scanAll(context, "jobs", limits(context).jobs).some((job) => job.workflow_id === row.id && isRunning(jobPhase(job, now)))) new Issues().add("body", "Workflow has a running job").raise(context);
  context.state.delete("workflows", row.id);
  return {};
};

/** Job file entry from a source file row or a runtime upload; `error` is set when the file cannot be processed. */
function jobFile(file, sourceRow, options, context) {
  const entry = { file_id: file.file_id, source_row: sourceRow, filename: clip(file.filename, 200), path: clip(file.path, 500), content_type: clip(file.content_type, 100), size_bytes: file.size_bytes, error: null };
  if (typeof file.error === "string" && file.error.length > 0) entry.error = clip(file.error, 500);
  else {
    const result = partitionFile({ filename: file.filename, content: file.content, content_type: file.content_type }, options, context);
    if (!result.ok) entry.error = clip(result.message, 500);
  }
  return entry;
}

export const run = (input, context) => {
  const workspace = workspaceOf(context);
  requestProblem(input, context);
  const workflow = findWorkflow(context, input.workflow_id, workspace);
  const issues = new Issues();
  if (workflow.status !== "active") issues.add("body", "Workflow is not active").raise(context);
  const runtime = input.input_files === undefined || input.input_files === null ? [] : input.input_files;
  if (runtime.length > 0) checkFiles(runtime, context, "body.input_files");
  if (workflow.source_id === null && runtime.length === 0) issues.add("body.input_files", "Field required").raise(context);
  let total = 0;
  for (const file of runtime) total += utf8Length(file.content);
  if (total > RUNTIME_BUDGET) issues.add("body.input_files", `Runtime input files exceed ${RUNTIME_BUDGET} bytes in total`).raise(context);
  const options = nodeOptions(workflow.workflow_nodes, nowIso(context));
  const files = [];
  if (workflow.source_id !== null) {
    const source = findConnectorOrIssue(context, workflow.source_id, workspace, issues);
    for (const file of scanPrefix(context, "source-files", `${source.id}:`, limits(context).files_per_source)) files.push(jobFile({ ...file, file_id: `${source.id}:${file.file_id}` }, `${source.id}:${file.file_id}`, options, context));
  }
  const jobId = uuid(context);
  const uploads = [];
  for (const [index, file] of runtime.entries()) {
    const fileId = uuid(context);
    const upload = { file_id: fileId, filename: file.filename, path: `upload://${file.filename}`, content_type: typeof file.content_type === "string" ? file.content_type : "", size_bytes: utf8Length(file.content), content: file.content, error: null };
    files.push(jobFile(upload, null, options, context));
    uploads.push({ rowId: `${jobId}:${fileId}`, value: { job_id: jobId, file_id: fileId, filename: clip(file.filename, 200), content_type: upload.content_type, size_bytes: upload.size_bytes, content: file.content } });
    void index;
  }
  if (files.length === 0) issues.add("body", "Source connector holds no files").raise(context);
  const nodes = workflow.workflow_nodes;
  const job = {
    id: jobId, workspace_id: workspace, seq: nextSeq(context), workflow_id: workflow.id, workflow_name: workflow.name, job_type: "ephemeral", created_at: nowIso(context),
    cancelled_at: null, stop_requested: false, files, nodes, destination_node_id: nodes.length > 0 ? nodes[nodes.length - 1].id : null, created_by: clip(context.actor.id, 200),
  };
  context.state.put("jobs", job.id, job);
  for (const upload of uploads) context.state.put("job-files", upload.rowId, upload.value);
  context.events.emit("job.created", { job_id: job.id, workflow_id: workflow.id, workflow_name: workflow.name, input_file_count: files.length, runtime_file_count: uploads.length });
  return jobView(job, context.clock.nowUs());
};

function findConnectorOrIssue(context, id, workspace, issues) {
  const row = usableId(id) ? context.state.get("sources", id) : null;
  if (row === null || row.workspace_id !== workspace) issues.add("body.source_id", "Source connector not found").raise(context);
  return row;
}
