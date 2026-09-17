// Job lifecycle: launch → (RUNNING until virtual time reaches due_at_us) → SUCCEEDED with output, usage, balance debit,
// daily usage counters and the `job.completed` event. Completion is derived from virtual time inside the first
// operation that observes a due job; nothing is scheduled. Money is integer micro-USD.
import { account, clip, fail, normalizeUuid, newUuid, usd } from "./core.mjs";
import { totalMicros, usageWire } from "./usage.mjs";
import { dateOfUs, isoOfUs } from "./time.mjs";
import { computeAsyncResult } from "./results.mjs";

const SYNC_KINDS = new Set(["search_contact", "search_company", "job_change", "verify_email"]);
const REQUEST_COUNTER = {
  enrichment_contact: "enrichment_contact_requests",
  enrichment_phone: "enrichment_phone_requests",
  enrichment_company: "enrichment_company_requests",
  search_contact: "search_contact_requests",
  search_company: "search_company_requests",
  job_change: "job_change_requests",
  verify_email: "verify_email_requests",
};
const FOUND_COUNTERS = {
  enrichment_contact: { persons: "enrichment_contact_persons", phones: "enrichment_contact_persons_phones" },
  enrichment_phone: { phones: "enrichment_phone_phones" },
  enrichment_company: { companies: "enrichment_company_companies" },
  search_contact: { persons: "search_contact_found" },
  search_company: { companies: "search_company_found" },
  job_change: { persons: "job_change_found" },
  verify_email: { persons: "verify_email_verified" },
};
const USAGE_FIELDS = [
  "prospector_requests", "prospector_persons", "prospector_persons_phones",
  "enrichment_contact_requests", "enrichment_contact_persons", "enrichment_contact_persons_phones",
  "enrichment_phone_requests", "enrichment_phone_phones",
  "enrichment_company_requests", "enrichment_company_companies",
  "verify_email_requests", "verify_email_verified",
  "search_contact_requests", "search_contact_found",
  "search_company_requests", "search_company_found",
  "job_change_requests", "job_change_found",
];

export const USAGE_COUNTERS = USAGE_FIELDS;

function bumpUsage(context, apiKey, day, increments) {
  const rowId = `${apiKey}/${day}`;
  const existing = context.state.get("usage", rowId);
  const row = { api_key: apiKey, day };
  for (const field of USAGE_FIELDS) row[field] = existing === null ? 0 : existing[field];
  let changed = existing === null;
  for (const [field, amount] of Object.entries(increments)) {
    if (amount > 0) {
      row[field] += amount;
      changed = true;
    }
  }
  if (changed) context.state.put("usage", rowId, row);
}

/** Materialise a due job: output, usage, balance debit, usage counters and the completion event. */
function complete(context, job, result, nowUs) {
  const usage = result.usage;
  const total = totalMicros(usage);
  const done = { ...job, status: "SUCCEEDED", stop_at_us: nowUs, output: result.output, usage, error: null };
  context.state.put("jobs", job.job_id, done);
  if (total > 0) {
    const acct = account(context);
    context.state.put("meta", "account", { ...acct, balance_remaining_micros: acct.balance_remaining_micros - total });
  }
  const found = FOUND_COUNTERS[job.kind];
  const increments = {};
  if (found.persons !== undefined) increments[found.persons] = usage.persons_count;
  if (found.phones !== undefined) increments[found.phones] = usage.phones_count;
  if (found.companies !== undefined) increments[found.companies] = usage.companies_count;
  bumpUsage(context, job.api_key, dateOfUs(nowUs), increments);
  context.events.emit("job.completed", {
    job_id: job.job_id,
    kind: job.kind,
    api_key: job.api_key,
    status: "SUCCEEDED",
    stop_date: isoOfUs(nowUs),
    total_usd: usd(total),
    persons_count: usage.persons_count,
    phones_count: usage.phones_count,
    companies_count: usage.companies_count,
  });
  return done;
}

/**
 * Create a job for the calling key. Sync kinds complete in this call with `result`; async kinds complete now when
 * `job_delay_us` is 0, otherwise on the first finder read at or after `due_at_us`.
 */
export function launchJob(context, key, kind, task, result) {
  const nowUs = context.clock.nowUs();
  const jobId = newUuid(context);
  const delay = SYNC_KINDS.has(kind) ? 0 : account(context).job_delay_us;
  const fullTask = { ...task, job_id: jobId, context_id: jobId };
  const job = { job_id: jobId, kind, api_key: key.api_key, start_at_us: nowUs, due_at_us: nowUs + delay, stop_at_us: null, status: "RUNNING", task: fullTask, output: null, usage: null, error: null };
  context.state.put("jobs", jobId, job);
  bumpUsage(context, key.api_key, dateOfUs(nowUs), { [REQUEST_COUNTER[kind]]: 1 });
  context.events.emit("job.launched", { job_id: jobId, kind, api_key: key.api_key, start_date: isoOfUs(nowUs) });
  if (delay > 0) return job;
  return complete(context, job, result === undefined ? computeAsyncResult(context, job) : result, nowUs);
}

/** Finder: validate `job_id`, load the job of this kind, complete it when due, and render the finder shape. */
export function readJob(context, kind, input) {
  if (!Object.hasOwn(input, "job_id")) fail(context, "VALIDATION_MISSING_JOB_ID_PARAMETER", "Missing job_id parameter");
  const jobId = normalizeUuid(input.job_id);
  if (jobId === null) fail(context, "VALIDATION_BAD_JOB_ID", `Bad job_id ${clip(input.job_id)}`);
  let job = context.state.get("jobs", jobId);
  if (job === null || job.kind !== kind) fail(context, "NOT_FOUND_JOB_NOT_FOUND", `Job ${jobId} not found`);
  const nowUs = context.clock.nowUs();
  if (job.status === "RUNNING" && nowUs >= job.due_at_us) job = complete(context, job, computeAsyncResult(context, job), nowUs);
  return finderWire(job);
}

export function finderWire(job) {
  const wire = { status: job.status, start_date: isoOfUs(job.start_at_us), input: { task: job.task } };
  if (job.stop_at_us !== null) wire.stop_date = isoOfUs(job.stop_at_us);
  if (job.status === "SUCCEEDED" && job.output !== null) wire.output = { ...job.output, usage: usageWire(job.usage) };
  if (job.error !== null) wire.error = job.error;
  return wire;
}
