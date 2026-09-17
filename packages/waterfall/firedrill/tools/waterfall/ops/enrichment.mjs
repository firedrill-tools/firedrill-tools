// Contact, phone and company enrichment: launchers validate one identifier strategy, create a job and answer
// `{ job_id, start_date }`; finders read the job of their kind (completing it when due).
import { fail, resolveKey } from "../lib/core.mjs";
import { launchJob, readJob } from "../lib/jobs.mjs";
import { isoOfUs } from "../lib/time.mjs";
import { normalizeCustomFields, normalizeDomain, normalizeEmail, normalizeLinkedin, normalizeWebhook, optionalString, rejectExtraFields } from "../lib/validate.mjs";

const PERSON_FIELDS = new Set(["email", "linkedin", "full_name", "first_name", "last_name", "domain", "include_phones", "webhook_url", "custom_fields", "missing_body"]);
const COMPANY_FIELDS = new Set(["domain", "linkedin", "name", "webhook_url", "custom_fields", "missing_body"]);

function requireBody(context, input) {
  if (input.missing_body === true) fail(context, "VALIDATION_MISSING_BODY", "Missing body");
}

function optionalBoolean(context, input, name) {
  if (!Object.hasOwn(input, name) || input[name] === null) return false;
  if (typeof input[name] !== "boolean") fail(context, "VALIDATION_BAD_REQUEST", "Bad request", [`${name}: Input should be a valid boolean`]);
  return input[name];
}

/** Validate a person-identifier task (contact and phone launchers share it). */
function personTask(context, input, allowed) {
  requireBody(context, input);
  rejectExtraFields(context, input, allowed);
  const email = optionalString(context, input, "email", 254);
  const linkedin = optionalString(context, input, "linkedin", 2083);
  const fullName = optionalString(context, input, "full_name", 200);
  const firstName = optionalString(context, input, "first_name", 100);
  const lastName = optionalString(context, input, "last_name", 100);
  const domain = optionalString(context, input, "domain", 2083);
  const task = {
    email: email === null ? null : normalizeEmail(context, email, "email", { role: true }),
    linkedin: linkedin === null ? null : normalizeLinkedin(context, linkedin, "linkedin"),
    full_name: fullName === null ? null : fullName.trim(),
    first_name: firstName === null ? null : firstName.trim(),
    last_name: lastName === null ? null : lastName.trim(),
    domain: domain === null ? null : normalizeDomain(context, domain),
  };
  const byName = task.domain !== null && (task.full_name !== null || (task.first_name !== null && task.last_name !== null));
  if (task.email === null && task.linkedin === null && !byName) {
    fail(context, "VALIDATION_BAD_REQUEST", "Bad request", ["request: Value error, one of email, linkedin, full_name + domain or first_name + last_name + domain is required"]);
  }
  if (allowed.has("include_phones")) task.include_phones = optionalBoolean(context, input, "include_phones");
  task.webhook_url = normalizeWebhook(context, input);
  task.custom_fields = normalizeCustomFields(context, input);
  return task;
}

function launched(job) {
  return { job_id: job.job_id, start_date: isoOfUs(job.start_at_us) };
}

export function contactLaunch(input, context) {
  const { key } = resolveKey(context, { billable: true });
  const task = personTask(context, input, PERSON_FIELDS);
  return launched(launchJob(context, key, "enrichment_contact", task));
}

export function contactGet(input, context) {
  resolveKey(context);
  return readJob(context, "enrichment_contact", input);
}

const PHONE_FIELDS = new Set([...PERSON_FIELDS].filter((name) => name !== "include_phones"));

export function phoneLaunch(input, context) {
  const { key } = resolveKey(context, { billable: true });
  const task = personTask(context, input, PHONE_FIELDS);
  return launched(launchJob(context, key, "enrichment_phone", task));
}

export function phoneGet(input, context) {
  resolveKey(context);
  return readJob(context, "enrichment_phone", input);
}

export function companyLaunch(input, context) {
  const { key } = resolveKey(context, { billable: true });
  requireBody(context, input);
  rejectExtraFields(context, input, COMPANY_FIELDS);
  const domain = optionalString(context, input, "domain", 2083);
  const linkedin = optionalString(context, input, "linkedin", 2083);
  const name = optionalString(context, input, "name", 500);
  const given = [domain, linkedin, name].filter((value) => value !== null).length;
  if (given !== 1) {
    fail(context, "VALIDATION_BAD_REQUEST", "Bad request", ["request: Value error, exactly one of domain, linkedin or name is required"]);
  }
  const task = {
    domain: domain === null ? null : normalizeDomain(context, domain),
    linkedin: linkedin === null ? null : normalizeLinkedin(context, linkedin, "linkedin"),
    name: name === null ? null : name.trim(),
    webhook_url: normalizeWebhook(context, input),
    custom_fields: normalizeCustomFields(context, input),
  };
  if (task.name !== null && task.name.length === 0) fail(context, "VALIDATION_BAD_REQUEST", "Bad request", ["name: String should have at least 1 character"]);
  return launched(launchJob(context, key, "enrichment_company", task));
}

export function companyGet(input, context) {
  resolveKey(context);
  return readJob(context, "enrichment_company", input);
}
