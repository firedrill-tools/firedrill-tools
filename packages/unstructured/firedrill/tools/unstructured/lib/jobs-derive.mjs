// Job status derived from virtual time: SCHEDULED for 5 s, IN_PROGRESS for 10 s per file plus 1 s per 4 KB, then
// finished. Nothing time-dependent is stored on the job row, so the same world read at the same virtual time
// always answers the same way.
import { isoDuration, isoFromUs, usFromIso } from "./util.mjs";

const SCHEDULE_US = 5000000;
const PER_FILE_US = 10000000;
const PER_4KB_US = 1000000;

export function jobTiming(job) {
  const createdUs = usFromIso(job.created_at) ?? 0;
  const startUs = createdUs + SCHEDULE_US;
  let bytes = 0;
  for (const file of job.files) bytes += Number.isInteger(file.size_bytes) ? file.size_bytes : 0;
  const finishUs = startUs + job.files.length * PER_FILE_US + Math.floor(bytes / 4096) * PER_4KB_US;
  return { createdUs, startUs, finishUs };
}

/** "STOPPED" | "SCHEDULED" | "IN_PROGRESS" | "FINISHED" */
export function jobPhase(job, nowUs) {
  const { startUs, finishUs } = jobTiming(job);
  if (typeof job.cancelled_at === "string") {
    const cancelledUs = usFromIso(job.cancelled_at) ?? 0;
    if (cancelledUs < finishUs) return "STOPPED";
  }
  if (nowUs < startUs) return "SCHEDULED";
  if (nowUs < finishUs) return "IN_PROGRESS";
  return "FINISHED";
}

export const isRunning = (phase) => phase === "SCHEDULED" || phase === "IN_PROGRESS";

/** { status, processing_status, runtime, reason, phase } as the Workflow Endpoint reports them. */
export function jobStatus(job, nowUs) {
  const phase = jobPhase(job, nowUs);
  if (phase === "STOPPED") return { phase, status: "STOPPED", processing_status: "STOPPED", runtime: null, reason: "Cancelled by user" };
  if (phase === "SCHEDULED") return { phase, status: "SCHEDULED", processing_status: "SCHEDULED", runtime: null, reason: null };
  if (phase === "IN_PROGRESS") return { phase, status: "IN_PROGRESS", processing_status: "IN_PROGRESS", runtime: null, reason: null };
  const { startUs, finishUs } = jobTiming(job);
  const runtime = isoDuration((finishUs - startUs) / 1000000);
  const failed = job.files.filter((file) => file.error !== null).length;
  if (job.files.length === 0) return { phase, status: "FAILED", processing_status: "FAILED", runtime, reason: "Source connector holds no files" };
  if (failed === job.files.length) return { phase, status: "FAILED", processing_status: "FAILED", runtime, reason: "All files failed" };
  if (failed > 0) return { phase, status: "COMPLETED", processing_status: "COMPLETED_WITH_ERRORS", runtime, reason: null };
  return { phase, status: "COMPLETED", processing_status: "SUCCESS", runtime, reason: null };
}

/** The node whose output the destination receives: the last node of the snapshot. */
export const outputNodeOf = (job) => (job.nodes.length > 0 ? job.nodes[job.nodes.length - 1] : null);

/** `JobInformation` view of a job row at virtual `nowUs`. */
export function jobView(job, nowUs) {
  const derived = jobStatus(job, nowUs);
  const node = outputNodeOf(job);
  const outputs = [];
  if (derived.phase === "FINISHED" && node !== null) {
    for (const file of job.files) if (file.error === null) outputs.push({ node_id: node.id, file_id: file.file_id, node_type: node.type, node_subtype: node.subtype });
  }
  return {
    id: job.id,
    workflow_id: job.workflow_id,
    workflow_name: job.workflow_name,
    status: derived.status,
    stop_requested: job.stop_requested,
    created_at: job.created_at,
    runtime: derived.runtime,
    input_file_ids: job.files.map((file) => file.file_id),
    output_node_files: outputs,
    job_type: job.job_type,
    created_by_id: job.created_by,
    reason: derived.reason,
  };
}

/** `node_stats` for `GET /jobs/{id}/details`. */
export function nodeStats(job, phase) {
  const total = job.files.length;
  const failed = job.files.filter((file) => file.error !== null).length;
  return job.nodes.map((node) => {
    const stat = { node_name: node.name, node_type: node.type, node_subtype: node.subtype, ready: 0, in_progress: 0, success: 0, failure: 0 };
    if (phase === "SCHEDULED") stat.ready = total;
    else if (phase === "IN_PROGRESS") stat.in_progress = total;
    else if (phase === "STOPPED") stat.ready = total;
    else {
      stat.success = total - failed;
      stat.failure = failed;
    }
    return stat;
  });
}

export const nowIso = (context) => isoFromUs(context.clock.nowUs());
