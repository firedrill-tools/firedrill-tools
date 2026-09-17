// Jobs: list, get, cancel, details, failed files and output download (recomputed from the stored node snapshot).
import { Issues, fail, notFound, requestProblem } from "../lib/errors.mjs";
import { limits, usableId } from "../lib/ids.mjs";
import { workspaceOf } from "../lib/identity.mjs";
import { isRunning, jobPhase, jobStatus, jobView, nodeStats, nowIso, outputNodeOf } from "../lib/jobs-derive.mjs";
import { pageOf, responseBudget, withinBudget } from "../lib/pages.mjs";
import { partitionFile } from "../lib/partition/index.mjs";
import { scanAll } from "../lib/store.mjs";
import { mangled, parseEnum, parseInteger } from "../lib/validate.mjs";
import { nodeOptions } from "./nodes.mjs";

const JOB_STATUSES = ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "STOPPED", "FAILED"];

export function findJob(context, id, workspace) {
  if (!usableId(id) || mangled(id)) notFound(context, "Job not found");
  const row = context.state.get("jobs", id);
  if (row === null || row.workspace_id !== workspace) notFound(context, "Job not found");
  return row;
}

export const list = (input, context) => {
  const workspace = workspaceOf(context);
  requestProblem(input, context);
  const issues = new Issues();
  const status = parseEnum(input.status, "query.status", issues, JOB_STATUSES, null);
  const page = parseInteger(input.page, "query.page", issues, 1, { min: 1, max: 1000000 });
  const pageSize = parseInteger(input.page_size, "query.page_size", issues, 20, { min: 1, max: 100 });
  if (input.workflow_id !== undefined && (typeof input.workflow_id !== "string" || mangled(input.workflow_id))) issues.add("query.workflow_id", "Input should be a valid string");
  issues.raise(context);
  const now = context.clock.nowUs();
  const rows = scanAll(context, "jobs", limits(context).jobs)
    .filter((job) => job.workspace_id === workspace && (input.workflow_id === undefined || job.workflow_id === input.workflow_id))
    .map((job) => ({ job, view: jobView(job, now) }))
    .filter((entry) => status === null || entry.view.status === status)
    .sort((a, b) => (a.job.created_at < b.job.created_at ? 1 : a.job.created_at > b.job.created_at ? -1 : b.job.seq - a.job.seq));
  return pageOf(context, rows.map((entry) => entry.view), (page - 1) * pageSize, pageSize);
};

export const get = (input, context) => jobView(findJob(context, input.job_id, workspaceOf(context)), context.clock.nowUs());

export const cancel = (input, context) => {
  const job = findJob(context, input.job_id, workspaceOf(context));
  const phase = jobPhase(job, context.clock.nowUs());
  if (!isRunning(phase)) new Issues().add("body", phase === "STOPPED" ? "Job is already stopped" : "Job is already finished").raise(context);
  context.state.put("jobs", job.id, { ...job, cancelled_at: nowIso(context), stop_requested: true });
  context.events.emit("job.cancelled", { job_id: job.id, workflow_id: job.workflow_id });
  return { id: job.id, status: "STOPPED", message: "Job cancellation requested" };
};

export const details = (input, context) => {
  const job = findJob(context, input.job_id, workspaceOf(context));
  const derived = jobStatus(job, context.clock.nowUs());
  const failed = job.files.filter((file) => file.error !== null).length;
  const message = derived.phase === "FINISHED" ? `${job.files.length - failed} of ${job.files.length} files processed successfully` : derived.reason ?? `Job is ${derived.status.toLowerCase().replace("_", " ")}`;
  return { id: job.id, processing_status: derived.processing_status, node_stats: nodeStats(job, derived.phase), message };
};

export const failedFiles = (input, context) => {
  const job = findJob(context, input.job_id, workspaceOf(context));
  return { failed_files: job.files.filter((file) => file.error !== null).map((file) => ({ document: file.path, error: file.error })) };
};

export const downloadOutput = (input, context) => {
  const workspace = workspaceOf(context);
  requestProblem(input, context);
  const job = findJob(context, input.job_id, workspace);
  const issues = new Issues();
  if (typeof input.file_id !== "string" || input.file_id.length === 0) issues.add("query.file_id", "Field required");
  if (typeof input.node_id !== "string" || input.node_id.length === 0) issues.add("query.node_id", "Field required");
  issues.raise(context);
  const phase = jobPhase(job, context.clock.nowUs());
  if (phase !== "FINISHED") issues.add("body", "Job output is not available yet").raise(context);
  const node = outputNodeOf(job);
  const file = job.files.find((entry) => entry.file_id === input.file_id && entry.error === null);
  if (node === null || node.id !== input.node_id || file === undefined) notFound(context, "Job output file not found");
  const content = file.source_row !== null ? context.state.get("source-files", file.source_row) : context.state.get("job-files", `${job.id}:${file.file_id}`);
  if (content === null) notFound(context, "Job output file not found");
  const options = { ...nodeOptions(job.nodes, content.last_modified ?? job.created_at), responseBudget: responseBudget(context) };
  const result = partitionFile({ filename: content.filename, content: content.content, content_type: content.content_type, last_modified: content.last_modified }, options, context);
  if (!result.ok && result.code === "RESPONSE_TOO_LARGE") fail(context, "RESPONSE_TOO_LARGE", result.message.replace("Partition output", "Job output"));
  if (!result.ok) notFound(context, "Job output file not found");
  return withinBudget(context, result.elements, "Job output");
};
