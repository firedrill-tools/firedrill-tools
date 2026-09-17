// Job Change (moved / left / no_change / unknown against the seeded directory) and Email Verification
// (valid / invalid / risky / unknown from seeded MX and catch-all data). Both complete synchronously.
import { account, fail, resolveKey } from "../lib/core.mjs";
import { companyByDomain, companyByLinkedin, companyById, personByEmail, personByLinkedin, personByNameInCompany, redactedPersonWire } from "../lib/directory.mjs";
import { finderWire, launchJob, readJob } from "../lib/jobs.mjs";
import { zeroUsage } from "../lib/usage.mjs";
import { normalizeCustomFields, normalizeDomain, normalizeEmail, normalizeLinkedin, optionalString, rejectExtraFields } from "../lib/validate.mjs";

const CHANGE_FIELDS = new Set(["company_domain", "company_linkedin", "professional_email", "personal_email", "contact_linkedin", "contact_full_name", "custom_fields", "missing_body"]);
const VERIFY_FIELDS = new Set(["email", "custom_fields", "missing_body"]);

const bad = (context, detail) => fail(context, "VALIDATION_BAD_REQUEST", "Bad request", [detail]);

export function jobChangeRun(input, context) {
  const { key } = resolveKey(context, { billable: true });
  if (input.missing_body === true) fail(context, "VALIDATION_MISSING_BODY", "Missing body");
  rejectExtraFields(context, input, CHANGE_FIELDS);
  const raw = {
    company_domain: optionalString(context, input, "company_domain", 2083),
    company_linkedin: optionalString(context, input, "company_linkedin", 2083),
    professional_email: optionalString(context, input, "professional_email", 254),
    personal_email: optionalString(context, input, "personal_email", 254),
    contact_linkedin: optionalString(context, input, "contact_linkedin", 2083),
    contact_full_name: optionalString(context, input, "contact_full_name", 200),
  };
  const personKeys = ["contact_linkedin", "professional_email", "personal_email", "contact_full_name"].filter((name) => raw[name] !== null);
  const companyKeys = ["company_domain", "company_linkedin"].filter((name) => raw[name] !== null);
  if (personKeys.length !== 1) bad(context, "request: Value error, exactly one of contact_linkedin, professional_email, personal_email or contact_full_name is required");
  if (companyKeys.length > 1) bad(context, "request: Value error, company_domain and company_linkedin cannot be set together");
  if ((personKeys[0] === "personal_email" || personKeys[0] === "contact_full_name") && companyKeys.length === 0) {
    bad(context, `request: Value error, ${personKeys[0]} requires company_domain or company_linkedin`);
  }
  const task = {
    company_domain: raw.company_domain === null ? null : normalizeDomain(context, raw.company_domain, "company_domain"),
    company_linkedin: raw.company_linkedin === null ? null : normalizeLinkedin(context, raw.company_linkedin, "company_linkedin"),
    professional_email: raw.professional_email === null ? null : normalizeEmail(context, raw.professional_email, "professional_email", { role: true }),
    personal_email: raw.personal_email === null ? null : normalizeEmail(context, raw.personal_email, "personal_email", { role: true }),
    contact_linkedin: raw.contact_linkedin === null ? null : normalizeLinkedin(context, raw.contact_linkedin, "contact_linkedin"),
    contact_full_name: raw.contact_full_name === null ? null : raw.contact_full_name.trim(),
    custom_fields: normalizeCustomFields(context, input),
  };
  const reference = task.company_domain !== null ? companyByDomain(context, task.company_domain)
    : task.company_linkedin !== null ? companyByLinkedin(context, task.company_linkedin) : null;
  let person = null;
  if (task.contact_linkedin !== null) person = personByLinkedin(context, task.contact_linkedin);
  else if (task.professional_email !== null) person = personByEmail(context, task.professional_email);
  else if (task.personal_email !== null) person = personByEmail(context, task.personal_email);
  else if (reference !== null) person = personByNameInCompany(context, reference.id, task.contact_full_name);
  const usage = zeroUsage();
  let status = "unknown";
  if (person !== null) {
    const current = companyById(context, person.company_id);
    if (current === null) status = "left";
    else if (companyKeys.length > 0) status = reference !== null && reference.id === current.id ? "no_change" : "moved";
    else if (task.professional_email !== null) status = task.professional_email.endsWith(`@${current.domain}`) ? "no_change" : "moved";
    else status = "no_change";
    usage.persons_count = 1;
    usage.persons_micros = account(context).price_micros.job_change_found;
  }
  const output = { job_change_status: status, person: person === null ? {} : redactedPersonWire(context, person) };
  return finderWire(launchJob(context, key, "job_change", task, { output, usage }));
}

export function jobChangeGet(input, context) {
  resolveKey(context);
  return readJob(context, "job_change", input);
}

export function verifyEmailRun(input, context) {
  const { key } = resolveKey(context, { billable: true });
  if (input.missing_body === true) fail(context, "VALIDATION_MISSING_BODY", "Missing body");
  rejectExtraFields(context, input, VERIFY_FIELDS);
  if (!Object.hasOwn(input, "email") || input.email === null) bad(context, "email: Field required");
  if (typeof input.email !== "string") bad(context, "email: Input should be a valid string");
  const email = normalizeEmail(context, input.email, "email");
  const task = { email, custom_fields: normalizeCustomFields(context, input) };
  const domain = email.slice(email.indexOf("@") + 1);
  const company = companyByDomain(context, domain);
  const owner = personByEmail(context, email);
  let status;
  if (owner !== null && owner.professional_email === email) status = "valid";
  else if (domain.endsWith(".invalid")) status = "invalid";
  else if (company === null) status = "unknown";
  else status = company.catch_all === true ? "risky" : "invalid";
  const usage = zeroUsage();
  if (status !== "unknown") {
    usage.persons_count = 1;
    usage.persons_micros = account(context).price_micros.verify_email_verified;
  }
  const output = {
    email: {
      email,
      domain,
      email_status: status,
      smtp_provider: company === null ? null : company.smtp_provider,
      mx_records: company === null ? [] : [...company.mx_records],
    },
  };
  return finderWire(launchJob(context, key, "verify_email", task, { output, usage }));
}
